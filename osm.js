/* הורדת נתוני OpenStreetMap (Overpass API) והמרתם ל-GeoJSON קומפקטי – ישירות בדפדפן. */
(function (root) {
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
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

  function query([w, s, e, n]) {
    const b = `${s},${w},${n},${e}`;
    const hw = Object.keys(ROAD_CLASS).join('|');
    return `[out:json][timeout:300];
relation["route"~"^(hiking|foot)$"](${b});
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
out;`;
  }

  const nameOf = (t) => t['name:he'] || t.name || '';
  const r6 = (v) => Math.round(v * 1e6) / 1e6;

  function trailColor(t) {
    for (const src of [(t['osmc:symbol'] || '').split(':')[0], t.colour || '']) {
      const c = src.trim().toLowerCase();
      if (TRAIL_COLORS[c]) return TRAIL_COLORS[c];
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(c)) return c;
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
      if (el.type === 'relation') {
        const props = { k: 'trail', c: trailColor(t) };
        if (n) props.n = n;
        for (const m of el.members || []) if (m.type === 'way') lines(m.geometry).forEach((c) => add('LineString', c, props));
      } else if (el.type === 'way') {
        const props = t.waterway ? { k: 'water' } : { k: 'road', r: ROAD_CLASS[t.highway] || 'minor' };
        if (n) props.n = n;
        lines(el.geometry).forEach((c) => add('LineString', c, props));
      } else if (el.type === 'node') {
        const p = [r6(el.lon), r6(el.lat)];
        if (t.place) { if (n) add('Point', p, { k: 'place', t: t.place, n }); continue; }
        const kind = t.natural || t.tourism || t.historic || (t.amenity === 'drinking_water' ? 'water' : null);
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

  async function download(bbox, onProgress) {
    let last;
    for (const url of OVERPASS) {
      try {
        onProgress?.('מוריד נתונים מ-OpenStreetMap…');
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query(bbox) }) });
        if (!res.ok) throw new Error(`Overpass ${res.status}`);
        onProgress?.('מעבד…');
        const fc = convert(await res.json());
        fc.bbox = bbox;
        return fc;
      } catch (e) { last = e; }
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
