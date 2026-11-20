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
  function query([w, s, e, n]) {
    const b = `${s},${w},${n},${e}`;
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
        if (!t.waterway) {
          if (t.foot === 'no' || t.access === 'no' || t.access === 'private') props.fn = 1;
          // שביל ייעודי לאופניים (סינגל) – בתכנון הליכה משתמשים בו רק אם ביקשו
          if (t.highway === 'cycleway' || (t.highway === 'path' && (t.bicycle === 'designated' || t['mtb:scale'])
            && !['designated', 'yes'].includes(t.foot))) props.b = 1;
        }
        if (n) props.n = n;
        const segs = lines(el.geometry);
        segs.forEach((c) => add('LineString', c, props));
        // שביל שהסימון שלו רשום על הדרך עצמה (ולא כמסלול) – מציירים גם כשביל מסומן
        if (!t.waterway && (t['osmc:symbol'] || t.colour)) {
          const tp = { k: 'trail', c: trailColor(t), ...tagInfo(t), w: 1 };
          if (n) tp.n = n;
          segs.forEach((c) => add('LineString', c, tp));
        }
      } else if (el.type === 'node') {
        const p = [r6(el.lon), r6(el.lat)];
        if (t.place) { if (n) add('Point', p, { k: 'place', t: t.place, n }); continue; }
        const kind = t.natural || t.tourism || t.historic
          || (t.amenity === 'drinking_water' ? 'water' : t.amenity === 'parking' ? 'parking' : null);
        if (!kind) continue;
        const props = { k: 'poi', t: kind };
        if (n) props.n = n;
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

  const why = (st) => (st === 429 || st === 503 || st === 504 ? `השרת עמוס (${st})` : `שגיאת שרת ${st}`);
  /** הורדה: מנסים שרת אחרי שרת. signal – ביטול מבחוץ (למשל כשהמשתמש מבקש אזור אחר) */
  async function download(bbox, onProgress, signal) {
    let last;
    for (const url of OVERPASS) {
      if (signal?.aborted) throw signal.reason;
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      signal?.addEventListener('abort', stop);
      const timer = setTimeout(stop, big(bbox) ? 330000 : 120000); // שרת שלא עונה – עוברים לבא
      try {
        onProgress?.('מוריד נתונים מ-OpenStreetMap…');
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query(bbox) }), signal: ctl.signal });
        if (!res.ok) throw new Error(why(res.status));
        onProgress?.('מעבד…');
        const json = await res.json();
        // שגיאה באמצע (זמן, זיכרון) מגיעה עם 200 ונתונים חלקיים – לא שומרים מפה חסרה
        if (/error/i.test(json.remark || '')) throw new Error('השרת לא סיים');
        const fc = convert(json);
        fc.bbox = bbox;
        return fc;
      } catch (e) {
        if (signal?.aborted) throw signal.reason;
        last = e.name === 'AbortError' ? new Error('אין תשובה מהשרת') : e.name === 'TypeError' ? new Error('אין חיבור לשרת') : e;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
    }
    throw last;
  }

  /** מיזוג הורדה חדשה לתוך המפה הקיימת: מה שבתוך האזור החדש מוחלף, השאר נשמר */
  function merge(old, fresh) {
    const [w, s, e, n] = fresh.bbox;
    const inside = (c) => c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n;
    const touches = (f) => (f.geometry.type === 'Point' ? inside(f.geometry.coordinates) : f.geometry.coordinates.some(inside));
    const feats = old.features.filter((f) => !touches(f)).concat(fresh.features);
    feats.sort((a, b) => (a.properties.k === 'trail') - (b.properties.k === 'trail'));
    const ob = old.bbox || fresh.bbox;
    return { type: 'FeatureCollection', features: feats,
      bbox: [Math.min(ob[0], w), Math.min(ob[1], s), Math.max(ob[2], e), Math.max(ob[3], n)] };
  }

  const OSM = { query, convert, glyphRanges, download, trailColor, merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = OSM;
  root.OSM = OSM;
})(typeof self !== 'undefined' ? self : globalThis);
