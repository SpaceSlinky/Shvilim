"""שליפת כל מה שהמפה המפורטת צריכה מקובץ ה-pbf של Geofabrik – קובץ JSON-lines אחד לכל הארץ.
אותם אלמנטים כמו בשאילתת Overpass ב-osm.js (query): מסלולים מסומנים (relations), דרכים ונחלים, נקודות, חניונים.
tools/tiles_build.js מחלק אותם למשבצות וממיר עם אותו קוד של האפליקציה (osm.js).
שורות: r – מסלול (relation) עם רשימת הדרכים; w – דרך/נחל עם גאומטריה; m – גאומטריה של דרך שהיא רק חלק ממסלול;
p – חניון (שטח) במרכזו; n – נקודה.  שימוש: python3 tools/tiles_extract.py il.osm.pbf out.jsonl"""
import json
import sys

import osmium

ROADS = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
         'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'pedestrian', 'track', 'path',
         'footway', 'bridleway', 'steps', 'cycleway'}
WATER = {'river', 'stream', 'wadi'}
ROUTES = {'hiking', 'foot', 'mtb', 'bicycle'}
NODE_TAGS = {'natural': {'peak', 'spring', 'cave_entrance'}, 'tourism': {'viewpoint', 'picnic_site', 'camp_site', 'attraction'},
             'amenity': {'drinking_water', 'parking'}, 'historic': {'ruins', 'archaeological_site'},
             'place': {'city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'locality'}}
KEEP = {'name', 'name:he', 'highway', 'waterway', 'foot', 'access', 'bicycle', 'osmc:symbol', 'colour', 'ref', 'image',
        'wikimedia_commons', 'wikidata', 'wikipedia', 'natural', 'tourism', 'amenity', 'historic', 'place', 'ele', 'route'}


def tags(o):
    return {t.k: t.v for t in o.tags if t.k in KEEP}


class Rels(osmium.SimpleHandler):
    def __init__(self, out):
        super().__init__()
        self.out, self.members = out, set()

    def relation(self, r):
        if r.tags.get('route') not in ROUTES:
            return
        ways = [m.ref for m in r.members if m.type == 'w']
        self.members.update(ways)
        self.out.write(json.dumps({'t': 'r', 'id': r.id, 'tags': tags(r), 'm': ways}, ensure_ascii=False) + '\n')


class Rest(osmium.SimpleHandler):
    def __init__(self, out, members):
        super().__init__()
        self.out, self.members = out, members

    def put(self, d):
        self.out.write(json.dumps(d, ensure_ascii=False, separators=(',', ':')) + '\n')

    def way(self, w):
        hw, ww, park = w.tags.get('highway'), w.tags.get('waterway'), w.tags.get('amenity') == 'parking'
        main = hw in ROADS or ww in WATER
        if not (main or park or w.id in self.members):
            return
        g = []
        for n in w.nodes:
            if n.location.valid():
                g.append([round(n.location.lon, 6), round(n.location.lat, 6)])
        if len(g) < 1:
            return
        if main:
            self.put({'t': 'w', 'id': w.id, 'tags': tags(w), 'g': g})
        elif w.id in self.members:
            self.put({'t': 'm', 'id': w.id, 'g': g})
        if park:  # כמו out center ב-Overpass: מרכז המלבן החוסם
            xs, ys = [p[0] for p in g], [p[1] for p in g]
            self.put({'t': 'p', 'id': w.id, 'tags': tags(w), 'c': [round((min(xs) + max(xs)) / 2, 6), round((min(ys) + max(ys)) / 2, 6)]})

    def node(self, n):
        if not any(n.tags.get(k) in v for k, v in NODE_TAGS.items()):
            return
        self.put({'t': 'n', 'id': n.id, 'tags': tags(n), 'c': [round(n.location.lon, 6), round(n.location.lat, 6)]})


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with open(dst, 'w', encoding='utf-8') as out:
        rels = Rels(out)
        rels.apply_file(src)
        Rest(out, rels.members).apply_file(src, locations=True, idx='flex_mem')
    print('OK', dst)


if __name__ == '__main__':
    main()
