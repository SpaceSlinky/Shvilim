#!/usr/bin/env python3
"""בונה את israel.json – מפה כללית של כל הארץ שמגיעה עם האפליקציה (רק בזום רחוק):
שמות ערים, עיירות, יישובים וכפרים; קו החוף; הגבול; כבישים ראשיים (מפושטים).
מקור: OpenStreetMap דרך Overpass. מריצים מ-GitHub Actions (overview.yml) ושומרים ברפו.

שימוש: python3 tools/overview.py israel.json
"""
import json, math, sys, time, urllib.parse, urllib.request

SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
AREA = '(area["ISO3166-1"="IL"][admin_level=2];area["ISO3166-1"="PS"][admin_level=2];)->.a;'
QUERIES = {
    'places': AREA + 'node[place~"^(city|town|village)$"](area.a);out;',
    'roads': AREA + 'way[highway~"^(motorway|trunk|primary)$"](area.a);out geom;',
    'coast': 'way[natural=coastline](29.45,34.1,33.4,35.1);out geom;',
    'border': 'relation["ISO3166-1"="IL"][admin_level=2];way(r)[!"maritime"];out geom;',
}


def overpass(q):
    body = urllib.parse.urlencode({'data': '[out:json][timeout:300];' + q}).encode()
    last = None
    for attempt in range(3):
        for url in SERVERS:
            try:
                req = urllib.request.Request(url, data=body, headers={'User-Agent': 'shvilim-overview/1'})
                with urllib.request.urlopen(req, timeout=360) as r:
                    return json.load(r)['elements']
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
    print('places…', file=sys.stderr)
    for el in overpass(QUERIES['places']):
        t = el.get('tags', {})
        n = t.get('name:he') or t.get('name')
        if not n:
            continue
        kind = {'city': 'c', 'town': 't', 'village': 'v'}[t['place']]
        feats.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(el['lon'], 4), round(el['lat'], 4)]},
                      'properties': {'k': 'p', 't': kind, 'n': n}})
    print('roads…', file=sys.stderr)
    roads = overpass(QUERIES['roads'])
    for hw, r in (('motorway', 'm'), ('trunk', 't'), ('primary', 'p')):
        # רק לזום רחוק (עד 10, ~130 מ' לפיקסל): פישוט 100 מ', דיוק 3 ספרות (~100 מ'), קווים מחוברים
        for c in lines([el for el in roads if el['tags']['highway'] == hw], 100, 3):
            feats.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': c}, 'properties': {'k': 'r', 'r': r}})
    for key, k in (('coast', 'c'), ('border', 'b')):
        print(key + '…', file=sys.stderr)
        for c in lines(overpass(QUERIES[key]), 80, 3):
            feats.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': c}, 'properties': {'k': k}})
    fc = {'type': 'FeatureCollection', 'built': time.strftime('%Y-%m-%d'), 'features': feats}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))
    print(len(feats), 'features', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'israel.json')
