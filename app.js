/* שבילים – ניווט אופליין במסלולי הליכה (מפה וקטורית מ-OpenStreetMap). */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DEFAULT_VIEW = { center: [35.03, 32.75], zoom: 13.5 }; // שוויצריה הקטנה
  const CARMEL = [34.94, 32.60, 35.13, 32.84]; // הכרמל, כולל שוויצריה הקטנה (מערב, דרום, מזרח, צפון)
  const FONT = ['Noto Sans Regular'];
  const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
  const RTL_PLUGIN = 'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js';

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
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
      const fc = await OSM.download(bbox, (m) => toast(m, 120000));
      if (!fc.features.length) throw new Error('לא נמצאו נתונים באזור');
      await db.set('mapdata', fc);
      await mapReady;
      map.getSource('osm').setData(fc);
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

  function downloadVisible() {
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => +v.toFixed(4));
    if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > 0.12) return toast('האזור גדול מדי – התקרבו (זום) ונסו שוב', 5000);
    downloadArea(bbox);
  }

  Promise.all([db.get('mapdata').catch(() => null), mapReady]).then(([fc]) => {
    if (fc) map.getSource('osm').setData(fc);
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
  $('m-carmel').addEventListener('click', () => { menu.close(); downloadArea(CARMEL); });
  $('w-carmel').addEventListener('click', () => downloadArea(CARMEL));
  gpxInput.addEventListener('change', () => { if (gpxInput.files[0]) loadGpxFile(gpxInput.files[0]); gpxInput.value = ''; });

  // ---------- הפעלה ----------
  db.get('gpx').then((t) => t && showGpx(t, false)).catch(console.error);
  if (navigator.storage?.persist) navigator.storage.persist();
  navigator.permissions?.query({ name: 'geolocation' }).then((s) => {
    if (s.state === 'granted') startGps();
  }).catch(() => {});
})();
