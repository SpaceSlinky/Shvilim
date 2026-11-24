/* שבילים – ניווט אופליין במסלולי הליכה (מפה וקטורית מ-OpenStreetMap). */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
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
  // רמות הגריד המאוחד: m = כמה ריבועים בצלע; op = עצירות [זום, שקיפות] – נכנס כשהרמה שמעליו יוצאת (פייד מוצלב)
  const GRID_LEVELS = [
    { m: 6, op: [5, 0, 5.4, 0.5, 8.4, 0.5, 9.2, 0] }, // 0.6° – שלוש עמודות לרוחב כל ישראל, קבוע מהזום הכי רחוק
  ];
  const zw = (a, b) => ['interpolate', ['exponential', 1.5], ['zoom'], 11, a, 16, b];
  // כמו zw, אבל הערך בכל זום מחושב לפי המאפיינים של הקו (fn מקבל את הרוחב הבסיסי)
  const zwShared = (a, b, fn) => ['interpolate', ['exponential', 1.5], ['zoom'], 11, fn(a), 16, fn(b)];
  const SN = ['coalesce', ['get', 'sn'], 1], SI = ['coalesce', ['get', 'si'], 0], SHARED_W = 0.85, SHARED_STEP = 1.35; // רוחב כל קו, והמרחק בין קווים (פס לבן ביניהם)
  // ההזזה הצידה של קו בקטע משותף – זהה לשבילים במפה ולמסלול שעליהם. tf (0–1): בקצוות של קטע משותף ההזזה
  // עולה בהדרגה (taperSplit) – אחרת יש "מדרגה" במקום שבו הקו עובר מהאמצע לצד
  const SHARED_V = ['*', ['-', SI, ['/', ['-', SN, 1], 2]], ['coalesce', ['get', 'tf'], 1]];
  const SHARED_OFFSET = zwShared(1.5, 4.5, (w) => ['*', w * SHARED_STEP, SHARED_V]);
  const halo = { 'text-halo-color': '#fff', 'text-halo-width': 1.6 };
  const empty = { type: 'FeatureCollection', features: [] };

  // דהייה לפי זום: מופיע בין z0 ל-z1 (שקיפות 0 → max). המפה המפורטת מתרוקנת בשלבים בהתרחקות
  const fade = (z0, z1, max = 1) => ['interpolate', ['linear'], ['zoom'], z0, 0, z1, max];
  // המעטפת: מופיעה 8.5–9, נעלמת 10.3–11 (בדיוק כשהשבילים המסומנים מופיעים, 10–10.7)
  // הנקודה והשם מרחוק – מלאים עד 8.6, נעלמים עד 9.2 (בדיוק כשהמעטפת והשם בתוכה מופיעים)
  const DOT_FADE = ['interpolate', ['linear'], ['zoom'], 8.6, 1, 9.2, 0];
  const ENV_FADE = (max) => ['interpolate', ['linear'], ['zoom'], 8.5, 0, 9, max, 10.3, max, 11, 0];
  const FADES = { // שכבה: [מתחיל להופיע, מלא]
    'minor-casing': [11.5, 12], minor: [11.5, 12], path: [11.5, 12], track: [11, 11.5], bike: [11, 11.5],
    water: [10.5, 11], 'medium-casing': [10.5, 11.2], medium: [10.5, 11.2], 'major-casing': [10.5, 11.2], major: [10.5, 11.2],
    'trail-casing': [10, 10.7], trail: [10, 10.7],
  };
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
      // תצלום אוויר: דרך esrifb:// – איפה שיש רזולוציה גבוהה מציגים אותה; איפה ש-Esri מחזיר תמונת
      // "Map data not yet available" – מגדילים את החלק המתאים מהרמה הקודמת שיש בה צילום (מפוקסל, אבל אמיתי)
      sat: { type: 'raster', tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri', tiles: ['esrifb://{z}/{y}/{x}'] },
      overview: { type: 'geojson', data: empty }, // israel.json – כל הארץ, רק בזום רחוק
      'areas-env': { type: 'geojson', data: empty }, // מעטפת האזורים שהורדו (updateEnvelope)
      'dl-grid': { type: 'geojson', data: empty }, // ריבועי ההורדה שעוד חסרים (checkArea)
      'areas-del': { type: 'geojson', data: empty }, // מפות שמורות: האזורים שהורדו, כשרואים את כל הארץ (renderAreasMap)
      'dl-grid-c': { type: 'geojson', data: empty }, // הגריד המאוחד (2×2, 4×4, 8×8 ריבועים) – כך שבכל זום יש גריד על המפה
      scrub: { type: 'geojson', data: empty },
      detour: { type: 'geojson', data: empty },
      walked: { type: 'geojson', data: empty },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e6e1d1' } },
      // תצלום אוויר מתחת למפה – במקום הרקע (חצי העליון של הסליידר)
      { id: 'base-sat', type: 'raster', source: 'sat', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 150, 'raster-opacity': 0 } },
      // מפה כללית של כל הארץ (israel.json, מגיעה עם האפליקציה). הים, מפרץ אילת, הכנרת וים המלח – בכל זום (במפות האזורים
      // אין ים); קו חוף, גבול ושמות יישובים (בלי כבישים). הכול בין שתי שכבות התצלום – הסליידר עובד עליהן כמו על השבילים
      { id: 'ov-sea', type: 'fill', source: 'overview', filter: k('w'), paint: { 'fill-color': '#aad3df' } },
      { id: 'ov-coast', type: 'line', source: 'overview', maxzoom: 10, filter: k('c'), paint: { 'line-color': '#7fa7c9', 'line-width': 1.2 } },
      // קו הגבול – רציף וברור (קו המתאר של הארץ)
      { id: 'ov-border', type: 'line', source: 'overview', maxzoom: 10, filter: k('b'), layout: { 'line-join': 'round' },
        paint: { 'line-color': '#7a6f80', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.4, 12, 2.2] } },
      // מעטפת המפות שהורדו (זום בינוני): כשהשבילים דוהים בהתרחקות – נשאר קו סביב האזורים השמורים (איחוד, בלי קווים
      // פנימיים), עם גוון קל ושם; בהתרחקות נוספת גם היא נעלמת (ובהתקרבות – מתחלפת בשבילים עצמם)
      { id: 'env-fill', type: 'fill', source: 'areas-env', filter: ['==', ['geometry-type'], 'Polygon'], minzoom: 8.5, maxzoom: 11,
        paint: { 'fill-color': '#2e7d4f', 'fill-antialias': false, 'fill-opacity': ENV_FADE(0.1) } },
      { id: 'env-line', type: 'line', source: 'areas-env', filter: ['==', ['geometry-type'], 'LineString'], minzoom: 8.5, maxzoom: 11,
        layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#2e7d4f', 'line-width': 1.6, 'line-opacity': ENV_FADE(0.9) } },
      { id: 'ad-fill', type: 'fill', source: 'areas-del', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['case', ['==', ['get', 'sel'], 1], '#c62828', '#2e7d4f'], 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['==', ['get', 'sel'], 1], 0.5, 0.32], 12.5, ['case', ['==', ['get', 'sel'], 1], 0.25, 0.08]] } },
      { id: 'ad-line', type: 'line', source: 'areas-del', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': ['case', ['==', ['get', 'sel'], 1], '#c62828', ['==', ['get', 'upd'], 1], '#f9a825', '#2e7d4f'], 'line-width': ['case', ['==', ['get', 'upd'], 1], 2.5, 1.5] } },
      { id: 'ad-label', type: 'symbol', source: 'areas-del', filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 14, 'text-allow-overlap': true },
        paint: { 'text-color': '#1f5f3a', 'text-halo-color': '#fff', 'text-halo-width': 1.2, 'text-halo-blur': 0.5 } },
      // הגריד תמיד על המפה וידוע מראש (buildGrids – לא מתעדכן בזום ובתנועה): מרחוק – 0.6°, ומזום ~8.4 הוא מתחלף
      // בפייד בריבועי ההורדה הרגילים (רק החסרים)
      { id: 'dl-grid', type: 'line', source: 'dl-grid', minzoom: 8.2,
        paint: { 'line-color': '#6b6470', 'line-width': 1, 'line-dasharray': [4, 3], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 8.4, 0, 9.2, 0.55] } },
      ...GRID_LEVELS.map(({ m, op }) => ({ id: 'dl-grid-' + m, type: 'line', source: 'dl-grid-c', filter: ['==', ['get', 'm'], m], maxzoom: 9.4,
        paint: { 'line-color': '#6b6470', 'line-width': 1, 'line-dasharray': [4, 3], 'line-opacity': ['interpolate', ['linear'], ['zoom'], ...op] } })),
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
      // שביל לאופניים בלבד (סינגל) – כתום, כדי שיהיה ברור שלא נכנסים אליו ברגל
      { id: 'path', type: 'line', source: 'osm', filter: road('path'), minzoom: 12,
        paint: { 'line-color': ['case', ['==', ['get', 'b'], 1], '#f57c00', '#4a3d30'], 'line-width': zw(0.6, 1.8), 'line-dasharray': [2, 1.5] } },
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
      { id: 'poi-icon', type: 'symbol', source: 'osm', filter: ['all', k('poi'), ['!=', ['get', 't'], 'peak'], ['!=', ['get', 't'], 'parking']], minzoom: 12.5,
        layout: { 'icon-image': ['concat', 'poi-', ['get', 't']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 12.5, 0.5, 16, 0.85],
          'icon-padding': 1, 'icon-allow-overlap': ['step', ['zoom'], false, 15.5, true] } },
      { id: 'poi-label', type: 'symbol', source: 'osm', filter: ['all', k('poi'), ['has', 'n'], ['!=', ['get', 't'], 'peak'], ['!=', ['get', 't'], 'parking']], minzoom: 14,
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 1.3],
          'text-max-width': 8, 'text-optional': true },
        paint: { 'text-color': '#333', ...halo } },
      // חניונים – בקבוצת "עירוני"
      { id: 'parking-icon', type: 'symbol', source: 'osm', filter: ['all', k('poi'), ['==', ['get', 't'], 'parking']], minzoom: 12.5,
        layout: { 'icon-image': 'poi-parking', 'icon-size': ['interpolate', ['linear'], ['zoom'], 12.5, 0.5, 16, 0.85],
          'icon-padding': 1, 'icon-allow-overlap': ['step', ['zoom'], false, 15.5, true] } },
      { id: 'parking-label', type: 'symbol', source: 'osm', filter: ['all', k('poi'), ['has', 'n'], ['==', ['get', 't'], 'parking']], minzoom: 14,
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
      // שמות: בזום רחוק – רק ערים מרכזיות (m, ~24 לכל הארץ, להתמצאות), ולא בתוך אזור שהורד (שם – רק שם האזור);
      // מקרוב (11+) מחוץ לאזורים – כל היישובים. כל יישוב אחר – בחיפוש. הגדולים קודמים בהתנגשות (symbol-sort-key)
      { id: 'ov-city', type: 'symbol', source: 'ov-cities', maxzoom: 11,
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-max-width': 8, 'text-size': 13.5,
          'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'pop'], 0]] },
        paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } },
      { id: 'ovh-place', type: 'symbol', source: 'overview-hi', minzoom: 11, filter: k('p'),
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-max-width': 8, 'text-size': 12.5,
          'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'pop'], 0]] },
        paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.6 } },
      // מרחוק (מתחת לזום 9, עד הזום הכי רחוק): כל אזור שהורד – נקודה ירוקה עם השם; קרוב יותר – המעטפת והשם בתוכה
      { id: 'env-dot', type: 'circle', source: 'areas-env', filter: ['==', ['geometry-type'], 'Point'], maxzoom: 9.2,
        paint: { 'circle-radius': 5, 'circle-color': '#2e7d4f', 'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff',
          'circle-opacity': DOT_FADE, 'circle-stroke-opacity': DOT_FADE } },
      { id: 'env-dot-label', type: 'symbol', source: 'areas-env', filter: ['==', ['geometry-type'], 'Point'], maxzoom: 9.2,
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 13, 'text-anchor': 'right', 'text-offset': [-0.7, 0],
          'text-allow-overlap': true },
        paint: { 'text-color': '#1f5f3a', 'text-halo-color': 'rgba(255,255,255,.8)', 'text-halo-width': 1, 'text-halo-blur': 0.5, 'text-opacity': DOT_FADE } },
      { id: 'env-label', type: 'symbol', source: 'areas-env', filter: ['==', ['geometry-type'], 'Point'], minzoom: 8.5, maxzoom: 11,
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 13, 'text-allow-overlap': true },
        paint: { 'text-color': '#1f5f3a', 'text-halo-color': '#fff', 'text-halo-width': 1, 'text-halo-blur': 0.5, 'text-opacity': ENV_FADE(1) } },
      { id: 'place-major', type: 'symbol', source: 'osm', minzoom: 11,
        filter: ['all', k('place'), ['in', ['get', 't'], ['literal', ['city', 'town', 'village']]]],
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-max-width': 8,
          'text-size': ['match', ['get', 't'], ['city', 'town'], 17, 15] },
        paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 2 } },
      // תצלום אוויר מעל כל המפה (חצי התחתון של הסליידר); המסלול, הנקודות והמיקום – מעליו
      { id: 'sat-top', type: 'raster', source: 'sat', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 150, 'raster-opacity': 0 } },
      // מסלול פעיל: המפה מתחתיו דוהה, והמסלול מצויר בצבעי השבילים עם מסגרת לבנה (בלי קו מתאר כהה)
      { id: 'dim', type: 'fill', source: 'dim', layout: { visibility: 'none' }, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.55 } },
      { id: 'route-casing', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['case', ['==', ['get', 'c'], '#ffffff'], '#3a3a3a', '#ffffff'], 'line-width': zw(4, 8.5), 'line-offset': SHARED_OFFSET } },
      { id: 'route-line', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        // שביל לבן – אפור בהיר עם מסגרת כהה; בהדגשה (גרירה על הגרף) – לבן מלא עם מסגרת לבנה
        paint: { 'line-color': ['case', ['==', ['get', 'c'], '#ffffff'], '#d3d6d9', ['coalesce', ['get', 'c'], '#d4148f']], 'line-width': zw(2.4, 5), 'line-offset': SHARED_OFFSET,
          'line-dasharray': ['case', ['==', ['get', 'h'], 'free'], ['literal', [1, 1]], ['literal', [1, 0]]] } },
      // מה שכבר הלכת: קו בצבע הרקע מעל המסלול, כך שהחלק הזה נראה דהוי
      { id: 'route-walked', type: 'line', source: 'walked', layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.65, 'line-width': zw(4, 8.5), 'line-offset': SHARED_OFFSET } },
      // נקודות המסלול
      { id: 'route-ends', type: 'circle', source: 'route', filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 5.5, 'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
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
      // האצבע על הגרף: הקטע המסומן – רצועה מלאה בצבע השביל לכל הרוחב (בלי מסגרת לבנה; שביל לבן – לבן עם קו מתאר כהה דק),
      // ושאר המסלול דוהה בינתיים (SCRUB_FADE);
      // אצבע אחת – שברון לבן בקצה שזז עם האצבע, בכיוון ההליכה; שתי אצבעות – שני קווים לבנים ניצבים בקצוות הטווח
      { id: 'scrub-glow-casing', type: 'line', source: 'scrub', filter: ['==', ['get', 'k'], 'hl'], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['case', ['==', ['get', 'c'], '#ffffff'], '#3a3a3a', ['coalesce', ['get', 'c'], '#d4148f']], 'line-width': zw(4, 8.5), 'line-offset': SHARED_OFFSET } },
      { id: 'scrub-glow', type: 'line', source: 'scrub', filter: ['==', ['get', 'k'], 'hl'], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['case', ['==', ['get', 'c'], '#ffffff'], '#ffffff', ['coalesce', ['get', 'c'], '#d4148f']],
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, ['case', ['==', ['get', 'c'], '#ffffff'], 2.8, 4], 16, ['case', ['==', ['get', 'c'], '#ffffff'], 6.6, 8.5]],
          'line-offset': SHARED_OFFSET } },
      { id: 'scrub-mark', type: 'symbol', source: 'scrub', filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'icon-image': ['get', 'k'], 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true, 'icon-ignore-placement': true } },
      { id: 'acc', type: 'fill', source: 'acc',
        paint: { 'fill-color': '#1e88e5', 'fill-opacity': 0.12, 'fill-outline-color': '#1e88e5' } },
    ],
  };
  // המפה הכללית מעבר לזום 10: איפה שאין מפה שמורה היא ממשיכה להופיע (אחרת – מסך ריק), מתוך עותק שממנו נחתכו
  // האזורים השמורים (overview-hi, `updateOverviewHi`) – שם יש מפה מפורטת, וכבישים מפושטים היו מצוירים כפולים לידה
  style.sources['overview-hi'] = { type: 'geojson', data: empty };
  style.sources['ov-cities'] = { type: 'geojson', data: empty };
  for (const l of style.layers) {
    const f = FADES[l.id];
    if (!f) continue;
    l.minzoom = f[0];
    l.paint['line-opacity'] = fade(f[0], f[1], typeof l.paint['line-opacity'] === 'number' ? l.paint['line-opacity'] : 1);
  }
  style.layers = style.layers.flatMap((l) => {
    if (l.id !== 'ov-coast' && l.id !== 'ov-border') return [l]; // רק קווי המתאר ממשיכים מקרוב
    const hi = { ...l, id: 'ovh-' + l.id.slice(3), source: 'overview-hi', minzoom: 10 };
    delete hi.maxzoom;
    return [l, hi];
  });

  // ---------- מפה ----------
  // תוסף ה-RTL נטען מה-thread הראשי (דרך המטמון האופליין) ומועבר ל-MapLibre כ-blob,
  // כדי לא להסתמך על כך שה-Web Workers של MapLibre עוברים דרך ה-Service Worker.
  fetch(RTL_PLUGIN)
    .then((r) => (r.ok ? r.blob() : Promise.reject(r.status)))
    .then((b) => maplibregl.setRTLTextPlugin(URL.createObjectURL(b), false))
    .catch((e) => console.error('RTL plugin', e));

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('view')); } catch { /* ignore */ }

  // ---------- תצלום אוויר: תמונת "אין נתונים" של Esri → הרמה הקודמת ----------
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/';
  async function esriImage(z, y, x, signal, depth = 0) {
    const res = await fetch(`${ESRI}${z}/${y}/${x}`, { signal });
    if (!res.ok) throw new Error('esri ' + res.status);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    // התמונה של Esri כשאין צילום: רקע אפור אחיד (204,204,204) עם כיתוב בהיר – בודקים דגימה של פיקסלים
    const c = new OffscreenCanvas(32, 32), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    let gray = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 204) < 6 && Math.abs(d[i + 1] - 204) < 6 && Math.abs(d[i + 2] - 204) < 6) gray++;
    const missing = gray > 0.6 * 32 * 32;
    if (!missing || z <= 10 || depth >= 4) return { bmp, blob };
    // הרמה הקודמת: הרבע המתאים, מוגדל לגודל אריח
    const up = await esriImage(z - 1, y >> 1, x >> 1, signal, depth + 1);
    const out = new OffscreenCanvas(256, 256), og = out.getContext('2d');
    og.imageSmoothingEnabled = true;
    const sw = up.bmp.width / 2, sh = up.bmp.height / 2;
    og.drawImage(up.bmp, (x & 1) * sw, (y & 1) * sh, sw, sh, 0, 0, 256, 256);
    const ob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    return { bmp: await createImageBitmap(ob), blob: ob };
  }
  maplibregl.addProtocol?.('esrifb', async (params, ac) => {
    const [z, y, x] = params.url.replace('esrifb://', '').split('/').map(Number);
    const { blob } = await esriImage(z, y, x, ac?.signal);
    return { data: await blob.arrayBuffer() };
  });

  const map = new maplibregl.Map({
    container: 'map',
    style,
    // פתיחה ראשונה – כל הארץ (מתוקן מיד ל-israelMinZoom); אחר כך – איפה שהיית
    center: saved?.center || [35.0, 31.4],
    zoom: saved?.zoom || 6,
    minZoom: 6, // מעודכן מיד לפי גודל המסך (israelMinZoom)
    maxZoom: 19,
    dragRotate: true,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: false, // הקרדיטים – בחלון השכבות
  });
  map.touchPitch?.disable?.();
  // זום אאוט נגמר כשכל ישראל (מאילת עד החרמון) על המסך – לפי גודל המסך, מעל הדוק הסגור
  const ISRAEL = [[34.2, 29.45], [35.95, 33.35]];
  // וגם תזוזה: אי אפשר לגרור אל מחוץ למעטפת של כל הארץ – המלבן שרואים בזום הכי רחוק (setMaxBounds)
  let farCam = null; // המצלמה של "כל הארץ" (מעודכן ב-israelMinZoom)
  function israelMinZoom() {
    const cam = map.cameraForBounds(ISRAEL, { padding: { top: 70, bottom: 100, left: 10, right: 10 } });
    if (!cam || !isFinite(cam.zoom)) return cam;
    const z = Math.max(4, Math.min(9, cam.zoom));
    const { width: W, height: H } = map.getCanvas().getBoundingClientRect();
    const c0 = maplibregl.LngLat.convert(cam.center), COL = 0.6; // הגריד הרחוק סימטרי: מרכז המסך = מרכז עמודה (לא פס גריד)
    const c = new maplibregl.LngLat((Math.floor(c0.lng / COL) + 0.5) * COL, c0.lat);
    cam.center = c;
    const scale = (512 * 2 ** z) / (2 * Math.PI) / 1.01; // פיקסלים לרדיאן (+1% מרווח)
    const my = Math.log(Math.tan(Math.PI / 4 + (c.lat * Math.PI) / 360));
    const lat = (y) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
    const dLon = (W / 2 / scale) * (180 / Math.PI);
    map.setMaxBounds(null);
    map.setMinZoom(z);
    map.setMaxBounds([[c.lng - dLon, lat(my - H / 2 / scale)], [c.lng + dLon, lat(my + H / 2 / scale)]]);
    farCam = cam;
    return cam;
  }
  const israelCam = israelMinZoom();
  if (!saved && israelCam) map.jumpTo(israelCam); // פתיחה ראשונה – כל הארץ
  map.on('resize', israelMinZoom);
  // בזום הכי רחוק – מפת ישראל ישרה וקבועה: בלי סיבוב ובלי גרירה (הכול על המסך ממילא). ננעל כשהזום נגמר (zoomend),
  // ומשתחרר ברגע שמתקרבים – לא באמצע מחווה
  const FAR_EPS = 0.25;
  let farLocked = false;
  const isFar = () => map.getZoom() <= map.getMinZoom() + FAR_EPS;
  // סיבוב בזמן זום אאוט: מותר רק כשהמלבן המסובב של המסך עדיין נכנס בתוך מה שרואים בזום הכי רחוק (קרופ נכון של ישראל).
  // בזום הכי רחוק – 0 (ישרה), ומשם הזווית המותרת גדלה עד שאין הגבלה (ממש מעט אחרי שהמפה מגדילה פי ~2.3)
  let clampingBearing = false;
  function maxBearing(z) {
    const k = 2 ** (z - map.getMinZoom()), { width: W, height: H } = map.getCanvas().getBoundingClientRect();
    let ok = 0;
    for (let a = 1; a <= 90; a++) {
      const t = (a * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t);
      if (W * c + H * sn <= W * k + 1e-6 && W * sn + H * c <= H * k + 1e-6) ok = a; else break;
    }
    return ok >= 90 ? 180 : ok;
  }
  function clampBearing() {
    if (clampingBearing) return;
    const lim = maxBearing(map.getZoom());
    if (lim >= 180) return;
    let b = map.getBearing();
    b = ((b + 540) % 360) - 180; // (-180, 180]
    if (Math.abs(b) <= lim + 0.01) return;
    clampingBearing = true;
    // לא map.setBearing – הוא עוצר את אנימציית הזום (הזום "נתקע" באמצע התרחקות בהטלה). משנים ישירות את המצלמה
    if (map.transform?.setBearing) { map.transform.setBearing(Math.sign(b) * lim); map.triggerRepaint(); } else map.setBearing(Math.sign(b) * lim);
    clampingBearing = false;
  }
  map.on('move', clampBearing);
  function syncFarLock() {
    const far = isFar();
    if (far === farLocked) return;
    farLocked = far;
    if (far) {
      map.dragPan.disable();
      if (typeof compassMode !== 'undefined' && compassMode) { compassMode = false; updateCompassIcon(); }
      if (farCam) { // מיישרים: איפה שכל הארץ בדיוק על המסך
        const c = maplibregl.LngLat.convert(farCam.center), m = map.getCenter();
        if (map.getZoom() > map.getMinZoom() + 0.01 || Math.abs(m.lng - c.lng) > 1e-4 || Math.abs(m.lat - c.lat) > 1e-4)
          map.easeTo({ center: c, zoom: map.getMinZoom(), bearing: 0, duration: 350 });
      }
    } else {
      map.dragPan.enable();
    }
  }
  map.once('load', syncFarLock);
  map.on('zoomend', syncFarLock);
  map.on('moveend', syncFarLock);
  map.on('resize', () => { farLocked = !isFar(); syncFarLock(); });
  // מפה כללית של כל הארץ – קובץ שמגיע עם האפליקציה (במטמון; מתעדכן עם כל גרסה)
  let overviewFC = null;
  fetch('israel.json').then((r) => (r.ok ? r.json() : null)).then(async (fc) => {
    if (!fc?.features) return;
    overviewFC = fc;
    searchIndex = null;
    await mapReady;
    map.getSource('overview')?.setData(fc);
    updateOverviewHi();
  }).catch(() => {});
  // מעטפת האזורים שהורדו: איחוד המלבנים (רשת לפי כל קווי הקצה) – משטח (תאים), קו המתאר (רק צלעות שבצד השני שלהן
  // אין אזור) ושם לכל קבוצה מחוברת (של האזור הגדול בה, במרכזו). נגיעה – מתקרבים לקבוצה
  let envGroups = [];
  // מרכז המעטפת של קבוצת משבצות: מרכז המלבן החוסם; אם הוא מחוץ למשבצות (צורת L) – מרכז המשבצת הקרובה אליו
  function groupCenter(g) {
    const c = [(g.bbox[0] + g.bbox[2]) / 2, (g.bbox[1] + g.bbox[3]) / 2];
    if (g.areas.some(({ b }) => c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3])) return c;
    let best = null, bd = Infinity;
    for (const { b } of g.areas) { const m = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], d = Math.hypot(m[0] - c[0], m[1] - c[1]); if (d < bd) { bd = d; best = m; } }
    return best || c;
  }
  function updateEnvelope() {
    const boxes = dlAreas().map((a) => a.b);
    const xs = [...new Set(boxes.flatMap((b) => [b[0], b[2]]))].sort((a, b) => a - b);
    const ys = [...new Set(boxes.flatMap((b) => [b[1], b[3]]))].sort((a, b) => a - b);
    const cov = (i, j) => i >= 0 && j >= 0 && i < xs.length - 1 && j < ys.length - 1
      && boxes.some((b) => b[0] <= xs[i] && b[2] >= xs[i + 1] && b[1] <= ys[j] && b[3] >= ys[j + 1]);
    const feats = [];
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
      if (!cov(i, j)) continue;
      const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } });
      const edge = (a, b) => feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [a, b] } });
      if (!cov(i, j - 1)) edge([x0, y0], [x1, y0]);
      if (!cov(i, j + 1)) edge([x0, y1], [x1, y1]);
      if (!cov(i - 1, j)) edge([x0, y0], [x0, y1]);
      if (!cov(i + 1, j)) edge([x1, y0], [x1, y1]);
    }
    envGroups = areaGroups();
    for (const g of envGroups) {
      feats.push({ type: 'Feature', properties: { n: g.name }, geometry: { type: 'Point', coordinates: groupCenter(g) } });
    }
    map.getSource('areas-env')?.setData({ type: 'FeatureCollection', features: feats });
  }
  map.on('click', 'env-fill', (e) => {
    if (areasMode || map.getZoom() >= 10.8) return;
    const { lng, lat } = e.lngLat;
    const g = envGroups.find((x) => lng >= x.bbox[0] && lng <= x.bbox[2] && lat >= x.bbox[1] && lat <= x.bbox[3]);
    if (g) map.fitBounds([[g.bbox[0], g.bbox[1]], [g.bbox[2], g.bbox[3]]], { padding: 40, duration: 900 });
  });
  // עותק של המפה הכללית בלי מה שבתוך אזורים שמורים (מלבנים): קווים נחתכים בגבול, נקודות שבתוכם – בחוץ
  function updateOverviewHi() {
    if (!overviewFC) return;
    const boxes = (() => { try { return JSON.parse(localStorage.getItem('dlAreas')) || []; } catch { return []; } })().map((a) => a.b);
    const inBoxP = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
    // חלקי קו מחוץ למלבן (Liang–Barsky לכל קטע)
    const outside = (line, b) => {
      const out = [];
      let cur = [];
      const flush = () => { if (cur.length > 1) out.push(cur); cur = []; };
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], c = line[i], dx = c[0] - a[0], dy = c[1] - a[1];
        let t0 = 0, t1 = 1, hit = true;
        for (const [p, q] of [[-dx, a[0] - b[0]], [dx, b[2] - a[0]], [-dy, a[1] - b[1]], [dy, b[3] - a[1]]]) {
          if (p === 0) { if (q < 0) { hit = false; break; } } else { const r = q / p; if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r); }
        }
        if (!hit || t0 >= t1) { if (!cur.length) cur.push(a); cur.push(c); continue; }
        const at = (t) => [a[0] + dx * t, a[1] + dy * t];
        if (t0 > 0) { if (!cur.length) cur.push(a); cur.push(at(t0)); }
        flush();
        if (t1 < 1) cur.push(at(t1), c);
      }
      flush();
      return out;
    };
    const feats = [];
    for (const f of overviewFC.features) {
      if (f.properties.k === 'w') continue;
      if (f.geometry.type === 'Point') { if (!boxes.some((b) => inBoxP(f.geometry.coordinates, b))) feats.push(f); continue; }
      let lines = [f.geometry.coordinates];
      for (const b of boxes) lines = lines.flatMap((l) => outside(l, b));
      for (const l of lines) feats.push({ type: 'Feature', properties: f.properties, geometry: { type: 'LineString', coordinates: l } });
    }
    map.getSource('overview-hi')?.setData({ type: 'FeatureCollection', features: feats });
    // ערים מרכזיות (זום רחוק) – לא בתוך אזור שהורד (שם מוצג רק שם האזור)
    map.getSource('ov-cities')?.setData({ type: 'FeatureCollection',
      features: overviewFC.features.filter((f) => f.properties.m && !boxes.some((b) => inBoxP(f.geometry.coordinates, b))) });
  }
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 100 }), 'bottom-left');
  map.on('moveend', () => {
    try {
      const c = map.getCenter();
      localStorage.setItem('view', JSON.stringify({ center: [c.lng, c.lat], zoom: map.getZoom() }));
    } catch { /* ignore */ }
  });
  map.on('styleimagemissing', (e) => {
    if (map.hasImage(e.id)) return;
    if (e.id.startsWith('poi-')) map.addImage(e.id, poiIcon(e.id.slice(4)), { pixelRatio: 2 });
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
  mapReady.then(() => (PERF.style = performance.now()));

  // ---------- נתוני המפה: הורדה חד-פעמית ושמירה בטלפון ----------
  // הורדה אחת בכל פעם. עדכון שקט ברקע מפנה את הדרך כשהמשתמש מבקש משהו
  let dlJob = null; // { quiet, ctl, done }
  let dlErr = ''; // ההורדה האחרונה של אזור נכשלה – הסיבה מוצגת על הכפתור
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  // quiet: עדכון ברקע בלי הודעות; area: אזור חדש – ההתקדמות על הכפתור במרכז המסך
  async function downloadArea(bbox, { quiet = false, area = false, cells = null } = {}) {
    if (dlJob) {
      if (quiet || !dlJob.quiet) return;
      dlJob.ctl.abort(new DOMException('הופסק', 'AbortError'));
      await dlJob.done;
    }
    if (!navigator.onLine) return quiet || area ? undefined : toast('אין חיבור לאינטרנט');
    const ctl = new AbortController();
    const job = { quiet, ctl };
    job.done = runDownload(bbox, { quiet, area, cells, signal: ctl.signal }).finally(() => { if (dlJob === job) dlJob = null; });
    dlJob = job;
    return job.done;
  }
  async function runDownload(bbox, { quiet, area, cells, signal }) {
    const say = (m, ms) => { if (area) { dlMsg = m; placeDlHere(); } else if (!quiet) toast(m, ms); };
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
      for (const c of cells || [bbox]) markArea(c); // הורדה בריבועים – כל ריבוע נרשם לבד
      areasChanged();
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
  // חלוקת קו כך שההזזה הצידה עולה בהדרגה בהתחלה (t0) ו/או יורדת בסוף (t1): 4 חלקים לאורך ~20 מ' בכל קצה,
  // tf = 0, ¼, ½, ¾ – בקצה עצמו ההזזה 0, כמו הקו שממשיך ממנו
  const TAPER_M = 20, TAPER_N = 4;
  function taperSplit(coords, t0, t1) {
    if (!t0 && !t1) return [{ coords, tf: 1 }];
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + Geo.haversine(coords[i - 1], coords[i]));
    const L = cum[cum.length - 1];
    if (L < 1) return [{ coords, tf: 1 }];
    const tl = Math.min(TAPER_M, L / ((t0 ? 1 : 0) + (t1 ? 1 : 0)) * 0.8);
    const at = (d) => {
      let j = 1;
      while (j < cum.length - 1 && cum[j] < d) j++;
      const seg = cum[j] - cum[j - 1], t = seg ? (d - cum[j - 1]) / seg : 0;
      return [coords[j - 1][0] + (coords[j][0] - coords[j - 1][0]) * t, coords[j - 1][1] + (coords[j][1] - coords[j - 1][1]) * t];
    };
    const cut = (a, b) => {
      const line = [at(a)];
      for (let j = 0; j < coords.length; j++) if (cum[j] > a && cum[j] < b) line.push(coords[j]);
      line.push(at(b));
      return line;
    };
    const parts = [];
    const step = tl / TAPER_N;
    if (t0) for (let j = 0; j < TAPER_N; j++) parts.push([j * step, (j + 1) * step, j / TAPER_N]);
    parts.push([t0 ? tl : 0, t1 ? L - tl : L, 1]);
    if (t1) for (let j = TAPER_N - 1; j >= 0; j--) parts.push([L - (j + 1) * step, L - j * step, j / TAPER_N]);
    return parts.filter(([a, b]) => b - a > 0.01).map(([a, b, tf]) => ({ coords: cut(a, b), tf }));
  }
  const sharedV = (p) => (p.sn > 1 ? p.si - (p.sn - 1) / 2 : 0);
  // שבילים מסומנים במפה: קטע משותף שממשיך לקו בהזזה אחרת (שביל רגיל, או קטע משותף שההזזה שלו לצד השני) – מחודד בקצה
  function taperTrails(fc) {
    const ends = new Map(); // נקודת קצה + צבע → [{v, start}]
    const key = (p, c) => p[0].toFixed(7) + ',' + p[1].toFixed(7) + c;
    for (const f of fc.features) {
      if (f.properties.k !== 'trail' || f.geometry.type !== 'LineString') continue;
      const c = f.geometry.coordinates, v = sharedV(f.properties);
      for (const [p, start] of [[c[0], true], [c[c.length - 1], false]]) {
        const kk = key(p, f.properties.c);
        if (!ends.has(kk)) ends.set(kk, []);
        ends.get(kk).push({ f, v, start });
      }
    }
    const out = [];
    for (const f of fc.features) {
      const v = f.properties.k === 'trail' && f.geometry.type === 'LineString' ? sharedV(f.properties) : 0;
      if (!v) { out.push(f); continue; }
      const c = f.geometry.coordinates;
      // ממשיך בלי מדרגה: שכן באותו צבע שההזזה שלו – בכיוון של הקו הזה – זהה
      const smooth = (p, atStart) => (ends.get(key(p, f.properties.c)) || []).some((n) => n.f !== f && (n.start === atStart ? -n.v : n.v) === v);
      const t0 = !smooth(c[0], true), t1 = !smooth(c[c.length - 1], false);
      for (const x of taperSplit(c, t0, t1)) out.push({ type: 'Feature', properties: x.tf === 1 ? f.properties : { ...f.properties, tf: x.tf }, geometry: { type: 'LineString', coordinates: x.coords } });
    }
    return { ...fc, features: out };
  }
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
  // זמני פתיחה (לחלון הפיתוח): מתי הנתונים נקראו מהטלפון, נשלחו למפה, והמפה מוכנה
  const PERF = {};
  function showPerf() {
    const f = (v) => (v != null ? (v / 1000).toFixed(1) + ' ש\'' : '–');
    $('ls-perf').textContent = `פתיחה: מפה ${f(PERF.style)} · נתונים מהטלפון ${f(PERF.data)} · עיבוד ${f(PERF.sent && PERF.data != null ? PERF.sent - PERF.data : null)} · מוכן ${f(PERF.ready)}`
      + (mapFC ? ` · ${mapFC.features.length.toLocaleString()} קווים ונקודות` : '');
  }
  async function setMapData(fc) {
    updateOverviewHi(); // האזורים השמורים השתנו (הורדה / מחיקה)
    if (PERF.data == null) PERF.data = performance.now();
    const trailGeoms = markShared(fc);
    buildSharedIdx(fc);
    pieceCache = null; // הקטעים המשותפים השתנו
    mapFC = fc;
    updateEnvelope(); // אחרי mapFC – שמות האזורים לפי היישובים שבהם
    searchIndex = null;
    const lvl = smoothLevel();
    smoother = lvl ? Geo.makeSmoother(fc, lvl) : null;
    if (!lvl) return map.getSource('osm').setData(taperTrails(fc));
    // פעם אחת בלבד (לא קודם המקורי ואז המעוגל – זה כפל עבודה למפה). מעגלים רק שבילים, דרכי עפר ונחלים
    if (smoothCache?.src !== fc) smoothCache = { src: fc, fc: taperTrails(Geo.smoothFC(fc, lvl, (f) => f.properties.k !== 'road' || f.properties.r === 'path' || f.properties.r === 'track'
      || trailGeoms.has(JSON.stringify(f.geometry.coordinates)))) };
    if (mapFC === fc && smoothLevel()) map.getSource('osm').setData(smoothCache.fc);
    if (PERF.sent == null) { PERF.sent = performance.now(); map.once('idle', () => (PERF.ready = performance.now())); }
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
  // ---------- הורדה בריבועים קבועים (0.1° ≈ 9×11 ק"מ): בלי חפיפות וחתיכות קטנות; הורדה שנייה – רק מה שחסר ----------
  const CELL = 0.1;
  const cellBox = (i, j) => [i * CELL, j * CELL, (i + 1) * CELL, (j + 1) * CELL].map((v) => +v.toFixed(4));
  const covers = (b, c) => b[0] <= c[0] + 1e-6 && b[1] <= c[1] + 1e-6 && b[2] >= c[2] - 1e-6 && b[3] >= c[3] - 1e-6;
  // מלבן פחות מלבן – מה שנשאר (עד 4 מלבנים)
  function rectMinus(r, b) {
    if (b[0] >= r[2] || b[2] <= r[0] || b[1] >= r[3] || b[3] <= r[1]) return [r];
    const out = [], y0 = Math.max(r[1], b[1]), y1 = Math.min(r[3], b[3]);
    if (b[1] > r[1]) out.push([r[0], r[1], r[2], b[1]]);
    if (b[3] < r[3]) out.push([r[0], b[3], r[2], r[3]]);
    if (b[0] > r[0]) out.push([r[0], y0, b[0], y1]);
    if (b[2] < r[2]) out.push([b[2], y0, r[2], y1]);
    return out;
  }
  // אזורים שנוגעים או חופפים – אזור אחד (במעטפת וב"מפות שמורות"): שם, גבולות, ותאריך העדכון הישן ביותר
  function areaGroups() {
    const list = dlAreas(), par = list.map((_, i) => i);
    const find = (i) => (par[i] === i ? i : (par[i] = find(par[i])));
    const touch = (a, b) => a[0] <= b[2] + 1e-6 && b[0] <= a[2] + 1e-6 && a[1] <= b[3] + 1e-6 && b[1] <= a[3] + 1e-6;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (touch(list[i].b, list[j].b)) par[find(i)] = find(j);
    const groups = new Map();
    list.forEach((a, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(a); });
    return [...groups.values()].map((areas) => {
      const bbox = areas.reduce((u, { b }) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])], areas[0].b);
      const big = areas.map((a) => a.b).sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))[0];
      const name = areas.some((a) => a.b.join() === CARMEL.join()) ? 'הכרמל' : areaName(bbox);
      return { areas, bbox, big, name, t: Math.min(...areas.map((a) => a.t || Date.now())) };
    });
  }
  // האזורים השמורים השתנו – המעטפת, המפה הכללית שמחוצה להם, והריבועים שעוד חסרים
  function areasChanged() { updateEnvelope(); updateOverviewHi(); checkArea(); }
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
    }
    // פעם ראשונה: אין הורדה אוטומטית ואין מסך פתיחה – המפה הכללית של כל הארץ כבר באפליקציה; מתקרבים לאזור ומורידים אותו
    checkArea();
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
  // ---------- מפות שמורות (כפתור דלוק/כבוי בכלים): המשבצות שהורדו על המפה; בחירה מרובה (נגיעה – בוחרת, נגיעה נוספת – מבטלת),
  // מחיקה של הנבחרות, ו"עדכון" כשב-OSM נוספו/השתנו שבילים או דרכים מאז שהמשבצת הורדה (בדיקה אחת ל-Overpass בכניסה).
  // במצב הזה המפה לא פעילה: בלי מידע בנגיעה, תוספות למסלול וכפתורי הורדה; שמות היישובים מעומעמים
  let areasMode = false;
  const areaSel = new Set(); // מפתחות המשבצות הנבחרות (b.join())
  let areasUpd = new Set(), areasChecking = false, areasBusy = ''; // משבצות שיש להן עדכון; בדיקה / עדכון שרצים
  // המפה עצמה נשארת (מקרוב רואים את השבילים בתוך המשבצות – בלי מידע בנגיעה), שמות היישובים מעומעמים, והמעטפת הרגילה
  // מוסתרת (המשבצות במקומה)
  const AREAS_HIDE = /^env-/, AREAS_DIM = /^(ov-city|ovh-place|place-major|place-minor)$/;
  const areasHidden = new Map(), areasDimmed = new Map();
  function hideForAreas() {
    for (const l of map.getStyle().layers) {
      if (AREAS_HIDE.test(l.id)) {
        if (!areasHidden.has(l.id)) areasHidden.set(l.id, map.getLayoutProperty(l.id, 'visibility') || 'visible');
        map.setLayoutProperty(l.id, 'visibility', 'none');
      } else if (AREAS_DIM.test(l.id)) {
        if (!areasDimmed.has(l.id)) areasDimmed.set(l.id, map.getPaintProperty(l.id, 'text-opacity'));
        map.setPaintProperty(l.id, 'text-opacity', 0.35);
      }
    }
  }
  function restoreAfterAreas() {
    for (const [id, v] of areasHidden) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
    for (const [id, v] of areasDimmed) if (map.getLayer(id)) map.setPaintProperty(id, 'text-opacity', v ?? 1);
    areasHidden.clear(); areasDimmed.clear();
    applyLayers();
  }
  const sizeOf = (boxes) => {
    const tests = boxes.map(inBox);
    let size = 0;
    for (const f of mapFC?.features || []) if (tests.some((t) => touchesBox(f, t))) size += JSON.stringify(f).length;
    return size;
  };
  function renderAreasMap() {
    const list = dlAreas(), groups = areaGroups(), feats = [];
    for (const k of [...areaSel]) if (!list.some((a) => a.b.join() === k)) areaSel.delete(k);
    for (const k of [...areasUpd]) if (!list.some((a) => a.b.join() === k)) areasUpd.delete(k);
    list.forEach((a) => feats.push({ type: 'Feature', properties: { sel: areaSel.has(a.b.join()) ? 1 : 0, upd: areasUpd.has(a.b.join()) ? 1 : 0 },
      geometry: { type: 'Polygon', coordinates: [[[a.b[0], a.b[1]], [a.b[2], a.b[1]], [a.b[2], a.b[3]], [a.b[0], a.b[3]], [a.b[0], a.b[1]]]] } }));
    for (const g of groups) feats.push({ type: 'Feature', properties: { n: g.name }, geometry: { type: 'Point', coordinates: groupCenter(g) } });
    map.getSource('areas-del')?.setData({ type: 'FeatureCollection', features: areasMode ? feats : [] });
    const sel = list.filter((a) => areaSel.has(a.b.join()));
    $('ab-del').hidden = !sel.length || !!areasBusy;
    $('ab-upd').hidden = !areasUpd.size || !navigator.onLine || !!areasBusy;
    const info = $('ab-info');
    if (areasBusy) return (info.textContent = areasBusy);
    if (!list.length) return (info.textContent = 'אין מפות שמורות');
    const upd = areasChecking ? ' · בודק עדכונים…' : areasUpd.size ? ` · יש עדכון ל-${areasUpd.size === 1 ? 'משבצת אחת' : areasUpd.size + ' משבצות'}` : '';
    if (!sel.length) return (info.textContent = `${list.length === 1 ? 'משבצת אחת שמורה' : list.length + ' משבצות שמורות'} · נגעו כדי לבחור${upd}`);
    if (sel.length === 1) {
      const a = sel[0], g = groups.find((x) => x.areas.some((y) => y.b.join() === a.b.join()));
      return info.replaceChildren(Object.assign(document.createElement('b'), { textContent: g?.name || 'משבצת' }),
        document.createTextNode(` · ${fmtSize(sizeOf([a.b]))}${a.t ? ' · עודכן ' + new Date(a.t).toLocaleDateString('he-IL') : ''}`));
    }
    info.replaceChildren(Object.assign(document.createElement('b'), { textContent: `נבחרו ${sel.length} משבצות` }),
      document.createTextNode(` · ${fmtSize(sizeOf(sel.map((a) => a.b)))}`));
  }
  // בדיקת עדכונים: האם ב-OSM יש שבילים/דרכים שנוספו או השתנו מאז שכל משבצת הורדה
  async function checkAreaUpdates() {
    const list = dlAreas().filter((a) => a.t);
    if (!list.length || !navigator.onLine || areasChecking) return;
    areasChecking = true; renderAreasMap();
    try {
      const res = await OSM.changedSince(list);
      if (res) areasUpd = new Set(list.filter((_, i) => res[i]).map((a) => a.b.join()));
    } catch (e) { console.warn('בדיקת עדכונים', e); }
    areasChecking = false;
    if (areasMode) renderAreasMap();
  }
  function enterAreasMode() {
    if (areasMode) return;
    areasMode = true; areaSel.clear();
    document.body.classList.add('areas-mode');
    $('btn-areas').classList.add('pressed');
    closeSearch();
    hideForAreas();
    renderDock();
    placeDlHere();
    layoutTools();
    renderAreasMap();
    checkAreaUpdates();
    setTimeout(syncBack);
  }
  function exitAreasMode() {
    if (!areasMode || areasBusy) return;
    areasMode = false; areaSel.clear();
    document.body.classList.remove('areas-mode');
    $('btn-areas').classList.remove('pressed');
    renderAreasMap();
    restoreAfterAreas();
    renderDock();
    placeDlHere();
    layoutTools();
    setTimeout(syncBack);
  }
  map.on('click', (e) => {
    if (!areasMode || areasBusy) return;
    const { lng, lat } = e.lngLat;
    let best = null, ba = Infinity;
    for (const a of dlAreas()) { // כמה משבצות חופפות – הקטנה
      if (lng >= a.b[0] && lng <= a.b[2] && lat >= a.b[1] && lat <= a.b[3]) { const ar = (a.b[2] - a.b[0]) * (a.b[3] - a.b[1]); if (ar < ba) { ba = ar; best = a; } }
    }
    if (!best) return;
    const k = best.b.join();
    areaSel.has(k) ? areaSel.delete(k) : areaSel.add(k);
    renderAreasMap();
  });
  $('ab-close').addEventListener('click', exitAreasMode);
  $('ab-del').addEventListener('click', async () => {
    const sel = dlAreas().filter((a) => areaSel.has(a.b.join()));
    if (!sel.length) return;
    const title = sel.length === 1 ? 'למחוק את המשבצת?' : `למחוק ${sel.length} משבצות?`;
    // מסלולים שמורים שעוברים במשבצות – נשארים, אבל בלי המפה מתחתם, בלי גובה כשאין רשת, ובלי עריכה ותוספות
    const tests = sel.map((a) => inBox(a.b));
    const hit = (await libLoad().catch(() => [])).filter((r) => (r.segs || []).some((sg) => sg.coords.some((c) => tests.some((t) => t(c)))));
    const text = !hit.length ? 'אפשר להוריד שוב כשיש אינטרנט.'
      : hit.length === 1 ? `המסלול "${hit[0].name}" יישאר, בלי מפה מתחתיו.` : `${hit.length} מסלולים שמורים יישארו, בלי מפה מתחתם.`;
    if (!(await confirmDlg(title, text))) return;
    await deleteAreas(sel.map((a) => a.b));
    areaSel.clear();
    renderAreasMap();
  });
  // עדכון: מורידים מחדש את המשבצות שיש להן עדכון, אחת אחרי השנייה
  $('ab-upd').addEventListener('click', async () => {
    const todo = dlAreas().filter((a) => areasUpd.has(a.b.join()));
    let fails = 0;
    for (let i = 0; i < todo.length; i++) {
      areasBusy = `מעדכן ${todo.length > 1 ? `${i + 1} מתוך ${todo.length}` : ''}…`.replace(' …', '…');
      renderAreasMap();
      dlErr = '';
      await downloadArea(todo[i].b, { area: true, cells: [todo[i].b] });
      if (dlErr) fails++; else areasUpd.delete(todo[i].b.join());
    }
    areasBusy = '';
    renderAreasMap();
    if (fails) toast(`העדכון נכשל${todo.length > 1 ? ` ב-${fails} משבצות` : ''}: ${dlErr}`, 6000);
    else toast('המפות עודכנו ✓', 2500);
  });
  // מוחקים את מה שבתוך האזור – חוץ ממה שנוגע באזור שמור אחר
  async function deleteAreas(bs) {
    if (dlJob?.quiet) { dlJob.ctl.abort(new DOMException('הופסק', 'AbortError')); await dlJob.done; }
    const gone = new Set(bs.map((b) => b.join()));
    const rest = dlAreas().filter((a) => !gone.has(a.b.join()));
    const dels = bs.map(inBox), keep = rest.map((a) => inBox(a.b));
    const fc = mapFC || (await db.get('mapdata').catch(() => null)) || { type: 'FeatureCollection', features: [] };
    const features = fc.features.filter((f) => !dels.some((t) => touchesBox(f, t)) || keep.some((t) => touchesBox(f, t)));
    const bbox = rest.length ? rest.reduce((u, { b: x }) => [Math.min(u[0], x[0]), Math.min(u[1], x[1]), Math.max(u[2], x[2]), Math.max(u[3], x[3])], rest[0].b) : undefined;
    const nfc = { type: 'FeatureCollection', features, ...(bbox ? { bbox } : {}) };
    await db.set('mapdata', nfc); // נשאר גם כשריק – כדי שהכרמל לא יורד שוב לבד
    try { localStorage.setItem('dlAreas', JSON.stringify(rest)); } catch { /* ignore */ }
    // גם נתוני הגובה של האזור (מה שלא משותף לאזור אחר)
    const keepUrls = new Set(rest.flatMap((a) => Elev.tileUrls(a.b)));
    const drop = [...new Set(bs.flatMap((b) => Elev.tileUrls(b)))].filter((u) => !keepUrls.has(u));
    if (self.caches) for (const k of await caches.keys()) { const c = await caches.open(k); await Promise.all(drop.map((u) => c.delete(u))); }
    await setMapData(nfc);
    areasChanged();
    renderAreasMap();
  }

  // אזור בלי מפה שמורה (למשל אחרי חיפוש): במרכז המסך – "להורדת מפות האזור" (לחיץ)
  let dlMsg = '';
  function viewBox() {
    const v = map.getBounds(), pad = 0.01; // קצת מעבר למסך
    return [v.getWest() - pad, v.getSouth() - pad, v.getEast() + pad, v.getNorth() + pad].map((x) => +x.toFixed(4));
  }
  // כפתור הורדה על כל ריבוע חסר שרואים – באמצע שלו, בשורה אחת; כולם מופיעים יחד בפייד כשהריבוע תופס 45–60% מרוחב המסך
  let dlCell = null, dlAll = []; // dlAll – כל הריבועים החסרים (קבוע, מחושב מראש; משתנה רק כשהאזורים השמורים משתנים)
  const DL_SHOW = [0.45, 0.6];
  const dlBtns = new Map(); // מפתח ריבוע → כפתור
  function dlButton(c) {
    const key = c.join();
    let b = dlBtns.get(key);
    if (!b) {
      b = document.createElement('button');
      b.className = 'dl-here';
      b.hidden = true;
      b.addEventListener('click', () => {
        if (b.disabled) return;
        dlCell = c;
        downloadArea(c, { area: true, cells: [c] });
      });
      document.body.appendChild(b);
      dlBtns.set(key, b);
    }
    return b;
  }
  const dlLabel = () => dlMsg || (!navigator.onLine ? 'אין מפה שמורה לאזור הזה · צריך אינטרנט כדי להוריד'
    : dlErr ? `ההורדה נכשלה:\n${dlErr}\n⬇ לנסות שוב` : '⬇ להורדת מפות האזור');
  function placeDlHere() {
    if (areasMode) { for (const b of dlBtns.values()) b.hidden = true; return; }
    const W = innerWidth, H = innerHeight, top = 110, bottom = H - ($('dock')?.offsetHeight || 120) - 10;
    const lat = map.getCenter().lat, cw = Math.abs(map.project([CELL, lat]).x - map.project([0, lat]).x); // רוחב ריבוע במסך
    const o = dlMsg ? 1 : Math.max(0, Math.min(1, (cw / W - DL_SHOW[0]) / (DL_SHOW[1] - DL_SHOW[0])));
    const show = new Set();
    if (o > 0) {
      const v = map.getBounds();
      const cells = dlMsg && dlCell ? [dlCell] : dlAll.filter((c) => c[2] >= v.getWest() && c[0] <= v.getEast() && c[3] >= v.getSouth() && c[1] <= v.getNorth());
      for (const c of cells) {
        const p = map.project([(c[0] + c[2]) / 2, (c[1] + c[3]) / 2]);
        if (p.x < 0 || p.x > W || p.y < top || p.y > bottom) continue; // באמצע שלו – רק כשהאמצע על המסך
        const btn = dlButton(c);
        btn.hidden = false;
        btn.textContent = dlLabel();
        btn.disabled = !!dlMsg || !navigator.onLine;
        btn.style.scale = 1;
        const sc = Math.min(1, (0.88 * cw) / (btn.offsetWidth || 1)); // לא רחב מהריבוע שלו
        btn.style.scale = sc;
        // נכנס/יוצא בפייד כשהאמצע של הריבוע מתקרב לקצה המסך – לא נחתך ולא קופץ
        const e = Math.max(0, Math.min(1, Math.min(Math.min(p.x, W - p.x) / (btn.offsetWidth * sc / 2 + 8), Math.min(p.y - top, bottom - p.y) / (btn.offsetHeight * sc / 2 + 8))));
        if (e <= 0) { btn.hidden = true; continue; }
        btn.style.opacity = o * e;
        btn.style.pointerEvents = o * e < 0.6 ? 'none' : '';
        btn.style.left = p.x + 'px';
        btn.style.top = p.y + 'px';
        show.add(c.join());
      }
    }
    for (const [k, b] of dlBtns) if (!show.has(k)) b.hidden = true;
  }
  // הגריד ידוע מראש ולא משתנה בזמן תנועה וזום: מחושב פעם אחת לכל השטח שאפשר להגיע אליו (המלבן של setMaxBounds),
  // ורק כשהאזורים השמורים משתנים – הריבועים החסרים מחושבים מחדש
  function buildGrids() {
    const mb = map.getMaxBounds(), areas = dlAreas(), MIN = 0.003;
    const [w, e, so, n] = mb ? [mb.getWest(), mb.getEast(), mb.getSouth(), mb.getNorth()] : [34, 36.2, 29, 34];
    const coarse = [];
    for (const { m } of GRID_LEVELS) {
      const st = m * CELL, x0 = Math.floor(w / st) * st, x1 = Math.ceil(e / st) * st, y0 = Math.floor(so / st) * st, y1 = Math.ceil(n / st) * st;
      for (let x = x0; x <= x1 + 1e-9; x += st) coarse.push({ type: 'Feature', properties: { m }, geometry: { type: 'LineString', coordinates: [[+x.toFixed(4), y0], [+x.toFixed(4), y1]] } });
      for (let y = y0; y <= y1 + 1e-9; y += st) coarse.push({ type: 'Feature', properties: { m }, geometry: { type: 'LineString', coordinates: [[x0, +y.toFixed(4)], [x1, +y.toFixed(4)]] } });
    }
    map.getSource('dl-grid-c')?.setData({ type: 'FeatureCollection', features: coarse });
    // ריבוע חסר = יש בו חלק שלא מכוסה במפות שהורדו (כולן יחד); פס דק (~300 מ') לא נחשב
    dlAll = [];
    for (let i = Math.floor(w / CELL); i < Math.ceil(e / CELL); i++)
      for (let j = Math.floor(so / CELL); j < Math.ceil(n / CELL); j++) {
        const c = cellBox(i, j);
        if (areas.some((a) => covers(a.b, c))) continue;
        let left = [c];
        for (const a of areas) left = left.flatMap((r) => rectMinus(r, a.b));
        if (left.some((r) => r[2] - r[0] > MIN && r[3] - r[1] > MIN)) dlAll.push(c);
      }
    map.getSource('dl-grid')?.setData({ type: 'FeatureCollection', features: dlAll.map((c) => ({ type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: [[c[0], c[1]], [c[2], c[1]], [c[2], c[3]], [c[0], c[3]], [c[0], c[1]]] } })) });
  }
  function checkArea() { buildGrids(); placeDlHere(); }
  map.on('move', placeDlHere);
  map.on('resize', checkArea);
  addEventListener('online', placeDlHere);
  addEventListener('offline', placeDlHere);


  let longPressAt = 0; // אחרי לחיצה ארוכה (תוספת למסלול) – לא פותחים מידע על מה שמתחת
  map.on('click', 'wpts', (e) => {
    if (areasMode || Date.now() - longPressAt < 800) return;
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
    if (areasMode || plan || Date.now() - longPressAt < 800) return;
    const { x, y } = e.point;
    const feats = map.queryRenderedFeatures([[x - 10, y - 10], [x + 10, y + 10]], { layers: INFO_LAYERS.filter((l) => map.getLayer(l)) });
    if (!feats.length) return;
    // שבילים מסומנים – ריבוע בצבע השביל, הכי שמאלי בשורה (אחרי שם הדרך וסוגה) (ולא שורה "שביל מסומן ירוק")
    const trails = feats.filter((f) => f.properties.k === 'trail');
    const colors = [...new Set(trails.map((f) => f.properties.c))];
    const trailName = trails.map((f) => f.properties.n).find(Boolean) || '';
    const squares = colors.map((c) => `<span class="sq" style="background:${esc(c)}"></span>`).join('');
    // נקודת עניין / נחל עם שם – אייקון מצלמה בסוף השורה שלה (משמאל): תמונות שאנשים צילמו
    const named = navigator.onLine && feats.find((f) => (f.properties.k === 'poi' || f.properties.k === 'water') && f.properties.n);
    let cam = '';
    if (named) {
      // גוגל מפות: חיפוש השם בלבד, ממוקד במקום שלו – מוצא את המקום עצמו (ולא יישוב בשם דומה) ופותח את הכרטיס עם התמונות.
      // (גוגל תמונות עם "השם + היישוב הקרוב" – בוטל: היישוב ניצח, למשל "צנירי הכרמל בית אורן" הביא את בית אורן)
      const [lon, lat] = named.geometry.type === 'Point' ? named.geometry.coordinates : [e.lngLat.lng, e.lngLat.lat];
      cam = `<a class="info-photos" href="https://www.google.com/maps/search/${encodeURIComponent(named.properties.n)}/@${lat.toFixed(6)},${lon.toFixed(6)},17z" target="_blank" rel="noopener" aria-label="תמונות">${CAM_SVG}</a>`;
    }
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
      if (p.k === 'road') line = p.b ? 'שביל לאופניים בלבד – לא להליכה' : p.fn ? 'אסור להולכי רגל' : HW[p.h] || 'דרך';
      else if (p.k === 'water') line = 'נחל';
      else if (p.k === 'bike') line = 'מסלול אופניים';
      else if (p.k === 'poi') line = KIND[p.t === 'water' ? 'water_poi' : p.t] || p.t;
      const withSq = p.k === 'road' && !gotSquares && colors.length;
      if (withSq) gotSquares = true;
      const name = p.n || (withSq ? trailName : '');
      rows.push(`<div class="info-row">${name ? `<b>${esc(name)}</b> ` : ''}${line}${withSq ? squares : ''}${f === named ? cam : ''}</div>`);
      if (f === named) cam = '';
      if (rows.length >= 4) break;
    }
    // שביל מסומן בלי דרך מתחתיו
    if (colors.length && !gotSquares) rows.unshift(`<div class="info-row">${trailName ? `<b>${esc(trailName)}</b> ` : ''}שביל${squares}</div>`);
    if (!rows.length) return;
    if (cam) rows.push(`<div class="info-row">${cam}</div>`);
    new maplibregl.Popup({ closeButton: false, maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(rows.join('')).addTo(map);
  });
  const CAM_SVG = '<svg viewBox="0 0 24 24"><path d="M4 8h3.5l1.5-2.5h6L16.5 8H20v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
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
    const f = [];
    for (const x of routePieces(segs)) {
      let line = [];
      const flush = () => { if (line.length > 1) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: x.props }); line = []; };
      for (let j = 1; j < x.coords.length; j++) {
        if (x.dup?.[j]) { flush(); continue; } // מעבר חוזר באותה דרך – מצויר פעם אחת
        if (!line.length) line.push(x.coords[j - 1]);
        line.push(x.coords[j]);
      }
      flush();
    }
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
  const estTime = (lenM, gain, bike) => (bike ? (lenM / 1000) * 5 + (gain / 100) * 6 : (lenM / 1000) * 15 + (gain / 100) * 10); // גיבוי, כשאין גובה

  // ---------- הערכת זמן: לכל קטע של 15 מ' – מהירות לפי השיפוע (טובלר), × תוואי × קצב × כיול אישי ----------
  // טובלר: 6·e^(−3.5·|שיפוע+0.05|) קמ"ש – ירידה קלה הכי מהירה (~5), עלייה וגם ירידה תלולה מאטות.
  const PACES = [['normal', 'רגיל', 1], ['fast', 'מהיר', 1.15], ['kids', 'עם ילדים', 0.7]];
  let pace = localStorage.getItem('pace') || 'normal';
  const paceRow = () => PACES.find((x) => x[0] === pace) || PACES[0];
  const paceCal = (() => { try { return JSON.parse(localStorage.getItem('paceCal')) || {}; } catch { return {}; } })(); // {walk:{f,n}, bike:{f,n}}
  const calOf = (bike) => paceCal[bike ? 'bike' : 'walk'] || { f: 1, n: 0 };
  const TERRAIN = { walk: { road: 1.05, track: 1, path: 0.9, steps: 0.6, free: 0.6 }, bike: { road: 1.3, track: 1, path: 0.8, steps: 0.15, free: 0.5 } };
  const terrClass = (h) => (!h ? 'path' : h === 'free' ? 'free' : h === 'steps' ? 'steps' : h === 'track' ? 'track'
    : ['path', 'footway', 'bridleway', 'cycleway'].includes(h) ? 'path' : 'road');
  const terrCache = new WeakMap();
  function terrainOf(segs) { // [{to: מרחק מצטבר, cls}] לפי סוג הדרך של כל קטע
    if (!segs?.length) return null;
    if (terrCache.has(segs)) return terrCache.get(segs);
    const out = [];
    let acc = 0;
    for (const sg of segs) {
      for (let j = 1; j < sg.coords.length; j++) acc += Geo.haversine(sg.coords[j - 1], sg.coords[j]);
      out.push({ to: acc, cls: terrClass(sg.h) });
    }
    terrCache.set(segs, out);
    return out;
  }
  function speedAt(sl, cls, bike) { // קמ"ש
    if (bike) return Math.max(3, sl >= 0 ? 14 * Math.exp(-12 * sl) : Math.min(25, 14 * (1 - 8 * sl))) * TERRAIN.bike[cls];
    return 6 * Math.exp(-3.5 * Math.abs(sl + 0.05)) * TERRAIN.walk[cls];
  }
  // דקות תנועה (בלי עצירות) בין from ל-to (מרחקים בגרף). raw – בלי קצב וכיול (לכיול עצמו)
  function timeOf(p, from, to, segs, bike, raw) {
    if (!p) return null;
    const terr = terrainOf(segs), scale = terr ? terr[terr.length - 1].to / (p.total || 1) : 1;
    let t = 0, ti = 0;
    for (let i = 1; i < p.dist.length; i++) {
      const a = p.dist[i - 1], b = p.dist[i];
      if (b <= from || b === a) continue;
      if (a >= to) break;
      const dx = Math.min(b, to) - Math.max(a, from);
      const sl = Math.max(-0.5, Math.min(0.5, (p.ele[i] - p.ele[i - 1]) / (b - a)));
      let cls = 'path';
      if (terr) { const al = a * scale; while (ti < terr.length - 1 && terr[ti].to < al) ti++; cls = terr[ti].cls; }
      t += (dx / 1000 / speedAt(sl, cls, bike)) * 60;
    }
    return raw ? t : t / (paceRow()[2] * calOf(bike).f);
  }
  // הכפתור מתחת לזמן: הקצב הנוכחי; נגיעה מחליפה רגיל → מהיר → עם ילדים
  function paceLabel(bike) { return paceRow()[1] + (calOf(bike).n ? ' · מותאם לך' : ''); }
  function cyclePace() {
    pace = PACES[(PACES.indexOf(paceRow()) + 1) % PACES.length][0];
    try { localStorage.setItem('pace', pace); } catch { /* ignore */ }
    renderRouteInfo();
    if (plan) planTime();
  }

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
    // הקטע המסומן (עד האצבע / בין שתי אצבעות): צבע מלא. הקו והמספר – אפור בהיר בכהה, אפור כהה בבהיר
    const hot = night ? '#d5d9dc' : '#59626a';
    const base = marks.from != null ? marks.from : marks.at != null && marks.touch != null && marks.at <= marks.touch ? marks.at : 0;
    // המילוי – ירוק מלא בצבע הקו העליון של הגרף (לא לבן/אפור)
    if (marks.touch != null) band(X(base), X(marks.touch), () => { area(); g.fillStyle = night ? '#81c784' : '#2e7d4f'; g.fill(); });
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
        // המספר, ומימינו חץ מצויר בגובה הטקסט (התו ↗↘ בגופן קטן ודק)
        const cx = (X(marks.from) + X(marks.touch)) / 2, txt = Math.abs(dh) + " מ'";
        g.textAlign = 'center';
        g.fillText(txt, cx, 12);
        if (dh) {
          const w = g.measureText(txt).width, ax = cx + w / 2 + 4, s9 = 9, top = 3;
          g.save(); g.strokeStyle = hot; g.lineWidth = 1.7; g.lineCap = g.lineJoin = 'round';
          g.beginPath();
          if (dh > 0) { g.moveTo(ax, top + s9); g.lineTo(ax + s9, top); g.moveTo(ax + 2.5, top); g.lineTo(ax + s9, top); g.lineTo(ax + s9, top + s9 - 2.5); }
          else { g.moveTo(ax, top); g.lineTo(ax + s9, top + s9); g.moveTo(ax + s9, top + 2.5); g.lineTo(ax + s9, top + s9); g.lineTo(ax + 2.5, top + s9); }
          g.stroke(); g.restore();
        }
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
  function legInfo(p, from, to, bike, segs) {
    const st = profileStats(p, from, to);
    const len = to - from;
    return { len, ele: eleAt(p, to), gain: st.gain, loss: st.loss, time: timeOf(p, from, to, segs, bike) ?? estTime(len, st.gain, bike) };
  }

  let scrub = null; // האצבע על הגרף של המסלול הפעיל: { b } – נקודה, { a, b } – שתי אצבעות (מרחקים בגרף)
  // על המפה: הקטע a→b של המסלול והנקודה (או שתי הנקודות)
  // שכבה מעל קטע של המסלול (from→to, מרחקים על המסלול), מחולקת כמו המסלול עצמו – כדי לזוז הצידה יחד איתו בקטעים משותפים
  // החלוקה של המסלול (כולל ההזזה בקטעים משותפים) מחושבת פעם אחת לכל מסלול ונשמרת עם מרחקים מצטברים –
  // בזמן גרירה על הגרף רק חותכים ממנה את הקטע (בלי לחפש שוב קטעים משותפים בכל תזוזה)
  let pieceCache = null;
  function routePieces(segs) {
    if (pieceCache?.segs === segs) return pieceCache.pieces;
    // קטע משותף שהמסלול נכנס אליו או יוצא ממנו – ההזזה עולה/יורדת בהדרגה (כמו השביל במפה), בלי מדרגה
    const raw = segs.flatMap((sg) => splitShared(sg));
    const near = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
    const split = [];
    raw.forEach((x, i) => {
      const v = sharedV(x.props);
      if (!v) return split.push(x);
      const prev = raw[i - 1], next = raw[i + 1];
      const t0 = !!prev && near(prev.coords[prev.coords.length - 1], x.coords[0]) && sharedV(prev.props) !== v;
      const t1 = !!next && near(next.coords[0], x.coords[x.coords.length - 1]) && sharedV(next.props) !== v;
      for (const y of taperSplit(x.coords, t0, t1)) split.push({ coords: y.coords, props: y.tf === 1 ? x.props : { ...x.props, tf: y.tf } });
    });
    const pieces = [];
    let acc = 0;
    for (const x of split) {
      const cum = [acc];
      for (let j = 1; j < x.coords.length; j++) cum.push((acc += Geo.haversine(x.coords[j - 1], x.coords[j])));
      pieces.push({ coords: x.coords, props: x.props, cum });
    }
    markRepeats(pieces);
    pieceCache = { segs, pieces };
    return pieces;
  }
  // דרך שהמסלול עובר בה פעמיים (הלוך ושוב, או לולאה שחוזרת) – מצוירת פעם אחת: קטע שכולו (התחלה, אמצע וסוף)
  // עד 5 מ' מקטע מוקדם יותר במסלול, ובאותו כיוון או הפוך – מסומן dup[j] ולא מצויר (גם לא העמעום / מה שהלכת עליו).
  // אחרת שני המעברים נראים כשני קווים צמודים (גאומטריה מעט שונה / הזזה לצד אחר)
  function markRepeats(pieces) {
    const D = 5, ALONG = 15, CELL = 10;
    const lat0 = pieces[0]?.coords[0][1] ?? 32.7, kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
    const grid = new Map();
    const P = (c) => [c[0] * kx, c[1] * ky];
    const distSeg = (p, s) => {
      const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / L2)) : 0;
      return Math.hypot(s.a[0] + t * dx - p[0], s.a[1] + t * dy - p[1]);
    };
    const near = (p, dir, along) => {
      const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const s of grid.get(cx + i + ',' + (cy + j)) || []) {
        if (along - s.along < ALONG) continue;
        if (Math.abs(dir[0] * s.dir[0] + dir[1] * s.dir[1]) < 0.85) continue; // לא מקביל – חצייה, לא חזרה
        if (distSeg(p, s) < D) return true;
      }
      return false;
    };
    for (const pc of pieces) {
      pc.dup = [];
      for (let j = 1; j < pc.coords.length; j++) {
        const a = P(pc.coords[j - 1]), b = P(pc.coords[j]), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.01) continue;
        const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], along = (pc.cum[j - 1] + pc.cum[j]) / 2;
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (near(a, dir, along) && near(m, dir, along) && near(b, dir, along)) pc.dup[j] = true;
        const s = { a, b, dir, along };
        for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
          for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
            const kk = x + ',' + y;
            if (!grid.has(kk)) grid.set(kk, []);
            grid.get(kk).push(s);
          }
      }
    }
  }
  function overlayFeatures(segs, from, to, k) {
    const out = [];
    for (const pc of routePieces(segs)) {
      const { coords: c, cum } = pc;
      if (cum[cum.length - 1] <= from || cum[0] >= to) continue;
      const at = (j, x) => { const d = cum[j] - cum[j - 1], t = d ? (x - cum[j - 1]) / d : 0; return [c[j - 1][0] + (c[j][0] - c[j - 1][0]) * t, c[j - 1][1] + (c[j][1] - c[j - 1][1]) * t]; };
      let line = [];
      const flush = () => { if (line.length > 1) out.push({ type: 'Feature', properties: { ...pc.props, k }, geometry: { type: 'LineString', coordinates: line } }); line = []; };
      for (let j = 1; j < c.length; j++) {
        if (cum[j] <= from || cum[j - 1] >= to) continue;
        if (k !== 'dot' && pc.dup?.[j]) { flush(); continue; } // מעבר חוזר – לא מצויר, גם לא מעליו
        if (!line.length) line.push(cum[j - 1] >= from ? c[j - 1] : at(j, from));
        line.push(cum[j] <= to ? c[j] : at(j, to));
      }
      flush();
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
  // בזמן הגרירה – שאר המסלול דוהה, כך שרואים רק את הקטע המסומן
  const SCRUB_FADE = 0.35;
  let routeFaded = false;
  function fadeRoute(on) {
    if (on === routeFaded) return;
    routeFaded = on;
    for (const id of ['route-casing', 'route-line']) if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', on ? SCRUB_FADE : 1);
  }
  function drawScrubMap() {
    const [segs, r, p, a, b, both] = scrubPending || [];
    fadeRoute(!!(segs && r));
    if (!segs || !r) return map.getSource('scrub')?.setData(empty);
    const ra = profToRoute(p, r, a), rb = profToRoute(p, r, b);
    const feats = rb - ra > 1 ? overlayFeatures(segs, ra, rb, 'hl') : [];
    const mark = (d, k) => { const at = pieceAt(segs, d) || routeAt(r, d); if (at) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: at.p }, properties: { k, rot: at.brg } }); };
    if (both) { mark(ra, 'scrub-tick'); mark(rb, 'scrub-tick'); } else mark(rb, 'scrub-chev');
    map.getSource('scrub')?.setData({ type: 'FeatureCollection', features: feats });
  }
  function clearScrub() { scrub = null; setScrubMap(null); }
  // נקודה וכיוון במרחק d – על הקו המצויר עצמו (המעוגל, ומוזז הצידה בקטע משותף כמו line-offset), כדי שהשברון
  // וקווי הטווח יישבו בדיוק על קצה הקטע המסומן ולא "ירקדו" בין הקו הגולמי לקו המצויר
  function pieceAt(segs, d) {
    const pcs = routePieces(segs);
    const pc = pcs.find((x) => x.cum[x.cum.length - 1] >= d) || pcs[pcs.length - 1];
    if (!pc || pc.coords.length < 2) return null;
    let j = 1;
    while (j < pc.coords.length - 1 && pc.cum[j] < d) j++;
    const a = pc.coords[j - 1], b = pc.coords[j], seg = pc.cum[j] - pc.cum[j - 1], t = seg ? Math.max(0, Math.min(1, (d - pc.cum[j - 1]) / seg)) : 0;
    let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    // הכיוון – לא של הקטע הקצרצר שבו נמצאים (משתנה בכל נקודה בקו המעוגל – השברון "רועד" בסיבוב), אלא ממוצע
    // על חלון של ~18 פיקסלים לכל צד: מהנקודה שלפני עד הנקודה שאחרי
    const k = Math.cos((a[1] * Math.PI) / 180), mpp = (40075016 * k) / (512 * 2 ** map.getZoom());
    const w = Math.max(4, 18 * mpp), p0 = posAt(pcs, d - w), p1 = posAt(pcs, d + w);
    const brg = (Math.atan2((p1[0] - p0[0]) * k, p1[1] - p0[1]) * 180) / Math.PI;
    const v = sharedV(pc.props) * (pc.props.tf ?? 1);
    if (v) {
      const z = map.getZoom(), f = Math.max(0, Math.min(1, (1.5 ** (z - 11) - 1) / (1.5 ** 5 - 1)));
      const off = (1.5 + 3 * f) * SHARED_STEP * v; // כמו SHARED_OFFSET, בפיקסלים
      const pa = map.project(a), pb = map.project(b), dx = pb.x - pa.x, dy = pb.y - pa.y, n = Math.hypot(dx, dy) || 1;
      const pp = map.project(p), q = map.unproject([pp.x - (dy / n) * off, pp.y + (dx / n) * off]);
      p = [q.lng, q.lat];
    }
    return { p, brg };
  }
  // נקודה (בלי הזזה) במרחק d לאורך הקו המצויר
  function posAt(pcs, d) {
    const first = pcs[0], last = pcs[pcs.length - 1];
    if (d <= 0) return first.coords[0];
    const pc = pcs.find((x) => x.cum[x.cum.length - 1] >= d);
    if (!pc) return last.coords[last.coords.length - 1];
    let j = 1;
    while (j < pc.coords.length - 1 && pc.cum[j] < d) j++;
    const a = pc.coords[j - 1], b = pc.coords[j], seg = pc.cum[j] - pc.cum[j - 1], t = seg ? Math.max(0, Math.min(1, (d - pc.cum[j - 1]) / seg)) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  // נקודה וכיוון (מעלות מהצפון) במרחק d לאורך המסלול
  function routeAt(r, d) {
    if (!r?.pts?.length) return null;
    let i = 1;
    while (i < r.pts.length - 1 && r.cum[i] < d) i++;
    const a = r.pts[i - 1], b = r.pts[i], seg = r.cum[i] - r.cum[i - 1], t = seg ? Math.max(0, Math.min(1, (d - r.cum[i - 1]) / seg)) : 0;
    const k = Math.cos((a[1] * Math.PI) / 180);
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], brg: (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI };
  }
  // סימני הגרירה על המסלול: שברון לבן (מצביע קדימה) וקו לבן ניצב לקצוות טווח – עם קו מתאר כהה דק, שייראו על כל צבע
  mapReady.then(() => {
    const img = (draw, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.lineCap = g.lineJoin = 'round'; draw(g); return g.getImageData(0, 0, w, h); };
    const both = (g, path, lw) => { g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = lw + 3; path(); g.stroke(); g.strokeStyle = '#fff'; g.lineWidth = lw; path(); g.stroke(); };
    if (!map.hasImage('scrub-chev')) map.addImage('scrub-chev', img((g) => both(g, () => { g.beginPath(); g.moveTo(13, 37); g.lineTo(28, 21); g.lineTo(43, 37); }, 6), 56, 56), { pixelRatio: 2 });
    if (!map.hasImage('scrub-tick')) map.addImage('scrub-tick', img((g) => both(g, () => { g.beginPath(); g.moveTo(8, 28); g.lineTo(48, 28); }, 6), 56, 56), { pixelRatio: 2 });
  });
  // הפרש גובה: חץ במקום סימן (+/− מתהפך בטקסט עברי)
  const signed = (v) => (Math.round(v) > 0 ? '↗ ' : Math.round(v) < 0 ? '↘ ' : '') + Math.abs(Math.round(v)) + " מ'";

  // מרחק בגרף -> מרחק על המסלול (כמעט זהים; מתקן הבדלים קטנים בשיטת החישוב)
  const profToRoute = (p, r, d) => (p.total ? (d * r.total) / p.total : 0);

  // ---------- המסלול בדוק ----------
  // שני מצבים: תצוגה מקדימה (לפני היציאה) וניווט (active.nav). שורת מספרים אחת:
  // בתצוגה – של כל המסלול; בניווט – מה שנשאר; בגרירה על הגרף – עד האצבע (בכתום), וחוזרת בעזיבה.
  const fmtClock = (min) => { const t = new Date(Date.now() + min * 60000); return `\u2066~${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}\u2069`; }; // בידוד LTR בתוך טקסט עברי
  const mtr = (v) => Math.round(v) + " מ'";
  // חץ עלייה/ירידה (↗ ↘) בתחילת תווית או ערך – אייקון בגובה הטקסט שלידו (התו עצמו קטן ודק בגופן)
  const ARROW = { '↗': 'M2.5 9.5L9.5 2.5M4 2.5h5.5V8', '↘': 'M2.5 2.5l7 7M9.5 4v5.5H4' };
  const arrowSvg = (ch) => `<svg class="arr" viewBox="0 0 12 12" aria-hidden="true"><path d="${ARROW[ch]}"/></svg>`;
  function setLabel(el, l) {
    const m = /^([↗↘])\s*(.*)$/.exec(l);
    if (!m) return void (el.textContent = l);
    el.innerHTML = arrowSvg(m[1]);
    el.append(' ' + m[2]);
  }
  function setStats(cells, hot) {
    cells.forEach(([l, v], i) => {
      setLabel($('st-l' + (i + 1)), l);
      setLabel($('st-v' + (i + 1)), v);
    });
    $('ri-stats').classList.toggle('hot', !!hot);
    const l4 = cells[3]?.[0] || '';
    // גלולת הקצב – כשאין זמן (טווח בגרף) רק מוסתרת ושומרת את המקום, כדי שהדוק לא יקפוץ
    $('ri-pace').hidden = false;
    $('ri-pace').style.visibility = /זמן|סיום|מגיעים/.test(l4) ? '' : 'hidden';
    $('ri-pace').textContent = paceLabel(!!active?.opts?.bike);
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
      const L = legInfo(prof, scrub.a, scrub.b, bike, active.segs);
      setStats([['טווח', Geo.fmtDist(L.len)], ['↗ עלייה', mtr(L.gain)], ['↘ ירידה', mtr(L.loss)],
        ['הפרש גובה', signed(eleAt(prof, scrub.b) - eleAt(prof, scrub.a))]], true);
      setScrubMap(active.segs, route, prof, scrub.a, scrub.b, true);
    } else if (scrub && prof) {
      // האצבע על הגרף: מהמיקום שלך (בניווט, אם הנקודה לפניך) או מתחילת המסלול
      const from = atP != null && atP <= scrub.b ? atP : 0;
      const L = legInfo(prof, from, scrub.b, bike, active.segs);
      setStats([[from > 0 ? 'ממך עד כאן' : 'עד כאן', Geo.fmtDist(L.len)], ['↗ עלייה', mtr(L.gain)], ['↘ ירידה', mtr(L.loss)],
        ['מגיעים', fmtClock(L.time)]], true);
      setScrubMap(active.segs, route, prof, from, scrub.b);
    } else if (nav && atP != null) {
      const rem = profileStats(prof, atP), left = total - prevAlong;
      const t = timeOf(prof, atP, prof.total, active.segs, bike);
      setStats([['נותרו', Geo.fmtDist(left)], ['↗ לעלות', mtr(rem.gain)], ['↘ לרדת', mtr(rem.loss)], ['🏁 סיום', fmtClock(t)]]);
    } else {
      const t = prof ? timeOf(prof, 0, prof.total, active.segs, bike) : null;
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
    active.nav = true; prevAlong = null; paceLog = null;
    db.set('active', active);
    startGps(); setFollow(true);
    if (lastPos) map.easeTo({ center: lastPos.p, zoom: Math.max(map.getZoom(), 16) });
    if (!compassMode && (await enableOrientation())) { compassMode = true; updateCompassIcon(); }
    setDockOpen(false);
    updateStatus();
  });
  // ---------- כיול אישי: זמן התנועה בפועל (בלי עצירות) מול ההערכה, על הקטע שהלכת ----------
  let paceLog = null; // { from, along, moving(ms), t, p }
  function logPace(along) {
    const now = Date.now(), p = lastPos.p;
    if (!paceLog) { paceLog = { from: along, along, moving: 0, t: now, p }; return; }
    const dt = now - paceLog.t, v = (Geo.haversine(paceLog.p, p) / Math.max(dt, 1)) * 1000; // מ'/שנ'
    if (dt < 60000 && v > 0.3 && v < (active.opts?.bike ? 12 : 3)) paceLog.moving += dt; // זז – לא עומד, לא ברכב
    Object.assign(paceLog, { t: now, p, along: Math.max(paceLog.along, along) });
  }
  function finishPace() {
    const L = paceLog;
    paceLog = null;
    if (!L || !prof || L.moving < 10 * 60000 || L.along - L.from < 800) return; // מעט מדי בשביל למדוד
    const bike = !!active?.opts?.bike, k = prof.total / (route.total || 1);
    const est = timeOf(prof, L.from * k, L.along * k, active.segs, bike, true);
    const f = Math.max(0.4, Math.min(2, est / (paceRow()[2] * (L.moving / 60000))));
    const c = calOf(bike);
    paceCal[bike ? 'bike' : 'walk'] = { f: c.n ? c.f * 0.6 + f * 0.4 : f, n: c.n + 1 };
    try { localStorage.setItem('paceCal', JSON.stringify(paceCal)); } catch { /* ignore */ }
    toast('ההערכה הותאמה לקצב שלך', 2500);
  }
  function stopNav() {
    if (!active) return;
    finishPace();
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
    if (areasMode || !showingRoute() || !mapFC) return;
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
      const oldT = prof ? timeOf(prof, 0, prof.total, active.segs, bike) : estTime(route.total, 0, bike);
      const newT = p ? timeOf(p, 0, p.total, buildDetourSegs(), bike) : null;
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
      m.on('dragend', () => { const ll = m.getLngLat(); plan.wps[i] = snapWp([+ll.lng.toFixed(6), +ll.lat.toFixed(6)]); plan.lastDrag = Date.now(); renderPlan(); });
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
    clearTimeout(profTimer);
    plan.prof = null; plan.scrubAt = null; setScrubMap(null);
    $('pl-up').textContent = $('pl-down').textContent = $('pl-time').textContent = '–';
    if (plan.wps.length > 1) {
      profTimer = setTimeout(async () => {
        const mine = plan;
        const r = Geo.buildRoute(segsToLines(segs));
        const p = await Elev.profile(r.pts, 15, r.breaks);
        if (plan !== mine) return;
        plan.prof = p; plan.route = r; plan.rawSegs = segs;
        $('pl-up').textContent = p ? Math.round(p.gain) + " מ'" : '?';
        $('pl-down').textContent = p ? Math.round(p.loss) + " מ'" : '?';
        planTime();
        drawProfile($('pl-profile'), p);
      }, 350);
    } else drawProfile($('pl-profile'), null);
  }

  function planTime() {
    $('pl-pace').textContent = paceLabel(plan.opts.bike);
    if (plan.prof) $('pl-time').textContent = fmtTime(timeOf(plan.prof, 0, plan.prof.total, plan.rawSegs, plan.opts.bike));
    else if (plan.prof === null && plan.wps.length > 1 && $('pl-time').textContent === '…') $('pl-time').textContent = '?';
  }
  $('pl-pace').addEventListener('click', cyclePace);
  $('ri-pace').addEventListener('click', cyclePace);
  attachScrub($('pl-profile'), () => plan?.prof, (a, b) => {
    const range = b != null, from = range ? a : 0, to = range ? b : a;
    plan.scrubAt = to;
    setScrubMap(plan.segs, plan.route, plan.prof, from, to, range);
    const L = legInfo(plan.prof, from, to, plan.opts.bike, plan.rawSegs);
    if (plan.hint == null) plan.hint = $('pl-hint').textContent;
    $('pl-hint').textContent = range
      ? `טווח: ${Geo.fmtDist(L.len)} · ↗${Math.round(L.gain)} ↘${Math.round(L.loss)} · הפרש ${signed(eleAt(plan.prof, to) - eleAt(plan.prof, from))}`
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
    $('pl-name').value = plan.name;
    planToggles();
    $('pl-pace').textContent = paceLabel(plan.opts.bike);
    clearScrub();
    document.body.classList.add('planning');
    // עד אז – התוכן כבר בגודל הסופי (הנחיה ונתונים ריקים), כדי שהגובה לא ישתנה אחר כך
    $('pl-hint').textContent = plan.wps.length > 1 ? 'גררו נקודה להזזה · הקשה על נקודה מוחקת אותה' : 'הקישו על המפה כדי לסמן נקודת התחלה';
    for (const id of ['pl-len', 'pl-up', 'pl-down', 'pl-time']) $(id).textContent = '–';
    drawProfile($('pl-profile'), null);
    renderDock();
    if (!plan.wps.length) map.getSource('route').setData(empty);
    // בניית הרשת תוקעת את הדף – אחרי שהדוק סיים לגדול (אחרת הוא "קופץ")
    if (plan.opts.snap && plan.wps.length) { if (!graphKey) toast('מכין את רשת השבילים…', 1500); setTimeout(() => { if (!plan) return; getGraph(plan.opts.bike); renderPlan(); }, 380); }
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
    if (areasMode || !plan) return;
    plan.wps.push(snapWp([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]));
    renderPlan();
  });
  $('pl-cancel').addEventListener('click', endPlan);
  // הליכה / אופניים – כפתור אחד שמתחלף (מראה את המצב הנוכחי); הצמדה לשבילים – דלוק/כבוי
  const MODE_ICON = {
    walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M12.5 8l-2 6 3 3 1 4.5M10.5 14l-2 7M11.5 9.5L8 11.5v3M12.5 8.5l2.5 3 3 1"/>',
    bike: '<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16l3.5-7h7l2.5 7M9 9l3.5 7h-7M15 9l-1.5-3H11"/>',
  };
  function planToggles() {
    const m = plan.opts.bike ? 'bike' : 'walk';
    $('pl-mode').querySelector('svg').innerHTML = MODE_ICON[m];
    $('pl-mode').querySelector('span').textContent = m === 'bike' ? 'אופניים' : 'הליכה';
    $('pl-snap').classList.toggle('off', !plan.opts.snap);
    $('pl-snap').setAttribute('aria-pressed', plan.opts.snap);
  }
  $('pl-snap').addEventListener('click', () => { plan.opts.snap = !plan.opts.snap; planToggles(); renderPlan(); });
  $('pl-mode').addEventListener('click', () => {
    plan.opts.bike = !plan.opts.bike;
    planToggles();
    $('pl-pace').textContent = paceLabel(plan.opts.bike);
    // נקודות שנצמדו לשביל אופניים בלבד – לא מתאימות להליכה: מצמידים מחדש לרשת של המצב החדש
    toast('מעדכן…', 800);
    setTimeout(() => { plan.wps = plan.wps.map(snapWp); renderPlan(); }, 30);
  });
  // נקודה שמסמנים (גם מרחוק, בזום רחוק) נצמדת לשביל/דרך הקרובים: רדיוס ~30 פיקסלים על המסך (25–400 מ'), עם העדפה לשביל מסומן
  function snapWp(p) {
    if (!plan?.opts.snap) return p;
    const g = getGraph(plan.opts.bike);
    if (!g) return p;
    const mpp = (40075016.686 * Math.cos((p[1] * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
    const s = Router.snap(g, p, Math.max(25, Math.min(400, 30 * mpp)));
    return s ? [+s.p[0].toFixed(6), +s.p[1].toFixed(6)] : p;
  }
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
  // שם המסלול – בדוק, נוגעים ועורכים (בלי כפתור "עריכת שם")
  $('pl-name').addEventListener('input', (e) => { if (plan) plan.name = e.target.value; });
  $('pl-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  // מסלול קיים – נשמר במקומו (השם כבר בדוק); חדש – חלון עם שם וקטגוריה
  $('pl-done').addEventListener('click', async () => {
    if (plan.libId && plan.name.trim()) return savePlan(plan.name.trim(), plan.folder || '');
    openSaveDlg('plan', { name: plan.name, folder: plan.folder, coords: plan.wps });
  });
  async function savePlan(name, folder) {
    const a = { kind: 'plan', name, folder, wps: plan.wps, opts: plan.opts, segs: plan.segs, waypoints: [], libId: plan.libId || Date.now() };
    endPlan();
    await libPut(a);
    await setActive(a, { fit: true });
    toast(`"${name}" נשמר${folder ? ` ב"${folder}"` : ''} · ${Geo.fmtDist(route.total)}`, 4000);
  }
  $('plan-dlg').addEventListener('close', async () => {
    if ($('plan-dlg').returnValue !== 'ok') return;
    const name = $('plan-name').value.trim() || 'מסלול מתוכנן';
    const folder = $('plan-folder').value.trim();
    if (saveMode === 'plan' && plan) await savePlan(name, folder);
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
    row.addEventListener('dblclick', () => { if (!lsel.editing) openFromLib(r.id); }); // נגיעה כפולה – פותחת
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
          // נגיעה ראשונה – מסמנת ופותחת; נגיעה בקטגוריה המסומנת – מבטלת וסוגרת
          if (!(lsel.kind === 'folder' && lsel.folder === c)) {
            // בחירה בלי לצייר מחדש – כך הפתיחה מונפשת, כמו הסגירה
            libOpen.add(c);
            Object.assign(lsel, { kind: 'folder', id: null, folder: c, editing: false });
            box.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
            sec.classList.add('sel', 'open');
            return renderLibTools(lib, cats);
          }
          // נגיעה נוספת בקטגוריה המסומנת – מבטלת את הסימון (הצבע והרקע יחד) וסוגרת אותה
          libOpen.delete(c);
          clearSel();
          sec.classList.remove('sel', 'open');
          renderLibTools(lib, cats);
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
  //  מסלול:   עריכה · מחיקה | + מסלול (באותה קטגוריה)
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
      // בלי "פתח" (נגיעה שנייה / כפולה פותחת) ובלי "מסלול": "עריכה" פותחת את המסלול לעריכה – הדרך והשם (בדוק);
      // מסלול שלא תוכנן כאן (בלי נקודות) – רק השם, במקום
      btn(g1, 'edit', 'עריכה', () => {
        if (r.kind === 'plan' && r.wps?.length) { clearSel(); startPlan({ ...r, libId: r.id }); } else { lsel.editing = true; renderLibrary(); }
      });
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

  // נגיעה: כבוי → מדליקים וממרכזים; דלוק והמפה זזה ממך → ממרכזים; דלוק ועליך → מכבים (בלי לחיצה ארוכה חבויה)
  $('btn-locate').addEventListener('click', () => {
    if (watchId != null && follow && !active?.nav) { stopGps(); return toast('GPS כבוי', 1500); }
    startGps();
    setFollow(true);
    if (lastPos) map.easeTo({ center: lastPos.p, zoom: Math.max(map.getZoom(), 15) });
    else toast('מחפש מיקום…', 2000);
  });
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
      logPace(r.along);
    }
    renderRouteInfo();
  }

  // ---------- כפתורים ותפריט ----------
  $('btn-fit').addEventListener('click', () => { setFollow(false); fitRoute(); });

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
    if (isFar()) return Math.abs(map.getBearing()) > 0.5 ? map.rotateTo(0, { duration: 300 }) : toast('במבט על כל הארץ – צפון תמיד למעלה', 1800);
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
    places: ['place-minor', 'place-major', 'ov-city', 'ovh-place'],
    parking: ['parking-icon', 'parking-label'],
    route: ['route-casing', 'route-line', 'route-walked', 'route-ends', 'wpts'],
  };
  const LABELS = new Set(['trail-label', 'road-label', 'water-label', 'poi-label', 'parking-label', 'place-minor', 'place-major', 'ov-city', 'ovh-place']);
  const layerPrefs = Object.assign(
 { sat: 0, labels: true, smooth: true, dimDay: 0.55, dimNight: 0.5, ...Object.fromEntries(Object.keys(GROUPS).map((g) => [g, true])) },
    (() => { try { return JSON.parse(localStorage.getItem('layers')) || {}; } catch { return {}; } })());
  layerPrefs.route = true; // המסלול תמיד מוצג (אין לו יותר תיבה בשכבות)
  // אין יותר בחירה של שכבה-שכבה: כולן דלוקות, ו"הסתרת שכבות" (overlay) מסתירה את כולן יחד
  for (const g of Object.keys(GROUPS)) layerPrefs[g] = true;
  layerPrefs.labels = true;
  // תצלום אוויר: שקיפות 0–1 (סליידר). פעם היה "סוג מפה" (מפה/תצלום/טופו) ו"הסתרת שכבות" – בוטלו
  if ('base' in layerPrefs) { layerPrefs.sat = layerPrefs.base === 'sat' ? 1 : 0; delete layerPrefs.base; }
  delete layerPrefs.overlay;
  layerPrefs.sat = Math.max(0, Math.min(1, +layerPrefs.sat || 0));
  // ערך אחד לסליידר בכל האפליקציה, נשמר (layers.sat) – בשיטוט ובתוך מסלול הידית באותו מקום, רק המשמעות משתנה
  // (פעם: בתוך מסלול ערך נפרד שהתחיל תמיד מ-0 – בוטל)
  const FOCUS_DIM = 0.85; // מסלול ממוקד: כמה המפה מוסתרת
  const inRoute = () => !!active && !plan;
  const sliderVal = () => layerPrefs.sat;
  // הסתרת הרקע – ערך אחד ליום וללילה (פעם היו שניים: ממשיכים מהערך של המצב הנוכחי)
  if (layerPrefs.dim == null) layerPrefs.dim = (localStorage.getItem('theme') === 'dark' ? layerPrefs.dimNight : layerPrefs.dimDay) ?? 0.55;

  function applyLayers() {
    const vis = (on) => (on ? 'visible' : 'none');
    // סליידר אחד, שלושה מצבים. בשיטוט: 0 – מפה; 0.5 – תצלום מלא מתחת למפה; 1 – רק תצלום (מעל המפה).
    // בתוך מסלול: 0 – מסלול ממוקד (המפה כמעט מוסתרת); 0.5 – מפה מלאה; 1 – המסלול על תצלום (מעל המפה)
    const v = sliderVal();
    const under = inRoute() ? 0 : Math.min(1, v * 2), over = Math.max(0, v * 2 - 1);
    map.setLayoutProperty('base-sat', 'visibility', vis(under > 0));
    map.setPaintProperty('base-sat', 'raster-opacity', under);
    map.setLayoutProperty('sat-top', 'visibility', vis(over > 0));
    map.setPaintProperty('sat-top', 'raster-opacity', over);
    for (const [g, ids] of Object.entries(GROUPS))
      for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(layerPrefs[g] && (!LABELS.has(id) || layerPrefs.labels)));
    map.setLayoutProperty('dim', 'visibility', vis(dimValue() > 0 && layerPrefs.route && (!!active || !!plan)));
    map.setPaintProperty('dim', 'fill-opacity', dimValue());
    showSat();
    if (areasMode) hideForAreas();
    try { localStorage.setItem('layers', JSON.stringify(layerPrefs)); } catch { /* ignore */ }
  }
  if (typeof layerPrefs.smooth === 'number') layerPrefs.smooth = layerPrefs.smooth > 0; // מעבר מהגרסה עם רמות
  function smoothLevel() { return layerPrefs.smooth ? 2 : 0; }
  $('btn-areas').addEventListener('click', () => (areasMode ? exitAreasMode() : enterAreasMode()));
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
    ['path', 'line-color', ['case', ['==', ['get', 'b'], 1], '#f57c00', '#4a3d30'], ['case', ['==', ['get', 'b'], 1], '#ffa040', '#b3a596']],
    // בלילה: שביל שחור נשאר שחור אבל מקבל מסגרת בהירה בולטת
    ['trail-casing', 'line-color', ['case', ['==', ['get', 'c'], '#ffffff'], '#3a3a3a', '#ffffff'],
      ['case', ['==', ['get', 'c'], '#ffffff'], '#777777', ['in', ['get', 'c'], ['literal', DARK]], '#e8e8e8', '#0d0f12']],
    ['trail-casing', 'line-opacity', fade(10, 10.7, 0.85), fade(10, 10.7, 1)],
    ['env-fill', 'fill-color', '#2e7d4f', '#81c784'],
    ['dl-grid', 'line-color', '#6b6470', '#9aa3ab'],
    ...GRID_LEVELS.map(({ m }) => ['dl-grid-' + m, 'line-color', '#6b6470', '#9aa3ab']),
    ['env-line', 'line-color', '#2e7d4f', '#81c784'],
    ['env-label', 'text-color', '#1f5f3a', '#a5d6a7'],
    ['ad-label', 'text-color', '#1f5f3a', '#a5d6a7'],
    ['ad-label', 'text-halo-color', 'rgba(255,255,255,.8)', 'rgba(16,19,23,.8)'],
    ['env-dot', 'circle-color', '#2e7d4f', '#81c784'],
    ['env-dot', 'circle-stroke-color', '#ffffff', '#101317'],
    ['env-dot-label', 'text-color', '#1f5f3a', '#a5d6a7'],
    ['env-dot-label', 'text-halo-color', 'rgba(255,255,255,.8)', 'rgba(16,19,23,.8)'],
    ['env-label', 'text-halo-color', 'rgba(255,255,255,.8)', 'rgba(16,19,23,.8)'], // הילה דקה בצבע הרקע – לא קו מתאר לבן גס בלילה
    ['trail', 'line-color', ['get', 'c'], ['get', 'c']],
    ...['water-label', 'road-label', 'trail-label', 'poi-label', 'peak', 'place-minor', 'place-major', 'ov-city', 'ovh-place', 'area-label']
      .flatMap((id) => [[id, 'text-halo-color', '#ffffff', '#101317']]),
    ['water-label', 'text-color', '#2a74b5', '#7dbbec'],
    ['road-label', 'text-color', '#555555', '#b9b9b9'],
    ['trail-label', 'text-color', '#222222', '#eeeeee'],
    ['poi-label', 'text-color', '#333333', '#dddddd'],
    ['peak', 'text-color', '#6d4c2f', '#d9b48c'],
    ['place-minor', 'text-color', '#444444', '#cccccc'],
    ['place-major', 'text-color', '#222222', '#f2f2f2'],
    ...['ov-city', 'ovh-place'].map((id) => [id, 'text-color', '#222222', '#f2f2f2']),
    ['ov-sea', 'fill-color', '#aad3df', '#1c2f3e'],
    ['ov-coast', 'line-color', '#7fa7c9', '#3d6a8f'],
    ['ov-border', 'line-color', '#7a6f80', '#8d8494'],
    ['area-label', 'text-color', '#e06000', '#ffa040'],
    ['dim', 'fill-color', '#ffffff', '#000000'],
    ['route-walked', 'line-color', '#ffffff', '#1b1f24'],
  ];
  for (const t of THEME.slice()) if (t[0] === 'ov-coast' || t[0] === 'ov-border') THEME.push(['ovh-' + t[0].slice(3), ...t.slice(1)]);
  function applyTheme(night) {
    document.body.classList.toggle('night', night);
    document.querySelector('meta[name=theme-color]').content = night ? '#101317' : '#1f5f3a';
    for (const [id, prop, day, nightV] of THEME) if (map.getLayer(id)) map.setPaintProperty(id, prop, night ? nightV : day);
    for (const id of ['base-sat', 'sat-top']) map.setPaintProperty(id, 'raster-brightness-max', night ? 0.7 : 1);
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
    // כל יישובי הארץ מהמפה הכללית – חיפוש בלי רשת גם מחוץ לאזורים שהורדו
    for (const f of overviewFC?.features || []) {
      if (f.properties.k !== 'p') continue;
      const [x, y] = f.geometry.coordinates;
      idx.set('place|' + f.properties.n, { name: f.properties.n, kind: 'place', bbox: [x, y, x, y], key: norm(f.properties.n) });
    }
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

  // ---------- הסתרת הרקע מתחת למסלול: צבע מלא (לבן ביום, שחור בלילה). בלי סליידר (הוחלף בתצלום האוויר):
  // הערך השמור, ופוחת ככל שמעלים את התצלום – כדי שהתצלום לא ייראה דהוי ----------
  function dimValue() {
    if (inRoute()) return FOCUS_DIM * Math.max(0, 1 - layerPrefs.sat * 2);
    return layerPrefs.dim * (1 - Math.min(1, layerPrefs.sat * 2));
  }
  // ---------- הסליידר שליד הכלים ----------
  function showSat() {
    $('sat-v').style.setProperty('--f', sliderVal());
    $('sat-v').setAttribute('aria-valuenow', Math.round(sliderVal() * 100));
    $('sat-v').setAttribute('aria-label', inRoute() ? 'מסלול ממוקד / מפה / תצלום' : 'תצלום אוויר');
  }
  (() => {
    const tr = document.querySelector('#sat-v .vs-track');
    let down = false;
    const at = (e) => {
      const r = tr.getBoundingClientRect();
      let f = Math.round(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 100) / 100;
      // סנאפ עדין באמצע (תצלום מלא מתחת למפה) ובקצוות; רטט קצר כשנתפס באמצע
      if (Math.abs(f - 0.5) < 0.05) f = 0.5; else if (f < 0.03) f = 0; else if (f > 0.97) f = 1;
      const was = sliderVal(), satFrom = inRoute() ? 0.5 : 0; // מאיפה מתחיל התצלום
      if (f === 0.5 && was !== 0.5) navigator.vibrate?.(8);
      if (f > satFrom && was <= satFrom && !navigator.onLine) toast('תצלום אוויר דורש אינטרנט', 3000);
      if (f === was) return;
      layerPrefs.sat = f;
      applyLayers();
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
    if (areasMode) return 'areas';
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
    showSat();
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
    if (m === 'plan') return plan?.wps.length ? (plan.wps.pop(), renderPlan()) : endPlan(); // הנקודה האחרונה; בלי נקודות – יציאה
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
    { k: 'head', name: 'כותרת "מסלולים"', min: 14, max: 30, s: 20, w: 300 },
    { k: 'cat', name: 'כותרת קטגוריה', min: 12, max: 26, s: 16, w: 400 },
    { k: 'row', name: 'שם מסלול', min: 12, max: 24, s: 16, w: 400 },
    { k: 'len', name: 'אורך (ק"מ)', min: 11, max: 22, s: 16, w: 400 },
  ];
  const LS_PAD = { min: 4, max: 22, def: 8 };
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
  $('dev-dot').addEventListener('click', () => {
    showPerf();
    if (dockMode() === 'lib' && !dock.libOpen) setLibOpen(true); // כדי לראות את השינויים על הרשימה עצמה
    renderStyleDlg();
    $('style-dlg').showModal();
  });
  $('ls-reset').addEventListener('click', () => { libStyle = {}; saveLibStyle(); renderStyleDlg(); });
  $('ls-close').addEventListener('click', () => $('style-dlg').close());
  // העתקת הערכים (להדבקה בצ'אט – כדי שיהפכו לברירת המחדל באפליקציה)
  $('ls-copy').addEventListener('click', async () => {
    const vals = { pad: libStyle.pad ?? LS_PAD.def };
    for (const it of LS) vals[it.k] = { s: libStyle[it.k]?.s ?? it.s, w: libStyle[it.k]?.w ?? it.w };
    const txt = 'libStyle ' + JSON.stringify(vals);
    try { await navigator.clipboard.writeText(txt); toast('הועתק – אפשר להדביק בצ׳אט'); }
    catch { $('ls-perf').textContent = txt; toast('לא הצלחתי להעתיק – הערכים למעלה'); }
  });

  // ---------- כפתור "חזור" של הטלפון ----------
  // כשיש לאן לחזור, יש בהיסטוריה רשומה אחת שלנו; "חזור" מוריד אותה (popstate), ואנחנו עושים צעד אחד אחורה.
  // כשאין לאן לחזור – הרשומה יורדת, ו"חזור" הבא יוצא מהאפליקציה כרגיל.
  const openDialog = () => [...document.querySelectorAll('dialog[open]')].pop(); // העליון (אישור מעל השכבות)
  function canGoBack() {
    return !!(openDialog() || areasMode || !$('dock-ask').hidden || $('search-input').value || dockMode() !== 'lib' || dock.libOpen);
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
    else if (areasMode) exitAreasMode();
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
    if (b.id === 'btn-areas') return areasMode; // מצב מפות דלוק – הכפתור נשאר על המסך, לחיצה נוספת יוצאת
    return false;
  }
  function layoutTools() {
    const STAGGER = 30; // מ"ש בין כפתור לכפתור (בתוך הפונקציה – היא נקראת גם לפני שהקוד כאן רץ)
    const col = document.querySelector('#controls .kcol');
    const ctl = col.closest('#controls');
    const open = ctl.classList.contains('open');
    const all = [...col.children].filter((b) => !b.hidden);
    for (const b of col.children) if (b.hidden && b.classList.contains('on')) {
      b.style.setProperty('--d', '0ms');
      b.classList.remove('on');
      (layoutTools.shown || new Set()).delete(b);
    }
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
    $('sat-v').style.height = h + 'px';
    $('sat-v').style.setProperty('--draw', (all.length - 1) * STAGGER + 120 + 'ms'); // הקו יורד באותו קצב שהכפתורים מופיעים
  }
  function setKnife(on) {
    knifeOpen = on;
    knife.classList.toggle('open', knifeOpen);
    layoutTools();
    $('btn-menu').setAttribute('aria-expanded', knifeOpen);
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
