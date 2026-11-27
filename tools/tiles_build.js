// חלוקה למשבצות: קורא את מה ש-tools/tiles_extract.py שלף מכל הארץ, ולכל משבצת יבשה (land.json) בונה את אותו GeoJSON
// שהאפליקציה הייתה מקבלת מ-Overpass – עם אותו קוד בדיוק (osm.js: convert + חיתוך לריבוע). כותב tiles/<i>_<j>.json
// ו-tiles/index.json: לכל משבצת [מתי השתנתה, גודל, hash] – מתי = מהאינדקס הקודם אם התוכן לא השתנה.
// שימוש: node tools/tiles_build.js all.jsonl <תיקיית יעד> [index.json קודם]
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const OSM = require('../osm.js');

const CELL = 0.1, PAD = 0.004;
const cellBox = (i, j) => [i * CELL, j * CELL, (i + 1) * CELL, (j + 1) * CELL].map((v) => +v.toFixed(4));
const bboxOf = (g) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of g) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
};
const hits = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
const geom = (g) => g.map(([lon, lat]) => ({ lat, lon }));

async function main() {
  const [src, outDir, prevPath] = process.argv.slice(2);
  const land = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'land.json'), 'utf8')).cells;
  const want = new Set(land.map(([i, j]) => i + '_' + j));
  // אינדקס לפי משבצת: כל אלמנט נרשם בכל המשבצות שהמלבן שלו (עם השוליים) נוגע בהן
  const grid = new Map();
  const put = (bb, item) => {
    for (let i = Math.floor((bb[0] - PAD) / CELL); i <= Math.floor((bb[2] + PAD) / CELL); i++)
      for (let j = Math.floor((bb[1] - PAD) / CELL); j <= Math.floor((bb[3] + PAD) / CELL); j++) {
        const k = i + '_' + j;
        if (!want.has(k)) continue;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(item);
      }
  };
  const rels = [], wayGeo = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(src), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line);
    n++;
    if (o.t === 'r') rels.push(o);
    else if (o.t === 'w' || o.t === 'm') {
      const bb = bboxOf(o.g);
      wayGeo.set(o.id, { g: o.g, bb });
      if (o.t === 'w') put(bb, { kind: 'w', o, bb });
    } else if (o.t === 'p' || o.t === 'n') put([o.c[0], o.c[1], o.c[0], o.c[1]], { kind: o.t, o, bb: [o.c[0], o.c[1], o.c[0], o.c[1]] });
  }
  for (const r of rels) {
    const ms = r.m.map((id) => ({ id, ...(wayGeo.get(id) || {}) })).filter((m) => m.g);
    if (!ms.length) continue;
    const item = { kind: 'r', o: r, ms };
    const seen = new Set();
    for (const m of ms) {
      for (let i = Math.floor((m.bb[0] - PAD) / CELL); i <= Math.floor((m.bb[2] + PAD) / CELL); i++)
        for (let j = Math.floor((m.bb[1] - PAD) / CELL); j <= Math.floor((m.bb[3] + PAD) / CELL); j++) {
          const k = i + '_' + j;
          if (!want.has(k) || seen.has(k)) continue;
          seen.add(k);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(item);
        }
    }
  }
  console.log('lines', n, 'relations', rels.length, 'cells', want.size);

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')).cells || {}; } catch { /* אין קודם */ }
  fs.mkdirSync(outDir, { recursive: true });
  const now = Date.now(), index = {};
  let total = 0;
  for (const [i, j] of land) {
    const k = i + '_' + j, box = cellBox(i, j);
    const pb = [box[0] - PAD, box[1] - PAD, box[2] + PAD, box[3] + PAD];
    const items = grid.get(k) || [];
    // באותו סדר כמו התשובה של Overpass: מסלולים, דרכים, נקודות, חניונים
    const els = [];
    for (const it of items) if (it.kind === 'r') {
      const members = it.ms.filter((m) => hits(m.bb, pb)).map((m) => ({ type: 'way', ref: m.id, role: '', geometry: geom(m.g) }));
      if (members.length) els.push({ type: 'relation', id: it.o.id, tags: it.o.tags, members });
    }
    for (const it of items) if (it.kind === 'w' && hits(it.bb, pb)) els.push({ type: 'way', id: it.o.id, tags: it.o.tags, geometry: geom(it.o.g) });
    for (const it of items) if (it.kind === 'n' && hits(it.bb, pb)) els.push({ type: 'node', id: it.o.id, lat: it.o.c[1], lon: it.o.c[0], tags: it.o.tags });
    for (const it of items) if (it.kind === 'p' && hits(it.bb, pb)) els.push({ type: 'way', id: it.o.id, tags: it.o.tags, center: { lat: it.o.c[1], lon: it.o.c[0] } });
    const fc = OSM.fromJson({ elements: els }, box);
    const txt = JSON.stringify(fc);
    fs.writeFileSync(path.join(outDir, k + '.json'), txt);
    const h = crypto.createHash('sha1').update(txt).digest('hex').slice(0, 12);
    const p = prev[k];
    index[k] = [p && p[2] === h ? p[0] : now, txt.length, h];
    total += txt.length;
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ v: 1, built: now, cells: index }));
  console.log('tiles', land.length, 'MB', (total / 1e6).toFixed(1));
}
main().catch((e) => { console.error(e); process.exit(1); });
