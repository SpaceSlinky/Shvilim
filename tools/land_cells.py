"""משבצות ההורדה (0.1°) שיש בהן יבשה בתוך ישראל ויהודה ושומרון – land.json.
המתאר: הגבול ה"מעשי" (k:'b' ב-israel.json – לבנון/סוריה/ירדן, ואז מצרים ועזה) + קו החוף של הים התיכון מצפון לעזה עד
ראש הנקרה + קטע ישר באילת. משבצת נשמרת אם אחת מ-7×7 נקודות דגימה בתוכה בתוך המתאר, או שהמתאר עצמו עובר בה. הגבולות לא משתנים – מריצים ידנית."""
import json, math, sys
d = json.load(open('israel.json', encoding='utf-8'))
B = [f['geometry']['coordinates'] for f in d['features'] if f['properties'].get('k') == 'b']
b1 = max(B, key=lambda c: c[0][1])          # ראש הנקרה → אילת
b2 = [c for c in B if c is not b1][0]         # טאבה → צפון עזה
RH, GZ = b1[0], b2[-1]
coast = []
for f in d['features']:
    if f['properties'].get('k') != 'c': continue
    for p in f['geometry']['coordinates']:
        if GZ[1] - 0.001 <= p[1] <= RH[1] + 0.001 and p[0] > 34.3: coast.append(p)
# החוף ממוין מדרום לצפון (בישראל החוף כמעט מונוטוני בקו הרוחב)
coast.sort(key=lambda p: p[1])
ring = b1 + b2 + coast + [RH]
def inside(x, y):
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1): c = not c
    return c
# גם רצועה דקה של יבשה (למשל חוף בקצה משבצת שרובה ים): אם קו המתאר – החוף או הגבול – עובר בתוך המשבצת, יש בה יבשה.
# (פעם רק 7×7 נקודות דגימה – רצועת חוף צרה נפלה ביניהן, ומשבצת כזו לא הייתה ניתנת להורדה)
def seg_hits(p, q, x0, y0, x1, y1):
    (ax, ay), (bx, by) = p, q
    t0, t1 = 0.0, 1.0  # Liang–Barsky: חיתוך קטע עם מלבן
    for pp, qq in ((-(bx - ax), ax - x0), (bx - ax, x1 - ax), (-(by - ay), ay - y0), (by - ay, y1 - ay)):
        if pp == 0:
            if qq < 0: return False
        else:
            r = qq / pp
            if pp < 0: t0 = max(t0, r)
            else: t1 = min(t1, r)
            if t0 > t1: return False
    return True
CELL = 0.1; N = 7
cells = []
for i in range(int(math.floor(33.9 / CELL)), int(math.ceil(36.2 / CELL))):
    for j in range(int(math.floor(29.3 / CELL)), int(math.ceil(33.5 / CELL))):
        x0, y0 = i * CELL, j * CELL
        if any(inside(x0 + (a + .5) / N * CELL, y0 + (b + .5) / N * CELL) for a in range(N) for b in range(N)) \
                or any(seg_hits(p, q, x0, y0, x0 + CELL, y0 + CELL) for p, q in zip(ring, ring[1:])):
            cells.append([i, j])
json.dump({'cell': CELL, 'cells': cells}, open('land.json', 'w'), separators=(',', ':'))
print(len(cells), 'cells')
if '--show' in sys.argv:
    S = {tuple(c) for c in cells}
    for j in range(335, 292, -1):
        print(''.join('#' if (i, j) in S else '.' for i in range(339, 362)))
