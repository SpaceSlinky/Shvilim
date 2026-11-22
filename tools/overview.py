#!/usr/bin/env python3
"""בונה את israel.json – מפה כללית של כל הארץ שמגיעה עם האפליקציה:
שמות ערים, עיירות, יישובים וכפרים (עם דירוג לפי גודל); הים התיכון, מפרץ אילת, הכנרת וים המלח (משטחים);
קו החוף; קו הגבול (רציף). בלי כבישים.
מקור: OpenStreetMap דרך Overpass. מריצים מ-GitHub Actions (overview.yml) ושומרים ברפו.

שימוש: python3 tools/overview.py israel.json
"""
import json, math, sys, time, urllib.parse, urllib.request

SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
AREA = '(area["ISO3166-1"="IL"][admin_level=2];area["ISO3166-1"="PS"][admin_level=2];)->.a;'
QUERIES = {
    'places': AREA + 'node[place~"^(city|town|village)$"](area.a);out;',
    'border_il': 'relation["ISO3166-1"="IL"][admin_level=2];way(r)[!"maritime"];out geom;',
    'border_ps': 'relation["ISO3166-1"="PS"][admin_level=2];way(r)[!"maritime"];out geom;',
    'lakes': 'nwr["natural"="water"]["name:he"~"^((ים )?כי?נרת|ים המלח)$"](29.4,34.8,33.4,35.8);out geom;',
    'kinneret': 'nwr["natural"="water"]["name:en"~"^(Sea of Galilee|Lake Kinneret|Lake Tiberias)$"](32.6,35.4,33.0,35.8);out geom;',
}
# ימים: קו החוף בתוך מלבן, נחתך לגבולותיו ונסגר לאורכם (המים מימין לקו החוף ב-OSM). נקודה שחייבת להיות בתוך הים – בדיקה
SEAS = [  # (מערב, דרום, מזרח, צפון), נקודה בים
    # הים התיכון: עד קו אורך 33 (מערבה – לגונות סיני מבלבלות את חיבור קו החוף); מערבה מזה – מלבן פשוט (FILL)
    ((33.0, 30.9, 35.3, 33.6), (33.5, 32.5)),
    ((34.4, 28.9, 35.2, 29.65), (34.93, 29.45)),  # מפרץ אילת (בין טאבה לחוף אילת)
]


FILL = [[28.0, 31.28], [28.0, 36.0], [33.0, 36.0], [33.0, 31.28], [28.0, 31.28]]  # הים מערבית לקו 33 (רק לזום רחוק)


def coast_q(b):
    w, s, e, n = b
    return f'way[natural=coastline]({s},{w},{n},{e});out geom;'


def clip(line, b):
    """חותך קו למלבן – מחזיר חלקים שבתוכו (נקודות כניסה ויציאה על הגבול)"""
    w, s, e, n = b
    inside = lambda p: w <= p[0] <= e and s <= p[1] <= n
    pieces, cur = [], []
    for a, c in zip(line, line[1:]):
        # Liang–Barsky לקטע a→c
        t0, t1, dx, dy = 0.0, 1.0, c[0] - a[0], c[1] - a[1]
        ok = True
        for pp, qq in ((-dx, a[0] - w), (dx, e - a[0]), (-dy, a[1] - s), (dy, n - a[1])):
            if pp == 0:
                if qq < 0:
                    ok = False
                    break
            else:
                r = qq / pp
                if pp < 0:
                    t0 = max(t0, r)
                else:
                    t1 = min(t1, r)
        if not ok or t0 > t1:
            if cur:
                pieces.append(cur)
                cur = []
            continue
        p0 = [a[0] + t0 * dx, a[1] + t0 * dy]
        p1 = [a[0] + t1 * dx, a[1] + t1 * dy]
        if not cur:
            cur = [p0]
        cur.append(p1)
        if t1 < 1:
            pieces.append(cur)
            cur = []
    if cur:
        pieces.append(cur)
    return [p for p in pieces if len(p) > 1]


def chain(lines, maxgap_m=12000):
    """מחבר קטעי קו חוף שיש ביניהם רווח (סוף של אחד → התחלה של אחר, עד 12 ק"מ) – בנתונים חסרים לפעמים קטעים"""
    lines = [list(l) for l in lines]
    kx = 111320 * math.cos(math.radians(32))
    d = lambda p, q: math.hypot((p[0] - q[0]) * kx, (p[1] - q[1]) * 110540)
    while True:
        best = None
        for i, a in enumerate(lines):
            for j, b2 in enumerate(lines):
                if i != j:
                    g = d(a[-1], b2[0])
                    if g < maxgap_m and (best is None or g < best[0]):
                        best = (g, i, j)
        if not best:
            return lines
        _, i, j = best
        lines[i] = lines[i] + lines[j][1:] if lines[i][-1] == lines[j][0] else lines[i] + lines[j]
        del lines[j]


# ערים מרכזיות – השמות היחידים שמוצגים בזום רחוק (להתמצאות; השאר בחיפוש, ומקרוב)
MAJOR = {'ירושלים', 'תל אביב–יפו', 'חיפה', 'באר שבע', 'אילת', 'נתניה', 'אשדוד', 'אשקלון', 'חדרה', 'טבריה', 'צפת',
         'קרית שמונה', 'נהריה', 'עפולה', 'בית שאן', 'נצרת', 'ערד', 'דימונה', 'מצפה רמון', 'קצרין', 'עין גדי', 'יטבתה',
         'עין יהב', 'שדה בוקר'}
GAZA = (34.2, 31.2, 34.6, 31.6)  # הגבול עם עזה נשאר (אליה אי אפשר להגיע)


def seg_key(a, b):
    return (a, b) if a <= b else (b, a)


def segments(els):
    out = set()
    for el in els:
        g = [(round(p['lon'], 5), round(p['lat'], 5)) for p in el.get('geometry', [])]
        for a, b in zip(g, g[1:]):
            if a != b:
                out.add(seg_key(a, b))
    return out


def outer_border(il_els, ps_els):
    """קו המתאר "המעשי": הגבולות החיצוניים של ישראל ויהודה ושומרון יחד – בלי הקו הירוק באמצע (קטע שמשותף לשני
    הגבולות = גבול פנימי), חוץ מהגבול עם עזה"""
    il, ps = segments(il_els), segments(ps_els)
    inside = lambda s: all(GAZA[0] <= p[0] <= GAZA[2] and GAZA[1] <= p[1] <= GAZA[3] for p in s)
    keep = (il ^ ps) | {s for s in il & ps if inside(s)}
    return unique_lines([{'geometry': [{'lon': a[0], 'lat': a[1]}, {'lon': b[0], 'lat': b[1]}]} for a, b in keep])


WB_EAST = (35.3, 31.3, 35.65, 32.6)  # רצועת הירדן וים המלח הצפוני – הגבול של יהודה ושומרון עם ירדן


def practical_border(il_els, nb):
    """קו המתאר "המעשי" מקובץ ישראל: הגבולות הבינלאומיים של ישראל (קטע שמשותף לגבול ישראל ולגבול שכנה – לבנון,
    סוריה, ירדן, מצרים); הגבול עם עזה (וגבול עזה–מצרים); והגבול של ירדן לאורך הירדן וים המלח מול יהודה ושומרון.
    בלי הקו הירוק (גבול של ישראל שאין לו שכנה מעבר לו). ב-OSM אין יחס admin_level=2 לפלסטין"""
    il = segments(il_els)
    nbs = {c: segments(v) for c, v in nb.items()}
    allnb = set().union(*nbs.values()) if nbs else set()
    box = lambda b: (lambda sg: all(b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3] for p in sg))
    gaza, wb = box(GAZA), box(WB_EAST)
    keep = {sg for sg in il if sg in allnb or gaza(sg)}
    keep |= {sg for sg in nbs.get('EG', set()) - il if gaza(sg)}
    keep |= {sg for sg in nbs.get('JO', set()) - il if wb(sg)}
    print('  border segments:', len(il), 'IL,', len(keep), 'kept', file=sys.stderr)
    return unique_lines([{'geometry': [{'lon': a[0], 'lat': a[1]}, {'lon': b[0], 'lat': b[1]}]} for a, b in keep])


def unique_lines(els):
    """קווים מתוך דרכים, כשכל קטע נספר פעם אחת (בגבול יש דרכים כפולות – אחרת הקו הולך וחוזר על עצמו)"""
    adj = {}
    seen = set()
    for el in els:
        g = [(round(p['lon'], 5), round(p['lat'], 5)) for p in el.get('geometry', [])]
        for a, b in zip(g, g[1:]):
            if a == b or (a, b) in seen or (b, a) in seen:
                continue
            seen.add((a, b))
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
    used, out = set(), []
    def walk(a, b):
        line = [a, b]
        used.add(frozenset((a, b)))
        while len(adj[line[-1]]) == 2:
            nxt = next((n for n in adj[line[-1]] if frozenset((line[-1], n)) not in used), None)
            if nxt is None:
                break
            used.add(frozenset((line[-1], nxt)))
            line.append(nxt)
        return [list(p) for p in line]
    for start in [n for n in adj if len(adj[n]) != 2] + list(adj):
        for n in adj[start]:
            if frozenset((start, n)) not in used:
                out.append(walk(start, n))
    return out


def drop_loops(line):
    """לולאה קטנה שהקו חוזר בה לאותה נקודה (בגבול ליד טאבה – "קשקוש") – נחתכת: מהמופע הראשון של נקודה ישר לאחרון"""
    closed = len(line) > 2 and line[0] == line[-1]
    if closed:
        line = line[:-1]  # טבעת: נקודת הסגירה היא לא "חזרה"
    last = {tuple(p): i for i, p in enumerate(line)}
    out, i = [], 0
    while i < len(line):
        out.append(line[i])
        i = last[tuple(line[i])] + 1
    return out + [out[0]] if closed else out


def join_all(lines, maxgap_m=15000, water=()):
    """מחבר קווים לקו רציף בלי קשר לכיוון (הופך כשצריך), וממלא רווחים קטנים בקו ישר – לגבול (בנתונים חסרים
    לפעמים קטעים). לא מחבר מעל מים (טאבה–אילת)"""
    lines = [list(l) for l in lines if len(l) > 1]
    kx = 111320 * math.cos(math.radians(31.5))
    d = lambda p, q: math.hypot((p[0] - q[0]) * kx, (p[1] - q[1]) * 110540)
    while len(lines) > 1:
        best = None
        for i in range(len(lines)):
            for j in range(i + 1, len(lines)):
                a, b2 = lines[i], lines[j]
                for g, ra, rb in ((d(a[-1], b2[0]), False, False), (d(a[-1], b2[-1]), False, True),
                                  (d(a[0], b2[-1]), True, True), (d(a[0], b2[0]), True, False)):
                    if g < maxgap_m and (best is None or g < best[0]):
                        p = (a[0] if ra else a[-1]); q = (b2[-1] if rb else b2[0])
                        mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
                        if not any(inside_ring(mid, r) for r in water):
                            best = (g, i, j, ra, rb)
        if not best:
            break
        _, i, j, ra, rb = best
        a = lines[i][::-1] if ra else lines[i]
        b2 = lines[j][::-1] if rb else lines[j]
        lines[i] = a + (b2[1:] if a[-1] == b2[0] else b2)
        del lines[j]
    return lines


# שמות פחות מוכרים שלא יעלו לזום הרחוק – במקומם עולה השכן המוכר (מדרשת בן גוריון → שדה בוקר)
NOT_PROMOTED = {'מדרשת בן גוריון'}


def promote(places, gap_km=22):
    """באזורים ריקים (נגב, ערבה) – יישובים נוספים מוצגים כבר בזום הרחוק: עוברים מהגדול לקטן, וכל יישוב שרחוק
    יותר מ-gap_km מכל יישוב שכבר מוצג (r=1) – עולה לדירוג 1"""
    kx = 111320 * math.cos(math.radians(31.5))
    shown = [f['geometry']['coordinates'] for f in places if f['properties']['r'] == 1]
    for f in sorted(places, key=lambda f: -f['properties'].get('pop', 0)):
        if f['properties']['r'] == 1 or f['properties']['n'] in NOT_PROMOTED:
            continue
        x, y = f['geometry']['coordinates']
        if all(math.hypot((x - a) * kx, (y - b) * 110540) > gap_km * 1000 for a, b in shown):
            f['properties']['r'] = 1
            shown.append([x, y])


def sea_polygons(els, b, probe):
    w, s, e, n = b
    W, H = e - w, n - s
    P = 2 * (W + H)
    eps = 1e-7

    def t(p):  # מיקום על היקף המלבן, עם כיוון השעון מהפינה הצפון-מערבית
        x, y = p
        if abs(y - n) < eps: return x - w
        if abs(x - e) < eps: return W + (n - y)
        if abs(y - s) < eps: return W + H + (e - x)
        if abs(x - w) < eps: return 2 * W + H + (y - s)
        return None
    corners = [(0, [w, n]), (W, [e, n]), (W + H, [e, s]), (2 * W + H, [w, s])]
    raw = [[[g['lon'], g['lat']] for g in el.get('geometry', [])] for el in els]
    pieces = []
    for l in chain([l for l in merge(raw) if l[0] != l[-1]]):  # בלי איים (טבעות סגורות)
        if l[0] == l[-1]:
            continue
        for pc in clip(l, b):
            ts, te = t(pc[0]), t(pc[-1])
            if ts is not None and te is not None:
                pieces.append({'pts': pc, 'ts': ts, 'te': te})
    polys, used = [], [False] * len(pieces)
    for i in range(len(pieces)):
        if used[i]:
            continue
        ring, j = [], i
        for _ in range(len(pieces) + 1):
            used[j] = True
            pc = pieces[j]
            ring += pc['pts']
            # הקטע הבא: ההתחלה הקרובה ביותר עם כיוון השעון מהסוף
            dist = lambda k: (pieces[k]['ts'] - pc['te']) % P
            k = min(range(len(pieces)), key=dist)
            d0 = dist(k)
            for ct, cp in sorted(corners, key=lambda c: (c[0] - pc['te']) % P):
                if 0 < (ct - pc['te']) % P < d0:
                    ring.append(cp)
            if k == i:
                break
            j = k
        ring.append(ring[0])
        polys.append(ring)
    good = [r for r in polys if inside_ring(probe, r)]
    if not good:
        print('  sea: probe not inside – skipped', b, file=sys.stderr)
    return good


def inside_ring(p, ring):
    x, y, c = p[0], p[1], False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def ring_clean(r, tol, prec):
    # טבעת סגורה: הקצוות זהים – לפשט כל חצי בנפרד (אחרת כל הנקודות "על הקו" ונמחקות)
    mid = len(r) // 2
    pts = simplify(r[:mid + 1], tol) + simplify(r[mid:], tol)[1:]
    pts = [[round(x, prec), round(y, prec)] for x, y in pts]
    out = [pts[0]]
    for p in pts[1:]:
        if p != out[-1]:
            out.append(p)
    if out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None


def overpass(q, need=1):
    """need – כמה תוצאות לפחות; פחות מזה (או הודעת שגיאה של השרת) – ניסיון חוזר (אחרת נשמרת מפה ריקה)"""
    body = urllib.parse.urlencode({'data': '[out:json][timeout:300];' + q}).encode()
    last = None
    for attempt in range(3):
        for url in SERVERS:
            try:
                req = urllib.request.Request(url, data=body, headers={'User-Agent': 'shvilim-overview/1'})
                with urllib.request.urlopen(req, timeout=360) as r:
                    d = json.load(r)
                if 'error' in (d.get('remark') or '').lower() or len(d['elements']) < need:
                    raise RuntimeError('partial result: %d elements, %s' % (len(d['elements']), d.get('remark')))
                return d['elements']
            except Exception as e:  # שרת עמוס – הבא בתור
                last = e
                print('  ', url, e, file=sys.stderr)
        time.sleep(20)
    raise last


def simplify(pts, tol_m):
    """Douglas–Peucker במטרים (הקרנה מקומית)"""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(pts[0][1])
    kx, ky = 111320 * math.cos(lat0), 110540
    xy = [(p[0] * kx, p[1] * ky) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = xy[a], xy[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1e-9
        best, bi = -1, -1
        for i in range(a + 1, b):
            d = abs((xy[i][0] - ax) * dy - (xy[i][1] - ay) * dx) / L
            if d > best:
                best, bi = d, i
        if best > tol_m:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def merge(lines):
    """מחבר קווים שנוגעים בקצוות לקווים ארוכים (פחות קווים – הרבה פחות נפח)"""
    lines = [l for l in lines if len(l) > 1]
    ends = {}
    for i, l in enumerate(lines):
        for p in (tuple(l[0]), tuple(l[-1])):
            ends.setdefault(p, []).append(i)
    used = [False] * len(lines)
    out = []
    for i in range(len(lines)):
        if used[i]:
            continue
        used[i] = True
        cur = list(lines[i])
        for forward in (True, False):
            while True:
                p = tuple(cur[-1] if forward else cur[0])
                nxt = next((j for j in ends.get(p, []) if not used[j]), None)
                if nxt is None:
                    break
                used[nxt] = True
                l = lines[nxt]
                if tuple(l[0]) != p:
                    l = l[::-1]
                cur = cur + l[1:] if forward else l[:-1] + cur
        out.append(cur)
    return out


def lines(els, tol, prec):
    raw = [[[round(g['lon'], 5), round(g['lat'], 5)] for g in el.get('geometry', [])] for el in els]
    res = []
    for l in merge(raw):
        pts = [[round(x, prec), round(y, prec)] for x, y in simplify(l, tol)]
        out = [pts[0]]
        for p in pts[1:]:
            if p != out[-1]:
                out.append(p)
        if len(out) > 1:
            res.append(out)
    return res


def from_pbf(path):
    """קובץ מוכן של Geofabrik (ישראל ופלסטין): יישובים, ודרכי הגבול של IL ו-PS – בלי שרת ציבורי עמוס"""
    import osmium

    class Rel(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.il, self.nb = set(), {}

        def relation(self, r):
            t = r.tags
            if t.get('admin_level') != '2' or t.get('boundary') not in ('administrative', None):
                return
            iso = t.get('ISO3166-1') or t.get('ISO3166-1:alpha2') or ''
            en = t.get('name:en') or ''
            print('  admin2:', r.id, iso, en, file=sys.stderr)
            ways = {m.ref for m in r.members if m.type == 'w'}
            if iso == 'IL':
                self.il |= ways
            elif iso in ('JO', 'EG', 'LB', 'SY'):
                self.nb.setdefault(iso, set()).update(ways)

    rel = Rel()
    rel.apply_file(path)

    class H(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.places, self.il, self.nb = [], [], {}

        def node(self, n):
            t = n.tags
            if t.get('place') in ('city', 'town', 'village') and (t.get('name:he') or t.get('name')):
                self.places.append({'lon': n.location.lon, 'lat': n.location.lat, 'tags': {k: v for k, v in t}})

        def way(self, w):
            mine = [c for c, ids in rel.nb.items() if w.id in ids]
            if (w.id in rel.il or mine) and w.tags.get('maritime') != 'yes':
                try:
                    el = {'geometry': [{'lon': nd.lon, 'lat': nd.lat} for nd in w.nodes]}
                except osmium.InvalidLocationError:
                    return
                if w.id in rel.il:
                    self.il.append(el)
                for c in mine:
                    self.nb.setdefault(c, []).append(el)

    h = H()
    h.apply_file(path, locations=True)
    print('pbf:', len(h.places), 'places,', len(h.il), 'IL ways,', {c: len(v) for c, v in h.nb.items()}, file=sys.stderr)
    return h


def main(path, pbf=None):
    feats = []
    F = lambda geom, props: feats.append({'type': 'Feature', 'geometry': geom, 'properties': props})
    src = from_pbf(pbf) if pbf else None
    print('places…', file=sys.stderr)
    for el in (src.places if src else overpass(QUERIES['places'], need=800)):
        t = el.get('tags', {})
        n = t.get('name:he') or t.get('name')
        if not n:
            continue
        try:
            pop = int(str(t.get('population', '0')).replace(',', '').split('.')[0] or 0)
        except ValueError:
            pop = 0
        # דירוג: 1 – עיר / מעל 40 אלף (תמיד), 2 – עיירה (מזום 7.5), 3 – יישוב/כפר (מזום 8.5)
        rank = 1 if t['place'] == 'city' or pop >= 40000 else 2 if t['place'] == 'town' else 3
        F({'type': 'Point', 'coordinates': [round(el['lon'], 4), round(el['lat'], 4)]}, {'k': 'p', 'r': rank, 'pop': pop, 'n': n})
    if src:
        # ים, חוף ואגמים לא משתנים – נשארים מהקובץ הקיים (בקובץ של ישראל אין את החוף של לבנון וסיני, שצריך לסגירת הים)
        with open(path, encoding='utf-8') as f:
            for x in json.load(f)['features']:
                if x['properties']['k'] in ('w', 'c'):
                    feats.append(x)
    for b, probe in ([] if src else SEAS):
        print('seas…', file=sys.stderr)
        coast = overpass(coast_q(b), need=5)
        for ring in sea_polygons(coast, b, probe):
            r = ring_clean(ring, 20, 4)
            if r:
                F({'type': 'Polygon', 'coordinates': [r]}, {'k': 'w'})
        for c in lines(coast, 20, 4):
            F({'type': 'LineString', 'coordinates': c}, {'k': 'c'})
    if not src:
        F({'type': 'Polygon', 'coordinates': [FILL]}, {'k': 'w'})
    print('lakes…', file=sys.stderr)
    lakes = [] if src else overpass(QUERIES['lakes'], need=1)
    if not src and not any(32.6 < (el.get('bounds') or {}).get('minlat', 0) < 33 for el in lakes):  # הכנרת לא נמצאה בשם העברי
        lakes += overpass(QUERIES['kinneret'], need=1)
    for el in lakes:
        if el['type'] == 'way':
            rings = [[[g['lon'], g['lat']] for g in el.get('geometry', [])]]
        else:
            rings = merge([[[g['lon'], g['lat']] for g in m.get('geometry', [])] for m in el.get('members', []) if m.get('role') == 'outer'])
        for ring in rings:
            if len(ring) > 3 and ring[0] == ring[-1]:
                r = ring_clean(ring, 20, 4)
                if r:
                    F({'type': 'Polygon', 'coordinates': [r]}, {'k': 'w'})
    print('border…', file=sys.stderr)
    # קו גבול רציף ושלם (רווחים בנתונים – בקו ישר)
    water = [f['geometry']['coordinates'][0] for f in feats if f['properties']['k'] == 'w']
    border = []
    for l in (practical_border(src.il, src.nb) if src else outer_border(overpass(QUERIES['border_il'], need=3), overpass(QUERIES['border_ps'], need=2))):
        pts = (simplify(l[:len(l) // 2 + 1], 60) + simplify(l[len(l) // 2:], 60)[1:]) if l[0] == l[-1] else simplify(l, 60)
        c = [[round(x, 3), round(y, 3)] for x, y in pts]
        if len(c) > 1:
            border.append(c)
    for c in join_all(border, water=water):
        F({'type': 'LineString', 'coordinates': drop_loops(c)}, {'k': 'b'})
    for f in feats:
        if f['properties']['k'] == 'p' and f['properties']['n'] in MAJOR:
            f['properties']['m'] = 1
    count = lambda k: sum(1 for f in feats if f['properties']['k'] == k)
    print({k: count(k) for k in 'pwcb'}, file=sys.stderr)
    if count('p') < 800 or count('b') < 1 or count('w') < 2:
        sys.exit('חסרים נתונים – לא שומר')
    # בלי שינוי בנתונים – לא נוגעים בקובץ (אחרת כל הרצה "משנה" רק את התאריך ומעלה גרסה סתם)
    try:
        with open(path, encoding='utf-8') as f:
            if json.load(f).get('features') == json.loads(json.dumps(feats, ensure_ascii=False)):
                print('no change', file=sys.stderr)
                return
    except (OSError, ValueError):
        pass
    fc = {'type': 'FeatureCollection', 'built': time.strftime('%Y-%m-%d'), 'features': feats}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))
    print(len(feats), 'features', file=sys.stderr)


if __name__ == '__main__':
    args = sys.argv[1:]
    pbf = args[args.index('--pbf') + 1] if '--pbf' in args else None
    main(args[0] if args and not args[0].startswith('--') else 'israel.json', pbf)
