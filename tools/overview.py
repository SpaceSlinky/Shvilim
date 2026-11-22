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


def line(el, tol):
    pts = [[round(g['lon'], 4), round(g['lat'], 4)] for g in el.get('geometry', [])]
    pts = simplify(pts, tol)
    out = [pts[0]] if pts else []
    for p in pts[1:]:
        if p != out[-1]:
            out.append(p)
    return out if len(out) > 1 else None


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
    for el in overpass(QUERIES['roads']):
        c = line(el, 40)
        if c:
            r = {'motorway': 'm', 'trunk': 't', 'primary': 'p'}[el['tags']['highway']]
            feats.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': c}, 'properties': {'k': 'r', 'r': r}})
    for key, k in (('coast', 'c'), ('border', 'b')):
        print(key + '…', file=sys.stderr)
        for el in overpass(QUERIES[key]):
            c = line(el, 60)
            if c:
                feats.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': c}, 'properties': {'k': k}})
    fc = {'type': 'FeatureCollection', 'built': time.strftime('%Y-%m-%d'), 'features': feats}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))
    print(len(feats), 'features', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'israel.json')
