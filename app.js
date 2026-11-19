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
      wpts: { type: 'geojson', data: empty },
      acc: { type: 'geojson', data: empty },
      areas: { type: 'geojson', data: empty },
      draft: { type: 'geojson', data: empty },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#f3f0e6' } },
      { id: 'water', type: 'line', source: 'osm', filter: k('water'),
        paint: { 'line-color': '#5aa9e6', 'line-width': zw(0.6, 2.4) } },
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
      // אזורים שסימנתם
      { id: 'area-fill', type: 'fill', source: 'areas', filter: ['==', '$type', 'Polygon'],
        paint: { 'fill-color': '#ff7a00', 'fill-opacity': 0.07 } },
      { id: 'area-line', type: 'line', source: 'areas', filter: ['==', '$type', 'Polygon'],
        paint: { 'line-color': '#ff7a00', 'line-width': 2.5, 'line-dasharray': [3, 2] } },
      // מסלול ה-GPX: פס רחב ושקוף מתחת לשבילים כדי שצבע הסימון יישאר גלוי
      { id: 'route-halo', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ff1fa6', 'line-opacity': 0.38, 'line-width': zw(8, 18) } },
      // שבילים מסומנים
      { id: 'trail-casing', type: 'line', source: 'osm', filter: k('trail'), layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['case', ['==', ['get', 'c'], '#ffffff'], '#666', '#ffffff'],
          'line-opacity': 0.85, 'line-width': zw(2.5, 7) } },
      { id: 'trail', type: 'line', source: 'osm', filter: k('trail'), layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'c'], 'line-width': zw(1.5, 4.5) } },
      { id: 'route-line', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#c2007a', 'line-width': zw(1.2, 2.2) } },
      { id: 'route-arrows', type: 'symbol', source: 'route', filter: ['==', '$type', 'LineString'],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 80, 'icon-image': 'arrow',
          'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map' } },
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
      { id: 'poi-dot', type: 'circle', source: 'osm', filter: ['all', k('poi'), ['!=', ['get', 't'], 'peak']], minzoom: 12.5,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.5, 3, 16, 6], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff',
          'circle-color': ['match', ['get', 't'], ['spring', 'water'], '#1f88e5', 'viewpoint', '#e53935',
            ['ruins', 'archaeological_site'], '#795548', 'cave_entrance', '#424242', '#43a047'] } },
      { id: 'poi-label', type: 'symbol', source: 'osm', filter: ['all', k('poi'), ['has', 'n'], ['!=', ['get', 't'], 'peak']], minzoom: 14,
        layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 0.6],
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
      // נקודות המסלול
      { id: 'route-ends', type: 'circle', source: 'route', filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 7, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#fff',
          'circle-color': ['match', ['get', 'kind'], 'start', '#1a9b3c', '#c62828'] } },
      { id: 'wpts', type: 'circle', source: 'wpts',
        paint: { 'circle-radius': 6, 'circle-color': '#f39c12', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } },
      { id: 'area-label', type: 'symbol', source: 'areas', filter: ['==', '$type', 'Point'],
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 15, 'text-max-width': 10 },
        paint: { 'text-color': '#e06000', ...halo, 'text-halo-width': 2 } },
      { id: 'draft-line', type: 'line', source: 'draft',
        paint: { 'line-color': '#ff7a00', 'line-width': 3 } },
      { id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': '#ff7a00', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } },
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
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 100 }), 'bottom-left');
  map.on('moveend', () => {
    try {
      const c = map.getCenter();
      localStorage.setItem('view', JSON.stringify({ center: [c.lng, c.lat], zoom: map.getZoom() }));
    } catch { /* ignore */ }
  });
  map.on('styleimagemissing', (e) => e.id === 'arrow' && !map.hasImage('arrow') && map.addImage('arrow', arrowImage(), { pixelRatio: 2 }));
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
  function setMapData(fc) {
    mapFC = fc;
    searchIndex = null;
    map.getSource('osm').setData(fc);
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
    g.strokeStyle = '#c2007a'; g.lineWidth = 3.5; chevron();
    return g.getImageData(0, 0, s, s);
  }

  map.on('click', 'wpts', (e) => {
    const f = e.features[0];
    if (!f.properties.name) return;
    const el = document.createElement('div');
    el.textContent = f.properties.name;
    new maplibregl.Popup({ closeButton: false }).setLngLat(f.geometry.coordinates).setDOMContent(el).addTo(map);
  });

  // ---------- מסלול GPX ----------
  let route = null;
  let routeData = null;
  let prevAlong = null;

  async function showGpx(text, fit) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const g = Geo.parseGpx(doc);
    await mapReady;
    route = Geo.buildRoute(g.lines);
    routeData = g;
    prevAlong = null;
    const features = g.lines.map((l) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l }, properties: {} }));
    if (route.pts.length > 1) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: route.pts[route.pts.length - 1] }, properties: { kind: 'end' } });
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: route.pts[0] }, properties: { kind: 'start' } });
    }
    map.getSource('route').setData({ type: 'FeatureCollection', features });
    map.getSource('wpts').setData({ type: 'FeatureCollection',
      features: g.waypoints.map((w) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: w.coord }, properties: { name: w.name } })) });
    $('btn-fit').hidden = false;
    $('status').hidden = route.pts.length < 2;
    if (fit) fitRoute();
    updateStatus();
    return g;
  }

  function fitRoute() {
    if (!routeData) return;
    const all = routeData.lines.flat().concat(routeData.waypoints.map((w) => w.coord));
    if (all.length) map.fitBounds(Geo.bounds(all), { padding: { top: 70, bottom: 100, left: 40, right: 76 }, maxZoom: 16 });
  }

  async function loadGpxFile(file) {
    try {
      const text = await file.text();
      const g = await showGpx(text, true);
      await db.set('gpx', text);
      toast(`${g.name || 'מסלול'} · ${Geo.fmtDist(route.total)}`);
    } catch (e) {
      console.error(e);
      toast(e.message || 'שגיאה בטעינת הקובץ');
    }
  }

  async function clearRoute() {
    route = routeData = null;
    await mapReady;
    map.getSource('route').setData(empty);
    map.getSource('wpts').setData(empty);
    $('btn-fit').hidden = true;
    $('status').hidden = true;
    await db.del('gpx');
  }

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
    el.classList.toggle('has-heading', moving);
    if (moving) marker.setRotation(heading);
    el.classList.toggle('poor', accuracy > 50);
    map.getSource('acc')?.setData({ type: 'Feature', geometry: Geo.circle(p, accuracy), properties: {} });
    if (follow) map.easeTo({ center: p, zoom: first ? Math.max(map.getZoom(), 15.5) : map.getZoom(), duration: first ? 600 : 400 });
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

  function setFollow(on) {
    follow = on;
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
    const offEl = $('s-off');
    if (!lastPos) {
      offEl.textContent = '–';
      offEl.className = 'val';
      $('s-done').textContent = '–';
      $('s-left').textContent = Geo.fmtDist(route.total);
      return;
    }
    const r = Geo.locate(route, lastPos.p, prevAlong);
    prevAlong = r.along;
    offEl.textContent = Geo.fmtDist(r.off);
    offEl.className = 'val ' + (r.off <= Math.max(25, lastPos.accuracy) ? 'ok' : r.off <= 100 ? 'warn' : 'bad');
    $('s-done').textContent = Geo.fmtDist(r.along);
    $('s-left').textContent = Geo.fmtDist(route.total - r.along);
  }

  // ---------- כפתורים ותפריט ----------
  const gpxInput = $('file-gpx'), menu = $('menu');
  $('btn-gpx').addEventListener('click', () => gpxInput.click());
  $('btn-fit').addEventListener('click', () => { setFollow(false); fitRoute(); });
  $('btn-menu').addEventListener('click', async () => {
    const ready = navigator.serviceWorker?.controller ? 'האפליקציה והמפה שמורות לשימוש אופליין ✓' : 'טוען לשימוש אופליין…';
    $('offline-info').textContent = ready;
    menu.showModal();
  });
  $('m-close').addEventListener('click', () => menu.close());
  $('m-gpx').addEventListener('click', () => { menu.close(); gpxInput.click(); });
  $('m-clear').addEventListener('click', () => { menu.close(); clearRoute(); });
  $('m-area').addEventListener('click', () => { menu.close(); downloadVisible(); });
  $('m-draw').addEventListener('click', () => { menu.close(); startDraw(); });
  $('m-areas').addEventListener('click', () => { menu.close(); renderAreas(); $('areas-dlg').showModal(); });
  $('areas-close').addEventListener('click', () => $('areas-dlg').close());
  $('m-carmel').addEventListener('click', () => { menu.close(); downloadArea(CARMEL); });
  $('w-carmel').addEventListener('click', () => downloadArea(CARMEL));
  gpxInput.addEventListener('change', () => { if (gpxInput.files[0]) loadGpxFile(gpxInput.files[0]); gpxInput.value = ''; });

  // ---------- מצב לילה ----------
  const THEME = [ // [שכבה, מאפיין, יום, לילה]
    ['bg', 'background-color', '#f3f0e6', '#15191e'],
    ['water', 'line-color', '#5aa9e6', '#3d7fb3'],
    ['major-casing', 'line-color', '#b8742a', '#4d3215'],
    ['major', 'line-color', '#f7a656', '#9a6430'],
    ['medium-casing', 'line-color', '#c4a03a', '#4a3e18'],
    ['medium', 'line-color', '#ffe38f', '#7d6f38'],
    ['minor-casing', 'line-color', '#b5b5b5', '#2c2f33'],
    ['minor', 'line-color', '#ffffff', '#5a5e63'],
    ['track', 'line-color', '#8b6b3e', '#a98b5e'],
    ['path', 'line-color', '#4a3d30', '#b3a596'],
    ['trail-casing', 'line-color', ['case', ['==', ['get', 'c'], '#ffffff'], '#666', '#ffffff'],
      ['case', ['==', ['get', 'c'], '#ffffff'], '#888', '#0d0f12']],
    ['trail', 'line-color', ['get', 'c'], ['case', ['==', ['get', 'c'], '#222222'], '#d8d8d8', ['get', 'c']]],
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
    ['poi-dot', 'circle-stroke-color', '#ffffff', '#101317'],
  ];
  function applyTheme(night) {
    document.body.classList.toggle('night', night);
    document.querySelector('meta[name=theme-color]').content = night ? '#101317' : '#1f5f3a';
    for (const [id, prop, day, nightV] of THEME) if (map.getLayer(id)) map.setPaintProperty(id, prop, night ? nightV : day);
  }
  const nightPref = localStorage.getItem('night');
  $('m-night').checked = nightPref ? nightPref === '1' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.classList.toggle('night', $('m-night').checked);
  mapReady.then(() => applyTheme($('m-night').checked));
  $('m-night').addEventListener('change', (e) => {
    localStorage.setItem('night', e.target.checked ? '1' : '0');
    applyTheme(e.target.checked);
  });

  // ---------- אזורים מסומנים ----------
  const PRESETS = [{ name: 'שוויצריה הקטנה', bbox: [35.0, 32.735, 35.05, 32.765] }];
  let areas = [];
  const polyBbox = (ring) => Geo.bounds(ring).flat();

  function renderAreas() {
    const features = [];
    for (const a of areas) {
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [a.ring] }, properties: { name: a.name } });
      const [w, s, e, n] = polyBbox(a.ring);
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [(w + e) / 2, (s + n) / 2] }, properties: { name: a.name } });
    }
    map.getSource('areas')?.setData({ type: 'FeatureCollection', features });
    const list = $('areas-list');
    list.replaceChildren();
    if (!areas.length) list.innerHTML = '<p class="muted">עדיין לא סימנתם אזורים.</p>';
    for (const a of areas) {
      const row = document.createElement('div');
      row.className = 'area-row';
      row.innerHTML = '<b></b><span><button data-a="go">הצג</button><button data-a="dl">הורד מפה</button><button data-a="del">מחק</button></span>';
      row.querySelector('b').textContent = a.name;
      row.addEventListener('click', async (ev) => {
        const act = ev.target.dataset?.a;
        if (!act) return;
        $('areas-dlg').close();
        if (act === 'go') flyToBbox(polyBbox(a.ring));
        if (act === 'dl') { const [w, s, e, n] = polyBbox(a.ring); downloadBbox([w - 0.003, s - 0.003, e + 0.003, n + 0.003]); }
        if (act === 'del') { areas = areas.filter((x) => x !== a); await db.set('areas', areas); renderAreas(); toast('האזור נמחק'); }
      });
      list.appendChild(row);
    }
  }
  Promise.all([db.get('areas').catch(() => null), mapReady]).then(([a]) => { areas = a || []; renderAreas(); });

  function flyToBbox(b) {
    setFollow(false);
    if (b[0] === b[2] && b[1] === b[3]) map.flyTo({ center: [b[0], b[1]], zoom: 15.5 });
    else map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 50, maxZoom: 16 });
  }

  // מצב ציור: הקשה על המפה מוסיפה נקודה
  let draft = null;
  function renderDraft() {
    const f = draft.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }));
    if (draft.length > 1) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: draft.length > 2 ? [...draft, draft[0]] : draft }, properties: {} });
    map.getSource('draft').setData({ type: 'FeatureCollection', features: f });
    $('draw-hint').textContent = draft.length < 3 ? `הקישו על המפה כדי לסמן את גבולות האזור (${draft.length}/3 לפחות)` : `${draft.length} נקודות · אפשר להמשיך או לסיים`;
    $('draw-done').disabled = draft.length < 3;
  }
  function startDraw() {
    draft = [];
    setFollow(false);
    $('drawbar').hidden = false;
    document.body.classList.add('drawing');
    renderDraft();
  }
  function endDraw() {
    draft = null;
    map.getSource('draft').setData(empty);
    $('drawbar').hidden = true;
    document.body.classList.remove('drawing');
  }
  map.on('click', (e) => { if (draft) { draft.push([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]); renderDraft(); } });
  $('draw-undo').addEventListener('click', () => { draft.pop(); renderDraft(); });
  $('draw-cancel').addEventListener('click', endDraw);
  $('draw-done').addEventListener('click', () => { $('area-name').value = ''; $('name-dlg').showModal(); $('area-name').focus(); });
  $('name-dlg').addEventListener('close', async () => {
    if ($('name-dlg').returnValue !== 'ok' || !draft) return;
    const name = $('area-name').value.trim() || `אזור ${areas.length + 1}`;
    areas.push({ id: Date.now(), name, ring: [...draft, draft[0]] });
    await db.set('areas', areas);
    endDraw();
    renderAreas();
    toast(`"${name}" נשמר ✓ אפשר להוריד לו מפה מ"האזורים שלי"`, 5000);
  });

  // ---------- חיפוש ----------
  const KIND = { trail: 'שביל', road: 'דרך', water: 'נחל', place: 'יישוב / מקום', area: 'האזור שלי', preset: 'אזור',
    peak: 'פסגה', spring: 'מעיין', viewpoint: 'תצפית', ruins: 'חורבה', archaeological_site: 'אתר עתיקות',
    cave_entrance: 'מערה', picnic_site: 'חניון', camp_site: 'חניון לילה', attraction: 'אתר', water_poi: 'ברזייה' };
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

  function localSearch(q) {
    const nq = norm(q);
    if (!nq) return [];
    searchIndex ||= buildIndex();
    const extra = [...PRESETS.map((p) => ({ ...p, kind: 'preset' })), ...areas.map((a) => ({ name: a.name, kind: 'area', bbox: polyBbox(a.ring) }))]
      .map((x) => ({ ...x, key: norm(x.name) }));
    const rank = { area: 0, preset: 0, place: 1, peak: 2, spring: 2, viewpoint: 2, trail: 3 };
    const lq = loose(nq);
    return [...extra, ...searchIndex]
      .filter((x) => x.key.includes(nq) || (lq.length > 1 && loose(x.key).includes(lq)))
      .sort((a, b) => (b.key.startsWith(nq) - a.key.startsWith(nq)) || ((rank[a.kind] ?? 4) - (rank[b.kind] ?? 4)) || a.name.length - b.name.length)
      .slice(0, 30);
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
  $('btn-search').addEventListener('click', openSearch);
  $('search-close').addEventListener('click', closeSearch);
  $('search-input').addEventListener('input', (e) => {
    const r = localSearch(e.target.value);
    showResults(r, e.target.value.trim() ? (r.length ? 'לא מצאתם? הקישו "חפש" במקלדת לחיפוש באינטרנט' : 'אין תוצאות במפה השמורה – הקישו "חפש" לחיפוש באינטרנט') : '');
  });
  $('search-form').addEventListener('submit', (e) => { e.preventDefault(); if ($('search-input').value.trim()) onlineSearch($('search-input').value.trim()); });

  // ---------- הפעלה ----------
  db.get('gpx').then((t) => t && showGpx(t, false)).catch(console.error);
  if (navigator.storage?.persist) navigator.storage.persist();
  navigator.permissions?.query({ name: 'geolocation' }).then((s) => {
    if (s.state === 'granted') startGps();
  }).catch(() => {});
})();
