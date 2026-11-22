#!/usr/bin/env python3
"""בונה את israel.json – מפה כללית של כל הארץ שמגיעה עם האפליקציה:
שמות ערים, עיירות, יישובים וכפרים (עם דירוג לפי גודל); הים התיכון, מפרץ אילת, הכנרת וים המלח (משטחים);
קו החוף; הגבול; כבישים ראשיים ומשניים (מפושטים).
מקור: OpenStreetMap דרך Overpass. מריצים מ-GitHub Actions (overview.yml) ושומרים ברפו.

שימוש: python3 tools/overview.py israel.json
"""
import json, math, sys, time, urllib.parse, urllib.request

SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
AREA = '(area["ISO3166-1"="IL"][admin_level=2];area["ISO3166-1"="PS"][admin_level=2];)->.a;'
QUERIES = {
    'places': AREA + 'node[place~"^(city|town|village)$"](area.a);out;',
    'roads': AREA + 'way[highway~"^(motorway|trunk|primary|secondary)$"](area.a);out geom;',
    'border': 'relation["ISO3166-1"="IL"][admin_level=2];way(r)[!"maritime"];out geom;',
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


def main(path):
    feats = []
    F = lambda geom, props: feats.append({'type': 'Feature', 'geometry': geom, 'properties': props})
    print('places…', file=sys.stderr)
    for el in overpass(QUERIES['places'], need=800):
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
    print('seas…', file=sys.stderr)
    for b, probe in SEAS:
        coast = overpass(coast_q(b), need=5)
        for ring in sea_polygons(coast, b, probe):
            r = ring_clean(ring, 20, 4)
            if r:
                F({'type': 'Polygon', 'coordinates': [r]}, {'k': 'w'})
        for c in lines(coast, 20, 4):
            F({'type': 'LineString', 'coordinates': c}, {'k': 'c'})
    F({'type': 'Polygon', 'coordinates': [FILL]}, {'k': 'w'})
    print('lakes…', file=sys.stderr)
    lakes = overpass(QUERIES['lakes'], need=1)
    if not any(32.6 < (el.get('bounds') or {}).get('minlat', 0) < 33 for el in lakes):  # הכנרת לא נמצאה בשם העברי
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
    print('roads…', file=sys.stderr)
    roads = overpass(QUERIES['roads'], need=1000)
    for hw, r, tol in (('motorway', 'm', 80), ('trunk', 't', 80), ('primary', 'p', 80), ('secondary', 's', 100)):
        for c in lines([el for el in roads if el['tags']['highway'] == hw], tol, 3):
            F({'type': 'LineString', 'coordinates': c}, {'k': 'r', 'r': r})
    print('border…', file=sys.stderr)
    for c in lines(overpass(QUERIES['border'], need=3), 60, 3):
        F({'type': 'LineString', 'coordinates': c}, {'k': 'b'})
    count = lambda k: sum(1 for f in feats if f['properties']['k'] == k)
    print({k: count(k) for k in 'pwcrb'}, file=sys.stderr)
    if count('p') < 800 or count('r') < 300 or count('w') < 2:
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
    main(sys.argv[1] if len(sys.argv) > 1 else 'israel.json')
