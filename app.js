/* שבילים – ניווט אופליין במסלולי הליכה (מפה וקטורית מ-OpenStreetMap). */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DEFAULT_VIEW = { center: [35.03, 32.75], zoom: 13.5 }; // שוויצריה הקטנה
  const CARMEL = [34.94, 32.60, 35.13, 32.84]; // הכרמל, כולל שוויצריה הקטנה (מערב, דרום, מזרח, צפון)
  const FONT = ['Noto Sans Regular'];
  const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
  const RTL_PLUGIN = 'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js';

  if ('serviceWorker' in navigator) {
    // עדכון אוטומטי: כשגרסה חדשה של האפליקציה מותקנת ברקע – טוענים אותה מחדש
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => hadController && location.reload());
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(console.error);
  }
  if (typeof maplibregl === 'undefined') {
    document.body.insertAdjacentHTML('beforeend', '<p style="padding:20px">יש לפתוח את האפליקציה פעם אחת עם חיבור לאינטרנט.</p>');
    return;
  }

  // ---------- אחסון מקומי (IndexedDB) – לשמירת המסלול האחרון ----------
  const db = (() => {
    let p;
    const open = () => (p ||= new Promise((res, rej) => {
      const r = indexedDB.open('hike', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction('kv', mode);
        const req = fn(t.objectStore('kv'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
      del: (k) => tx('readwrite', (s) => s.delete(k)),
    };
  })();

  let toastTimer;
  function toast(msg, ms = 3500) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  // ---------- סגנון המפה ----------
  const k = (v) => ['==', ['get', 'k'], v];
  const road = (r) => ['all', k('road'), ['==', ['get', 'r'], r]];
  const zw = (a, b) => ['interpolate', ['exponential', 1.5], ['zoom'], 11, a, 16, b];
  // כמו zw, אבל הערך בכל זום מחושב לפי המאפיינים של הקו (fn מקבל את הרוחב הבסיסי)
  const zwShared = (a, b, fn) => ['interpolate', ['exponential', 1.5], ['zoom'], 11, fn(a), 16, fn(b)];
  const SN = ['coalesce', ['get', 'sn'], 1], SI = ['coalesce', ['get', 'si'], 0], SHARED_W = 0.85, SHARED_STEP = 1.35; // רוחב כל קו, והמרחק בין קווים (פס לבן ביניהם)
  // ההזזה הצידה של קו בקטע משותף – זהה לשבילים במפה ולמסלול שעליהם
  const SHARED_OFFSET = zwShared(1.5, 4.5, (w) => ['*', w * SHARED_STEP, ['-', SI, ['/', ['-', SN, 1], 2]]]);
  // אותה הזזה לחצים (icon-offset: [0, y] בכיוון הקו – y חיובי = ימינה מכיוון התנועה, כמו line-offset)
  const SHARED_ICON_OFFSET = zwShared(1.5, 4.5, (w) => ['interpolate', ['linear'], ['-', SI, ['/', ['-', SN, 1], 2]],
    -1, ['literal', [0, -w * SHARED_STEP]], 1, ['literal', [0, w * SHARED_STEP]]]);
  const halo = { 'text-halo-color': '#fff', 'text-halo-width': 1.6 };
  const empty = { type: 'FeatureCollection', features: [] };

  const style = {
    version: 8,
    transition: { duration: 0, delay: 0 }, // החלפת בהיר/כהה ושינויי צבע – מיד
    glyphs: GLYPHS,
    sources: {
      osm: { type: 'geojson', data: empty, attribution: '© OpenStreetMap', tolerance: 0.3 },
      route: { type: 'geojson', data: empty },
      dim: { type: 'geojson', data: { type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } },
      wpts: { type: 'geojson', data: empty },
      acc: { type: 'geojson', data: empty },
      // רקעים אונליין (דורשים אינטרנט)
      // תצלום אוויר: ב-19 יש אזורים (גם בכרמל) שבהם Esri מחזיר תמונת "Map data not yet available" – עוצרים ב-18,
      // ומעבר לזה המפה מגדילה את הרמה האחרונה (מפוקסל, אבל אמיתי)
      sat: { type: 'raster', tileSize: 256, maxzoom: 18, attribution: 'Imagery © Esri',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
      topo: { type: 'raster', tileSize: 256, maxzoom: 17, attribution: '© OpenTopoMap (CC-BY-SA)',
        tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png'] },
      ihm: { type: 'raster', tileSize: 256, maxzoom: 16, attribution: '© Israel Hiking Map',
        tiles: ['https://israelhiking.osm.org.il/Hebrew/Tiles/{z}/{x}/{y}.png'] },
      scrub: { type: 'geojson', data: empty },
      detour: { type: 'geojson', data: empty },
      walked: { type: 'geojson', data: empty },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e6e1d1' } },
      ...['sat', 'topo', 'ihm'].map((id) => ({ id: 'base-' + id, type: 'raster', source: id,
        layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 150 } })),
      { id: 'water', type: 'line', source: 'osm', filter: k('water'),
        paint: { 'line-color': '#5aa9e6', 'line-width': zw(0.35, 1.3), 'line-opacity': 0.85 } },
      // דרכים
      { id: 'major-casing', type: 'line', source: 'osm', filter: road('major'), layout: { 'line-join': 'round' },
        paint: { 'line-color': '#b8742a', 'line-width': zw(2, 9) } },
      { id: 'medium-casing', type: 'line', source: 'osm', filter: road('medium'), layout: { 'line-join': 'round' },
        paint: { 'line-color': '#c4a03a', 'line-width': zw(1.5, 7) } },
      { id: 'minor-casing', type: 'line', source: 'osm', filter: road('minor'), minzoom: 12, layout: { 'line-join': 'round' },
        paint: { 'line-color': '#b5b5b5', 'line-width': zw(1, 5.5) } },
      { id: 'minor', type: 'line', source: 'osm', filter: road('minor'), minzoom: 12, layout: { 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': zw(0.5, 4) } },
      { id: 'medium', type: 'line', source: 'osm', filter: road('medium'), layout: { 'line-join': 'round' },
        paint: { 'line-color': '#ffe38f', 'line-width': zw(0.8, 5.5) } },
      { id: 'major', type: 'line', source: 'osm', filter: road('major'), layout: { 'line-join': 'round' },
        paint: { 'line-color': '#f7a656', 'line-width': zw(1.2, 7) } },
      { id: 'track', type: 'line', source: 'osm', filter: road('track'), minzoom: 11,
        paint: { 'line-color': '#8b6b3e', 'line-width': zw(0.8, 2.4), 'line-dasharray': [3, 1.5] } },
      { id: 'path', type: 'line', source: 'osm', filter: road('path'), minzoom: 12,
        paint: { 'line-color': '#4a3d30', 'line-width': zw(0.6, 1.8), 'line-dasharray': [2, 1.5] } },
      // שבילי אופניים (מסלולי MTB)
      { id: 'bike', type: 'line', source: 'osm', filter: k('bike'), minzoom: 11, layout: { 'line-join': 'round', visibility: 'none' },
        paint: { 'line-color': '#ff6d00', 'line-width': zw(1, 3), 'line-dasharray': [2, 1.2], 'line-opacity': 0.9 } },
      // שבילים מסומנים
      // קטע משותף לכמה שבילים (sn = כמה, si = מספר הקו): קווים צמודים זה לזה, כמו הסימון על הסלעים
      { id: 'trail-casing', type: 'line', source: 'osm', filter: k('trail'), layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['case', ['==', ['get', 'c'], '#ffffff'], '#3a3a3a', '#ffffff'],
          // לכל קו מסגרת משלו (במקום מסגרת רחבה אחת) – כך גם שביל לבן נראה, עם המסגרת הכהה שלו
          'line-opacity': 0.85, 'line-width': zwShared(2.8, 7.5, (w) => ['*', w, ['case', ['>', SN, 1], SHARED_W, 1]]),
          'line-offset': SHARED_OFFSET } },
      { id: 'trail', type: 'line', source: 'osm', filter: k('trail'), layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'c'], 'line-width': zwShared(1.5, 4.5, (w) => ['*', w, ['case', ['>', SN, 1], SHARED_W, 1]]),
          'line-offset': SHARED_OFFSET } },
      // תוויות
      { id: 'water-label', type: 'symbol', source: 'osm', filter: ['all', k('water'), ['has', 'n']], minzoom: 13,
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 12, 'symbol-spacing': 300 },
        paint: { 'text-color': '#2a74b5', ...halo } },
      { id: 'road-label', type: 'symbol', source: 'osm', filter: ['all', k('road'), ['has', 'n']], minzoom: 14,
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 12, 'symbol-spacing': 350 },
        paint: { 'text-color': '#555', ...halo } },
      { id: 'trail-label', type: 'symbol', source: 'osm', filter: ['all', k('trail'), ['has', 'n']], minzoom: 13,
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 13,
          'symbol-spacing': 400, 'text-offset': [0, -1.1] },
        paint: { 'text-color': '#222', ...halo } },
      { id: 'poi-icon', type: 'symbol', source: 'osm', filter: ['all', k('poi'), ['!=', ['get', 't'], 'peak']], minzoom: 12.5,
        layout: { 'icon-image': ['concat', 'poi-', ['get', 't']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 12.5, 0.5, 16, 0.85],
          'icon-padding': 1, 'icon-allow-overlap': ['step', ['zoom'], false, 15.5, true] } },
      { id: 'poi-label', type: 'symbol', source: 'osm', filter: ['all', k('poi'), ['has', 'n'], ['!=', ['get', 't'], 'peak']], minzoom: 14,
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 1.3],
          'text-max-width': 8, 'text-optional': true },
        paint: { 'text-color': '#333', ...halo } },
      { id: 'peak', type: 'symbol', source: 'osm', filter: ['all', k('poi'), ['==', ['get', 't'], 'peak']], minzoom: 12,
        layout: { 'text-field': ['concat', '▲', ['case', ['has', 'n'], ['concat', '\n', ['get', 'n']], ''],
          ['case', ['has', 'e'], ['concat', '\n', ['to-string', ['get', 'e']]], '']],
          'text-font': FONT, 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, -0.6], 'text-max-width': 8 },
        paint: { 'text-color': '#6d4c2f', ...halo } },
      { id: 'place-minor', type: 'symbol', source: 'osm', minzoom: 13,
        filter: ['all', k('place'), ['!', ['in', ['get', 't'], ['literal', ['city', 'town', 'village']]]]],
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-max-width': 8, 'text-size': 13 },
        paint: { 'text-color': '#444', 'text-halo-color': '#fff', 'text-halo-width': 2 } },
      { id: 'place-major', type: 'symbol', source: 'osm', minzoom: 9,
        filter: ['all', k('place'), ['in', ['get', 't'], ['literal', ['city', 'town', 'village']]]],
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-max-width': 8,
          'text-size': ['match', ['get', 't'], ['city', 'town'], 17, 15] },
        paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 2 } },
      // מסלול פעיל: המפה מתחתיו דוהה, והמסלול מצויר בצבעי השבילים עם מסגרת לבנה (בלי קו מתאר כהה)
      { id: 'dim', type: 'fill', source: 'dim', layout: { visibility: 'none' }, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.55 } },
      { id: 'route-casing', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': zw(4, 8.5), 'line-offset': SHARED_OFFSET } },
      { id: 'route-line', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['coalesce', ['get', 'c'], '#d4148f'], 'line-width': zw(2.4, 5), 'line-offset': SHARED_OFFSET,
          'line-dasharray': ['case', ['==', ['get', 'h'], 'free'], ['literal', [1, 1]], ['literal', [1, 0]]] } },
      // מה שכבר הלכת: קו בצבע הרקע מעל המסלול, כך שהחלק הזה נראה דהוי
      { id: 'route-walked', type: 'line', source: 'walked', layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.65, 'line-width': zw(4, 8.5), 'line-offset': SHARED_OFFSET } },
      // חצי הכיוון – באותה הזזה הצידה כמו הקו (בקטע משותף), כדי לשבת עליו
      { id: 'route-arrows', type: 'symbol', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'arrow',
          'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map', 'icon-offset': SHARED_ICON_OFFSET } },
      // נקודות המסלול
      { id: 'route-ends', type: 'circle', source: 'route', filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 7, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#fff',
          'circle-color': ['match', ['get', 'kind'], 'start', '#1a9b3c', '#c62828'] } },
      { id: 'wpts', type: 'circle', source: 'wpts',
        paint: { 'circle-radius': 6, 'circle-color': '#f39c12', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } },
      // תוספת למסלול (לפני האישור): מה שמדלגים עליו – אפור; הקטע החדש – מקווקו; והנקודה
      { id: 'detour-skip', type: 'line', source: 'detour', filter: ['==', ['get', 'k'], 'skip'],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#9e9e9e', 'line-width': 9, 'line-opacity': 0.75 } },
      { id: 'detour-line', type: 'line', source: 'detour', filter: ['==', ['get', 'k'], 'new'],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d81b60', 'line-width': 5, 'line-dasharray': [1.6, 1.2] } },
      { id: 'detour-pt', type: 'circle', source: 'detour', filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 8, 'circle-color': '#d81b60', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } },
      // האצבע על הגרף: הקטע על המסלול והנקודה (כתום ביום, אפור בהיר בלילה)
      // האצבע על הגרף: הקטע עד האצבע מעומעם (כמו מה שכבר הלכת), והנקודה – קו קצרצר עגול, כדי לזוז הצידה יחד עם המסלול
      { id: 'scrub-line', type: 'line', source: 'scrub', filter: ['==', ['get', 'k'], 'dim'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.65, 'line-width': zw(4, 8.5), 'line-offset': SHARED_OFFSET } },
      { id: 'scrub-dot-casing', type: 'line', source: 'scrub', filter: ['==', ['get', 'k'], 'dot'], layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 18, 'line-offset': SHARED_OFFSET } },
      { id: 'scrub-dot', type: 'line', source: 'scrub', filter: ['==', ['get', 'k'], 'dot'], layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#3c4247', 'line-width': 12, 'line-offset': SHARED_OFFSET } },
      { id: 'acc', type: 'fill', source: 'acc',
        paint: { 'fill-color': '#1e88e5', 'fill-opacity': 0.12, 'fill-outline-color': '#1e88e5' } },
    ],
  };

  // ---------- מפה ----------
  // תוסף ה-RTL נטען מה-thread הראשי (דרך המטמון האופליין) ומועבר ל-MapLibre כ-blob,
  // כדי לא להסתמך על כך שה-Web Workers של MapLibre עוברים דרך ה-Service Worker.
  fetch(RTL_PLUGIN)
    .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
    .then((b) => maplibregl.setRTLTextPlugin(URL.createObjectURL(b), false))
    .catch((e) => console.error('RTL plugin', e));

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('view')); } catch { /* ignore */ }

  const map = new maplibregl.Map({
    container: 'map',
    style,
    center: saved?.center || DEFAULT_VIEW.center,
    zoom: saved?.zoom || DEFAULT_VIEW.zoom,
    minZoom: 9,
    maxZoom: 19,
    dragRotate: true,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: false, // הקרדיטים – בחלון השכבות
  });
  map.touchPitch?.disable?.();
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 100 }), 'bottom-left');
  map.on('moveend', () => {
    try {
      const c = map.getCenter();
      localStorage.setItem('view', JSON.stringify({ center: [c.lng, c.lat], zoom: map.getZoom() }));
    } catch { /* ignore */ }
  });
  map.on('styleimagemissing', (e) => {
    if (map.hasImage(e.id)) return;
    if (e.id === 'arrow') map.addImage('arrow', arrowImage(), { pixelRatio: 2 });
    else if (e.id.startsWith('poi-')) map.addImage(e.id, poiIcon(e.id.slice(4)), { pixelRatio: 2 });
  });
  const POI_ICON = { spring: ['💧', '#1e88e5'], water: ['🚰', '#1e88e5'], viewpoint: ['🔭', '#e53935'], picnic_site: ['🧺', '#43a047'],
    camp_site: ['⛺', '#43a047'], parking: ['P', '#3949ab'], ruins: ['🏛️', '#795548'], archaeological_site: ['🏺', '#795548'],
    cave_entrance: ['🕳️', '#424242'], attraction: ['⭐', '#f9a825'] };
  function poiIcon(t) {
    const [ch, col] = POI_ICON[t] || ['•', '#43a047'];
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(S / 2, S / 2, 27, 0, 2 * Math.PI);
    g.fillStyle = ch === 'P' ? col : '#ffffff'; g.fill();
    g.lineWidth = 5; g.strokeStyle = ch === 'P' ? '#ffffff' : col; g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (ch === 'P') { g.fillStyle = '#fff'; g.font = 'bold 36px "Noto Sans Hebrew", sans-serif'; g.fillText('P', S / 2, S / 2 + 2); }
    else { g.font = '32px "Noto Sans Hebrew", sans-serif'; g.fillText(ch, S / 2, S / 2 + 2); }
    return g.getImageData(0, 0, S, S);
  }
  map.on('error', (e) => console.warn(e.error || e));
  const mapReady = new Promise((r) => map.on('load', r));

  // ---------- נתוני המפה: הורדה חד-פעמית ושמירה בטלפון ----------
  // הורדה אחת בכל פעם. עדכון שקט ברקע מפנה את הדרך כשהמשתמש מבקש משהו
  let dlJob = null; // { quiet, ctl, done }
  let dlErr = ''; // ההורדה האחרונה של אזור נכשלה – הסיבה מוצגת על הכפתור
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  // quiet: עדכון ברקע בלי הודעות; area: אזור חדש – ההתקדמות על הכפתור במרכז המסך
  async function downloadArea(bbox, { quiet = false, area = false } = {}) {
    if (dlJob) {
      if (quiet || !dlJob.quiet) return;
      dlJob.ctl.abort(new DOMException('הופסק', 'AbortError'));
      await dlJob.done;
    }
    if (!navigator.onLine) return quiet || area ? undefined : toast('אין חיבור לאינטרנט');
    const ctl = new AbortController();
    const job = { quiet, ctl };
    job.done = runDownload(bbox, { quiet, area, signal: ctl.signal }).finally(() => { if (dlJob === job) dlJob = null; });
    dlJob = job;
    return job.done;
  }
  async function runDownload(bbox, { quiet, area, signal }) {
    $('nodata').hidden = true;
    const say = (m, ms) => { if (area) { dlMsg = m; checkArea(); } else if (!quiet) toast(m, ms); };
    if (area) { dlErr = ''; say('מוריד את מפות האזור…'); }
    try {
      const fresh = await OSM.download(bbox, (m) => say(m, 120000), signal);
      // אזור בלי שבילים ודרכים – לא שגיאה, פשוט אין מה להציג
      if (!fresh.features.length && !area) throw new Error('לא נמצאו נתונים באזור');
      const old = await db.get('mapdata').catch(() => null);
      const fc = old ? OSM.merge(old, fresh) : fresh;
      await db.set('mapdata', fc);
      await mapReady;
      setMapData(fc);
      say('שומר גופנים…', 60000);
      // טעינה מוקדמת של הגופנים שהשמות דורשים – ה-Service Worker שומר אותם לאופליין
      await withTimeout(Promise.all(OSM.glyphRanges(fc).map((r) =>
        fetch(GLYPHS.replace('{fontstack}', encodeURIComponent(FONT[0])).replace('{range}', r)).catch(() => null))), 30000);
      say('שומר נתוני גובה…', 60000);
      await withTimeout(Elev.prefetch(bbox).catch(() => 0), 60000);
      if (navigator.storage?.persist) navigator.storage.persist();
      const trails = fc.features.filter((f) => f.properties.k === 'trail').length;
      markArea(bbox);
      if (area) toast(fresh.features.length ? 'מפות האזור נשמרו – אפשר להשתמש בהן בלי אינטרנט ✓' : 'אין שבילים או דרכים באזור הזה', 3000);
      else say(`המפה נשמרה בטלפון ✓ (${trails} קטעי שבילים מסומנים)`, 5000);
    } catch (e) {
      // עדכון שקט שנכשל או שפינה את הדרך – ינסה שוב מחר, לא בכל פתיחה
      if (quiet) markArea(bbox, Date.now() - REFRESH_MS + 864e5);
      if (signal.aborted) return; // פינה את הדרך להורדה שהמשתמש ביקש
      console.error(e);
      const msg = e.message || String(e);
      if (area) dlErr = msg;
      else if (!quiet) toast('ההורדה נכשלה: ' + msg + '. נסו שוב.', 6000);
      if (!(await db.get('mapdata').catch(() => null))) $('nodata').hidden = false;
    } finally {
      if (area) { dlMsg = ''; checkArea(); }
    }
  }

  function downloadBbox(bbox) {
    bbox = bbox.map((v) => +v.toFixed(4));
    if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > 0.12) return toast('האזור גדול מדי – התקרבו (זום) ונסו שוב', 5000);
    downloadArea(bbox);
  }
  function downloadVisible() {
    const b = map.getBounds();
    downloadBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  }

  let mapFC = null;
  let searchIndex = null;
  // הגרסה המוחלקת מחושבת פעם אחת ונשמרת, כדי שהפתיחה תהיה מהירה
  // העיגול מחושב בזיכרון בכל פתיחה ולא נשמר – כך הוא לא תופס נפח בטלפון.
  let smoothCache = null;
  let smoother = null;
  db.del('mapsmooth').catch(() => {}); // ניקוי העותק השמור מגרסאות קודמות
  // שבילים מסומנים שעוברים על אותה דרך (אותה גאומטריה): לכל צבע מספר קו (si) ומספר הקווים (sn)
  // מחזיר את הגאומטריות שעליהן עובר שביל מסומן (כדי לעגל גם את הדרך שמתחת – אחרת היא מבצבצת לצדו)
  function markShared(fc) {
    const groups = new Map();
    for (const f of fc.features) {
      if (f.properties.k !== 'trail') continue;
      delete f.properties.si; delete f.properties.sn;
      f.properties.c = OSM.canonColor(f.properties.c); // גוני אדום שונים לאותו שביל – צבע אחד (לא שני קווים)
      const key = JSON.stringify(f.geometry.coordinates);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(f);
    }
    for (const g of groups.values()) {
      const colors = [...new Set(g.map((f) => f.properties.c))].sort();
      if (colors.length < 2) continue;
      for (const f of g) { f.properties.sn = Math.min(colors.length, 3); f.properties.si = Math.min(colors.indexOf(f.properties.c), 2); }
    }
    return groups;
  }
  async function setMapData(fc) {
    const trailGeoms = markShared(fc);
    buildSharedIdx(fc);
    pieceCache = null; // הקטעים המשותפים השתנו
    mapFC = fc;
    searchIndex = null;
    const lvl = smoothLevel();
    smoother = lvl ? Geo.makeSmoother(fc, lvl) : null;
    if (!lvl) return map.getSource('osm').setData(fc);
    // פעם אחת בלבד (לא קודם המקורי ואז המעוגל – זה כפל עבודה למפה). מעגלים רק שבילים, דרכי עפר ונחלים
    if (smoothCache?.src !== fc) smoothCache = { src: fc, fc: Geo.smoothFC(fc, lvl, (f) => f.properties.k !== 'road' || f.properties.r === 'path' || f.properties.r === 'track'
      || trailGeoms.has(JSON.stringify(f.geometry.coordinates))) };
    if (mapFC === fc && smoothLevel()) map.getSource('osm').setData(smoothCache.fc);
    // המסלול המוצג: מתקנים קטעים שלא עוגלו, ומזיזים עם הקווים המשותפים
    if (active && !plan) { fixActiveSegs(); map.getSource('route')?.setData(routeFeatures(active.segs)); }
  }
  // ---------- המפה השמורה מתעדכנת לבד ----------
  // אזורים שהורדו (localStorage `dlAreas`: [{b, t}]). פעם בשבועיים – עדכון שקט ברקע;
  // אזור חדש שמגיעים אליו (בזום קרוב, עם אינטרנט) – מורד לבד. בלי חיבור / חיסכון בנתונים – לא מורידים.
  const REFRESH_MS = 14 * 864e5;
  const dlAreas = () => { try { return JSON.parse(localStorage.getItem('dlAreas')) || []; } catch { return []; } };
  function markArea(b, t = Date.now()) {
    const list = dlAreas().filter((a) => a.b.join() !== b.join());
    list.push({ b, t });
    try { localStorage.setItem('dlAreas', JSON.stringify(list)); } catch { /* ignore */ }
  }
  const netOk = () => navigator.onLine && !navigator.connection?.saveData;
  Promise.all([db.get('mapdata').catch(() => null), mapReady]).then(([fc]) => {
    if (fc) {
      setMapData(fc);
      // מפה מגרסה ישנה (בלי תאריך) – נחשבת עדכנית; העדכון הבא בעוד שבועיים
      const list = localStorage.getItem('dlAreas') == null ? [{ b: CARMEL, t: 0 }] : dlAreas();
      if (list.some((a) => !a.t)) try { localStorage.setItem('dlAreas', JSON.stringify(list.map((a) => ({ ...a, t: a.t || Date.now() })))); } catch { /* ignore */ }
      // עדכון שקט של האזור הישן ביותר
      const old = dlAreas().sort((a, b) => a.t - b.t)[0];
      if (old && Date.now() - old.t > REFRESH_MS && netOk()) setTimeout(() => downloadArea(old.b, { quiet: true }), 8000);
      // נתוני הגובה של כל האזורים השמורים – משלימים ברקע מה שחסר (מה שכבר במטמון חוזר מיד, בלי רשת)
      if (netOk()) setTimeout(() => Promise.all(dlAreas().map((ar) => Elev.prefetch(ar.b).catch(() => 0)))
        .then(() => { if (active && prof === false) loadProfile(); }), 12000);
    } else if (navigator.onLine) downloadArea(CARMEL); // פעם ראשונה – מורידים לבד
    else $('nodata').hidden = false;
  });
  // ---------- מפות שמורות: רשימה ומחיקה (בחלון השכבות, תחת "עוד") ----------
  const inBox = (b) => (c) => c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3];
  const touchesBox = (f, test) => (f.geometry.type === 'Point' ? test(f.geometry.coordinates) : f.geometry.coordinates.some(test));
  const PLACE_RANK = { city: 0, town: 1, village: 2, suburb: 3, hamlet: 4, neighbourhood: 5, locality: 6 };
  function areaName(b) {
    if (b.join() === CARMEL.join()) return 'הכרמל';
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, inside = inBox(b);
    let best = null, bestScore = Infinity;
    for (const f of mapFC?.features || []) {
      if (f.properties.k !== 'place' || !inside(f.geometry.coordinates)) continue;
      const [x, y] = f.geometry.coordinates;
      const score = (PLACE_RANK[f.properties.t] ?? 7) * 10 + Math.hypot(x - cx, y - cy) / (b[2] - b[0]);
      if (score < bestScore) { bestScore = score; best = f.properties.n; }
    }
    return best || 'אזור ללא שם';
  }
  const fmtSize = (n) => '\u2066' + (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB') + '\u2069'; // בידוד: "KB 1" → "1 KB"
  function renderAreas() {
    const box = $('areas-list');
    box.textContent = '';
    const list = dlAreas().sort((a, b) => b.t - a.t);
    for (const a of list) {
      const test = inBox(a.b);
      let size = 0;
      for (const f of mapFC?.features || []) if (touchesBox(f, test)) size += JSON.stringify(f).length;
      const name = areaName(a.b);
      const row = document.createElement('div');
      row.className = 'area-row';
      const go = document.createElement('button');
      go.className = 'a-name';
      go.textContent = name;
      const sm = document.createElement('small');
      sm.textContent = `${fmtSize(size)} · ${a.t ? 'עודכן ' + new Date(a.t).toLocaleDateString('he-IL') : ''}`;
      go.append(sm);
      go.addEventListener('click', () => {
        $('layers-dlg').close();
        map.fitBounds([[a.b[0], a.b[1]], [a.b[2], a.b[3]]], { padding: 20, duration: 600 });
      });
      const del = document.createElement('button');
      del.className = 'a-del';
      del.textContent = 'מחיקה';
      del.addEventListener('click', async () => {
        if (!(await confirmDlg(`למחוק את המפה של ${name}?`, 'המפה של האזור תימחק מהטלפון. המסלולים השמורים נשארים. אפשר להוריד אותה שוב כשיש אינטרנט.'))) return;
        await deleteArea(a.b);
      });
      row.append(go, del);
      box.append(row);
    }
  }
  // מוחקים את מה שבתוך האזור – חוץ ממה שנוגע באזור שמור אחר
  async function deleteArea(b) {
    if (dlJob?.quiet) { dlJob.ctl.abort(new DOMException('הופסק', 'AbortError')); await dlJob.done; }
    const rest = dlAreas().filter((a) => a.b.join() !== b.join());
    const del = inBox(b), keep = rest.map((a) => inBox(a.b));
    const fc = mapFC || (await db.get('mapdata').catch(() => null)) || { type: 'FeatureCollection', features: [] };
    const features = fc.features.filter((f) => !touchesBox(f, del) || keep.some((t) => touchesBox(f, t)));
    const bbox = rest.length ? rest.reduce((u, { b: x }) => [Math.min(u[0], x[0]), Math.min(u[1], x[1]), Math.max(u[2], x[2]), Math.max(u[3], x[3])], rest[0].b) : undefined;
    const nfc = { type: 'FeatureCollection', features, ...(bbox ? { bbox } : {}) };
    await db.set('mapdata', nfc); // נשאר גם כשריק – כדי שהכרמל לא יורד שוב לבד
    try { localStorage.setItem('dlAreas', JSON.stringify(rest)); } catch { /* ignore */ }
    // גם נתוני הגובה של האזור (מה שלא משותף לאזור אחר)
    const keepUrls = new Set(rest.flatMap((a) => Elev.tileUrls(a.b)));
    const drop = Elev.tileUrls(b).filter((u) => !keepUrls.has(u));
    if (self.caches) for (const k of await caches.keys()) { const c = await caches.open(k); await Promise.all(drop.map((u) => c.delete(u))); }
    await setMapData(nfc);
    renderAreas();
    checkArea();
  }
  $('layers-dlg').querySelector('.more-layers').addEventListener('toggle', (e) => { if (e.target.open) renderAreas(); });

  // אזור בלי מפה שמורה (למשל אחרי חיפוש): במרכז המסך – "להורדת מפות האזור" (לחיץ)
  const dlHere = $('dl-here');
  let dlMsg = '';
  function viewBox() {
    const v = map.getBounds(), pad = 0.01; // קצת מעבר למסך
    return [v.getWest() - pad, v.getSouth() - pad, v.getEast() + pad, v.getNorth() + pad].map((x) => +x.toFixed(4));
  }
  function checkArea() {
    if (!mapFC && !dlJob) return (dlHere.hidden = true); // עוד אין מפה בכלל – המסך הראשון מטפל בזה
    const c = map.getCenter();
    const inside = dlAreas().some(({ b }) => c.lng >= b[0] && c.lng <= b[2] && c.lat >= b[1] && c.lat <= b[3]);
    if (inside && !dlMsg) return (dlHere.hidden = true);
    dlHere.hidden = false;
    const b = viewBox();
    const big = (b[2] - b[0]) * (b[3] - b[1]) > 0.12;
    dlHere.disabled = !!dlMsg || !navigator.onLine || big;
    dlHere.textContent = dlMsg || (!navigator.onLine ? 'אין מפה שמורה לאזור הזה · צריך אינטרנט כדי להוריד'
      : big ? 'התקרבו כדי להוריד את מפות האזור'
      : dlErr ? `ההורדה נכשלה: ${dlErr}\n⬇ לנסות שוב` : '⬇ להורדת מפות האזור');
  }
  dlHere.addEventListener('click', () => {
    if (dlHere.disabled) return;
    downloadArea(viewBox(), { area: true });
  });
  map.on('moveend', checkArea);
  addEventListener('online', checkArea);
  addEventListener('offline', checkArea);
  mapReady.then(() => !map.hasImage('arrow') && map.addImage('arrow', arrowImage(), { pixelRatio: 2 }));

  function arrowImage() {
    const s = 32, c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.lineCap = g.lineJoin = 'round';
    const chevron = () => { g.beginPath(); g.moveTo(11, 8); g.lineTo(22, 16); g.lineTo(11, 24); g.stroke(); };
    g.strokeStyle = '#fff'; g.lineWidth = 7; chevron();
    g.strokeStyle = '#222'; g.lineWidth = 3.5; chevron();
    return g.getImageData(0, 0, s, s);
  }

  let longPressAt = 0; // אחרי לחיצה ארוכה (תוספת למסלול) – לא פותחים מידע על מה שמתחת
  map.on('click', 'wpts', (e) => {
    if (Date.now() - longPressAt < 800) return;
    const f = e.features[0];
    if (!f.properties.name) return;
    const el = document.createElement('div');
    el.textContent = f.properties.name;
    new maplibregl.Popup({ closeButton: false }).setLngLat(f.geometry.coordinates).setDOMContent(el).addTo(map);
  });

  // ---------- הקשה על המפה: מה רשום ב-OpenStreetMap ----------
  const HW = { path: 'שביל', footway: 'שביל הליכה', track: 'דרך עפר', steps: 'מדרגות', bridleway: 'שביל רכיבה', cycleway: 'שביל אופניים',
    residential: 'רחוב', unclassified: 'דרך', tertiary: 'כביש', secondary: 'כביש', primary: 'כביש ראשי' };
  const INFO_LAYERS = ['trail', 'bike', 'path', 'track', 'minor', 'medium', 'major', 'water', 'poi-icon', 'peak'];
  map.on('click', (e) => {
    if (plan || Date.now() - longPressAt < 800) return;
    const { x, y } = e.point;
    const feats = map.queryRenderedFeatures([[x - 10, y - 10], [x + 10, y + 10]], { layers: INFO_LAYERS.filter((l) => map.getLayer(l)) });
    if (!feats.length) return;
    // שבילים מסומנים – ריבוע בצבע השביל, הכי שמאלי בשורה (אחרי שם הדרך וסוגה) (ולא שורה "שביל מסומן ירוק")
    const trails = feats.filter((f) => f.properties.k === 'trail');
    const colors = [...new Set(trails.map((f) => f.properties.c))];
    const trailName = trails.map((f) => f.properties.n).find(Boolean) || '';
    const squares = colors.map((c) => `<span class="sq" style="background:${esc(c)}"></span>`).join('');
    const seen = new Set();
    const rows = [];
    let gotSquares = false;
    for (const f of feats) {
      const p = f.properties;
      if (p.k === 'trail') continue;
      const id = p.k + p.n + p.h + p.t;
      if (seen.has(id)) continue;
      seen.add(id);
      let line = '';
      if (p.k === 'road') line = HW[p.h] || 'דרך';
      else if (p.k === 'water') line = 'נחל';
      else if (p.k === 'bike') line = 'מסלול אופניים';
      else if (p.k === 'poi') line = KIND[p.t === 'water' ? 'water_poi' : p.t] || p.t;
      const withSq = p.k === 'road' && !gotSquares && colors.length;
      if (withSq) gotSquares = true;
      const name = p.n || (withSq ? trailName : '');
      rows.push(`<div class="info-row">${name ? `<b>${esc(name)}</b> ` : ''}${line}${withSq ? squares : ''}</div>`);
      if (rows.length >= 4) break;
    }
    // שביל מסומן בלי דרך מתחתיו
    if (colors.length && !gotSquares) rows.unshift(`<div class="info-row">${trailName ? `<b>${esc(trailName)}</b> ` : ''}שביל${squares}</div>`);
    if (!rows.length) return;
    new maplibregl.Popup({ closeButton: false, maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(rows.join('')).addTo(map);
  });
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------- מסלול פעיל (GPX או מסלול מתוכנן) ----------
  let route = null;      // לחישובי מיקום (Geo.buildRoute)
  let active = null;     // { kind:'gpx'|'plan', segs:[{coords,c,h}], waypoints, name, text?, wps?, opts? }
  let prevAlong = null;
  let prof = null;       // פרופיל גובה

  // קטעים משותפים במפה מוזזים הצידה (קו לכל צבע); המסלול זז בדיוק כמו הקו בצבע שלו, כדי לשבת עליו.
  // sharedIdx: הקטעים (זוגות נקודות) של שבילים מסומנים משותפים, עם הצבע והמיקום (si/sn)
  let sharedIdx = [];
  function buildSharedIdx(fc) {
    sharedIdx = [];
    for (const f of fc.features) {
      const p = f.properties;
      if (p.k !== 'trail' || !(p.sn > 1)) continue;
      const c = f.geometry.coordinates;
      for (let i = 1; i < c.length; i++) sharedIdx.push({ c: p.c, si: p.si, sn: p.sn, a: c[i - 1], b: c[i] });
    }
  }
  // dir – כיוון ההליכה בקטע. line-offset נמדד ימינה מכיוון הקו: מסלול שהולך הפוך לכיוון השביל צריך את הצד ההפוך
  function sharedOffset(color, m, dir) {
    if (!sharedIdx.length || !color) return null;
    const kx = Math.cos((m[1] * Math.PI) / 180) * 111320, ky = 110540;
    let best = null, bd = 7; // מטרים
    for (const e of sharedIdx) {
      if (e.c !== color) continue;
      const ax = (e.a[0] - m[0]) * kx, ay = (e.a[1] - m[1]) * ky, bx = (e.b[0] - m[0]) * kx, by = (e.b[1] - m[1]) * ky;
      if (Math.min(ax, bx) > bd || Math.max(ax, bx) < -bd || Math.min(ay, by) > bd || Math.max(ay, by) < -bd) continue;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) return null;
    const same = (best.b[0] - best.a[0]) * dir[0] * kx * kx + (best.b[1] - best.a[1]) * dir[1] * ky * ky >= 0;
    return { si: same ? best.si : best.sn - 1 - best.si, sn: best.sn };
  }
  // מחלק כל קטע של המסלול לפי המקום שלו בקטע משותף (או בלי)
  function splitShared(sg) {
    const col = OSM.canonColor(sg.c);
    const props = { ...(col ? { c: col } : {}), ...(sg.h ? { h: sg.h } : {}) };
    if (!sharedIdx.length || !col || sg.h === 'free') return [{ coords: sg.coords, props }];
    const out = [];
    let cur = null;
    const c = sg.coords;
    for (let i = 1; i < c.length; i++) {
      const o = sharedOffset(col, [(c[i - 1][0] + c[i][0]) / 2, (c[i - 1][1] + c[i][1]) / 2], [c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]]);
      const key = o ? o.si + '/' + o.sn : '';
      if (cur && cur.key === key) cur.coords.push(c[i]);
      else { cur = { key, coords: [c[i - 1], c[i]], props: o ? { ...props, ...o } : props }; out.push(cur); }
    }
    return out;
  }
  function routeFeatures(segs, wpts) {
    const f = routePieces(segs).map((x) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: x.coords }, properties: x.props }));
    const all = segs.flatMap((sg) => sg.coords);
    if (all.length > 1) {
      f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: all[all.length - 1] }, properties: { kind: 'end' } });
      f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: all[0] }, properties: { kind: 'start' } });
    }
    return { type: 'FeatureCollection', features: f };
  }

  // מקטעים רצופים → קווים (קטעים שמתחברים מאוחדים לקו אחד לצורך חישוב מרחקים)
  function segsToLines(segs) {
    const lines = [];
    for (const sg of segs) {
      const last = lines[lines.length - 1];
      const a = sg.coords[0];
      if (last && Geo.haversine(last[last.length - 1], a) < 1) last.push(...sg.coords.slice(1));
      else lines.push([...sg.coords]);
    }
    return lines;
  }

  // מסלולים שנשמרו בזמן באג (v55–v65): כל קטע בין שתי נקודות נשמר לבד, ולכן לא עוגל – פינות חדות
  // שלא יושבות על השביל המעוגל. מחברים רצף של קטעים כאלה (אותו צבע, צמודים) ומעגלים מחדש.
  function repairSegs(segs) {
    if (!smoother) return segs;
    const out = [];
    let run = null, changed = false;
    const same = (p, q) => p[0] === q[0] && p[1] === q[1];
    const flush = () => {
      if (!run) return;
      if (run.n > 1) { out.push({ ...run.sg, coords: smoother(run.coords) }); changed = true; } else out.push(run.sg);
      run = null;
    };
    for (const sg of segs) {
      const two = sg.coords.length === 2 && sg.h !== 'free';
      if (two && run && run.sg.c === sg.c && run.sg.h === sg.h && same(run.coords[run.coords.length - 1], sg.coords[0])) {
        run.coords.push(sg.coords[1]); run.n++; continue;
      }
      flush();
      if (two) run = { sg, coords: [...sg.coords], n: 1 }; else out.push(sg);
    }
    flush();
    return changed ? out : segs;
  }
  function fixActiveSegs() {
    if (!active) return false;
    const fixed = repairSegs(active.segs);
    if (fixed === active.segs) return false;
    active.segs = fixed;
    route = Geo.buildRoute(segsToLines(fixed));
    db.set('active', active).catch(() => {});
    if (active.libId && !active.edits?.length) libPut(active).catch(() => {}); // גם בספרייה
    return true;
  }
  async function setActive(a, { fit = false, save = true } = {}) {
    await mapReady;
    active = a;
    a.segs = repairSegs(a.segs);
    const lines = segsToLines(a.segs);
    route = Geo.buildRoute(lines);
    prevAlong = null;
    map.getSource('route').setData(routeFeatures(a.segs));
    map.getSource('wpts').setData({ type: 'FeatureCollection',
      features: (a.waypoints || []).map((w) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: w.coord }, properties: { name: w.name } })) });
    walkedAt = -1;
    applyLayers();
    renderDock();
    if (fit) fitRoute();
    // כל מסלול נשמר בספרייה (מסלולים ישנים שלא נשמרו – נשמרים עכשיו)
    if (!a.libId) { a.libId = Date.now(); a.folder ||= ''; libPut(a); }
    if (save) db.set('active', a).catch(console.error);
    map.getSource('walked')?.setData(empty);
    if (a.nav) { startGps(); setFollow(true); }
    updateStatus();
    prof = null;
    clearScrub();
    loadProfile();
  }
  // prof: null – מחשב; false – נכשל (אין נתוני גובה); אחרת – הפרופיל. כשנכשל – מנסים שוב כשהאינטרנט חוזר
  function loadProfile() {
    const a = active;
    if (!a || !route) return;
    Elev.profile(route.pts, 15, route.breaks).then((p) => {
      if (active !== a) return;
      prof = p || false; updateStatus(); renderRouteInfo();
      if (p) { a.gain = Math.round(p.gain); a.loss = Math.round(p.loss); if (a.libId && !a.edits?.length) libUpdateStats(a.libId, p); }
    });
  }
  addEventListener('online', () => { if (active && prof === false) { Elev.lastError = ''; loadProfile(); } });

  function fitRoute(anim = {}) {
    const src = plan?.wps.length > 1 ? plan : active; // בתכנון – המסלול שמתכננים
    if (!src) return;
    const all = (src.segs || []).flatMap((sg) => sg.coords).concat((src.waypoints || []).map((w) => w.coord));
    if (all.length) map.fitBounds(Geo.bounds(all), { padding: { top: 40, bottom: $('dock').offsetHeight + 30, left: 40, right: 76 }, maxZoom: 16, ...anim });
  }

  async function showGpx(text, fit, save = true) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const g = Geo.parseGpx(doc);
    await setActive({ kind: 'gpx', name: g.name, text, waypoints: g.waypoints,
      segs: g.lines.map((l) => ({ coords: l, c: null })) }, { fit, save });
    return g;
  }


  async function clearRoute() {
    route = active = prof = null;
    await mapReady;
    map.getSource('route').setData(empty);
    map.getSource('wpts').setData(empty);
    setWalked(null);
    clearScrub();
    applyLayers();
    renderDock();
    await db.del('active');
    await db.del('gpx');
  }

  // ---------- נתוני מסלול: אורך, עלייה/ירידה, זמן וגרף גובה ----------
  const fmtTime = (min) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h}:${String(m).padStart(2, '0')} ש'` : `${m} דק'`; };
  const estTime = (lenM, gain, bike) => (bike ? (lenM / 1000) * 5 + (gain / 100) * 6 : (lenM / 1000) * 15 + (gain / 100) * 10);

  function profileStats(p, from = 0, to = Infinity) {
    if (!p) return null;
    let gain = 0, loss = 0, ref = null;
    for (let i = 0; i < p.dist.length; i++) {
      if (p.dist[i] < from) continue;
      if (p.dist[i] > to) break;
      const v = p.ele[i];
      if (ref == null) { ref = v; continue; }
      if (v - ref >= 2) { gain += v - ref; ref = v; } else if (ref - v >= 2) { loss += ref - v; ref = v; }
    }
    return { gain, loss };
  }

  // חיפוש בינארי במערך מרחקים מצטבר: האינדקס האחרון ש-arr[i] <= d
  function idxAt(arr, d) {
    let lo = 0, hi = arr.length - 1;
    if (d <= arr[0]) return 0;
    if (d >= arr[hi]) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= d) lo = m; else hi = m; }
    return lo;
  }
  function eleAt(p, d) {
    const i = idxAt(p.dist, d), j = Math.min(i + 1, p.dist.length - 1);
    const t = j > i ? (d - p.dist[i]) / ((p.dist[j] - p.dist[i]) || 1) : 0;
    return p.ele[i] + (p.ele[j] - p.ele[i]) * Math.max(0, Math.min(1, t));
  }
  function pointAt(r, d) {
    const i = idxAt(r.cum, d), j = Math.min(i + 1, r.pts.length - 1);
    if (j === i || r.breaks.has(j)) return r.pts[i];
    const t = Math.max(0, Math.min(1, (d - r.cum[i]) / ((r.cum[j] - r.cum[i]) || 1)));
    const a = r.pts[i], b = r.pts[j];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // הגרף נקי: בלי צירים. רק הקו, המיקום שלך והאצבע (המספרים עצמם בשורה שמעל)
  const PPAD = { l: 6, r: 6, t: 18, b: 4 };
  // marks.at – ההתקדמות (מה שעברת דהוי); marks.touch – האצבע (הקטע עד אליה בכתום, והגובה בנקודה)
  function drawProfile(canvas, p, marks = {}) {
    const dpr = devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    const night = document.body.classList.contains('night');
    if (!p) {
      g.fillStyle = night ? '#999' : '#888'; g.font = '13px "Noto Sans Hebrew", sans-serif'; g.textAlign = 'center';
      g.fillText(canvas.id === 'ri-profile' && prof === null && active ? 'מחשב גובה…' : 'אין נתוני גובה' + (Elev.lastError ? ` (${Elev.lastError})` : ' (נדרש אינטרנט פעם אחת)'), W / 2, H / 2);
      return;
    }
    const pad = PPAD;
    const lo = p.min - 3, hi = p.max + 3;
    const clampD = (d) => Math.max(0, Math.min(d, p.total));
    const X = (d) => pad.l + (clampD(d) / (p.total || 1)) * (W - pad.l - pad.r);
    const Y = (e) => pad.t + (1 - (e - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
    const area = () => {
      g.beginPath(); g.moveTo(X(0), H);
      p.dist.forEach((d, i) => g.lineTo(X(d), Y(p.ele[i])));
      g.lineTo(X(p.total), H); g.closePath();
    };
    const line = () => { g.beginPath(); p.dist.forEach((d, i) => (i ? g.lineTo : g.moveTo).call(g, X(d), Y(p.ele[i]))); };
    const band = (x0, x1, fn) => { g.save(); g.beginPath(); g.rect(x0, 0, x1 - x0, H); g.clip(); fn(); g.restore(); };
    const xAt = marks.at != null ? X(marks.at) : X(0);
    g.lineWidth = 2;
    // מה שנשאר: ירוק
    band(xAt, W, () => {
      area(); g.fillStyle = night ? 'rgba(76,175,80,.35)' : 'rgba(46,125,79,.22)'; g.fill();
      line(); g.strokeStyle = night ? '#81c784' : '#2e7d4f'; g.stroke();
    });
    // מה שעברת: דהוי
    if (marks.at != null) band(0, xAt, () => {
      area(); g.fillStyle = night ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'; g.fill();
      line(); g.strokeStyle = night ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.25)'; g.stroke();
    });
    // הקטע המסומן (עד האצבע / בין שתי אצבעות): צבע מלא – אפור בהיר בכהה, אפור כהה בבהיר
    const hot = night ? '#d5d9dc' : '#59626a';
    const base = marks.from != null ? marks.from : marks.at != null && marks.touch != null && marks.at <= marks.touch ? marks.at : 0;
    if (marks.touch != null) band(X(base), X(marks.touch), () => { area(); g.fillStyle = hot; g.fill(); });
    const dot = (d, color) => {
      g.fillStyle = color; g.strokeStyle = night ? '#1d2227' : '#fff'; g.lineWidth = 2;
      g.beginPath(); g.arc(X(d), Y(eleAt(p, clampD(d))), 5, 0, 7); g.fill(); g.stroke();
    };
    if (marks.at != null) dot(marks.at, '#1e88e5');
    if (marks.touch != null) {
      const ends = marks.from != null ? [marks.from, marks.touch] : [marks.touch];
      for (const d of ends) {
        const x = X(d);
        g.strokeStyle = hot; g.lineWidth = 1.5; g.setLineDash([4, 3]);
        g.beginPath(); g.moveTo(x, pad.t - 2); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
        dot(d, hot);
      }
      g.font = 'bold 12px "Noto Sans Hebrew", sans-serif'; g.fillStyle = hot;
      if (marks.from != null) {
        // שתי אצבעות: הפרש הגובה, באמצע
        const dh = Math.round(eleAt(p, clampD(marks.touch)) - eleAt(p, clampD(marks.from)));
        g.textAlign = 'center';
        g.fillText(signed(dh), (X(marks.from) + X(marks.touch)) / 2, 12);
      } else {
        // הגובה בנקודה, מעל האצבע
        const x = X(marks.touch);
        g.textAlign = x < 30 ? 'left' : x > W - 30 ? 'right' : 'center';
        g.fillText(Math.round(eleAt(p, clampD(marks.touch))) + " מ'", x, 12);
      }
    }
  }

  // נגיעה בגרף: גרירת האצבע בוחרת נקודה לאורך המסלול; שתי אצבעות – טווח (onPick(a, b)); בעזיבה – onEnd
  function attachScrub(canvas, getProfile, onPick, onEnd) {
    canvas.style.touchAction = 'none';
    const fingers = new Map();
    const emit = () => {
      const v = [...fingers.values()];
      if (v.length >= 2) onPick(Math.min(v[0], v[1]), Math.max(v[0], v[1]));
      else if (v.length) onPick(v[0]);
    };
    const toD = (e) => {
      const p = getProfile();
      if (!p) return null;
      const r = canvas.getBoundingClientRect();
      const f = (e.clientX - r.left - PPAD.l) / (r.width - PPAD.l - PPAD.r);
      return Math.max(0, Math.min(1, f)) * p.total;
    };
    canvas.addEventListener('pointerdown', (e) => {
      const d = toD(e);
      if (d == null) return;
      fingers.set(e.pointerId, d);
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      emit();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!fingers.has(e.pointerId)) return;
      const d = toD(e);
      if (d != null) { fingers.set(e.pointerId, d); emit(); }
    });
    for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, (e) => {
      if (!fingers.delete(e.pointerId)) return;
      if (fingers.size) emit(); else onEnd?.();
    });
  }

  // מה יש בין נקודה אחת לשנייה לאורך המסלול
  function legInfo(p, from, to, bike) {
    const st = profileStats(p, from, to);
    const len = to - from;
    return { len, ele: eleAt(p, to), gain: st.gain, loss: st.loss, time: estTime(len, st.gain, bike) };
  }

  let scrub = null; // האצבע על הגרף של המסלול הפעיל: { b } – נקודה, { a, b } – שתי אצבעות (מרחקים בגרף)
  // על המפה: הקטע a→b של המסלול והנקודה (או שתי הנקודות)
  // שכבה מעל קטע של המסלול (from→to, מרחקים על המסלול), מחולקת כמו המסלול עצמו – כדי לזוז הצידה יחד איתו בקטעים משותפים
  // החלוקה של המסלול (כולל ההזזה בקטעים משותפים) מחושבת פעם אחת לכל מסלול ונשמרת עם מרחקים מצטברים –
  // בזמן גרירה על הגרף רק חותכים ממנה את הקטע (בלי לחפש שוב קטעים משותפים בכל תזוזה)
  let pieceCache = null;
  function routePieces(segs) {
    if (pieceCache?.segs === segs) return pieceCache.pieces;
    const pieces = [];
    let acc = 0;
    for (const sg of segs) for (const x of splitShared(sg)) {
      const cum = [acc];
      for (let j = 1; j < x.coords.length; j++) cum.push((acc += Geo.haversine(x.coords[j - 1], x.coords[j])));
      pieces.push({ coords: x.coords, props: x.props, cum });
    }
    pieceCache = { segs, pieces };
    return pieces;
  }
  function overlayFeatures(segs, from, to, k) {
    const out = [];
    for (const pc of routePieces(segs)) {
      const { coords: c, cum } = pc;
      if (cum[cum.length - 1] <= from || cum[0] >= to) continue;
      const at = (j, x) => { const d = cum[j] - cum[j - 1], t = d ? (x - cum[j - 1]) / d : 0; return [c[j - 1][0] + (c[j][0] - c[j - 1][0]) * t, c[j - 1][1] + (c[j][1] - c[j - 1][1]) * t]; };
      const line = [];
      for (let j = 1; j < c.length; j++) {
        if (cum[j] <= from || cum[j - 1] >= to) continue;
        if (!line.length) line.push(cum[j - 1] >= from ? c[j - 1] : at(j, from));
        line.push(cum[j] <= to ? c[j] : at(j, to));
      }
      if (line.length > 1) out.push({ type: 'Feature', properties: { ...pc.props, k }, geometry: { type: 'LineString', coordinates: line } });
    }
    return out;
  }
  // לכל היותר פעם אחת בפריים (גרירה מהירה שולחת הרבה אירועים)
  let scrubPending = null, scrubRaf = 0;
  function setScrubMap(...args) {
    scrubPending = args;
    if (!args[0]) { cancelAnimationFrame(scrubRaf); scrubRaf = 0; return drawScrubMap(); }
    if (!scrubRaf) scrubRaf = requestAnimationFrame(() => { scrubRaf = 0; drawScrubMap(); });
  }
  function drawScrubMap() {
    const [segs, r, p, a, b, both] = scrubPending || [];
    if (!segs || !r) return map.getSource('scrub')?.setData(empty);
    const ra = profToRoute(p, r, a), rb = profToRoute(p, r, b);
    const feats = rb - ra > 1 ? overlayFeatures(segs, ra, rb, 'dim') : [];
    const dot = (d) => overlayFeatures(segs, Math.max(0, d - 0.8), Math.max(d, 0.8), 'dot');
    feats.push(...dot(rb));
    if (both) feats.push(...dot(ra));
    map.getSource('scrub')?.setData({ type: 'FeatureCollection', features: feats });
  }
  function clearScrub() { scrub = null; setScrubMap(null); }
  // הפרש גובה: חץ במקום סימן (+/− מתהפך בטקסט עברי)
  const signed = (v) => (Math.round(v) > 0 ? '↗ ' : Math.round(v) < 0 ? '↘ ' : '') + Math.abs(Math.round(v)) + " מ'";

  // מרחק בגרף -> מרחק על המסלול (כמעט זהים; מתקן הבדלים קטנים בשיטת החישוב)
  const profToRoute = (p, r, d) => (p.total ? (d * r.total) / p.total : 0);

  // ---------- המסלול בדוק ----------
  // שני מצבים: תצוגה מקדימה (לפני היציאה) וניווט (active.nav). שורת מספרים אחת:
  // בתצוגה – של כל המסלול; בניווט – מה שנשאר; בגרירה על הגרף – עד האצבע (בכתום), וחוזרת בעזיבה.
  const fmtClock = (min) => { const t = new Date(Date.now() + min * 60000); return `\u2066~${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}\u2069`; }; // בידוד LTR בתוך טקסט עברי
  const mtr = (v) => Math.round(v) + " מ'";
  // חץ בתחילת התווית (↗ ↘) – גדול יותר
  function setLabel(el, l) {
    const m = /^([↗↘])\s*(.*)$/.exec(l);
    if (!m) return void (el.textContent = l);
    const a = document.createElement('span');
    a.className = 'arr'; a.textContent = m[1];
    el.replaceChildren(a, ' ' + m[2]);
  }
  function setStats(cells, hot) {
    cells.forEach(([l, v], i) => {
      setLabel($('st-l' + (i + 1)), l);
      $('st-v' + (i + 1)).textContent = v;
    });
    $('ri-stats').classList.toggle('hot', !!hot);
  }
  function renderRouteInfo() {
    if (!active || !route || dockMode() !== 'route') return;
    const total = route.total;
    const bike = !!active.opts?.bike;
    const nav = !!active.nav;
    $('ri-name').textContent = active.name || 'מסלול';
    // התקדמות על הגרף (רק בניווט)
    const atP = nav && prevAlong != null && prof ? (prevAlong * prof.total) / (total || 1) : null;
    // לפני היציאה: יוצאים מכל נקודה על המסלול, רק כשקרובים אליו
    $('ri-go').textContent = goMsg || '▶ יוצאים לדרך';
    $('ri-go').classList.toggle('warn', !!goMsg && !goWait);
    $('ri-go').hidden = nav || !!detour;
    $('dt-box').hidden = !detour;
    const wait = prof === false ? '–' : '…'; // נכשל – קו; עוד מחשב – שלוש נקודות
    if (scrub && prof && scrub.a != null) {
      // שתי אצבעות: הטווח שביניהן
      const L = legInfo(prof, scrub.a, scrub.b, bike);
      setStats([['בין האצבעות', Geo.fmtDist(L.len)], ['↗ עלייה', mtr(L.gain)], ['↘ ירידה', mtr(L.loss)],
        ['הפרש גובה', signed(eleAt(prof, scrub.b) - eleAt(prof, scrub.a))]], true);
      setScrubMap(active.segs, route, prof, scrub.a, scrub.b, true);
    } else if (scrub && prof) {
      // האצבע על הגרף: מהמיקום שלך (בניווט, אם הנקודה לפניך) או מתחילת המסלול
      const from = atP != null && atP <= scrub.b ? atP : 0;
      const L = legInfo(prof, from, scrub.b, bike);
      setStats([[from > 0 ? 'ממך עד כאן' : 'עד כאן', Geo.fmtDist(L.len)], ['↗ עלייה', mtr(L.gain)], ['↘ ירידה', mtr(L.loss)],
        ['מגיעים', fmtClock(L.time)]], true);
      setScrubMap(active.segs, route, prof, from, scrub.b);
    } else if (nav && atP != null) {
      const rem = profileStats(prof, atP), left = total - prevAlong;
      const t = estTime(left, rem.gain, bike);
      setStats([['נותרו', Geo.fmtDist(left)], ['↗ לעלות', mtr(rem.gain)], ['↘ לרדת', mtr(rem.loss)], ['🏁 סיום', fmtClock(t)]]);
    } else {
      const t = prof ? estTime(total, prof.gain, bike) : null;
      setStats([['אורך', Geo.fmtDist(total)], ['↗ עלייה', prof ? mtr(prof.gain) : wait], ['↘ ירידה', prof ? mtr(prof.loss) : wait],
        ['⏱ זמן', t != null ? fmtTime(t) : wait]]);
    }
    drawProfile($('ri-profile'), prof, { at: atP, touch: scrub?.b, from: scrub?.a });
  }
  attachScrub($('ri-profile'), () => prof, (a, b) => {
    scrub = b == null ? { b: a } : { a, b };
    renderRouteInfo();
  }, () => { clearScrub(); renderRouteInfo(); });

  // יציאה – מכותרת הדוק: בניווט – עוצרים את הניווט; אחרת – חוזרים לרשימה, כמו שהייתה
  async function exitRoute() {
    if (detour) cancelDetour();
    // הוספת קטעים למסלול: שומרים כמסלול חדש? המקורי נשאר כמו שהוא
    if (active?.edits?.length) {
      const name = [active.baseName || active.name, ...(active.adds || [])].join(' + ');
      if (await confirmDlg('לשמור את השינויים כמסלול חדש?', `"${name}". המסלול המקורי נשאר כמו שהוא.`, { ok: 'שמירה', cancel: 'לא לשמור', danger: false })) {
        await libPut({ ...active, libId: Date.now(), name, nav: false });
      }
    }
    dock.libOpen = true;
    await clearRoute();
  }
  $('r-exit').addEventListener('click', () => (active?.nav ? stopNav() : exitRoute()));

  // יוצאים לדרך: רק ליד המסלול; ההתקדמות מתחילה מאיפה שנמצאים. מעקב, מסך דולק, והמפה מסתובבת לפי הטלפון
  const NEAR_ROUTE = 200; // מטרים
  let goMsg = '', goWait = false, goTimer = 0;
  const goSay = (m, wait = false) => {
    goMsg = m; goWait = wait; clearTimeout(goTimer);
    if (m && !wait) goTimer = setTimeout(() => { goMsg = ''; renderRouteInfo(); }, 5000);
    renderRouteInfo();
  };
  const waitFix = (ms) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => { if (lastPos || watchId == null || Date.now() - t0 > ms) { clearInterval(iv); res(lastPos); } }, 250);
  });
  $('ri-go').addEventListener('click', async () => {
    if (!active || goWait) return;
    const hadGps = watchId != null;
    startGps();
    if (!lastPos) goSay('מחפש מיקום…', true);
    const pos = await waitFix(20000);
    if (!active) return;
    const r = pos && Geo.locate(route, pos.p, null);
    const lim = Math.max(NEAR_ROUTE, pos?.accuracy || 0);
    if (!r || r.off > lim) {
      if (!hadGps) stopGps();
      return goSay(!pos ? 'לא נמצא מיקום · נסו שוב' : `רחוק מהמסלול (${Geo.fmtDist(r.off)}) · יוצאים לדרך רק ממנו`);
    }
    goSay('');
    active.nav = true; prevAlong = null;
    db.set('active', active);
    startGps(); setFollow(true);
    if (lastPos) map.easeTo({ center: lastPos.p, zoom: Math.max(map.getZoom(), 16) });
    if (!compassMode && (await enableOrientation())) { compassMode = true; updateCompassIcon(); }
    setDockOpen(false);
    updateStatus();
  });
  function stopNav() {
    if (!active) return;
    active.nav = false; prevAlong = null;
    db.set('active', active);
    setFollow(false);
    if (compassMode) { compassMode = false; map.rotateTo(0, { duration: 400 }); updateCompassIcon(); }
    setWalked(null);
    stopGps(); // ה-GPS פועל רק בניווט (או אחרי לחיצה על "מיקום")
    renderRouteInfo();
  }

  // מה שכבר הלכת – דהוי על המפה (קו בצבע הרקע מעל החלק שעברת)
  let walkedAt = -1;
  function setWalked(along) {
    if (along == null) { walkedAt = -1; map.getSource('walked')?.setData(empty); return; }
    if (Math.abs(along - walkedAt) < 5) return;
    walkedAt = along;
    // מחולק כמו המסלול – כך יושב עליו גם בקטעים משותפים (שזזים הצידה)
    map.getSource('walked')?.setData({ type: 'FeatureCollection', features: active ? overlayFeatures(active.segs, 0, along, 'walk') : [] });
  }

  // ---------- תוספת למסלול קיים: לחיצה ארוכה על המפה ----------
  // מהנקודה הקרובה במסלול (בניווט – שעוד לפניך) אל הנקודה שנבחרה, לאורך השבילים.
  // "הלוך וחזור" – חוזרים באותה דרך; "להמשיך משם" – הדרך הקצרה חזרה למסלול, בהמשך (מה שמדלגים עליו – אפור).
  let detour = null; // { target, dep, opts:{back, on}, mode }
  const segsLen = (segs) => segs.reduce((a, sg) => a + sg.coords.reduce((x, p, j) => (j ? x + Geo.haversine(sg.coords[j - 1], p) : 0), 0), 0);
  const colorLeg = (segs) => segs.map((sg) => ({ ...sg, c: sg.c || (sg.h === 'free' ? null
    : ['path', 'footway', 'track', 'steps', 'bridleway', 'cycleway'].includes(sg.h) ? '#7a6a58' : '#9e9e9e') }));
  const reverseSegs = (segs) => segs.slice().reverse().map((sg) => ({ ...sg, coords: sg.coords.slice().reverse() }));
  // הקטעים שבין שני מרחקים לאורך המסלול
  function cutSegs(segs, from, to) {
    const out = [];
    let acc = 0;
    for (const sg of segs) {
      const c = sg.coords;
      let piece = null;
      for (let j = 1; j < c.length; j++) {
        const d = Geo.haversine(c[j - 1], c[j]), a0 = acc, a1 = acc + d;
        acc = a1;
        if (a1 <= from || a0 >= to) continue;
        const at = (x) => { const t = d ? (x - a0) / d : 0; return [c[j - 1][0] + (c[j][0] - c[j - 1][0]) * t, c[j - 1][1] + (c[j][1] - c[j - 1][1]) * t]; };
        if (!piece) piece = [a0 >= from ? c[j - 1] : at(from)];
        piece.push(a1 <= to ? c[j] : at(to));
      }
      if (piece?.length > 1) out.push({ ...sg, coords: piece });
    }
    return out;
  }
  function placeNear(p) {
    let best = null, bd = 150;
    for (const f of mapFC?.features || []) {
      if (f.geometry.type !== 'Point' || !f.properties.n) continue;
      const d = Geo.haversine(p, f.geometry.coordinates);
      if (d < bd) { bd = d; best = f.properties.n; }
    }
    return best;
  }
  function proposeDetour(target) {
    if (!showingRoute() || !mapFC) return;
    const opts = { snap: true, bike: !!active.opts?.bike };
    const g = getGraph(opts.bike), sn = g && Router.snap(g, target, 200);
    if (sn) target = sn.p;
    const lo = active.nav && prevAlong != null ? prevAlong : 0;
    // יציאה: הנקודה הקרובה במסלול (שעוד לפניך)
    let di = -1, dd = Infinity;
    route.pts.forEach((p, i) => { if (route.cum[i] >= lo) { const d = Geo.haversine(p, target); if (d < dd) { dd = d; di = i; } } });
    if (di < 0 || dd < 15) return toast('הנקודה כבר על המסלול', 2000);
    const dep = route.cum[di];
    const depPt = route.pts[di];
    const sDep = g && Router.snap(g, depPt), outR = sDep && sn ? Router.route(g, sDep, sn) : null;
    const out = colorLeg(outR ? outR.segs : computeLeg(depPt, target, opts).segs);
    const outLen = segsLen(out);
    const choices = { back: { segs: Router.pickColors([...out, ...reverseSegs(out)]), rejoin: dep, add: 2 * outLen } };
    // חזרה למסלול בהמשך: הנקודות הקרובות ביותר (בקו אווירי) שאחרי היציאה, ומהן – הדרך הקצרה ביותר
    const cands = [];
    route.pts.forEach((p, i) => { if (route.cum[i] > dep + 60) cands.push({ i, d: Geo.haversine(p, target) }); });
    cands.sort((a, b) => a.d - b.d);
    const picked = [];
    for (const c of cands) {
      if (c.d > 2500 || picked.length >= 10) break;
      if (picked.every((x) => Math.abs(route.cum[x.i] - route.cum[c.i]) > 40)) picked.push(c);
    }
    let best = null;
    const avoid = new Set(outR?.edges || []); // לא לחזור באותה דרך
    for (const c of outR ? picked : []) {
      const sc = Router.snap(g, route.pts[c.i]);
      const leg = sc && Router.route(g, sn, sc, { avoid });
      if (!leg) continue;
      // דרך חזרה שעוברת בנקודת היציאה – זה בעצם הלוך וחזור
      if (leg.segs.some((sg) => sg.coords.some((q) => Geo.haversine(q, depPt) < 25))) continue;
      const len = segsLen(leg.segs);
      if (!best || len < best.len) best = { i: c.i, len, segs: leg.segs };
    }
    if (best && best.len < outLen * 3) {
      const rejoin = route.cum[best.i];
      choices.on = { segs: Router.pickColors([...out, ...colorLeg(best.segs)]), rejoin, add: outLen + best.len - (rejoin - dep) };
    }
    detour = { target, dep, choices, mode: 'back', name: placeNear(target) };
    longPressAt = Date.now();
    navigator.vibrate?.(25);
    showDetour();
  }
  function showDetour() {
    const ch = detour.choices[detour.mode];
    const feats = ch.segs.map((sg) => ({ type: 'Feature', properties: { k: 'new' }, geometry: { type: 'LineString', coordinates: sg.coords } }));
    if (detour.mode === 'on') for (const sg of cutSegs(active.segs, detour.dep, ch.rejoin))
      feats.unshift({ type: 'Feature', properties: { k: 'skip' }, geometry: { type: 'LineString', coordinates: sg.coords } });
    feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: detour.target } });
    map.getSource('detour')?.setData({ type: 'FeatureCollection', features: feats });
    for (const b of document.querySelectorAll('#dt-modes button')) {
      b.hidden = !detour.choices[b.dataset.m];
      b.classList.toggle('on', b.dataset.m === detour.mode);
    }
    $('dt-title').textContent = detour.name ? `תוספת: ${detour.name}` : 'תוספת למסלול';
    // במילים ולא +/− (סימנים מתהפכים בטקסט עברי)
    const more = (txt, neg) => (neg ? `${txt} פחות` : `עוד ${txt}`);
    const lenTxt = more(Geo.fmtDist(Math.abs(ch.add)), ch.add < 0);
    $('dt-info').textContent = `${lenTxt} · מחשב גובה…`;
    renderRouteInfo();
    // עלייה וזמן – אחרי חישוב הגובה של המסלול החדש
    const mine = detour, mode = detour.mode;
    const r = Geo.buildRoute(segsToLines(buildDetourSegs()));
    Elev.profile(r.pts, 15, r.breaks).then((p) => {
      if (detour !== mine || detour.mode !== mode) return;
      const bike = !!active.opts?.bike;
      const oldT = estTime(route.total, prof?.gain || 0, bike), newT = p ? estTime(r.total, p.gain, bike) : null;
      $('dt-info').textContent = lenTxt
        + (p && prof ? ` · ↗ עוד ${Math.max(0, Math.round(p.gain - prof.gain))} מ'` : '')
        + (newT != null ? ` · ⏱ ${more(fmtTime(Math.abs(newT - oldT)), newT < oldT)}` : '');
    });
  }
  function buildDetourSegs() {
    const ch = detour.choices[detour.mode];
    return [...cutSegs(active.segs, 0, detour.dep), ...ch.segs, ...cutSegs(active.segs, ch.rejoin, Infinity)];
  }
  function cancelDetour() {
    detour = null;
    map.getSource('detour')?.setData(empty);
    renderRouteInfo();
    checkFar(); // החזרה (למעטפת / למיקום) חוזרת לפעול
  }
  async function acceptDetour() {
    if (!detour || !active) return;
    const segs = buildDetourSegs();
    const a = active;
    a.edits = [...(a.edits || []), { segs: a.segs, adds: a.adds || [] }];
    a.baseName ||= a.name;
    a.adds = [...(a.adds || []), detour.name || 'תוספת'];
    a.segs = segs;
    cancelDetour();
    await setActive(a, { save: true });
    toast('נוסף למסלול · "חזור" מבטל', 2500);
  }
  async function undoDetour() {
    const a = active;
    const last = a?.edits?.pop();
    if (!last) return;
    a.segs = last.segs; a.adds = last.adds;
    await setActive(a, { save: true });
    toast('התוספת בוטלה', 2000);
  }
  for (const b of document.querySelectorAll('#dt-modes button')) b.addEventListener('click', () => { detour.mode = b.dataset.m; showDetour(); });
  $('dt-ok').addEventListener('click', acceptDetour);
  $('dt-cancel').addEventListener('click', cancelDetour);
  // לחיצה ארוכה (בלי לזוז) על המפה, כשמסלול מוצג
  {
    let lpTimer = 0, lpStart = null;
    const cancel = () => { clearTimeout(lpTimer); lpStart = null; };
    const mapBox = map.getContainer();
    mapBox.addEventListener('touchstart', (e) => {
      cancel();
      if (e.touches.length !== 1 || !showingRoute()) return;
      lpStart = [e.touches[0].clientX, e.touches[0].clientY];
      lpTimer = setTimeout(() => {
        const r = mapBox.getBoundingClientRect(), ll = map.unproject([lpStart[0] - r.left, lpStart[1] - r.top]);
        lpStart = null;
        proposeDetour([ll.lng, ll.lat]);
      }, 550);
    }, { passive: true });
    mapBox.addEventListener('touchmove', (e) => {
      if (lpStart && (e.touches.length > 1 || Math.hypot(e.touches[0].clientX - lpStart[0], e.touches[0].clientY - lpStart[1]) > 10)) cancel();
    }, { passive: true });
    for (const t of ['touchend', 'touchcancel']) mapBox.addEventListener(t, cancel, { passive: true });
    map.on('contextmenu', (e) => { if (!matchMedia('(pointer: coarse)').matches) proposeDetour([e.lngLat.lng, e.lngLat.lat]); });
  }

  // ---------- תכנון מסלול ----------
  let plan = null;       // { wps:[[lon,lat]], opts:{snap,bike}, name, markers:[] }
  let graph = null, graphKey = '';
  const legCache = new Map();

  function getGraph(bike) {
    const key = (mapFC?.features.length || 0) + '|' + (mapFC?.bbox || '') + '|' + bike;
    if (graphKey !== key) { graph = mapFC ? Router.buildGraph(mapFC, { bike }) : null; graphKey = key; legCache.clear(); }
    return graph;
  }

  function computeLeg(a, b, opts) {
    const k = a.join() + '|' + b.join() + '|' + opts.snap + opts.bike;
    if (legCache.has(k)) return legCache.get(k);
    let leg = null;
    if (opts.snap) {
      const g = getGraph(opts.bike);
      const s = g && Router.snap(g, a), t = g && Router.snap(g, b);
      const r = s && t ? Router.route(g, s, t) : null;
      if (r) {
        leg = { segs: r.segs };
        // קטעי "השלמה" ישרים מהנקודה שסומנה אל השביל (אם רחוקה ממנו)
        if (s.d > 3) leg.segs.unshift({ coords: [a, s.p], c: null, h: 'free' });
        if (t.d > 3) leg.segs.push({ coords: [t.p, b], c: null, h: 'free' });
      }
    }
    if (!leg) leg = { segs: [{ coords: [a, b], c: null, h: 'free' }], free: opts.snap };
    legCache.set(k, leg);
    return leg;
  }

  function planSegs() {
    const segs = [];
    let free = false;
    for (let i = 1; i < plan.wps.length; i++) {
      const leg = computeLeg(plan.wps[i - 1], plan.wps[i], plan.opts);
      free ||= leg.free;
      segs.push(...leg.segs.map((sg) => ({ ...sg, coords: sg.coords })));
    }
    Router.pickColors(segs); // קטע משותף לכמה שבילים – בצבע השביל שהולכים בו
    // צבע לקטעי שביל לא מסומן / דרך
    for (const sg of segs) if (!sg.c && sg.h !== 'free') sg.c = ['path', 'footway', 'track', 'steps', 'bridleway', 'cycleway'].includes(sg.h) ? '#7a6a58' : '#9e9e9e';
    return { segs, free };
  }

  let profTimer = 0;
  function renderPlan() {
    const { segs, free } = planSegs();
    const display = smoother ? segs.map((sg) => (sg.h === 'free' ? sg : { ...sg, coords: smoother(sg.coords) })) : segs;
    map.getSource('route').setData(plan.wps.length > 1 ? routeFeatures(display) : empty);
    plan.segs = display;
    // סמנים
    plan.markers.forEach((m) => m.remove());
    plan.markers = plan.wps.map((p, i) => {
      const el = document.createElement('div');
      el.className = 'wp' + (i === 0 ? ' first' : i === plan.wps.length - 1 ? ' last' : '');
      el.textContent = i + 1;
      const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(p).addTo(map);
      m.on('dragend', () => { const ll = m.getLngLat(); plan.wps[i] = [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]; plan.lastDrag = Date.now(); renderPlan(); });
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (Date.now() - (plan.lastDrag || 0) < 400) return;
        plan.wps.splice(i, 1); renderPlan();
      });
      return m;
    });
    const len = segs.reduce((s2, sg) => s2 + sg.coords.reduce((acc, p, j) => (j ? acc + Geo.haversine(sg.coords[j - 1], p) : 0), 0), 0);
    $('pl-len').textContent = plan.wps.length > 1 ? Geo.fmtDist(len) : '–';
    $('pl-hint').textContent = plan.wps.length === 0 ? 'הקישו על המפה כדי לסמן נקודת התחלה'
      : plan.wps.length === 1 ? 'הקישו על נקודה נוספת – המסלול יימשך לאורך השבילים'
      : free && plan.opts.snap ? 'חלק מהקטעים לא נמצאו על שבילים – מוצגים כקו מקווקו' : 'גררו נקודה להזזה · הקשה על נקודה מוחקת אותה';
    $('pl-done').disabled = plan.wps.length < 2;
    $('pl-undo').disabled = !plan.wps.length;
    clearTimeout(profTimer);
    plan.prof = null; plan.scrubAt = null; setScrubMap(null);
    $('pl-up').textContent = $('pl-down').textContent = $('pl-time').textContent = '–';
    if (plan.wps.length > 1) {
      profTimer = setTimeout(async () => {
        const mine = plan;
        const r = Geo.buildRoute(segsToLines(segs));
        const p = await Elev.profile(r.pts, 15, r.breaks);
        if (plan !== mine) return;
        plan.prof = p; plan.route = r;
        $('pl-up').textContent = p ? Math.round(p.gain) + " מ'" : '?';
        $('pl-down').textContent = p ? Math.round(p.loss) + " מ'" : '?';
        $('pl-time').textContent = p ? fmtTime(estTime(len, p.gain, plan.opts.bike)) : '?';
        drawProfile($('pl-profile'), p);
      }, 350);
    } else drawProfile($('pl-profile'), null);
  }

  attachScrub($('pl-profile'), () => plan?.prof, (a, b) => {
    const range = b != null, from = range ? a : 0, to = range ? b : a;
    plan.scrubAt = to;
    setScrubMap(plan.segs, plan.route, plan.prof, from, to, range);
    const L = legInfo(plan.prof, from, to, plan.opts.bike);
    if (plan.hint == null) plan.hint = $('pl-hint').textContent;
    $('pl-hint').textContent = range
      ? `בין האצבעות: ${Geo.fmtDist(L.len)} · ↗${Math.round(L.gain)} ↘${Math.round(L.loss)} · הפרש ${signed(eleAt(plan.prof, to) - eleAt(plan.prof, from))}`
      : `עד כאן: ${Geo.fmtDist(L.len)} · ↗${Math.round(L.gain)} ↘${Math.round(L.loss)} · ${fmtTime(L.time)}`;
    drawProfile($('pl-profile'), plan.prof, { touch: to, from: range ? from : null });
  }, () => {
    // בעזיבה – חוזרים להנחיה ולגרף הרגיל
    if (!plan) return;
    plan.scrubAt = null; setScrubMap(null);
    if (plan.hint != null) { $('pl-hint').textContent = plan.hint; plan.hint = null; }
    drawProfile($('pl-profile'), plan.prof);
  });

  function startPlan(from) {
    if (!mapFC) return toast('צריך להוריד מפה קודם');
    closeSearch();
    setFollow(false);
    plan = { wps: from?.wps ? from.wps.map((p) => [...p]) : [], opts: { snap: true, bike: false, ...(from?.opts || {}) },
      name: from?.name || '', folder: from?.folder, libId: from?.libId, markers: [] };
    $('pl-snap').checked = plan.opts.snap;
    $('pl-bike').checked = plan.opts.bike;
    clearScrub();
    document.body.classList.add('planning');
    renderDock();
    if (!plan.wps.length) map.getSource('route').setData(empty);
    if (plan.opts.snap) { toast('מכין את רשת השבילים…', 1500); setTimeout(() => { getGraph(plan.opts.bike); renderPlan(); }, 30); }
    else renderPlan();
    applyLayers();
  }

  function endPlan() {
    plan?.markers.forEach((m) => m.remove());
    setScrubMap(null);
    plan = null;
    document.body.classList.remove('planning');
    renderDock();
    if (active) map.getSource('route').setData(routeFeatures(active.segs));
    else map.getSource('route').setData(empty);
    applyLayers();
  }

  map.on('click', (e) => {
    if (!plan) return;
    plan.wps.push([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]);
    renderPlan();
  });
  $('pl-undo').addEventListener('click', () => { plan.wps.pop(); renderPlan(); });
  $('pl-clear').addEventListener('click', () => { plan.wps = []; renderPlan(); });
  $('pl-cancel').addEventListener('click', endPlan);
  $('pl-snap').addEventListener('change', (e) => { plan.opts.snap = e.target.checked; renderPlan(); });
  $('pl-bike').addEventListener('change', (e) => { plan.opts.bike = e.target.checked; toast('מעדכן…', 800); setTimeout(renderPlan, 30); });
  // דיאלוג שמירה – משמש גם לסיום תכנון וגם לשמירת מסלול GPX בספרייה
  let saveMode = null; // 'plan' | 'active'
  async function openSaveDlg(mode, { name = '', folder = '', coords = [] } = {}) {
    saveMode = mode;
    const lib = await libLoad();
    $('folders').replaceChildren(...catOrder(await catLoad(), lib)
      .filter(Boolean).map((f) => Object.assign(document.createElement('option'), { value: f })));
    $('plan-name').value = name;
    $('plan-folder').value = folder || '';
    $('plan-dlg-title').textContent = mode === 'plan' ? 'שמירת המסלול' : 'שמירה בספרייה';
    $('plan-dlg').showModal();
  }
  $('pl-done').addEventListener('click', () => openSaveDlg('plan', { name: plan.name, folder: plan.folder, coords: plan.wps }));
  $('plan-dlg').addEventListener('close', async () => {
    if ($('plan-dlg').returnValue !== 'ok') return;
    const name = $('plan-name').value.trim() || 'מסלול מתוכנן';
    const folder = $('plan-folder').value.trim();
    if (saveMode === 'plan' && plan) {
      const a = { kind: 'plan', name, folder, wps: plan.wps, opts: plan.opts, segs: plan.segs, waypoints: [], libId: plan.libId || Date.now() };
      endPlan();
      await libPut(a);
      await setActive(a, { fit: true });
      toast(`"${name}" נשמר${folder ? ` ב"${folder}"` : ''} · ${Geo.fmtDist(route.total)}`, 4000);
    }
  });

  // ---------- ספריית מסלולים (לפי אזורים) ----------
  const libLoad = async () => { const lib = (await db.get('library').catch(() => null)) || []; for (const r of lib) if (!r.folder || r.folder === 'כללי') r.folder = ''; return lib; };
  async function libPut(a) {
    const lib = await libLoad();
    const entry = { id: a.libId, kind: a.kind, name: a.name, folder: a.folder || '', segs: a.segs, wps: a.wps, opts: a.opts,
      waypoints: a.waypoints,
      len: segsToLines(a.segs).reduce((s2, l) => s2 + l.reduce((acc, p, j) => (j ? acc + Geo.haversine(l[j - 1], p) : 0), 0), 0),
      gain: a.gain, loss: a.loss, updated: Date.now() };
    const i = lib.findIndex((r) => r.id === entry.id);
    if (i >= 0) lib[i] = { ...lib[i], ...entry, gain: entry.gain ?? lib[i].gain, loss: entry.loss ?? lib[i].loss };
    else lib.push({ ...entry, created: Date.now() });
    await db.set('library', lib);
  }
  async function libUpdateStats(id, p) {
    const lib = await libLoad();
    const r = lib.find((x) => x.id === id);
    if (r && p) { r.gain = Math.round(p.gain); r.loss = Math.round(p.loss); await db.set('library', lib); }
  }

  // ---------- מסלולים: טבלה לפי קטגוריות ----------
  // שורה = מסלול: שם · אורך · ˄עלייה ˅ירידה. קטגוריה = כותרת; נגיעה בה פותחת/סוגרת, ותמיד מתחילות סגורות.
  // מסלול בלי קטגוריה – בחוץ, בלי כותרת. גרירה בידית (⋮⋮): מסלול לקטגוריה אחרת, או קטגוריה למקום אחר.
  // נגיעה במסלול בוחרת (נגיעה נוספת פותחת); נגיעה בידית של קטגוריה בוחרת אותה. הכלים למטה פועלים על הנבחר.
  const lsel = { kind: null, id: null, folder: null, editing: false };
  const libOpen = new Set(); // קטגוריות פתוחות – מתאפס בכל כניסה לרשימה
  const byName = (a, b) => a.localeCompare(b, 'he');
  // סדר המסלולים: מה שסודר בגרירה, ואחריו לפי א"ב
  const byOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || byName(a.name, b.name);
  const catLoad = async () => (await db.get('folders').catch(() => null)) || [];
  // סדר הקטגוריות: מה שנשמר (גרירה), ואחריו קטגוריות שעוד לא נשמרו – לפי א"ב
  function catOrder(saved, lib) {
    const out = saved.filter((f) => typeof f === 'string' && f);
    for (const f of [...new Set(lib.map((r) => r.folder).filter(Boolean))].sort(byName)) if (!out.includes(f)) out.push(f);
    return out;
  }
  const clearSel = () => Object.assign(lsel, { kind: null, id: null, folder: null, editing: false });
  function libSelect(id) {
    if (lsel.kind === 'route' && lsel.id === id) return openFromLib(id); // נגיעה שנייה – פותחת
    Object.assign(lsel, { kind: 'route', id, folder: null, editing: false });
    renderLibrary();
  }
  async function openFromLib(id) {
    const r = (await libLoad()).find((x) => x.id === id);
    if (!r) return;
    clearSel();
    await setActive({ ...r, libId: r.id, nav: false }, { fit: true });
  }
  // עריכה: הטקסט עצמו נהיה שדה, עם קו דק מתחתיו
  function editField(value, onSave) {
    const inp = Object.assign(document.createElement('input'), { className: 'edit-in', value, maxLength: 50 });
    let done = false;
    const commit = () => { if (done) return; done = true; lsel.editing = false; const v = inp.value.trim(); v && v !== value ? onSave(v) : renderLibrary(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { done = true; lsel.editing = false; renderLibrary(); } });
    inp.addEventListener('blur', commit);
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); inp.scrollIntoView({ block: 'nearest' }); });
    return inp;
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const gripEl = () => { const g = el('span', 'dh'); g.innerHTML = '<svg viewBox="0 0 10 16"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
    g.addEventListener('click', (e) => e.stopPropagation()); // הידית מטופלת בגרירה; הלחיצה שאחריה לא תפתח/תסגור
    return g; };
  function rowEl(r) {
    const sel = lsel.kind === 'route' && lsel.id === r.id;
    const row = el('div', 'lib-row' + (sel ? ' sel' : ''));
    row.dataset.id = r.id;
    const g = gripEl();
    // שורה אחת: מימין שם המסלול, משמאל האורך בק"מ
    const name = sel && lsel.editing ? editField(r.name, (v) => renameRoute(r.id, v)) : el('div', 'c-name', r.name);
    row.append(g, name, el('span', 'c-len', (r.len / 1000).toFixed(1) + ' ק"מ'));
    row.addEventListener('click', () => { if (dragJustEnded) return; if (!(sel && lsel.editing)) libSelect(r.id); });
    g.addEventListener('pointerdown', (e) => startDrag(e, row, 'route', r.id, true));
    // לחיצה ארוכה בכל מקום בשורה – גם מתחילה גרירה
    row.addEventListener('pointerdown', (e) => { if (!e.target.closest('.dh, input')) startDrag(e, row, 'route', r.id, false); });
    return row;
  }
  async function renderLibrary() {
    const lib = await libLoad();
    const cats = catOrder(await catLoad(), lib);
    if (lsel.kind === 'route' && !lib.some((r) => r.id === lsel.id)) clearSel();
    if (lsel.kind === 'folder' && !cats.includes(lsel.folder)) clearSel();
    const box = $('lib-list');
    const scroll = box.scrollTop;
    box.replaceChildren();
    if (!lib.length && !cats.length) {
      box.innerHTML = '<p class="muted center">עדיין אין מסלולים שמורים. מסלול שתתכננו יישמר כאן.</p>';
    } else {
      // בלי קטגוריה – בחוץ, בלי כותרת (בזמן גרירה יש כאן מקום להוציא מקטגוריה)
      const loose = el('div', 'lib-loose');
      for (const r of lib.filter((x) => !x.folder).sort(byOrder)) loose.appendChild(rowEl(r));
      box.appendChild(loose);
      for (const c of cats) {
        const items = lib.filter((x) => x.folder === c).sort(byOrder);
        const fsel = lsel.kind === 'folder' && lsel.folder === c;
        const sec = el('section', 'cat' + (libOpen.has(c) ? ' open' : '') + (fsel ? ' sel' : ''));
        sec.dataset.cat = c;
        const head = el('div', 'cat-head');
        const g = gripEl();
        head.append(g, fsel && lsel.editing ? editField(c, (v) => renameCat(c, v)) : el('span', 'cat-name', c), el('span', 'cat-count'));
        // נגיעה בכותרת: בוחרת את הקטגוריה (כמו מסלול) ופותחת/סוגרת אותה ברכות
        head.addEventListener('click', () => {
          if (dragJustEnded || (fsel && lsel.editing)) return;
          // נגיעה ראשונה – בוחרת ופותחת; נגיעה בקטגוריה שכבר נבחרה – פותחת/סוגרת
          if (!(lsel.kind === 'folder' && lsel.folder === c)) {
            // בחירה בלי לצייר מחדש – כך הפתיחה מונפשת, כמו הסגירה
            libOpen.add(c);
            Object.assign(lsel, { kind: 'folder', id: null, folder: c, editing: false });
            box.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
            sec.classList.add('sel', 'open');
            return renderLibTools(lib, cats);
          }
          const open = !libOpen.has(c);
          open ? libOpen.add(c) : libOpen.delete(c);
          sec.classList.toggle('open', open);
        });
        g.addEventListener('pointerdown', (e) => startDrag(e, sec, 'cat', c, true));
        head.addEventListener('pointerdown', (e) => { if (!e.target.closest('.dh, input')) startDrag(e, sec, 'cat', c, false); });
        const body = el('div', 'cat-body');
        const inner = el('div');
        for (const r of items) inner.appendChild(rowEl(r));
        if (!items.length) inner.appendChild(el('p', 'cat-empty', 'ריקה – גררו לכאן מסלולים'));
        body.appendChild(inner);
        sec.append(head, body);
        box.appendChild(sec);
      }
    }
    box.scrollTop = scroll;
    renderLibTools(lib, cats);
  }

  // ---------- גרירה: מסלולים בין מקומות וקטגוריות, קטגוריות בסדר אחר ----------
  // מהידית ⋮⋮ – מיד עם התזוזה; מכל מקום אחר בשורה – בלחיצה ארוכה (כדי שגלילה רגילה תמשיך לעבוד)
  let dragJustEnded = false; // הלחיצה שמגיעה אחרי גרירה לא בוחרת ולא פותחת
  let dragActive = false;
  $('lib-list').addEventListener('touchmove', (e) => { if (dragActive) e.preventDefault(); }, { passive: false });
  function startDrag(e, src, kind, key, fromHandle) {
    if (e.button > 0 || lsel.editing) return;
    if (fromHandle) { e.preventDefault(); e.stopPropagation(); }
    const box = $('lib-list');
    const target = e.currentTarget;
    const id = e.pointerId, sx = e.clientX, sy = e.clientY;
    let ghost = null, active = false, drop = null, raf = 0, lastY = sy, timer = 0;
    const clearMarks = () => box.querySelectorAll('.drop, .drop-before, .drop-after').forEach((x) => x.classList.remove('drop', 'drop-before', 'drop-after'));
    const autoScroll = () => {
      const r = box.getBoundingClientRect();
      if (lastY < r.top + 40) box.scrollTop -= 9; else if (lastY > r.bottom - 40) box.scrollTop += 9;
      raf = requestAnimationFrame(autoScroll);
    };
    const begin = () => {
      active = dragActive = true;
      try { target.setPointerCapture(id); } catch { /* ignore */ }
      navigator.vibrate?.(15);
      const r = src.getBoundingClientRect();
      ghost = src.cloneNode(true);
      ghost.classList.add('ghost', 'lift');
      Object.assign(ghost.style, { left: r.left + 'px', width: r.width + 'px', top: r.top + 'px' });
      ghost.dataset.dy = sy - r.top;
      document.body.appendChild(ghost);
      src.classList.add('dragging');
      box.classList.add(kind === 'route' ? 'drag-route' : 'drag-cat');
      raf = requestAnimationFrame(autoScroll);
    };
    if (!fromHandle) timer = setTimeout(begin, 380); // לחיצה ארוכה
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 7) return;
        if (!fromHandle) { clearTimeout(timer); return finish(true); } // זזו לפני הלחיצה הארוכה – זו גלילה
        begin();
      }
      lastY = ev.clientY;
      ghost.style.top = ev.clientY - ghost.dataset.dy + 'px';
      // השורה שנגררת נשארת ברשימה כמקום ריק, וזזה אחרי האצבע; השאר "מפנות לה מקום" (תנועה רכה)
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const y = ev.clientY;
      const isBefore = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const mid = (x) => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; };
      if (kind === 'route') {
        box.querySelectorAll('.drop').forEach((x) => x.classList.remove('drop'));
        dropCat = null;
        const row = under?.closest('.lib-row');
        const cat = under?.closest('.cat');
        if (row && row !== src && box.contains(row)) {
          if (isBefore(src, row) && y > mid(row)) flip(() => row.after(src));
          else if (isBefore(row, src) && y < mid(row)) flip(() => row.before(src));
          else if (row.parentNode !== src.parentNode) flip(() => (y > mid(row) ? row.after(src) : row.before(src)));
        } else if (cat && !cat.classList.contains('open')) {
          cat.classList.add('drop'); dropCat = cat.dataset.cat; // קטגוריה סגורה – נכנסים לסופה
        } else if (cat) {
          const list = cat.querySelector('.cat-body > div');
          if (under.closest('.cat-head')) { if (list.firstChild !== src) flip(() => list.prepend(src)); }
          else if (src.parentNode !== list) flip(() => list.insertBefore(src, list.querySelector('.cat-empty')));
        } else if (under?.closest('.lib-loose') || under === box) {
          const loose = box.querySelector('.lib-loose');
          if (src.parentNode !== loose) flip(() => loose.appendChild(src));
        }
      } else {
        const sec = under?.closest('.cat');
        if (sec && sec !== src && box.contains(sec)) {
          if (isBefore(src, sec) && y > mid(sec)) flip(() => sec.after(src));
          else if (isBefore(sec, src) && y < mid(sec)) flip(() => sec.before(src));
        }
      }
    };
    // FLIP: מודדים, מזיזים ב-DOM, ומחזירים כל שורה ממקומה הקודם למקומה החדש בתנועה
    let dropCat = null;
    const flip = (mutate) => {
      const els = [...box.querySelectorAll(kind === 'route' ? '.lib-row, .cat, .cat-empty, .lib-loose' : '.cat')].filter((x) => x !== src);
      const was = new Map(els.map((x) => [x, x.getBoundingClientRect().top]));
      mutate();
      for (const x of els) {
        const dy = was.get(x) - x.getBoundingClientRect().top;
        if (Math.abs(dy) < 0.5) continue;
        x.style.transition = 'none';
        x.style.transform = `translateY(${dy}px)`;
        x.getBoundingClientRect();
        x.style.transition = 'transform .2s cubic-bezier(.2,.8,.3,1)';
        x.style.transform = '';
      }
    };
    const finish = (cancelled) => {
      clearTimeout(timer);
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel);
      cancelAnimationFrame(raf);
      dragActive = false;
      ghost?.remove(); src.classList.remove('dragging'); box.classList.remove('drag-route', 'drag-cat'); clearMarks();
      if (active) { dragJustEnded = true; setTimeout(() => (dragJustEnded = false), 350); }
      return !cancelled && active;
    };
    const cancel = () => { const was = active; finish(true); if (was) renderLibrary(); };
    const up = async (ev) => {
      if (ev.pointerId !== id) return;
      const wasActive = active;
      finish(false);
      if (!wasActive) {
        // נגיעה בידית בלי גרירה: מסלול – בחירה; קטגוריה – בחירה / ביטול בחירה (נגיעה בשורה מטופלת ב-click)
        if (!fromHandle) return;
        if (kind === 'route') return libSelect(key);
        if (lsel.kind === 'folder' && lsel.folder === key) clearSel(); else Object.assign(lsel, { kind: 'folder', id: null, folder: key, editing: false });
        return renderLibrary();
      }
      // המקום שבו נשאר המקום הריק = המקום החדש
      if (kind === 'route') {
        let drop;
        if (dropCat != null) drop = { folder: dropCat };
        else {
          const sib = (dir) => { let x = src[dir]; while (x && !x.classList?.contains('lib-row')) x = x[dir]; return x; };
          const prev = sib('previousElementSibling'), next = sib('nextElementSibling');
          drop = { folder: src.closest('.cat')?.dataset.cat || '', row: prev || next, after: !!prev };
        }
        await dropRoute(key, drop);
      } else {
        const cats = [...box.querySelectorAll('.cat')].map((x) => x.dataset.cat);
        await db.set('folders', cats);
      }
      renderLibrary();
    };
    // על החלון: האירועים מגיעים לכאן גם מהאלמנט שתפס את האצבע
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', cancel);
  }
  // מסלול שנגרר: לקטגוריה (או החוצה), ובמקום שבו שוחרר – הסדר בקטגוריה נשמר
  async function dropRoute(id, drop) {
    const lib = await libLoad();
    const r = lib.find((x) => x.id === id);
    if (!r) return;
    const moved = (r.folder || '') !== drop.folder;
    r.folder = drop.folder;
    const ids = lib.filter((x) => x.folder === drop.folder && x.id !== id).sort(byOrder).map((x) => x.id);
    let at = ids.length;
    if (drop.row) { const k = ids.indexOf(+drop.row.dataset.id); if (k >= 0) at = k + (drop.after ? 1 : 0); }
    ids.splice(at, 0, id);
    ids.forEach((x, n) => { lib.find((y) => y.id === x).order = n; });
    await db.set('library', lib);
    if (active?.libId === id) { active.folder = drop.folder; db.set('active', active); }
    if (drop.folder) libOpen.add(drop.folder);
    if (moved) toast(drop.folder ? `הועבר ל"${drop.folder}"` : 'הוצא מהקטגוריה', 1800);
  }

  // ---------- הכלים: פועלים על מה שנבחר ----------
  const ICON = {
    open: '<path d="M8 5l11 7-11 7z"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
    route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h8"/>',
    del: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    cat: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  };
  // התיקייה של מה שנבחר – אליה ייכנס מסלול חדש
  const ctxFolder = (lib) => (lsel.kind === 'folder' ? lsel.folder : lsel.kind === 'route' ? lib.find((x) => x.id === lsel.id)?.folder || '' : '');
  // כמו בשירותים ב-ezpz: מופיעים רק הכפתורים שרלוונטיים למה שנבחר (לא כבויים)
  //  כלום:    + מסלול · + קטגוריה
  //  מסלול:   פתח · עריכה · מסלול (רק למתוכנן) · מחיקה | + מסלול (באותה קטגוריה)
  //  קטגוריה: עריכה · מחיקה | + מסלול (בתוכה) · + קטגוריה
  function renderLibTools(lib, cats) {
    const tools = $('lib-tools');
    tools.replaceChildren();
    const r = lsel.kind === 'route' ? lib.find((x) => x.id === lsel.id) : null;
    const c = lsel.kind === 'folder' ? lsel.folder : null;
    const grp = () => tools.appendChild(el('div', 'tgrp'));
    const btn = (g, ico, label, fn, cls = '') => {
      const b = el('button', cls);
      b.innerHTML = `<svg viewBox="0 0 24 24">${ICON[ico]}</svg><span></span>`;
      b.querySelector('span').textContent = label;
      b.addEventListener('click', fn);
      g.appendChild(b);
      return b;
    };
    const delBtn = (g) => btn(g, 'del', 'מחיקה', async () => {
      if (r) {
        if (!(await confirmDlg(`למחוק את "${r.name}"?`, 'המסלול יימחק מהטלפון, ואי אפשר יהיה לשחזר אותו.'))) return;
        await db.set('library', (await libLoad()).filter((x) => x.id !== r.id));
        toast(`"${r.name}" נמחק`);
      }
      if (c) {
        const n = lib.filter((x) => x.folder === c).length;
        if (!(await confirmDlg(`למחוק את הקטגוריה "${c}"?`, n ? `רק הקטגוריה נמחקת. ${n === 1 ? 'המסלול שבה לא יימחק – הוא יעבור' : `${n} המסלולים שבה לא יימחקו – הם יעברו`} לרשימה, מחוץ לקטגוריות.` : 'הקטגוריה ריקה.'))) return;
        await deleteCat(c);
      }
      clearSel(); renderLibrary();
    }, 'danger');
    const cf = ctxFolder(lib);
    const addRoute = (g) => { btn(g, 'add', 'מסלול', () => { clearSel(); startPlan(cf ? { folder: cf } : undefined); }).title = cf ? `מסלול חדש ב"${cf}"` : 'מסלול חדש'; };
    const addCatBtn = (g) => btn(g, 'cat', 'קטגוריה', () => addCat(cats));
    if (r) {
      const g1 = grp();
      btn(g1, 'open', 'פתח', () => openFromLib(r.id));
      btn(g1, 'edit', 'עריכה', () => { lsel.editing = true; renderLibrary(); });
      if (r.kind === 'plan') btn(g1, 'route', 'מסלול', () => { clearSel(); startPlan({ ...r, libId: r.id }); });
      delBtn(g1);
      addRoute(grp());
    } else if (c) {
      const g1 = grp();
      btn(g1, 'edit', 'עריכה', () => { lsel.editing = true; libOpen.add(c); renderLibrary(); });
      delBtn(g1);
      const g2 = grp(); addRoute(g2); addCatBtn(g2);
    } else {
      const g = grp(); addRoute(g); addCatBtn(g);
    }
  }

  // חלון אישור: כותרת, מה יקרה, ביטול / מחיקה
  function confirmDlg(title, text, { ok = 'מחיקה', cancel = 'ביטול', danger = true } = {}) {
    const d = $('confirm-dlg');
    $('cf-title').textContent = title;
    $('cf-text').textContent = text;
    const [bc, bo] = d.querySelectorAll('.cf-btns button');
    bc.textContent = cancel; bo.textContent = ok;
    bo.className = danger ? 'danger-btn' : 'primary';
    d.returnValue = '';
    d.showModal();
    return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
  }
  async function libEdit(fn) {
    const lib = await libLoad();
    fn(lib);
    await db.set('library', lib);
    renderLibrary();
  }
  const renameRoute = (id, name) => libEdit((lib) => { const r = lib.find((x) => x.id === id); if (r) r.name = name; if (active?.libId === id) { active.name = name; db.set('active', active); } });
  // שינוי שם של קטגוריה: גם המסלולים שבה עוברים (שם קיים – הקטגוריות מתאחדות)
  async function renameCat(from, to) {
    const cats = catOrder(await catLoad(), await libLoad());
    const i = cats.indexOf(from);
    if (cats.includes(to)) cats.splice(i, 1); else cats[i] = to;
    await db.set('folders', cats);
    if (libOpen.delete(from)) libOpen.add(to);
    lsel.folder = to;
    if (active?.folder === from) { active.folder = to; db.set('active', active); }
    await libEdit((lib) => { for (const r of lib) if (r.folder === from) r.folder = to; });
  }
  // מחיקת קטגוריה: המסלולים שבה יוצאים החוצה (לא נמחקים)
  async function deleteCat(c) {
    await db.set('folders', (await catLoad()).filter((x) => x !== c));
    const lib = await libLoad();
    for (const r of lib) if (r.folder === c) r.folder = '';
    await db.set('library', lib);
    if (active?.folder === c) { active.folder = ''; db.set('active', active); }
    toast(`הקטגוריה "${c}" נמחקה`, 2000);
  }
  async function addCat(cats) {
    let name = 'קטגוריה חדשה', n = 2;
    while (cats.includes(name)) name = `קטגוריה חדשה ${n++}`;
    await db.set('folders', [...cats, name]);
    Object.assign(lsel, { kind: 'folder', id: null, folder: name, editing: true });
    libOpen.add(name);
    await renderLibrary();
    $('lib-list').lastElementChild?.scrollIntoView({ block: 'nearest' });
  }
  // נגיעה ברקע הרשימה – מבטלת את הבחירה
  $('lib-list').addEventListener('click', (e) => {
    if ((e.target === $('lib-list') || e.target.classList.contains('lib-loose') ) && lsel.kind && !lsel.editing) { clearSel(); renderLibrary(); }
  });

  // ---------- GPS ----------
  let watchId = null;
  let follow = false;
  let lastPos = null;
  let marker = null;
  let wakeLock = null;

  function onPosition(pos) {
    const { longitude, latitude, accuracy, heading, speed } = pos.coords;
    const p = [longitude, latitude];
    const first = !lastPos;
    lastPos = { p, accuracy };
    if (!marker) {
      const el = document.createElement('div');
      el.className = 'me';
      el.innerHTML = '<div class="me-heading"></div><div class="me-dot"></div>';
      marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat(p).addTo(map);
    }
    marker.setLngLat(p);
    const el = marker.getElement();
    const moving = Number.isFinite(heading) && (speed ?? 0) > 0.4;
    gpsHeading = moving ? heading : null;
    updateMarkerHeading();
    el.classList.toggle('poor', accuracy > 50);
    map.getSource('acc')?.setData({ type: 'Feature', geometry: Geo.circle(p, accuracy), properties: {} });
    if (follow && first) map.easeTo({ center: p, zoom: Math.max(map.getZoom(), 15.5), duration: 600 });
    else if (follow) startCamera();
    updateStatus();
  }

  function onGeoError(err) {
    if (err.code === 1) { toast('אין הרשאת מיקום. אפשרו אותה בהגדרות הדפדפן.'); stopGps(); }
    else if (err.code === 3) toast('ממתין לאות GPS…');
    else toast('שגיאת GPS');
  }

  function startGps() {
    if (!('geolocation' in navigator)) return toast('המכשיר אינו תומך ב-GPS');
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError,
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    $('btn-locate').classList.add('gps-on');
    requestWake();
  }

  function stopGps() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    lastPos = null;
    marker?.remove();
    marker = null;
    map.getSource('acc')?.setData(empty);
    setFollow(false);
    $('btn-locate').classList.remove('gps-on');
    releaseWake();
    updateStatus();
  }

  let followedOnce = false; // אחרי שעקבו פעם אחת – כפתור המרכוז נשאר בחוץ כשהמפה זזה מהמיקום
  function setFollow(on) {
    follow = on;
    if (on) followedOnce = true;
    if (on) startCamera();
    $('btn-locate').classList.toggle('active', on);
  }

  $('btn-locate').addEventListener('click', () => {
    startGps();
    setFollow(true);
    if (lastPos) map.easeTo({ center: lastPos.p, zoom: Math.max(map.getZoom(), 15) });
    else toast('מחפש מיקום…', 2000);
  });
  $('btn-locate').addEventListener('contextmenu', (e) => { e.preventDefault(); stopGps(); toast('GPS כבוי'); });
  map.on('dragstart', () => follow && setFollow(false));

  async function requestWake() {
    if (!('wakeLock' in navigator) || wakeLock || watchId == null) return; // תמיד דולק כש-GPS פועל
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch { /* לא נתמך / נדחה */ }
  }
  function releaseWake() { wakeLock?.release(); wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWake();
    else if (!active?.nav && watchId != null) stopGps(); // לא בניווט – לא צורכים סוללה ברקע
  });

  // ---------- מיקום ביחס למסלול ----------
  function updateStatus() {
    if (!route || route.pts.length < 2) return;
    // ההתקדמות נמדדת רק בניווט – מתחילה מהמקום שבו יצאת לדרך
    if (lastPos && active?.nav) {
      const r = Geo.locate(route, lastPos.p, prevAlong);
      prevAlong = r.along;
      setWalked(r.along);
    }
    renderRouteInfo();
  }

  // ---------- כפתורים ותפריט ----------
  $('btn-fit').addEventListener('click', () => { setFollow(false); fitRoute(); });
  $('w-carmel').addEventListener('click', () => downloadArea(CARMEL));

  // ---------- סיבוב ומצפן ----------
  let compassMode = false;
  let devHeading = null;   // כיוון הטלפון (מצפן), מעלות מהצפון
  let gpsHeading = null;   // כיוון התנועה לפי GPS
  let lastRotate = 0;

  function updateMarkerHeading() {
    if (!marker) return;
    // החץ מראה לאן הטלפון מכוון (מצפן), ואם אין – את כיוון ההליכה
    const h = devHeading != null ? devHeading : gpsHeading;
    marker.getElement().classList.toggle('has-heading', h != null);
    if (h != null) marker.setRotation(h);
  }
  function updateCompassIcon() {
    for (const n of document.querySelectorAll('.needle')) n.style.transform = `rotate(${-map.getBearing()}deg)`;
    $('btn-compass').classList.toggle('active', compassMode);
    $('btn-compass').classList.toggle('rotated', Math.abs(map.getBearing()) > 0.5);
  }
  map.on('rotate', updateCompassIcon);

  function onOrientation(e) {
    let h = null;
    if (e.webkitCompassHeading != null) h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
    if (h == null) return;
    h = (h + (screen.orientation?.angle || 0) + 360) % 360;
    // סינון רעשי חיישן (low-pass) עם התחשבות במעבר 359→0
    if (devHeading == null) devHeading = h;
    else devHeading = (devHeading + angDiff(h, devHeading) * 0.12 + 360) % 360;
    const now = performance.now();
    if (now - lastRotate > 100) { lastRotate = now; updateMarkerHeading(); }
    if (compassMode) startCamera();
  }
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

  // לולאת מצלמה: מזיזה את המפה בהדרגה בכל פריים (במקום קפיצות) – לסיבוב ולמעקב אחרי המיקום
  let camRaf = 0;
  let touching = false;
  const mapEl = map.getContainer();
  mapEl.addEventListener('touchstart', () => (touching = true), { passive: true });
  mapEl.addEventListener('touchend', (e) => { if (!e.touches.length) touching = false; }, { passive: true });
  function startCamera() { if (!camRaf) camRaf = requestAnimationFrame(cameraStep); }
  function cameraStep() {
    camRaf = 0;
    if (touching || map.isEasing?.()) { if (compassMode || follow) startCamera(); return; }
    const opts = {};
    let moving = false;
    if (compassMode && devHeading != null) {
      const d = angDiff(devHeading, map.getBearing());
      if (Math.abs(d) > 0.15) { opts.bearing = map.getBearing() + d * 0.12; moving = true; }
    }
    if (follow && lastPos) {
      const c = map.getCenter();
      const dx = lastPos.p[0] - c.lng, dy = lastPos.p[1] - c.lat;
      if (Math.abs(dx) + Math.abs(dy) > 1e-7) { opts.center = [c.lng + dx * 0.15, c.lat + dy * 0.15]; moving = true; }
    }
    if (moving) map.jumpTo(opts);
    if (moving || compassMode) startCamera();
  }
  // ---------- מסלול מוצג (תצוגה וניווט): המעטפת = כל המסלול ----------
  // בתוך המעטפת (מתקרבים, זזים לאורך המסלול) – אין חזרה. יוצאים ממנה (המרכז מחוץ למסלול,
  // או מתרחקים בזום מעבר לכל המסלול) – אחרי רגע בלי נגיעה המפה חוזרת ברכות לכל המסלול.
  let farTimer = 0;
  const showingRoute = () => active && !plan && dockMode() === 'route';
  function outOfEnvelope() {
    const [[w, so], [e, n]] = Geo.bounds(active.segs.flatMap((sg) => sg.coords));
    const px = Math.max((e - w) * 0.15, 0.0015), py = Math.max((n - so) * 0.15, 0.0013); // ריפוד (~150 מ' לפחות)
    const c = map.getCenter(), v = map.getBounds();
    const outside = c.lng < w - px || c.lng > e + px || c.lat < so - py || c.lat > n + py;
    const zoomedOut = (e - w) < (v.getEast() - v.getWest()) * 0.4 && (n - so) < (v.getNorth() - v.getSouth()) * 0.4;
    return outside || zoomedOut;
  }
  // בניווט: הזזת את המפה – אחרי 8 שניות בלי נגיעה היא חוזרת למיקום שלך (ולא לכל המסלול).
  // בזמן הוספת נקודה למסלול (לפני האישור) – אין חזרה בכלל, כדי שאפשר יהיה להסתכל מסביב.
  const RETURN_MS = 8000;
  // תנועה אוטומטית של המפה: מתחילה רך ונגמרת רך (ease-in-out קובי)
  const SOFT = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function checkFar() {
    clearTimeout(farTimer);
    if (!showingRoute() || follow || detour) return; // במעקב – המפה ממילא עליך
    const nav = active.nav && watchId != null;
    farTimer = setTimeout(() => {
      if (!showingRoute() || follow || detour) return;
      if (touching || map.isMoving?.()) return checkFar();
      if (nav) {
        // חזרה למיקום שמתחילה רך ונגמרת רך (ולא קפיצה מהירה בהתחלה); אחרי זה – מעקב רגיל
        if (lastPos) map.easeTo({ center: lastPos.p, duration: 1800, easing: SOFT });
        setFollow(true);
      }
      else if (outOfEnvelope()) fitRoute({ duration: 1600, easing: SOFT });
    }, nav ? RETURN_MS : 1000);
  }
  map.on('moveend', checkFar);
  mapEl.addEventListener('touchend', checkFar, { passive: true });

  let orientationOn = false;
  async function enableOrientation() {
    if (orientationOn) return true;
    // ב-iOS חובה לבקש הרשאה; באנדרואיד מנסים, ואם אין נתונים – מודיעים אחרי 2.5 שניות
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      try { await DeviceOrientationEvent.requestPermission(); } catch { /* ignore */ }
    }
    const ev = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(ev, onOrientation);
    orientationOn = true;
    return true;
  }

  $('btn-compass').addEventListener('click', async () => {
    if (compassMode) {
      compassMode = false;
      map.rotateTo(0, { duration: 400 });
      toast('צפון למעלה', 1500);
    } else if (Math.abs(map.getBearing()) > 0.5) {
      map.rotateTo(0, { duration: 400 });
    } else {
      if (!(await enableOrientation())) return toast('אין גישה למצפן של הטלפון');
      compassMode = true;
      toast('המפה מסתובבת לפי כיוון הטלפון · הקשה נוספת: צפון למעלה', 3500);
      setTimeout(() => devHeading == null && compassMode && toast('לא מתקבל מצפן מהטלפון'), 2500);
    }
    updateCompassIcon();
  });
  // סיבוב ידני בשתי אצבעות מבטל את מצב המצפן
  map.on('rotatestart', (e) => { if (e.originalEvent && compassMode) { compassMode = false; updateCompassIcon(); } });

  // ---------- שכבות ----------
  const GROUPS = {
    trails: ['trail-casing', 'trail', 'trail-label'],
    paths: ['path'],
    tracks: ['track'],
    roads: ['major-casing', 'major', 'medium-casing', 'medium', 'minor-casing', 'minor', 'road-label'],
    water: ['water', 'water-label'],
    poi: ['poi-icon', 'poi-label', 'peak'],
    bike: ['bike'],
    places: ['place-minor', 'place-major'],
    route: ['route-casing', 'route-line', 'route-walked', 'route-arrows', 'route-ends', 'wpts'],
  };
  const LABELS = new Set(['trail-label', 'road-label', 'water-label', 'poi-label', 'place-minor', 'place-major']);
  const layerPrefs = Object.assign(
 { base: 'vector', labels: true, smooth: true, dimDay: 0.55, dimNight: 0.5, ...Object.fromEntries(Object.keys(GROUPS).map((g) => [g, true])) },
    (() => { try { return JSON.parse(localStorage.getItem('layers')) || {}; } catch { return {}; } })());
  layerPrefs.route = true; // המסלול תמיד מוצג (אין לו יותר תיבה בשכבות)
  // הסתרת הרקע – ערך אחד ליום וללילה (פעם היו שניים: ממשיכים מהערך של המצב הנוכחי)
  if (layerPrefs.dim == null) layerPrefs.dim = (localStorage.getItem('theme') === 'dark' ? layerPrefs.dimNight : layerPrefs.dimDay) ?? 0.55;

  function applyLayers() {
    const vis = (on) => (on ? 'visible' : 'none');
    for (const b of ['sat', 'topo', 'ihm']) map.setLayoutProperty('base-' + b, 'visibility', vis(layerPrefs.base === b));
    for (const [g, ids] of Object.entries(GROUPS)) {
      for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(layerPrefs[g] && (!LABELS.has(id) || layerPrefs.labels)));
    }
    map.setLayoutProperty('dim', 'visibility', vis(dimValue() > 0 && layerPrefs.route && (!!active || !!plan)));
    map.setPaintProperty('dim', 'fill-opacity', dimValue());
    showDim();
    try { localStorage.setItem('layers', JSON.stringify(layerPrefs)); } catch { /* ignore */ }
  }
  if (typeof layerPrefs.smooth === 'number') layerPrefs.smooth = layerPrefs.smooth > 0; // מעבר מהגרסה עם רמות
  function smoothLevel() { return layerPrefs.smooth ? 2 : 0; }
  function syncLayerForm() {
    for (const el of document.querySelectorAll('#layers-dlg input')) {
      if (el.type === 'radio') el.checked = el.value === layerPrefs.base;
      else el.checked = !!layerPrefs[el.name];
    }
  }
  $('layers-dlg').addEventListener('change', (e) => {
    const el = e.target;
    if (el.type === 'radio') {
      layerPrefs.base = el.value;
      if (el.value !== 'vector' && !navigator.onLine) toast('רקע זה דורש אינטרנט', 3000);
    } else layerPrefs[el.name] = el.checked;
    applyLayers();
    if (el.name === 'smooth' && mapFC) setTimeout(() => setMapData(mapFC), 30);
  });
  $('btn-layers').addEventListener('click', () => { syncLayerForm(); if ($('layers-dlg').querySelector('.more-layers').open) renderAreas(); $('layers-dlg').showModal(); });
  $('layers-close').addEventListener('click', () => $('layers-dlg').close());
  mapReady.then(applyLayers);

  // ---------- מצב לילה ----------
  const DARK = ['#222222', '#000000', '#000', '#111111', '#111', '#1a1a1a', '#333333', '#333'];
  const THEME = [ // [שכבה, מאפיין, יום, לילה]
    ['scrub-line', 'line-color', '#ffffff', '#1b1f24'],
    ['scrub-dot-casing', 'line-color', '#ffffff', '#1b1f24'],
    ['scrub-dot', 'line-color', '#3c4247', '#ffffff'],
    ['bg', 'background-color', '#e6e1d1', '#15191e'],
    ['water', 'line-color', '#5aa9e6', '#3d7fb3'],
    ['major-casing', 'line-color', '#b8742a', '#4d3215'],
    ['major', 'line-color', '#f7a656', '#9a6430'],
    ['medium-casing', 'line-color', '#c4a03a', '#4a3e18'],
    ['medium', 'line-color', '#ffe38f', '#7d6f38'],
    ['minor-casing', 'line-color', '#b5b5b5', '#2c2f33'],
    ['minor', 'line-color', '#ffffff', '#5a5e63'],
    ['track', 'line-color', '#8b6b3e', '#a98b5e'],
    ['path', 'line-color', '#4a3d30', '#b3a596'],
    // בלילה: שביל שחור נשאר שחור אבל מקבל מסגרת בהירה בולטת
    ['trail-casing', 'line-color', ['case', ['==', ['get', 'c'], '#ffffff'], '#3a3a3a', '#ffffff'],
      ['case', ['==', ['get', 'c'], '#ffffff'], '#777777', ['in', ['get', 'c'], ['literal', DARK]], '#e8e8e8', '#0d0f12']],
    ['trail-casing', 'line-opacity', 0.85, 1],
    ['trail', 'line-color', ['get', 'c'], ['get', 'c']],
    ...['water-label', 'road-label', 'trail-label', 'poi-label', 'peak', 'place-minor', 'place-major', 'area-label']
      .flatMap((id) => [[id, 'text-halo-color', '#ffffff', '#101317']]),
    ['water-label', 'text-color', '#2a74b5', '#7dbbec'],
    ['road-label', 'text-color', '#555555', '#b9b9b9'],
    ['trail-label', 'text-color', '#222222', '#eeeeee'],
    ['poi-label', 'text-color', '#333333', '#dddddd'],
    ['peak', 'text-color', '#6d4c2f', '#d9b48c'],
    ['place-minor', 'text-color', '#444444', '#cccccc'],
    ['place-major', 'text-color', '#222222', '#f2f2f2'],
    ['area-label', 'text-color', '#e06000', '#ffa040'],
    ['dim', 'fill-color', '#ffffff', '#000000'],
    ['route-walked', 'line-color', '#ffffff', '#1b1f24'],
  ];
  function applyTheme(night) {
    document.body.classList.toggle('night', night);
    document.querySelector('meta[name=theme-color]').content = night ? '#101317' : '#1f5f3a';
    for (const [id, prop, day, nightV] of THEME) if (map.getLayer(id)) map.setPaintProperty(id, prop, night ? nightV : day);
    for (const b of ['sat', 'topo', 'ihm']) map.setPaintProperty('base-' + b, 'raster-brightness-max', night ? 0.7 : 1);
  }
  // בהיר / כהה: כפתור אחד שמחליף מיד (בלי מצב אוטומטי). נשמר ב-localStorage `theme`
  let isNight = localStorage.getItem('theme') === 'dark';
  const showTheme = () => ($('btn-theme').dataset.mode = isNight ? 'dark' : 'light');
  document.body.classList.toggle('night', isNight);
  showTheme();
  mapReady.then(() => applyTheme(isNight));
  $('btn-theme').addEventListener('click', () => {
    isNight = !isNight;
    try { localStorage.setItem('theme', isNight ? 'dark' : 'light'); } catch { /* ignore */ }
    showTheme();
    applyTheme(isNight);
    applyLayers(); renderRouteInfo();
  });

  // אזורים מוכרים (לחיפוש ולהצעת תיקייה)
  const PRESETS = [{ name: 'שוויצריה הקטנה', bbox: [35.0, 32.735, 35.05, 32.765] }];

  function flyToBbox(b) {
    setFollow(false);
    if (b[0] === b[2] && b[1] === b[3]) map.flyTo({ center: [b[0], b[1]], zoom: 15.5 });
    else map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 50, maxZoom: 16 });
  }

  // ---------- חיפוש ----------
  const KIND = { trail: 'שביל', road: 'דרך', water: 'נחל', place: 'יישוב / מקום', area: 'האזור שלי', preset: 'אזור',
    peak: 'פסגה', spring: 'מעיין', viewpoint: 'תצפית', ruins: 'חורבה', archaeological_site: 'אתר עתיקות',
    cave_entrance: 'מערה', parking: 'חניה', picnic_site: 'חניון', camp_site: 'חניון לילה', attraction: 'אתר', water_poi: 'ברזייה' };
  const norm = (s) => s.toLowerCase().replace(/[\u0591-\u05C7]/g, '').replace(/["'״׳\-–]/g, ' ')
    .replace(/וו/g, 'ו').replace(/יי/g, 'י').replace(/\s+/g, ' ').trim();
  const loose = (s) => s.replace(/[וי]/g, ''); // כתיב מלא/חסר: שוויצריה = שווצריה = שויצריה

  function buildIndex() {
    const idx = new Map();
    for (const f of mapFC?.features || []) {
      const n = f.properties.n;
      if (!n) continue;
      const kind = f.properties.k === 'poi' ? (f.properties.t === 'water' ? 'water_poi' : f.properties.t) : f.properties.k;
      const key = kind + '|' + n;
      const coords = f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates;
      const b = Geo.bounds(coords).flat();
      const cur = idx.get(key);
      if (cur) cur.bbox = [Math.min(cur.bbox[0], b[0]), Math.min(cur.bbox[1], b[1]), Math.max(cur.bbox[2], b[2]), Math.max(cur.bbox[3], b[3])];
      else idx.set(key, { name: n, kind, bbox: b, key: norm(n) });
    }
    return [...idx.values()];
  }

  // מילים שמתארות סוג מקום – כדי שחיפוש כמו "חניון שוויצריה הקטנה" או "מעיין כלח" יעבוד
  const KIND_WORDS = {
    trail: ['שביל', 'מסלול', 'סימון'], road: ['דרך', 'כביש', 'רחוב', 'דרך עפר'], water: ['נחל', 'ואדי', 'וואדי', 'אפיק'],
    place: ['יישוב', 'ישוב', 'כפר', 'שכונה', 'מקום', 'עיר'], peak: ['הר', 'פסגה', 'גבעה', 'רכס'],
    spring: ['מעיין', 'מעין', 'עין', 'נביעה'], viewpoint: ['תצפית', 'נוף', 'מצפור'],
    ruins: ['חורבה', 'חרבה', 'חירבת', 'חרבת', 'עתיקות'], archaeological_site: ['עתיקות', 'אתר', 'ארכאולוגי'],
    cave_entrance: ['מערה', 'מערת'], picnic_site: ['חניון', 'יום', 'פיקניק'], parking: ['חניה', 'חנייה', 'חניון', 'חנית', 'פרקינג'],
    camp_site: ['חניון', 'לילה', 'קמפינג', 'לינה'], attraction: ['אתר', 'אטרקציה'],
    water_poi: ['ברזייה', 'ברזיה', 'מים', 'שתייה'], area: ['אזור'], preset: ['אזור'],
  };
  const kindWordsNorm = Object.fromEntries(Object.entries(KIND_WORDS).map(([k, ws]) => [k, ws.map((w) => loose(norm(w)))]));

  function localSearch(q) {
    const nq = norm(q);
    if (!nq) return [];
    searchIndex ||= buildIndex();
    const extra = PRESETS.map((p) => ({ ...p, kind: 'preset' }))
      .map((x) => ({ ...x, key: norm(x.name) }));
    const tokens = nq.split(' ').filter(Boolean);
    const rank = { area: 0, preset: 0, place: 1, peak: 2, spring: 2, viewpoint: 2, picnic_site: 2, camp_site: 2, trail: 3 };
    const results = [];
    for (const x of [...extra, ...searchIndex]) {
      const lkey = loose(x.key);
      const kw = kindWordsNorm[x.kind] || [];
      let nameHits = 0, ok = true;
      for (const t of tokens) {
        const lt = loose(t);
        const nameHit = x.key.includes(t) || (lt.length > 1 && lkey.includes(lt));
        const kindHit = lt.length > 0 && kw.some((w) => w.startsWith(lt));
        if (nameHit) nameHits++;
        else if (!kindHit) { ok = false; break; }
      }
      if (!ok) continue;
      // רק מילת סוג (למשל "מעיין") – מציגים את כל המקומות מהסוג הזה
      const score = nameHits * 10 + (x.key === nq ? 8 : 0) + (x.key.startsWith(tokens[0]) ? 3 : 0) + (nameHits < tokens.length ? 2 : 0);
      results.push({ x, score });
    }
    return results
      .sort((a, b) => (b.score - a.score) || ((rank[a.x.kind] ?? 4) - (rank[b.x.kind] ?? 4)) || a.x.name.length - b.x.name.length)
      .slice(0, 40).map((r) => r.x);
  }

  function showResults(items, note) {
    const ul = $('search-results');
    ul.replaceChildren();
    for (const it of items) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="r-name"></span><span class="r-kind"></span>';
      li.querySelector('.r-name').textContent = it.name;
      li.querySelector('.r-kind').textContent = KIND[it.kind] || it.kind || '';
      li.addEventListener('click', () => { closeSearch(); flyToBbox(it.bbox); });
      ul.appendChild(li);
    }
    if (note) { const li = document.createElement('li'); li.className = 'note'; li.textContent = note; ul.appendChild(li); }
  }

  async function onlineSearch(q) {
    if (!navigator.onLine) return showResults(localSearch(q), 'אין אינטרנט – מוצגות תוצאות מהמפה השמורה בלבד');
    showResults(localSearch(q), 'מחפש גם באינטרנט…');
    try {
      const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=il&accept-language=he&limit=8&q=' + encodeURIComponent(q);
      const res = await (await fetch(u)).json();
      const web = res.map((r) => {
        const [s, n, w, e] = r.boundingbox.map(Number);
        return { name: r.name || r.display_name.split(',')[0], kind: 'אינטרנט · ' + r.display_name.split(',').slice(1, 3).join(','), bbox: [w, s, e, n] };
      });
      const local = localSearch(q);
      showResults([...local, ...web], local.length + web.length ? '' : 'לא נמצאו תוצאות');
    } catch {
      showResults(localSearch(q), 'החיפוש באינטרנט נכשל');
    }
  }

  // חיפוש מקום: פס קבוע למעלה (רק כשלא בתוך מסלול או בתכנון). ✕ מנקה
  function syncSearch() { $('search-close').hidden = !$('search-input').value; }
  function closeSearch() { $('search-input').value = ''; showResults([]); syncSearch(); $('search-input').blur(); }
  $('search-input').addEventListener('focus', () => { $('toast').hidden = true; });
  $('search-close').addEventListener('click', closeSearch);
  $('search-input').addEventListener('input', (e) => {
    syncSearch();
    const r = localSearch(e.target.value);
    showResults(r, e.target.value.trim() ? (r.length ? 'לא מצאתם? הקישו "חפש" במקלדת לחיפוש באינטרנט' : 'אין תוצאות במפה השמורה – הקישו "חפש" לחיפוש באינטרנט') : '');
  });
  $('search-form').addEventListener('submit', (e) => { e.preventDefault(); if ($('search-input').value.trim()) onlineSearch($('search-input').value.trim()); });

  // ---------- הסתרת הרקע מתחת למסלול: צבע מלא (לבן ביום, שחור בלילה) בשקיפות שבוחרים ----------
  function dimValue() { return layerPrefs.dim; }
  function setDim(v) {
    layerPrefs.dim = v;
    applyLayers();
  }
  // הסליידר האנכי במשטח הכלים: למעלה – בלי הסתרה, למטה – הכי מוסתר
  const DIM_MAX = 0.9;
  function showDim() {
    const f = Math.min(1, dimValue() / DIM_MAX);
    $('dim-v').style.setProperty('--f', f);
    $('dim-v').setAttribute('aria-valuenow', dimValue().toFixed(2));
  }
  (() => {
    const tr = document.querySelector('#dim-v .vs-track');
    let down = false;
    const at = (e) => {
      const r = tr.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      setDim(Math.round(f * DIM_MAX * 20) / 20);
    };
    tr.addEventListener('pointerdown', (e) => { down = true; tr.setPointerCapture(e.pointerId); at(e); });
    tr.addEventListener('pointermove', (e) => down && at(e));
    tr.addEventListener('pointerup', () => (down = false));
    tr.addEventListener('pointercancel', () => (down = false));
  })();

  // ---------- הדוק התחתון: בית / רשימת מסלולים / מסלול / תכנון ----------
  const dock = { open: false, libOpen: false }; // open – פרטי המסלול פתוחים; libOpen – רשימת המסלולים פתוחה
  const dockEl = $('dock');
  function dockMode() {
    if (plan) return 'plan';
    return active && route?.pts.length > 1 ? 'route' : 'lib';
  }
  let lastMode = null;
  function renderDock() {
    const m = dockMode();
    if (lastMode && lastMode !== m) { dockEl.classList.add('morph'); clearTimeout(renderDock.t); renderDock.t = setTimeout(() => dockEl.classList.remove('morph'), 400); }
    lastMode = m;
    for (const sec of $('dock-in').querySelectorAll(':scope > section')) sec.hidden = sec.dataset.mode !== m;
    dockEl.dataset.mode = m;
    $('btn-fit').hidden = !(active || plan?.wps.length > 1); // מרכוז על כל המסלול – רק כשיש מסלול
    // חיפוש – רק כשלא בתוך מסלול או בתכנון: בכניסה למסלול השורה מתכנסת לתוך ה-☰ (משמאל לימין), וביציאה נפתחת ממנו
    $('search').classList.toggle('collapsed', m !== 'lib');
    layoutTools();
    if (m !== 'lib') closeSearch();
    $('dim-v').hidden = !(active || plan); // הסתרת הרקע – רק כשיש מסלול או בתכנון
    showDim();
    dockEl.classList.toggle('open', dock.open);
    if (m === 'route') renderRouteInfo();
    const ls = document.querySelector('#dock section[data-mode="lib"]');
    ls.classList.toggle('open', dock.libOpen);
    $('lib-head').setAttribute('aria-expanded', dock.libOpen);
    if (m === 'lib') renderLibrary();
    if (typeof syncBack === 'function') setTimeout(syncBack);
  }
  // פתיחה וסגירה של פרטי המסלול: הגובה עובר בהנפשה מהמקום שבו הוא עומד (גם באמצע גרירה) אל היעד
  const more = document.querySelector('#dock .r-more');
  const EASE = 'height .28s cubic-bezier(.22,1,.36,1)';
  function setDockOpen(on) {
    const from = more.offsetHeight;
    dock.open = on;
    if (!on) clearScrub();
    renderDock(); // התוכן מצויר גם כשהוא סגור, כדי שאפשר יהיה למדוד אותו
    const to = on ? more.scrollHeight : 0;
    more.style.transition = 'none';
    more.style.height = from + 'px';
    void more.offsetHeight;
    more.style.transition = EASE;
    more.style.height = to + 'px';
    // בסוף: פתוח = גובה חופשי (כדי שתוכן שנוסף, כמו בחירת תיקייה, ייכנס); סגור = 0 מה-CSS
    const done = () => { more.removeEventListener('transitionend', done); if (dock.open === on) { more.style.transition = ''; more.style.height = on ? 'auto' : ''; } };
    more.addEventListener('transitionend', done);
    setTimeout(done, 400);
  }
  // ראשי = המסלולים: פתוח/סגור במקום. בפתיחה – הקטגוריות תמיד סגורות
  function setLibOpen(on) {
    if (on && !dock.libOpen) libOpen.clear();
    dock.libOpen = on;
    if (!on) clearSel();
    renderDock();
  }
  $('lib-head').addEventListener('click', () => { if (!libDragged) setLibOpen(!dock.libOpen); });
  // גרירה על הידית או על שורת "מסלולים": הרשימה נפתחת ונסגרת צמוד לאצבע;
  // בעזיבה – פתוח או סגור לפי המקום, ותנועה מהירה ממשיכה לכיוון שלה
  let libDragged = false;
  const libBody = $('lib-body');
  const EASE_L = 'grid-template-rows .3s cubic-bezier(.22,1,.36,1)';
  for (const el of document.querySelectorAll('#dock .lib-pull')) {
    let y0 = null, h0 = 0, full = 0, track = [];
    el.addEventListener('pointerdown', (e) => {
      y0 = e.clientY; libDragged = false; track = [[e.clientY, e.timeStamp]];
      h0 = libBody.offsetHeight;
      if (!dock.libOpen) { libOpen.clear(); renderLibrary(); } // התוכן מוכן למדידה
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      if (!libDragged && Math.abs(dy) < 6) return;
      if (!libDragged) full = libBody.firstElementChild.scrollHeight;
      libDragged = true;
      track.push([e.clientY, e.timeStamp]); if (track.length > 6) track.shift();
      libBody.style.transition = 'none';
      libBody.style.gridTemplateRows = Math.max(0, Math.min(full, h0 - dy)) + 'px';
    });
    const end = () => {
      if (y0 == null) return;
      y0 = null;
      if (!libDragged) return; // הקשה – מטופלת ב-click
      const [ya, ta] = track[0], [yb, tb] = track[track.length - 1];
      const v = (yb - ya) / Math.max(1, tb - ta);
      const open = Math.abs(v) > 0.3 ? v < 0 : libBody.offsetHeight > full / 2;
      // מסיימים בהנפשה מהמקום שבו האצבע עזבה, ואז חוזרים לשליטת ה-CSS
      libBody.style.transition = EASE_L;
      libBody.style.gridTemplateRows = (open ? full : 0) + 'px';
      setTimeout(() => { libBody.style.transition = ''; libBody.style.gridTemplateRows = ''; dock.libOpen = open; if (!open) clearSel(); renderDock(); }, 300);
      setTimeout(() => (libDragged = false), 350);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // גרירה: הפרטים נפתחים ונסגרים צמוד לאצבע. בעזיבה – לפתוח או לסגור לפי המקום,
  // ותנועה מהירה (הַטָּלָה) ממשיכה לכיוון שלה. הקשה בלי תזוזה מחליפה מצב.
  // לאן חוזרים מכל מצב (בניווט ובתכנון עם נקודות – שואלים קודם)
  // "חזור" = שלב אחד אחורה: מבטלים את הדבר האחרון שנפתח, לא קופצים רמה שלמה
  function dockBack() {
    const m = dockMode();
    if (m === 'route') {
      if (detour) return cancelDetour(); // תוספת שעוד לא אושרה
      if (dock.open) return setDockOpen(false); // הגרף
      if (active?.edits?.length) return undoDetour(); // התוספת האחרונה
      if (active?.nav) return ask('לעצור את הניווט?', 'עצור', stopNav); // שומרים מעצירה בטעות
      return exitRoute(); // לרשימה, כמו שהייתה
    }
    if (m === 'plan') return plan?.wps.length ? $('pl-undo').click() : endPlan(); // הנקודה האחרונה; בלי נקודות – יציאה
    if (m === 'lib') {
      if (lsel.editing) { lsel.editing = false; return renderLibrary(); }
      if (lsel.kind) { clearSel(); return renderLibrary(); }
      if (libOpen.size) { // הקטגוריה שנפתחה אחרונה
        const c = [...libOpen].pop();
        libOpen.delete(c);
        for (const sec of document.querySelectorAll('#lib-list .cat')) if (sec.dataset.cat === c) sec.classList.remove('open');
        return;
      }
      if (dock.libOpen) return setLibOpen(false);
    }
  }

  // ---------- עיצוב רשימת המסלולים (localStorage `libStyle`) – משתני CSS על :root ----------
  const LS = [
    { k: 'head', name: 'כותרת "מסלולים"', min: 14, max: 30, s: 20, w: 800 },
    { k: 'cat', name: 'כותרת קטגוריה', min: 12, max: 26, s: 16, w: 700 },
    { k: 'row', name: 'שם מסלול', min: 12, max: 24, s: 16, w: 600 },
    { k: 'len', name: 'אורך (ק"מ)', min: 11, max: 22, s: 15, w: 700 },
  ];
  const LS_PAD = { min: 4, max: 22, def: 11 };
  let libStyle = {};
  try { libStyle = JSON.parse(localStorage.getItem('libStyle')) || {}; } catch { /* ignore */ }
  function applyLibStyle() {
    const r = document.documentElement.style;
    for (const it of LS) {
      const v = libStyle[it.k] || {};
      r.setProperty(`--ls-${it.k}-s`, (v.s ?? it.s) + 'px');
      r.setProperty(`--ls-${it.k}-w`, v.w ?? it.w);
    }
    r.setProperty('--ls-pad', (libStyle.pad ?? LS_PAD.def) + 'px');
  }
  applyLibStyle();
  function saveLibStyle() {
    try { localStorage.setItem('libStyle', JSON.stringify(libStyle)); } catch { /* ignore */ }
    applyLibStyle();
  }
  function renderStyleDlg() {
    const box = $('ls-list');
    box.textContent = '';
    // סליידר עם תווית קטנה והערך מימין
    const slider = (label, min, max, step, val, onInput) => {
      const row = el('div', 'ls-sl');
      const top = el('div', 'ls-top', label);
      const out = document.createElement('output');
      out.textContent = val;
      top.append(out);
      const rng = document.createElement('input');
      Object.assign(rng, { type: 'range', min, max, step, value: val });
      rng.addEventListener('input', () => { out.textContent = rng.value; onInput(+rng.value); });
      row.append(top, rng);
      return row;
    };
    for (const it of LS) {
      const v = (libStyle[it.k] ||= {});
      const item = el('div', 'ls-item');
      item.append(el('div', 'ls-name', it.name),
        slider('גודל', it.min, it.max, 1, v.s ?? it.s, (x) => { v.s = x; saveLibStyle(); }),
        slider('עובי', 100, 900, 50, v.w ?? it.w, (x) => { v.w = x; saveLibStyle(); }));
      box.append(item);
    }
    const pad = el('div', 'ls-item');
    pad.append(el('div', 'ls-name', 'שורות'), slider('מרווח', LS_PAD.min, LS_PAD.max, 1, libStyle.pad ?? LS_PAD.def, (x) => { libStyle.pad = x; saveLibStyle(); }));
    box.append(pad);
  }
  $('ls-open').addEventListener('click', () => {
    $('layers-dlg').close();
    if (dockMode() === 'lib' && !dock.libOpen) setLibOpen(true); // כדי לראות את השינויים על הרשימה עצמה
    renderStyleDlg();
    $('style-dlg').showModal();
  });
  $('ls-reset').addEventListener('click', () => { libStyle = {}; saveLibStyle(); renderStyleDlg(); });
  $('ls-close').addEventListener('click', () => $('style-dlg').close());

  // ---------- כפתור "חזור" של הטלפון ----------
  // כשיש לאן לחזור, יש בהיסטוריה רשומה אחת שלנו; "חזור" מוריד אותה (popstate), ואנחנו עושים צעד אחד אחורה.
  // כשאין לאן לחזור – הרשומה יורדת, ו"חזור" הבא יוצא מהאפליקציה כרגיל.
  const openDialog = () => [...document.querySelectorAll('dialog[open]')].pop(); // העליון (אישור מעל השכבות)
  function canGoBack() {
    return !!(openDialog() || !$('dock-ask').hidden || $('search-input').value || dockMode() !== 'lib' || dock.libOpen);
  }
  let backArmed = false, backIgnore = false;
  function syncBack() {
    const want = canGoBack();
    if (want && !backArmed) { history.pushState({ shvilim: 1 }, ''); backArmed = true; }
    else if (!want && backArmed) { backArmed = false; backIgnore = true; history.back(); }
  }
  addEventListener('popstate', () => {
    if (backIgnore) { backIgnore = false; return; }
    backArmed = false;
    const d = openDialog();
    if (d) d.close();
    else if (!$('dock-ask').hidden) $('dock-ask').hidden = true;
    else if ($('search-input').value) closeSearch();
    else dockBack();
    setTimeout(syncBack, 50); // אם עדיין יש לאן לחזור – שוב רשומה
  });
  // מעקב אחרי שינויים שמשפיעים על "יש לאן לחזור"
  for (const d of document.querySelectorAll('dialog')) { d.addEventListener('close', () => setTimeout(syncBack)); new MutationObserver(() => setTimeout(syncBack)).observe(d, { attributes: true, attributeFilter: ['open'] }); }
  new MutationObserver(() => setTimeout(syncBack)).observe($('dock-ask'), { attributes: true, attributeFilter: ['hidden'] });
  $('search-input').addEventListener('input', () => setTimeout(syncBack));

  // שאלה קצרה בראש הדוק: כן / המשך
  function ask(text, yes, fn) {
    const a = $('dock-ask');
    a.querySelector('span').textContent = text;
    a.querySelector('.yes').textContent = yes;
    a.querySelector('.yes').onclick = () => { a.hidden = true; fn(); };
    a.querySelector('.no').onclick = () => (a.hidden = true);
    a.hidden = false;
  }
  function attachDockDrag(el) {
    let y0 = null, h0 = 0, full = 0, moved = false, track = [];
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input, button:not(.grip)')) return;
      y0 = e.clientY; moved = false; track = [[e.clientY, e.timeStamp]];
      h0 = more.offsetHeight;
      full = more.scrollHeight;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      if (!moved && Math.abs(dy) < 6) return;
      moved = true;
      track.push([e.clientY, e.timeStamp]);
      if (track.length > 6) track.shift();
      more.style.transition = 'none';
      more.style.height = Math.max(0, Math.min(full, h0 - dy)) + 'px';
    });
    const end = (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      y0 = null;
      if (!moved) return setDockOpen(!dock.open);
      const [ya, ta] = track[0], [yb, tb] = track[track.length - 1];
      const v = (yb - ya) / Math.max(1, tb - ta); // פיקסלים למילישנייה; שלילי = למעלה
      setDockOpen(Math.abs(v) > 0.3 ? v < 0 : more.offsetHeight > full / 2);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  attachDockDrag($('r-grip'));
  attachDockDrag(document.querySelector('#dock .r-title'));
  attachDockDrag($('ri-stats'));

  // גובה הדוק נקבע לפי התוכן ועובר ברכות (בזמן גרירת פרטי המסלול – צמוד, בלי השהיה).
  // גם משתנה CSS, כדי שקנה המידה וזכויות היוצרים יישבו מעליו
  const dockIn = $('dock-in');
  new ResizeObserver(() => {
    const h = dockIn.offsetHeight;
    dockEl.style.height = h + 'px';
    document.documentElement.style.setProperty('--dock-h', h + 'px');
  }).observe(dockIn);
  renderDock();

  // ---------- כלים: עיגול ☰ בקצה הימני של שורת החיפוש (וכשאין חיפוש – באותו מקום) ----------
  // נגיעה פותחת: הכלים צומחים ממנו כעיגולים במרחקים שווים (--i = המקום בעמודה, לעיכוב ולמרחק).
  // נשאר פתוח עד נגיעה נוספת – לא נסגר לבד, גם לא ב"חזור"
  const knife = $('controls');
  let knifeOpen = false;
  // העיגולים לא זזים מה-☰: כל אחד גדל במקומו (אחד אחרי השני), ונעלם באותה צורה. כשסגור נשארים רק "נעוצים":
  // מצפן (המפה מסובבת / במצב מצפן) ומיקום (GPS פועל והמפה זזה ממך) – ועולים למקום הפנוי הראשון
  function pinned(b) {
    if (b.id === 'btn-compass') return compassMode || Math.abs(map.getBearing()) > 0.5;
    if (b.id === 'btn-locate') return watchId != null && !follow && followedOnce;
    return false;
  }
  function layoutTools() {
    const STAGGER = 30; // מ"ש בין כפתור לכפתור (בתוך הפונקציה – היא נקראת גם לפני שהקוד כאן רץ)
    const col = document.querySelector('#controls .kcol');
    const all = [...col.children].filter((b) => !b.hidden);
    const open = col.closest('#controls').classList.contains('open');
    const show = open ? all : all.filter(pinned);
    const now = new Set(show);
    let n = 0, k = 0;
    for (const b of all) {
      const on = now.has(b), was = (layoutTools.shown || new Set()).has(b);
      if (on) b.style.setProperty('--slot', show.indexOf(b));
      // עיכוב: מי שמופיע – לפי הסדר מלמעלה; מי שנעלם – מלמטה למעלה
      b.style.setProperty('--d', on && !was ? (n++) * STAGGER + 'ms' : !on && was ? (all.length - all.indexOf(b)) * 25 + 'ms' : '0ms');
      b.classList.toggle('on', on);
      k++;
    }
    layoutTools.shown = now; // (מאפיין ולא let – נקרא גם מ-renderDock לפני שהשורה הזו רצה)
    const h = all.length * 56 - 10; // גובה העמודה כשפתוחה – גם של הסליידר
    col.style.height = Math.max(0, show.length * 56 - 10) + 'px';
    $('dim-v').style.height = h + 'px';
    $('dim-v').style.setProperty('--draw', (all.length - 1) * STAGGER + 120 + 'ms'); // הקו יורד באותו קצב שהכפתורים מופיעים
  }
  function setKnife(on) {
    knifeOpen = on;
    knife.classList.toggle('open', on);
    layoutTools();
    $('btn-menu').setAttribute('aria-expanded', on);
  }
  $('btn-menu').addEventListener('click', () => setKnife(!knifeOpen));
  $('search-input').addEventListener('focus', () => setKnife(false)); // תוצאות החיפוש נפתחות מתחת – בלי עיגולים מעליהן
  // מצב ה-GPS, המעקב והסיבוב משתנים בכמה מקומות – בדיקה זולה מעדכנת את העיגולים ה"נעוצים"
  map.on('rotate', layoutTools);
  setInterval(layoutTools, 1000);

  // ---------- הפעלה ----------
  // שחזור המסלול הפעיל (וגם מסלול GPX מגרסה קודמת)
  Promise.all([db.get('active').catch(() => null), db.get('gpx').catch(() => null)]).then(([a, t]) => {
    if (a) setActive(a, { save: false });
    else if (t) showGpx(t, false);
  }).catch(console.error);
  if (navigator.storage?.persist) navigator.storage.persist();
})();
