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
  const halo = { 'text-halo-color': '#fff', 'text-halo-width': 1.6 };
  const empty = { type: 'FeatureCollection', features: [] };

  const style = {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      osm: { type: 'geojson', data: empty, attribution: '© OpenStreetMap', tolerance: 0.3 },
      route: { type: 'geojson', data: empty },
      dim: { type: 'geojson', data: { type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } },
      wpts: { type: 'geojson', data: empty },
      acc: { type: 'geojson', data: empty },
      // רקעים אונליין (דורשים אינטרנט)
      sat: { type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
      topo: { type: 'raster', tileSize: 256, maxzoom: 17, attribution: '© OpenTopoMap (CC-BY-SA)',
        tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png'] },
      ihm: { type: 'raster', tileSize: 256, maxzoom: 16, attribution: '© Israel Hiking Map',
        tiles: ['https://israelhiking.osm.org.il/Hebrew/Tiles/{z}/{x}/{y}.png'] },
      scrub: { type: 'geojson', data: empty },
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
      { id: 'trail-casing', type: 'line', source: 'osm', filter: k('trail'), layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['case', ['==', ['get', 'c'], '#ffffff'], '#3a3a3a', '#ffffff'],
          'line-opacity': 0.85, 'line-width': zw(2.8, 7.5) } },
      { id: 'trail', type: 'line', source: 'osm', filter: k('trail'), layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'c'], 'line-width': zw(1.5, 4.5) } },
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
      // מסלול פעיל: המפה מתחתיו דוהה, והמסלול מצויר עבה בצבעי השבילים עם מסגרת לבנה וקו מתאר כהה
      { id: 'dim', type: 'fill', source: 'dim', layout: { visibility: 'none' }, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.55 } },
      { id: 'route-outer', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#000000', 'line-opacity': 0.55, 'line-width': zw(7, 15) } },
      { id: 'route-casing', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': zw(5, 11) } },
      { id: 'route-line', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['coalesce', ['get', 'c'], '#d4148f'], 'line-width': zw(3, 6.5),
          'line-dasharray': ['case', ['==', ['get', 'h'], 'free'], ['literal', [1, 1]], ['literal', [1, 0]]] } },
      // מה שכבר הלכת: קו בצבע הרקע מעל המסלול, כך שהחלק הזה נראה דהוי
      { id: 'route-walked', type: 'line', source: 'walked', layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.65, 'line-width': zw(5, 11) } },
      { id: 'route-arrows', type: 'symbol', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'icon-image': 'arrow',
          'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map' } },
      // נקודות המסלול
      { id: 'route-ends', type: 'circle', source: 'route', filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 7, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#fff',
          'circle-color': ['match', ['get', 'kind'], 'start', '#1a9b3c', '#c62828'] } },
      { id: 'wpts', type: 'circle', source: 'wpts',
        paint: { 'circle-radius': 6, 'circle-color': '#f39c12', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } },
      { id: 'scrub', type: 'circle', source: 'scrub',
        paint: { 'circle-radius': 8, 'circle-color': '#ff6d00', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } },
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
    attributionControl: { compact: true },
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
    if (ch === 'P') { g.fillStyle = '#fff'; g.font = 'bold 36px sans-serif'; g.fillText('P', S / 2, S / 2 + 2); }
    else { g.font = '32px sans-serif'; g.fillText(ch, S / 2, S / 2 + 2); }
    return g.getImageData(0, 0, S, S);
  }
  map.on('error', (e) => console.warn(e.error || e));
  const mapReady = new Promise((r) => map.on('load', r));

  // ---------- נתוני המפה: הורדה חד-פעמית ושמירה בטלפון ----------
  let downloading = false;
  async function downloadArea(bbox) {
    if (downloading) return;
    if (!navigator.onLine) return toast('אין חיבור לאינטרנט');
    downloading = true;
    $('nodata').hidden = true;
    try {
      const fresh = await OSM.download(bbox, (m) => toast(m, 120000));
      if (!fresh.features.length) throw new Error('לא נמצאו נתונים באזור');
      const old = await db.get('mapdata').catch(() => null);
      const fc = old ? OSM.merge(old, fresh) : fresh;
      await db.set('mapdata', fc);
      await mapReady;
      setMapData(fc);
      toast('שומר גופנים…', 60000);
      // טעינה מוקדמת של הגופנים שהשמות דורשים – ה-Service Worker שומר אותם לאופליין
      await Promise.all(OSM.glyphRanges(fc).map((r) =>
        fetch(GLYPHS.replace('{fontstack}', encodeURIComponent(FONT[0])).replace('{range}', r)).catch(() => null)));
      toast('שומר נתוני גובה…', 60000);
      await Elev.prefetch(bbox).catch(() => 0);
      if (navigator.storage?.persist) navigator.storage.persist();
      const trails = fc.features.filter((f) => f.properties.k === 'trail').length;
      toast(`המפה נשמרה בטלפון ✓ (${trails} קטעי שבילים מסומנים)`, 5000);
    } catch (e) {
      console.error(e);
      toast('ההורדה נכשלה: ' + (e.message || e) + '. נסו שוב.', 6000);
      if (!(await db.get('mapdata').catch(() => null))) $('nodata').hidden = false;
    } finally {
      downloading = false;
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
  // המפה מוצגת מיד בקווים המקוריים, והגרסה המעוגלת מחליפה אותה כשהחישוב מסתיים.
  let smoothCache = null;
  let smoother = null;
  db.del('mapsmooth').catch(() => {}); // ניקוי העותק השמור מגרסאות קודמות
  async function setMapData(fc) {
    mapFC = fc;
    searchIndex = null;
    const lvl = smoothLevel();
    smoother = lvl ? Geo.makeSmoother(fc, lvl) : null;
    if (!lvl) return map.getSource('osm').setData(fc);
    if (smoothCache?.src !== fc) {
      map.getSource('osm').setData(fc);
      await new Promise((r) => setTimeout(r, 50)); // לתת למפה להופיע קודם
      smoothCache = { src: fc, fc: Geo.smoothFC(fc, lvl) };
    }
    if (mapFC === fc && smoothLevel()) map.getSource('osm').setData(smoothCache.fc);
  }
  Promise.all([db.get('mapdata').catch(() => null), mapReady]).then(([fc]) => {
    if (fc) setMapData(fc);
    else $('nodata').hidden = false;
  });
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

  map.on('click', 'wpts', (e) => {
    const f = e.features[0];
    if (!f.properties.name) return;
    const el = document.createElement('div');
    el.textContent = f.properties.name;
    new maplibregl.Popup({ closeButton: false }).setLngLat(f.geometry.coordinates).setDOMContent(el).addTo(map);
  });

  // ---------- הקשה על המפה: מה רשום ב-OpenStreetMap ----------
  const COLOR_NAMES = { '#e0262b': 'אדום', '#1f5bd8': 'כחול', '#16a03a': 'ירוק', '#222222': 'שחור', '#f57c00': 'כתום',
    '#8e24aa': 'סגול', '#e8b800': 'צהוב', '#8d5524': 'חום', '#ffffff': 'לבן / שקוף', '#808080': 'אפור', '#7b5cb8': 'לא ידוע' };
  const HW = { path: 'שביל', footway: 'שביל הליכה', track: 'דרך עפר', steps: 'מדרגות', bridleway: 'שביל רכיבה', cycleway: 'שביל אופניים',
    residential: 'רחוב', unclassified: 'דרך', tertiary: 'כביש', secondary: 'כביש', primary: 'כביש ראשי' };
  const INFO_LAYERS = ['trail', 'bike', 'path', 'track', 'minor', 'medium', 'major', 'water', 'poi-icon', 'peak'];
  map.on('click', (e) => {
    if (plan) return;
    const { x, y } = e.point;
    const feats = map.queryRenderedFeatures([[x - 10, y - 10], [x + 10, y + 10]], { layers: INFO_LAYERS.filter((l) => map.getLayer(l)) });
    if (!feats.length) return;
    const seen = new Set();
    const rows = [];
    for (const f of feats) {
      const p = f.properties;
      const id = p.k + p.n + p.c + p.h + p.t;
      if (seen.has(id)) continue;
      seen.add(id);
      let line = '';
      if (p.k === 'trail') line = `שביל מסומן ${COLOR_NAMES[p.c] || p.c}` + (p.ref ? ` (${p.ref})` : '')
        + `<small>OSM: ${[p.o && 'osmc:symbol=' + p.o, p.cl && 'colour=' + p.cl].filter(Boolean).join(' · ') || '—'}${p.w ? ' · הסימון רשום על השביל עצמו' : ''}</small>`;
      else if (p.k === 'road') line = HW[p.h] || 'דרך';
      else if (p.k === 'water') line = 'נחל';
      else if (p.k === 'bike') line = 'מסלול אופניים';
      else if (p.k === 'poi') line = KIND[p.t === 'water' ? 'water_poi' : p.t] || p.t;
      rows.push(`<div class="info-row"><b>${esc(p.n || '')}</b> ${line}</div>`);
      if (rows.length >= 4) break;
    }
    new maplibregl.Popup({ closeButton: false, maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(rows.join('')).addTo(map);
  });
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------- מסלול פעיל (GPX או מסלול מתוכנן) ----------
  let route = null;      // לחישובי מיקום (Geo.buildRoute)
  let active = null;     // { kind:'gpx'|'plan', segs:[{coords,c,h}], waypoints, name, text?, wps?, opts? }
  let prevAlong = null;
  let prof = null;       // פרופיל גובה

  function routeFeatures(segs, wpts) {
    const f = segs.map((sg) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: sg.coords },
      properties: { ...(sg.c ? { c: sg.c } : {}), ...(sg.h ? { h: sg.h } : {}) } }));
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

  async function setActive(a, { fit = false, save = true } = {}) {
    await mapReady;
    active = a;
    const lines = segsToLines(a.segs);
    route = Geo.buildRoute(lines);
    prevAlong = null;
    map.getSource('route').setData(routeFeatures(a.segs));
    map.getSource('wpts').setData({ type: 'FeatureCollection',
      features: (a.waypoints || []).map((w) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: w.coord }, properties: { name: w.name } })) });
    walkedAt = -1; offState = false;
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
    Elev.profile(route.pts, 15, route.breaks).then((p) => {
      if (active !== a) return;
      prof = p; updateStatus(); renderRouteInfo();
      if (p) { a.gain = Math.round(p.gain); a.loss = Math.round(p.loss); if (a.libId) libUpdateStats(a.libId, p); }
    });
  }

  function fitRoute() {
    const src = plan?.wps.length > 1 ? plan : active; // בתכנון – המסלול שמתכננים
    if (!src) return;
    const all = (src.segs || []).flatMap((sg) => sg.coords).concat((src.waypoints || []).map((w) => w.coord));
    if (all.length) map.fitBounds(Geo.bounds(all), { padding: { top: 40, bottom: $('dock').offsetHeight + 30, left: 40, right: 76 }, maxZoom: 16 });
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
    offState = false;
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
      g.fillStyle = night ? '#999' : '#888'; g.font = '13px sans-serif'; g.textAlign = 'center';
      g.fillText(prof === null && active ? 'מחשב גובה…' : 'אין נתוני גובה (נדרש אינטרנט פעם אחת)', W / 2, H / 2);
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
    // הקטע עד האצבע: כתום
    if (marks.touch != null) {
      const base = marks.at != null && marks.at <= marks.touch ? marks.at : 0;
      band(X(base), X(marks.touch), () => { area(); g.fillStyle = 'rgba(255,109,0,.35)'; g.fill(); });
    }
    const dot = (d, color) => {
      g.fillStyle = color; g.strokeStyle = night ? '#1d2227' : '#fff'; g.lineWidth = 2;
      g.beginPath(); g.arc(X(d), Y(eleAt(p, clampD(d))), 5, 0, 7); g.fill(); g.stroke();
    };
    if (marks.at != null) dot(marks.at, '#1e88e5');
    if (marks.touch != null) {
      const x = X(marks.touch), e = eleAt(p, clampD(marks.touch));
      g.strokeStyle = '#ff6d00'; g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x, pad.t - 2); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
      dot(marks.touch, '#ff6d00');
      // הגובה בנקודה, מעל האצבע
      g.font = 'bold 12px sans-serif'; g.fillStyle = night ? '#ffab40' : '#e65100';
      g.textAlign = x < 30 ? 'left' : x > W - 30 ? 'right' : 'center';
      g.fillText(Math.round(e) + " מ'", x, 12);
    }
  }

  // נגיעה בגרף: גרירת האצבע בוחרת נקודה לאורך המסלול; בעזיבה – onEnd
  function attachScrub(canvas, getProfile, onPick, onEnd) {
    canvas.style.touchAction = 'none';
    let down = false;
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
      down = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      onPick(d);
    });
    canvas.addEventListener('pointermove', (e) => { if (down) { const d = toD(e); if (d != null) onPick(d); } });
    for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, () => { if (down) { down = false; onEnd?.(); } });
  }

  // מה יש בין נקודה אחת לשנייה לאורך המסלול
  function legInfo(p, from, to, bike) {
    const st = profileStats(p, from, to);
    const len = to - from;
    return { len, ele: eleAt(p, to), gain: st.gain, loss: st.loss, time: estTime(len, st.gain, bike) };
  }

  let scrubAt = null; // מרחק (בגרף של המסלול הפעיל) של נקודת הנגיעה
  function setScrubPoint(pt) {
    map.getSource('scrub')?.setData(pt ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: pt } } : empty);
  }
  function clearScrub() { scrubAt = null; setScrubPoint(null); }

  // מרחק בגרף -> מרחק על המסלול (כמעט זהים; מתקן הבדלים קטנים בשיטת החישוב)
  const profToRoute = (p, r, d) => (p.total ? (d * r.total) / p.total : 0);

  // ---------- המסלול בדוק ----------
  // שני מצבים: תצוגה מקדימה (לפני היציאה) וניווט (active.nav). שורת מספרים אחת:
  // בתצוגה – של כל המסלול; בניווט – מה שנשאר; בגרירה על הגרף – עד האצבע (בכתום), וחוזרת בעזיבה.
  const fmtClock = (min) => { const t = new Date(Date.now() + min * 60000); return `\u2066~${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}\u2069`; }; // בידוד LTR בתוך טקסט עברי
  const mtr = (v) => Math.round(v) + " מ'";
  let offState = false; // סטייה מהמסלול (בניווט)
  function setStats(cells, hot) {
    cells.forEach(([l, v], i) => {
      $('st-l' + (i + 1)).textContent = l;
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
    // שורת משנה: תיקייה; בתצוגה – גם המרחק להתחלה כשרחוקים ממנה
    const toStart = !nav && lastPos ? Geo.haversine(lastPos.p, route.pts[0]) : 0;
    // לפני היציאה, כשרחוקים מההתחלה – המרחק אליה על הכפתור
    $('ri-go').textContent = '▶ יוצאים לדרך' + (toStart > 150 ? ` · ${Geo.fmtDist(toStart)} להתחלה` : '');
    // בניווט: "עצור" במקום החזרה (שלא ייצאו מהמסלול בטעות באמצע הדרך)
    $('ri-back').hidden = nav;
    $('ri-stop').hidden = !nav;
    $('ri-go').hidden = nav;
    $('ri-off').hidden = !(nav && offState);
    const wait = '…';
    if (scrubAt != null && prof) {
      // האצבע על הגרף: מהמיקום שלך (בניווט, אם הנקודה לפניך) או מתחילת המסלול
      const from = atP != null && atP <= scrubAt ? atP : 0;
      const L = legInfo(prof, from, scrubAt, bike);
      setStats([[from > 0 ? 'ממך עד כאן' : 'עד כאן', Geo.fmtDist(L.len)], ['↑ עלייה', mtr(L.gain)], ['↓ ירידה', mtr(L.loss)],
        ['מגיעים', fmtClock(L.time)]], true);
    } else if (nav && atP != null) {
      const rem = profileStats(prof, atP), left = total - prevAlong;
      const t = estTime(left, rem.gain, bike);
      setStats([['נותרו', Geo.fmtDist(left)], ['↑ לעלות', mtr(rem.gain)], ['↓ לרדת', mtr(rem.loss)], ['🏁 סיום', fmtClock(t)]]);
    } else {
      const t = prof ? estTime(total, prof.gain, bike) : null;
      setStats([['אורך', Geo.fmtDist(total)], ['↑ עלייה', prof ? mtr(prof.gain) : wait], ['↓ ירידה', prof ? mtr(prof.loss) : wait],
        ['⏱ זמן', t != null ? fmtTime(t) : wait]]);
    }
    drawProfile($('ri-profile'), prof, { at: atP, touch: scrubAt });
  }
  attachScrub($('ri-profile'), () => prof, (d) => {
    scrubAt = d;
    setScrubPoint(pointAt(route, profToRoute(prof, route, d)));
    renderRouteInfo();
  }, () => { clearScrub(); renderRouteInfo(); });

  // "› מסלולים" – יוצאים מהמסלול לרשימה; "עצור" – מפסיקים את הניווט
  $('ri-back').addEventListener('click', async () => {
    dock.libOpen = true; // חוזרים לרשימה פתוחה
    await clearRoute();
  });
  $('ri-stop').addEventListener('click', () => stopNav());

  // יוצאים לדרך: מעקב אחרי המיקום, מסך דולק, והמפה מסתובבת לפי הטלפון
  $('ri-go').addEventListener('click', async () => {
    if (!active) return;
    active.nav = true; offState = false;
    db.set('active', active);
    startGps(); setFollow(true);
    if (lastPos) map.easeTo({ center: lastPos.p, zoom: Math.max(map.getZoom(), 16) });
    if (!compassMode && (await enableOrientation())) { compassMode = true; updateCompassIcon(); }
    setDockOpen(false);
    updateStatus();
  });
  function stopNav() {
    if (!active) return;
    active.nav = false; offState = false;
    db.set('active', active);
    setFollow(false);
    if (compassMode) { compassMode = false; map.rotateTo(0, { duration: 400 }); updateCompassIcon(); }
    setWalked(null);
    renderRouteInfo();
  }

  // מה שכבר הלכת – דהוי על המפה (קו בצבע הרקע מעל החלק שעברת)
  let walkedAt = -1;
  function setWalked(along) {
    if (along == null) { walkedAt = -1; map.getSource('walked')?.setData(empty); return; }
    if (Math.abs(along - walkedAt) < 5) return;
    walkedAt = along;
    const i = idxAt(route.cum, along);
    const coords = route.pts.slice(0, i + 1).concat([pointAt(route, along)]);
    map.getSource('walked')?.setData(coords.length > 1 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } : empty);
  }

  // סטייה מהמסלול: מופיעה רק כשיש בעיה, עם רטט בכניסה וביציאה
  function checkOff(off, accuracy) {
    const th = Math.max(30, accuracy || 0);
    const was = offState;
    if (!offState && off > th) offState = true;
    else if (offState && off < th * 0.7) offState = false;
    if (offState !== was) navigator.vibrate?.(offState ? [250, 120, 250] : [80]);
    $('ri-off').textContent = `סטית ${Geo.fmtDist(off)} מהמסלול`;
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
    plan.prof = null; plan.scrubAt = null; setScrubPoint(null);
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

  attachScrub($('pl-profile'), () => plan?.prof, (d) => {
    plan.scrubAt = d;
    setScrubPoint(pointAt(plan.route, profToRoute(plan.prof, plan.route, d)));
    const L = legInfo(plan.prof, 0, d, plan.opts.bike);
    if (plan.hint == null) plan.hint = $('pl-hint').textContent;
    $('pl-hint').textContent = `עד כאן: ${Geo.fmtDist(L.len)} · ↑${Math.round(L.gain)} ↓${Math.round(L.loss)} · ${fmtTime(L.time)}`;
    drawProfile($('pl-profile'), plan.prof, { touch: d });
  }, () => {
    // בעזיבה – חוזרים להנחיה ולגרף הרגיל
    if (!plan) return;
    plan.scrubAt = null; setScrubPoint(null);
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
    setScrubPoint(null);
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
    // שתי שורות: השם, ומתחתיו הנתונים באותו סדר כמו בכרטיס המסלול – אורך · ↑עלייה ↓ירידה · זמן
    const name = sel && lsel.editing ? editField(r.name, (v) => renameRoute(r.id, v)) : el('div', 'c-name', r.name);
    const meta = el('div', 'c-meta');
    meta.appendChild(el('b', null, Geo.fmtDist(r.len)));
    if (r.gain != null) {
      const ud = el('span', 'ud', `↑${r.gain} ↓${r.loss ?? 0}`); ud.dir = 'ltr';
      meta.append(el('span', 'dot', ' · '), ud, ' מ\'', el('span', 'dot', ' · '), fmtTime(estTime(r.len, r.gain, !!r.opts?.bike)));
    }
    const main = el('div', 'c-main');
    main.append(name, meta);
    row.append(g, main);
    row.addEventListener('click', () => { if (dragJustEnded) return; if (!(sel && lsel.editing)) libSelect(r.id); });
    g.addEventListener('pointerdown', (e) => startDrag(e, row, 'route', r.id, true));
    // לחיצה ארוכה בכל מקום בשורה – גם מתחילה גרירה
    row.addEventListener('pointerdown', (e) => { if (!e.target.closest('.dh, input')) startDrag(e, row, 'route', r.id, false); });
    return row;
  }
  async function renderLibrary() {
    const lib = await libLoad();
    const cats = catOrder(await catLoad(), lib);
    $('lib-count').textContent = lib.length || '';
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
        head.append(g, fsel && lsel.editing ? editField(c, (v) => renameCat(c, v)) : el('span', 'cat-name', c), el('span', 'cat-count', items.length || ''));
        // נגיעה בכותרת – פותחת/סוגרת ברכות (בלי לצייר מחדש)
        head.addEventListener('click', () => {
          if (dragJustEnded || (fsel && lsel.editing)) return;
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
      clearMarks();
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      drop = null;
      if (kind === 'route') {
        const row = under?.closest('.lib-row');
        if (row && row !== src && box.contains(row)) {
          const r = row.getBoundingClientRect();
          const after = ev.clientY > r.top + r.height / 2;
          row.classList.add(after ? 'drop-after' : 'drop-before');
          drop = { folder: row.closest('.cat')?.dataset.cat || '', row, after };
        } else {
          const cat = under?.closest('.cat');
          if (cat) { cat.classList.add('drop'); drop = { folder: cat.dataset.cat }; }
          else if (under?.closest('#lib-list')) { box.querySelector('.lib-loose').classList.add('drop'); drop = { folder: '' }; }
        }
      } else {
        // קטגוריה: לפני הקטגוריה שמרכזה מתחת לאצבע
        const secs = [...box.querySelectorAll('.cat')].filter((x) => x !== src);
        const before = secs.find((x) => { const r = x.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; }) || null;
        if (before) before.classList.add('drop-before'); else secs[secs.length - 1]?.classList.add('drop-after');
        drop = { before };
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
    const cancel = () => finish(true);
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
      if (!drop) return;
      if (kind === 'route') await dropRoute(key, drop);
      else {
        const cats = catOrder(await catLoad(), await libLoad()).filter((c) => c !== key);
        cats.splice(drop.before ? cats.indexOf(drop.before.dataset.cat) : cats.length, 0, key);
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
    const delBtn = (g) => {
      const del = btn(g, 'del', 'מחיקה', async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed'); del.querySelector('span').textContent = 'בטוח?';
          setTimeout(() => { del.classList.remove('armed'); del.querySelector('span').textContent = 'מחיקה'; }, 3000);
          return;
        }
        if (r) { await db.set('library', (await libLoad()).filter((x) => x.id !== r.id)); toast(`"${r.name}" נמחק`); }
        if (c) await deleteCat(c);
        clearSel(); renderLibrary();
      }, 'danger');
    };
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
    toast(`הקטגוריה "${c}" נמחקה; המסלולים שבה נשארו`, 3000);
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
    if (!$('m-wake').checked || !('wakeLock' in navigator) || wakeLock || watchId == null) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch { /* לא נתמך / נדחה */ }
  }
  function releaseWake() { wakeLock?.release(); wakeLock = null; }
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && requestWake());
  $('m-wake').checked = localStorage.getItem('wake') !== '0';
  $('m-wake').addEventListener('change', (e) => {
    localStorage.setItem('wake', e.target.checked ? '1' : '0');
    e.target.checked ? requestWake() : releaseWake();
  });

  // ---------- מיקום ביחס למסלול ----------
  function updateStatus() {
    if (!route || route.pts.length < 2) return;
    if (lastPos) {
      const r = Geo.locate(route, lastPos.p, prevAlong);
      prevAlong = r.along;
      if (active?.nav) { checkOff(r.off, lastPos.accuracy); setWalked(r.along); }
    }
    renderRouteInfo();
  }

  // ---------- כפתורים ותפריט ----------
  const menu = $('menu');
  $('btn-fit').addEventListener('click', () => { setFollow(false); fitRoute(); });
  $('btn-settings').addEventListener('click', async () => {
    const ready = navigator.serviceWorker?.controller ? 'האפליקציה והמפה שמורות לשימוש אופליין ✓' : 'טוען לשימוש אופליין…';
    $('offline-info').textContent = ready;
    storageInfo().then((t) => ($('storage-info').textContent = t));
    menu.showModal();
  });
  $('m-close').addEventListener('click', () => menu.close());
  $('m-area').addEventListener('click', () => { menu.close(); downloadVisible(); });
  $('m-carmel').addEventListener('click', () => { menu.close(); downloadArea(CARMEL); });
  $('w-carmel').addEventListener('click', () => downloadArea(CARMEL));

  async function storageInfo() {
    try {
      const est = await navigator.storage.estimate();
      const mb = (b) => (b / 1048576).toFixed(1) + 'MB';
      const d = est.usageDetails || {};
      const parts = [d.indexedDB != null && `מפה ומסלולים ${mb(d.indexedDB)}`, d.caches != null && `אפליקציה, גופנים וגובה ${mb(d.caches)}`].filter(Boolean);
      return `נפח בטלפון: ${mb(est.usage)}` + (parts.length ? ` (${parts.join(' · ')})` : '');
    } catch { return ''; }
  }

  // ---------- סיבוב ומצפן ----------
  let compassMode = false;
  let devHeading = null;   // כיוון הטלפון (מצפן), מעלות מהצפון
  let gpsHeading = null;   // כיוון התנועה לפי GPS
  let lastRotate = 0;

  function updateMarkerHeading() {
    if (!marker) return;
    const h = compassMode && devHeading != null ? devHeading : gpsHeading;
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
    route: ['route-outer', 'route-casing', 'route-line', 'route-walked', 'route-arrows', 'route-ends', 'wpts'],
  };
  const LABELS = new Set(['trail-label', 'road-label', 'water-label', 'poi-label', 'place-minor', 'place-major']);
  const layerPrefs = Object.assign(
 { base: 'vector', labels: true, smooth: true, dimDay: 0.55, dimNight: 0.5, ...Object.fromEntries(Object.keys(GROUPS).map((g) => [g, true])) },
    (() => { try { return JSON.parse(localStorage.getItem('layers')) || {}; } catch { return {}; } })());
  layerPrefs.route = true; // המסלול תמיד מוצג (אין לו יותר תיבה בשכבות)

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
  $('btn-layers').addEventListener('click', () => { syncLayerForm(); $('layers-dlg').showModal(); });
  $('layers-close').addEventListener('click', () => $('layers-dlg').close());
  mapReady.then(applyLayers);

  // ---------- מצב לילה ----------
  const DARK = ['#222222', '#000000', '#000', '#111111', '#111', '#1a1a1a', '#333333', '#333'];
  const THEME = [ // [שכבה, מאפיין, יום, לילה]
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
  const nightPref = localStorage.getItem('night');
  $('m-night').checked = nightPref ? nightPref === '1' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.classList.toggle('night', $('m-night').checked);
  mapReady.then(() => applyTheme($('m-night').checked));
  $('m-night').addEventListener('change', (e) => {
    localStorage.setItem('night', e.target.checked ? '1' : '0');
    applyTheme(e.target.checked);
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

  function openSearch() { $('toast').hidden = true; $('search').hidden = false; $('search-input').value = ''; showResults([]); $('search-input').focus(); }
  function closeSearch() { $('search').hidden = true; $('search-input').blur(); }
  $('d-search').addEventListener('click', openSearch);
  $('search-close').addEventListener('click', closeSearch);
  $('search-input').addEventListener('input', (e) => {
    const r = localSearch(e.target.value);
    showResults(r, e.target.value.trim() ? (r.length ? 'לא מצאתם? הקישו "חפש" במקלדת לחיפוש באינטרנט' : 'אין תוצאות במפה השמורה – הקישו "חפש" לחיפוש באינטרנט') : '');
  });
  $('search-form').addEventListener('submit', (e) => { e.preventDefault(); if ($('search-input').value.trim()) onlineSearch($('search-input').value.trim()); });

  // ---------- הסתרת הרקע מתחת למסלול: צבע מלא (לבן ביום, שחור בלילה) בשקיפות שבוחרים ----------
  function dimValue() { return document.body.classList.contains('night') ? layerPrefs.dimNight : layerPrefs.dimDay; }
  function setDim(v) {
    layerPrefs[document.body.classList.contains('night') ? 'dimNight' : 'dimDay'] = v;
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
    lastMode = m;
    for (const sec of $('dock-in').querySelectorAll(':scope > section')) sec.hidden = sec.dataset.mode !== m;
    dockEl.dataset.mode = m;
    $('btn-fit').hidden = !(active || plan?.wps.length > 1); // מרכוז על כל המסלול – רק כשיש מסלול
    $('dim-v').hidden = !(active || plan); // הסתרת הרקע – רק כשיש מסלול או בתכנון
    showDim();
    dockEl.classList.toggle('open', dock.open);
    if (m === 'route') renderRouteInfo();
    const ls = document.querySelector('#dock section[data-mode="lib"]');
    ls.classList.toggle('open', dock.libOpen);
    $('lib-head').setAttribute('aria-expanded', dock.libOpen);
    if (m === 'lib') renderLibrary();
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
  // משיכה למעלה פותחת, למטה סוגרת (על הידית ושורת "מסלולים")
  let libDragged = false;
  for (const el of document.querySelectorAll('#dock .lib-pull')) {
    let y0 = null;
    el.addEventListener('pointerdown', (e) => { y0 = e.clientY; libDragged = false; try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
    el.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      if (Math.abs(dy) < 30) return;
      libDragged = true; y0 = null;
      setLibOpen(dy < 0);
      setTimeout(() => (libDragged = false), 300);
    });
    el.addEventListener('pointerup', () => (y0 = null));
    el.addEventListener('pointercancel', () => (y0 = null));
  }

  // גרירה: הפרטים נפתחים ונסגרים צמוד לאצבע. בעזיבה – לפתוח או לסגור לפי המקום,
  // ותנועה מהירה (הַטָּלָה) ממשיכה לכיוון שלה. הקשה בלי תזוזה מחליפה מצב.
  // משיכה למטה מעבר למצב הסגור – צעד אחורה. הדוק יורד עם האצבע; מעבר לסף מופיע "שחררו לחזרה"
  const PULL = 90;
  function pullMove(dy) {
    const d = Math.max(0, dy);
    dockEl.style.transition = 'none';
    dockEl.style.transform = `translateY(${d < PULL ? d : PULL + (d - PULL) * 0.3}px)`;
    dockEl.classList.toggle('pull-ready', d >= PULL);
  }
  function pullEnd(dy, back) {
    const go = dy >= PULL;
    dockEl.style.transition = 'transform .24s cubic-bezier(.22,1,.36,1), height .32s cubic-bezier(.22,1,.36,1)';
    dockEl.style.transform = '';
    dockEl.classList.remove('pull-ready');
    setTimeout(() => (dockEl.style.transition = ''), 260);
    if (go) back();
  }
  // לאן חוזרים מכל מצב (בניווט ובתכנון עם נקודות – שואלים קודם)
  function dockBack() {
    const m = dockMode();
    if (m === 'route') {
      if (active?.nav) return ask('לעצור את הניווט?', 'עצור', stopNav);
      return $('ri-back').click();
    }
    if (m === 'plan') return plan?.wps.length > 1 ? ask('לבטל את התכנון?', 'ביטול התכנון', endPlan) : endPlan();
    if (m === 'lib') return setLibOpen(false);
  }
  // שאלה קצרה בראש הדוק: כן / המשך
  function ask(text, yes, fn) {
    const a = $('dock-ask');
    a.querySelector('span').textContent = text;
    a.querySelector('.yes').textContent = yes;
    a.querySelector('.yes').onclick = () => { a.hidden = true; fn(); };
    a.querySelector('.no').onclick = () => (a.hidden = true);
    a.hidden = false;
  }
  function attachPullBack(el) {
    let y0 = null, moved = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input, button:not(.grip), .dh')) return;
      y0 = e.clientY; moved = false;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      if (!moved && dy < 8) return;
      moved = true;
      pullMove(dy);
    });
    const end = (e) => { if (y0 == null) return; const dy = e.clientY - y0; y0 = null; if (moved) pullEnd(dy, dockBack); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', (e) => { if (y0 != null) { y0 = null; pullEnd(0, dockBack); } });
  }
  function attachDockDrag(el) {
    let y0 = null, h0 = 0, full = 0, moved = false, track = [], pulling = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input, button:not(.grip)')) return;
      y0 = e.clientY; moved = false; pulling = false; track = [[e.clientY, e.timeStamp]];
      h0 = more.offsetHeight;
      full = more.scrollHeight;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      if (!moved && Math.abs(dy) < 6) return;
      if (!moved) pulling = h0 === 0 && dy > 0; // סגור ומושכים למטה – זו חזרה, לא פתיחה
      moved = true;
      if (pulling) return pullMove(dy);
      track.push([e.clientY, e.timeStamp]);
      if (track.length > 6) track.shift();
      more.style.transition = 'none';
      more.style.height = Math.max(0, Math.min(full, h0 - dy)) + 'px';
    });
    const end = (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      y0 = null;
      if (pulling) return pullEnd(dy, dockBack);
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
  for (const el of document.querySelectorAll('#dock .pull')) attachPullBack(el);

  // גובה הדוק נקבע לפי התוכן ועובר ברכות (בזמן גרירת פרטי המסלול – צמוד, בלי השהיה).
  // גם משתנה CSS, כדי שקנה המידה וזכויות היוצרים יישבו מעליו
  const dockIn = $('dock-in');
  new ResizeObserver(() => {
    const h = dockIn.offsetHeight;
    dockEl.style.height = h + 'px';
    document.documentElement.style.setProperty('--dock-h', h + 'px');
  }).observe(dockIn);
  renderDock();

  // ---------- משטח הכלים ("אולר"): נשלף מלמעלה; סגור – רק ☰; פותחים לרגע, ונסגר אחרי פעולה ----------
  // המשטח זז באמת: --k בין 0 (סגור) ל-1 (פתוח), ו---off הוא גובה הכלים שמעל ה-☰
  const knife = $('controls');
  const knifeItems = knife.querySelector('.kbody'); // הכלים והסליידר – מה שנשלף
  let knifeOpen = false;
  new ResizeObserver(() => knife.style.setProperty('--off', knifeItems.offsetHeight + 'px')).observe(knifeItems);
  function setKnife(on) {
    knifeOpen = on;
    knife.classList.toggle('open', on);
    knife.style.removeProperty('--k');
    $('btn-menu').setAttribute('aria-expanded', on);
  }
  // מתחת ל-☰ כשהמשטח סגור: צפון (כשהמפה מסובבת) ומרכוז (כש-GPS פועל והמפה זזה ממך אחרי מעקב)
  function updatePins() {
    $('pin-north').hidden = !(compassMode || Math.abs(map.getBearing()) > 0.5);
    $('pin-center').hidden = !(watchId != null && !follow && followedOnce);
  }
  map.on('rotate', updatePins);
  setInterval(updatePins, 1000); // מצב ה-GPS והמעקב משתנים בכמה מקומות; בדיקה זולה
  $('pin-north').addEventListener('click', () => $('btn-compass').click());
  $('pin-center').addEventListener('click', () => $('btn-locate').click());
  // גרירת ☰: כל המשטח זז עם האצבע; בעזיבה – פתוח או סגור לפי המקום ולפי מהירות התנועה. הקשה מחליפה
  (() => {
    const h = $('btn-menu');
    let y0 = null, moved = false, base = 0, k = 0, track = [];
    h.addEventListener('pointerdown', (e) => { y0 = e.clientY; moved = false; base = knifeOpen ? 1 : 0; track = [[e.clientY, e.timeStamp]]; h.setPointerCapture(e.pointerId); });
    h.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      const dy = e.clientY - y0;
      if (!moved && Math.abs(dy) < 6) return;
      moved = true;
      track.push([e.clientY, e.timeStamp]); if (track.length > 6) track.shift();
      knife.classList.add('dragging');
      k = Math.max(0, Math.min(1, base + dy / Math.max(1, knifeItems.offsetHeight)));
      knife.style.setProperty('--k', k);
    });
    const end = () => {
      if (y0 == null) return;
      y0 = null;
      knife.classList.remove('dragging');
      if (!moved) return setKnife(!knifeOpen);
      const [ya, ta] = track[0], [yb, tb] = track[track.length - 1];
      const v = (yb - ya) / Math.max(1, tb - ta);
      setKnife(Math.abs(v) > 0.3 ? v > 0 : k > 0.5);
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  })();
  // אחרי פעולה בכלים – המשטח נסגר
  for (const b of knife.querySelectorAll('.knife > button')) b.addEventListener('click', () => setTimeout(() => setKnife(false), 250));
  map.on('click', () => knifeOpen && setKnife(false));
  map.on('dragstart', () => knifeOpen && setKnife(false));

  // ---------- הפעלה ----------
  // שחזור המסלול הפעיל (וגם מסלול GPX מגרסה קודמת)
  Promise.all([db.get('active').catch(() => null), db.get('gpx').catch(() => null)]).then(([a, t]) => {
    if (a) setActive(a, { save: false });
    else if (t) showGpx(t, false);
  }).catch(console.error);
  if (navigator.storage?.persist) navigator.storage.persist();
  navigator.permissions?.query({ name: 'geolocation' }).then((s) => {
    if (s.state === 'granted') startGps();
  }).catch(() => {});
})();
