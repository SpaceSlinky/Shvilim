/* הורדת נתוני OpenStreetMap (Overpass API) והמרתם ל-GeoJSON קומפקטי – ישירות בדפדפן. */
(function (root) {
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'];
  const TRAIL_COLORS = {
    red: '#e0262b', blue: '#1f5bd8', green: '#16a03a', black: '#222222', orange: '#f57c00',
    purple: '#8e24aa', yellow: '#e8b800', brown: '#8d5524', white: '#ffffff', gray: '#808080', grey: '#808080',
  };
  const ROAD_CLASS = {
    motorway: 'major', motorway_link: 'major', trunk: 'major', trunk_link: 'major', primary: 'major', primary_link: 'major',
    secondary: 'medium', secondary_link: 'medium', tertiary: 'medium', tertiary_link: 'medium',
    unclassified: 'minor', residential: 'minor', living_street: 'minor', pedestrian: 'minor',
    track: 'track', path: 'path', footway: 'path', bridleway: 'path', steps: 'path', cycleway: 'path',
  };

  const big = ([w, s, e, n]) => (e - w) * (n - s) > 0.02; // למשל כל הכרמל
  // הגאומטריה נמשכת מעט מעבר לקצה האזור (PAD), ואז נחתכת בדיוק בקצה (clipToBox) – כך שבשולי ריבועים סמוכים
  // השבילים רציפים. בלי זה Overpass משמיט כל נקודה שמחוץ לאזור, ובין הריבועים נשאר חור בגודל הקטע שחוצה את הקצה
  const PAD = 0.004;
  function query([w, s, e, n]) {
    const b = `${s - PAD},${w - PAD},${n + PAD},${e + PAD}`;
    const hw = Object.keys(ROAD_CLASS).join('|');
    // אזור קטן – זמן קצוב צנוע: שרת עמוס דוחה מראש שאילתות שמבקשות הרבה זמן
    const t = big([w, s, e, n]) ? 300 : 90;
    return `[out:json][timeout:${t}];
relation["route"~"^(hiking|foot|mtb|bicycle)$"](${b});
out geom(${b});
(
  way["highway"~"^(${hw})$"](${b});
  way["waterway"~"^(river|stream|wadi)$"](${b});
);
out geom(${b});
(
  node["natural"~"^(peak|spring|cave_entrance)$"](${b});
  node["tourism"~"^(viewpoint|picnic_site|camp_site|attraction)$"](${b});
  node["amenity"="drinking_water"](${b});
  node["historic"~"^(ruins|archaeological_site)$"](${b});
  node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|locality)$"](${b});
);
out;
(
  node["amenity"="parking"](${b});
  way["amenity"="parking"](${b});
);
out center tags;`;
  }

  const nameOf = (t) => t['name:he'] || t.name || '';
  // התגים המקוריים של הסימון – מוצגים בהקשה על שביל
  const tagInfo = (t) => Object.fromEntries([['o', t['osmc:symbol']], ['cl', t.colour], ['ref', t.ref]].filter(([, v]) => v));
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  // תמונה של המקום עצמו, מהתגיות ב-OSM (רק כשמישהו קישר): image > wikimedia_commons > wikidata > wikipedia
  const photoRef = (t) => (t.image ? 'img:' + t.image : t.wikimedia_commons ? 'c:' + t.wikimedia_commons
    : t.wikidata ? 'wd:' + t.wikidata : t.wikipedia ? 'wp:' + t.wikipedia : '');

  function trailColor(t) {
    const osmc = (t['osmc:symbol'] || '').toLowerCase();
    for (const src of [osmc.split(':')[0], t.colour || '']) {
      const c = src.trim().toLowerCase();
      if (TRAIL_COLORS[c]) return TRAIL_COLORS[c];
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(c)) {
        const h = c.length === 4 ? c.replace(/[0-9a-f]/g, (x) => x + x) : c;
        const lum = parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
        return lum < 150 ? TRAIL_COLORS.black : h; // כמעט שחור → שחור (לטיפול אחיד במצב לילה)
      }
    }
    return '#7b5cb8';
  }

  // גאומטריה חתוכה לפי האזור מגיעה עם חורים (null) – מפצלים לקטעים
  function lines(geom) {
    const out = [];
    let cur = [];
    for (const p of geom || []) {
      if (p && p.lat != null) cur.push([r6(p.lon), r6(p.lat)]);
      else { if (cur.length > 1) out.push(cur); cur = []; }
    }
    if (cur.length > 1) out.push(cur);
    return out;
  }

  function convert(osm) {
    const feats = [];
    // דרכים ששייכות למסלול הליכה מסומן – אף פעם לא "לאופניים בלבד" (ב-OSM סימנו הרבה שבילים משותפים כ-bicycle=designated)
    const hikeWays = new Set();
    for (const el of osm.elements || []) if (el.type === 'relation' && /^(hiking|foot)$/.test(el.tags?.route || ''))
      for (const m of el.members || []) if (m.type === 'way') hikeWays.add(m.ref);
    const add = (type, coordinates, properties) => feats.push({ type: 'Feature', geometry: { type, coordinates }, properties });
    for (const el of osm.elements || []) {
      const t = el.tags || {};
      const n = nameOf(t);
      if (el.type === 'relation' && (t.route === 'mtb' || t.route === 'bicycle')) {
        const props = { k: 'bike' };
        if (n) props.n = n;
        for (const m of el.members || []) if (m.type === 'way') lines(m.geometry).forEach((c) => add('LineString', c, props));
      } else if (el.type === 'relation') {
        const props = { k: 'trail', c: trailColor(t), ...tagInfo(t) };
        if (n) props.n = n;
        for (const m of el.members || []) if (m.type === 'way') lines(m.geometry).forEach((c) => add('LineString', c, props));
      } else if (el.type === 'way' && el.center) {
        // חניון (שטח) – מוצג כנקודה במרכזו
        add('Point', [r6(el.center.lon), r6(el.center.lat)], { k: 'poi', t: 'parking', ...(n ? { n } : {}) });
      } else if (el.type === 'way') {
        const props = t.waterway ? { k: 'water' } : { k: 'road', r: ROAD_CLASS[t.highway] || 'minor', h: t.highway };
        if (t.waterway && n && photoRef(t)) props.ph = photoRef(t);
        if (!t.waterway) {
          if (t.foot === 'no' || t.access === 'no' || t.access === 'private') props.fn = 1;
          // שביל ייעודי לאופניים (סינגל) – בתכנון הליכה משתמשים בו רק אם ביקשו
          // (פעם גם mtb:scale לבד הספיק – אבל זה רק דרגת קושי לרוכבים, לא איסור להולכים)
          if (!hikeWays.has(el.id) && !['designated', 'yes', 'permissive'].includes(t.foot)
            && (t.highway === 'cycleway' || (t.highway === 'path' && t.bicycle === 'designated'))) props.b = 1;
        }
        if (n) props.n = n;
        const segs = lines(el.geometry);
        segs.forEach((c) => add('LineString', c, props));
        // שביל שהסימון שלו רשום על הדרך עצמה (ולא כמסלול) – מציירים גם כשביל מסומן
        // כמה צבעים על אותה דרך ("red;blue" – שבילים משותפים): קו לכל צבע (פעם – צבע לא מוכר, סגול)
        if (!t.waterway && (t['osmc:symbol'] || t.colour)) {
          const cols = String(t.colour || '').split(';').map((x) => x.trim()).filter(Boolean);
          for (const col of cols.length > 1 ? cols : [null]) {
            const tp = { k: 'trail', c: col ? trailColor({ colour: col }) : trailColor(t), ...tagInfo(t), w: 1 };
            if (n) tp.n = n;
            segs.forEach((c) => add('LineString', c, tp));
          }
        }
      } else if (el.type === 'node') {
        const p = [r6(el.lon), r6(el.lat)];
        if (t.place) { if (n) add('Point', p, { k: 'place', t: t.place, n }); continue; }
        const kind = t.natural || t.tourism || t.historic
          || (t.amenity === 'drinking_water' ? 'water' : t.amenity === 'parking' ? 'parking' : null);
        if (!kind) continue;
        const props = { k: 'poi', t: kind };
        if (n) props.n = n;
        if (photoRef(t)) props.ph = photoRef(t);
        const ele = parseFloat(String(t.ele || '').replace(',', '.'));
        if (kind === 'peak' && Number.isFinite(ele)) props.e = Math.round(ele);
        add('Point', p, props);
      }
    }
    // שבילים מסומנים אחרונים – מצוירים מעל הדרכים
    feats.sort((a, b) => (a.properties.k === 'trail') - (b.properties.k === 'trail'));
    return { type: 'FeatureCollection', features: feats };
  }

  /** טווחי הגליפים (גופן) שנדרשים כדי להציג את כל השמות במפה */
  function glyphRanges(fc) {
    const set = new Set([0, 1280, 8192, 9472]); // לטינית, עברית, פיסוק, ▲
    for (const f of fc.features) {
      for (const ch of (f.properties.n || '')) {
        const c = ch.codePointAt(0);
        if (c < 65536) set.add(Math.floor(c / 256) * 256);
      }
    }
    return [...set].sort((a, b) => a - b).map((s) => `${s}-${s + 255}`);
  }

  // ---------- חיתוך קווים למלבן (עם נקודות חיתוך מדויקות בקצה) ----------
  const eq2 = (u, v) => u[0] === v[0] && u[1] === v[1];
  function segParts(a, b, [w, s, e, n]) { // חלקי הקטע: בתוך / מחוץ למלבן (Liang–Barsky)
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let t0 = 0, t1 = 1;
    const P = [-dx, dx, -dy, dy], Q = [a[0] - w, e - a[0], a[1] - s, n - a[1]];
    for (let i = 0; i < 4; i++) {
      if (P[i] === 0) { if (Q[i] < 0) return [{ p: a, q: b, in: false }]; continue; }
      const r = Q[i] / P[i];
      if (P[i] < 0) { if (r > t1) return [{ p: a, q: b, in: false }]; if (r > t0) t0 = r; }
      else { if (r < t0) return [{ p: a, q: b, in: false }]; if (r < t1) t1 = r; }
    }
    if (t0 > t1) return [{ p: a, q: b, in: false }];
    const at = (t) => (t === 0 ? a : t === 1 ? b : [r6(a[0] + dx * t), r6(a[1] + dy * t)]);
    const m0 = at(t0), m1 = at(t1), out = [];
    if (t0 > 0) out.push({ p: a, q: m0, in: false });
    out.push({ p: m0, q: m1, in: true });
    if (t1 < 1) out.push({ p: m1, q: b, in: false });
    return out;
  }
  /** החלקים של קו שבתוך המלבן (wantIn) או מחוץ לו – רצפים רציפים */
  function clipLine(coords, box, wantIn) {
    const out = [];
    let cur = null;
    for (let i = 1; i < coords.length; i++) {
      for (const pt of segParts(coords[i - 1], coords[i], box)) {
        if (pt.in !== wantIn || eq2(pt.p, pt.q)) { if (pt.in !== wantIn) cur = null; continue; }
        if (cur && eq2(cur[cur.length - 1], pt.p)) cur.push(pt.q); else { cur = [pt.p, pt.q]; out.push(cur); }
      }
    }
    return out;
  }
  const inHalfOpen = ([w, s, e, n], c) => c[0] >= w && c[0] < e && c[1] >= s && c[1] < n; // נקודה שעל הקצה שייכת לריבוע אחד בלבד
  /** משאירים רק מה שבתוך האזור: קווים נחתכים בקצה, נקודות מחוץ לו נזרקות */
  function clipToBox(fc, box) {
    const feats = [];
    for (const f of fc.features) {
      if (f.geometry.type === 'Point') { if (inHalfOpen(box, f.geometry.coordinates)) feats.push(f); continue; }
      for (const c of clipLine(f.geometry.coordinates, box, true)) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: f.properties });
    }
    return { type: 'FeatureCollection', features: feats };
  }

  const why = (st) => (st === 429 || st === 503 || st === 504 ? `עמוס (${st})` : `שגיאה ${st}`);
  const short = (url) => new URL(url).hostname.replace(/^overpass[.-]/, '').replace(/\.(de|coffee|systems)$/, '');
  // fetch שנכשל ב-TypeError: רשת חסומה / אין חיבור – או ששרת עמוס החזיר שגיאה בלי כותרות CORS (הדפדפן לא מראה אותה).
  // בדיקה: בקשה בלי CORS (opaque) – אם השרת ענה, הוא חי ודחה אותנו; אם נכשלה – אין אליו דרך
  async function probe(url) {
    try { await fetch(url + '?data=' + encodeURIComponent('[out:json];out count;'), { mode: 'no-cors', signal: AbortSignal.timeout(8000) }); return 'דחה (עמוס?)'; }
    catch { return navigator.onLine ? 'לא נגיש' : 'אין רשת'; }
  }
  function fromJson(json, bbox) {
    if (json.type === 'FeatureCollection') return { ...json, bbox }; // משבצת מוכנה (tiles/) – כבר מומרת וחתוכה
    if (/error/i.test(json.remark || '')) throw new Error('השרת לא סיים');
    const fc = clipToBox(convert(json), bbox);
    fc.bbox = bbox;
    return fc;
  }
  // ---------- משבצות מוכנות מראש (נבנות פעם בשבועיים ב-GitHub Actions מקובץ של כל הארץ – pages.yml) ----------
  // קובץ סטטי לכל משבצת (tiles/<i>_<j>.json) – בערך שנייה, במקום דקה ויותר בשרתי Overpass העמוסים (ולפעמים כישלון).
  // index.json: לכל משבצת [מתי השתנתה, גודל, hash]. משבצת שאין לה קובץ (או בלי רשת לאינדקס) – Overpass כמו פעם
  const CELL = 0.1;
  const tileKey = (b) => (Math.abs(b[2] - b[0] - CELL) < 1e-6 && Math.abs(b[3] - b[1] - CELL) < 1e-6
    ? Math.round(b[0] / CELL) + '_' + Math.round(b[1] / CELL) : null);
  let tileIdx = null, tileIdxAt = 0;
  async function tileIndex() {
    if (tileIdx && Date.now() - tileIdxAt < 3600e3) return tileIdx;
    try {
      const res = await fetch('tiles/index.json', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (res.ok) { tileIdx = (await res.json()).cells || null; tileIdxAt = Date.now(); }
    } catch { /* בלי אינדקס – Overpass */ }
    return tileIdx;
  }
  const tileUrl = (b) => { const k = tileKey(b); return k && tileIdx?.[k] ? new URL(`tiles/${k}.json?h=${tileIdx[k][2]}`, root.location?.href).href : null; };
  async function fromTile(bbox, signal) {
    await tileIndex();
    const u = tileUrl(bbox);
    if (!u) return null;
    try {
      const res = await fetch(u, { signal });
      if (!res.ok) return null;
      return fromJson(await res.json(), bbox);
    } catch (e) { if (signal?.aborted) throw signal.reason; return null; }
  }

  // הורדה ברקע (Background Fetch – רק GET, בלי גוף): אותה שאילתה בכתובת, מהשרת הראשון
  // השרת שענה לאחרונה – ראשון בתור (גם להורדה ברקע, שיש לה שרת אחד בלבד). פעם תמיד overpass-api.de – כשהוא נפל,
  // ההורדה ברקע נתקעה
  const goodSrv = () => { const i = +(root.localStorage?.getItem('ovGood') || 0); return i >= 0 && i < OVERPASS.length ? i : 0; };
  const servers = () => { const g = goodSrv(); return [OVERPASS[g], ...OVERPASS.filter((_, i) => i !== g)]; };
  const bgUrl = (bbox, srv = goodSrv()) => tileUrl(bbox) || OVERPASS[srv] + '?data=' + encodeURIComponent(query(bbox));
  /** הורדה: מנסים שרת אחרי שרת (ועד שני סבבים כשהשרתים עמוסים). signal – ביטול מבחוץ (למשל כשהמשתמש מבקש אזור אחר) */
  async function download(bbox, onProgress, signal) {
    onProgress?.('מוריד…');
    const tile = await fromTile(bbox, signal);
    if (tile) return tile;
    let reasons = [];
    for (let pass = 0; pass < 2; pass++) {
      reasons = [];
      let busy = false;
      for (const url of servers()) {
        if (signal?.aborted) throw signal.reason;
        const ctl = new AbortController();
        const stop = () => ctl.abort();
        signal?.addEventListener('abort', stop);
        const timer = setTimeout(stop, big(bbox) ? 330000 : 120000); // שרת שלא עונה – עוברים לבא
        try {
          onProgress?.(pass ? 'מנסה שוב…' : 'מוריד נתונים מ-OpenStreetMap…');
          const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query(bbox) }), signal: ctl.signal });
          if (!res.ok) { busy = busy || [429, 503, 504].includes(res.status); throw new Error(why(res.status)); }
          onProgress?.('מעבד…');
          const json = await res.json();
          // שגיאה באמצע (זמן, זיכרון) מגיעה עם 200 ונתונים חלקיים – לא שומרים מפה חסרה
          if (/error/i.test(json.remark || '')) { busy = true; throw new Error('השרת לא סיים'); }
          try { root.localStorage?.setItem('ovGood', String(OVERPASS.indexOf(url))); } catch { /* ignore */ }
          return fromJson(json, bbox);
        } catch (e) {
          if (signal?.aborted) throw signal.reason;
          let r = e.name === 'AbortError' ? 'אין תשובה' : e.message;
          if (e.name === 'TypeError') { r = await probe(url); busy = busy || r.startsWith('דחה'); }
          if (e.name === 'AbortError') busy = true;
          reasons.push(`${short(url)}: ${r}`);
          console.warn('Overpass', url, e);
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
      }
      if (!busy || pass) break;
      await new Promise((r) => setTimeout(r, 5000)); // כולם עמוסים – ממתינים רגע וחוזרים על כל הסבב
    }
    throw new Error(reasons.join('\n'));
  }

  /** לכל משבצת ({b, t}) – האם ב-OSM יש דרכים/שבילים מסומנים שנוספו או השתנו מאז t. שאילתה אחת (out count לכל משבצת);
   *  null – אין תשובה מאף שרת */
  async function changedSince(cells) {
    // משבצות מוכנות: לפי האינדקס (מתי התוכן השתנה) – בלי לשאול את Overpass
    const idx = await tileIndex();
    if (idx && cells.every((c) => idx[tileKey(c.b)])) return cells.map((c) => idx[tileKey(c.b)][0] > c.t);
    const q = '[out:json][timeout:25];' + cells.map(({ b: [w, s, e, n], t }) => {
      const bb = `${s},${w},${n},${e}`, iso = new Date(t).toISOString().slice(0, 19) + 'Z';
      return `(way["highway"](newer:"${iso}")(${bb});relation["route"~"^(hiking|foot|mtb|bicycle)$"](newer:"${iso}")(${bb}););out count;`;
    }).join('');
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(30000) });
        if (!res.ok) continue;
        const counts = ((await res.json()).elements || []).filter((x) => x.type === 'count');
        if (counts.length !== cells.length) continue;
        return counts.map((c) => +(c.tags?.total || 0) > 0);
      } catch { /* השרת הבא */ }
    }
    return null;
  }

  /** מיזוג הורדה חדשה לתוך המפה הקיימת: מה שבתוך האזור החדש מוחלף, השאר נשמר */
  function merge(old, fresh) {
    const box = fresh.bbox, [w, s, e, n] = box;
    const feats = [];
    for (const f of old.features) {
      if (f.geometry.type === 'Point') { if (!inHalfOpen(box, f.geometry.coordinates)) feats.push(f); continue; }
      const cs = f.geometry.coordinates;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of cs) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
      if (x1 < w || x0 > e || y1 < s || y0 > n) { feats.push(f); continue; } // לא נוגע באזור החדש
      // נוגע: משאירים רק את החלקים שמחוץ לאזור החדש (בתוכו – ההורדה החדשה), חתוכים בדיוק בקצה
      for (const c of clipLine(cs, box, false)) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: c }, properties: f.properties });
    }
    feats.push(...fresh.features);
    feats.sort((a, b) => (a.properties.k === 'trail') - (b.properties.k === 'trail'));
    const ob = old.bbox || fresh.bbox;
    return { type: 'FeatureCollection', features: feats,
      bbox: [Math.min(ob[0], w), Math.min(ob[1], s), Math.max(ob[2], e), Math.max(ob[3], n)] };
  }

  /** צבע קרוב לאחד מצבעי הסימון (למשל #ff0000 ו"אדום") – אותו צבע. אחרת – כמו שהוא */
  function canonColor(c) {
    if (!c || Object.values(TRAIL_COLORS).includes(c)) return c;
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) return c;
    const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [r, g, b] = rgb(m[1]);
    let best = c, bd = 180; // מרחק מקסימלי (RGB)
    for (const v of new Set(Object.values(TRAIL_COLORS))) {
      const [r2, g2, b2] = rgb(v.slice(1));
      const d = Math.hypot(r - r2, g - g2, b - b2);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  const OSM = { query, convert, fromJson, bgUrl, tileIndex, goodSrv, glyphRanges, download, trailColor, merge, canonColor, changedSince };
  if (typeof module !== 'undefined' && module.exports) module.exports = OSM;
  root.OSM = OSM;
})(typeof self !== 'undefined' ? self : globalThis);
