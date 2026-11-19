/* פונקציות גאוגרפיות טהורות: פענוח GPX, מרחקים, מיקום ביחס למסלול. */
(function (root) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;

  function haversine(a, b) {
    const dLat = rad(b[1] - a[1]);
    const dLon = rad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** GPX (Document) -> { lines: [[ [lon,lat], ... ], ...], waypoints: [{coord,name}], name } */
  function parseGpx(doc) {
    if (doc.getElementsByTagName('parsererror').length) throw new Error('קובץ GPX לא תקין');
    const pt = (el) => [parseFloat(el.getAttribute('lon')), parseFloat(el.getAttribute('lat'))];
    const valid = (c) => Number.isFinite(c[0]) && Number.isFinite(c[1]);
    const text = (el, tag) => {
      const n = Array.from(el.children).find((c) => c.localName === tag);
      return n ? n.textContent.trim() : '';
    };
    const lines = [];
    for (const seg of doc.getElementsByTagName('trkseg')) {
      const l = Array.from(seg.getElementsByTagName('trkpt')).map(pt).filter(valid);
      if (l.length > 1) lines.push(l);
    }
    for (const rte of doc.getElementsByTagName('rte')) {
      const l = Array.from(rte.getElementsByTagName('rtept')).map(pt).filter(valid);
      if (l.length > 1) lines.push(l);
    }
    const waypoints = Array.from(doc.getElementsByTagName('wpt'))
      .map((w) => ({ coord: pt(w), name: text(w, 'name') }))
      .filter((w) => valid(w.coord));
    const trk = doc.getElementsByTagName('trk')[0] || doc.getElementsByTagName('rte')[0];
    const meta = doc.getElementsByTagName('metadata')[0];
    const name = (trk && text(trk, 'name')) || (meta && text(meta, 'name')) || '';
    if (!lines.length && !waypoints.length) throw new Error('לא נמצא מסלול בקובץ');
    return { lines, waypoints, name };
  }

  /** מאחד את כל הקטעים לנתיב אחד עם מרחק מצטבר. */
  function buildRoute(lines) {
    const pts = [];
    const cum = [];
    const breaks = new Set(); // אינדקס שבו מתחיל קטע חדש (אין קפיצה במרחק)
    let total = 0;
    lines.forEach((line, li) => {
      line.forEach((p, i) => {
        if (pts.length) {
          if (i === 0 && li > 0) breaks.add(pts.length);
          else total += haversine(pts[pts.length - 1], p);
        }
        pts.push(p);
        cum.push(total);
      });
    });
    return { pts, cum, breaks, total };
  }

  /**
   * מיקום ביחס למסלול.
   * prevAlong – ההתקדמות הקודמת; משמש להעדפת הקטע הנכון כשהמסלול חוזר על עצמו.
   * מחזיר { off: מטרים מהמסלול, along: מטרים שנעשו לאורך המסלול, point: [lon,lat] }
   */
  function locate(route, p, prevAlong) {
    const { pts, cum, breaks } = route;
    if (pts.length < 2) return null;
    const kx = Math.cos(rad(p[1])) * 111320;
    const ky = 110540;
    const cands = [];
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
      if (breaks.has(i)) continue;
      const ax = (pts[i - 1][0] - p[0]) * kx, ay = (pts[i - 1][1] - p[1]) * ky;
      const bx = (pts[i][0] - p[0]) * kx, by = (pts[i][1] - p[1]) * ky;
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 ? -(ax * dx + ay * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cy = ay + t * dy;
      const d = Math.hypot(cx, cy);
      const along = cum[i - 1] + t * (cum[i] - cum[i - 1]);
      cands.push({ d, along, i, t });
      if (d < best) best = d;
    }
    let pick = cands.reduce((a, b) => (b.d < a.d ? b : a));
    if (prevAlong != null) {
      const near = cands.filter((c) => c.d <= best + 25);
      pick = near.reduce((a, b) => (Math.abs(b.along - prevAlong) < Math.abs(a.along - prevAlong) ? b : a));
    }
    const a = pts[pick.i - 1], b = pts[pick.i];
    return {
      off: pick.d,
      along: pick.along,
      point: [a[0] + (b[0] - a[0]) * pick.t, a[1] + (b[1] - a[1]) * pick.t],
    };
  }

  function circle(center, radiusM, steps = 48) {
    const kx = Math.cos(rad(center[1])) * 111320, ky = 110540;
    const ring = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      ring.push([center[0] + (Math.cos(a) * radiusM) / kx, center[1] + (Math.sin(a) * radiusM) / ky]);
    }
    return { type: 'Polygon', coordinates: [ring] };
  }

  function fmtDist(m) {
    if (m == null || !Number.isFinite(m)) return '–';
    if (m < 1000) return `${Math.round(m)} מ'`;
    return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} ק"מ`;
  }

  function bounds(coords) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of coords) {
      if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
    }
    return [[w, s], [e, n]];
  }

  /** החלקת קו (Chaikin): מעגלת פינות, שומרת על נקודות הקצה כדי שחיבורים בין קווים יישמרו */
  function chaikin(pts, iters = 2) {
    for (let k = 0; k < iters && pts.length > 2; k++) {
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
        // קטעים קצרים (~4 מ') לא מחולקים – כדי שמספר הנקודות לא יתפוצץ ברמות עיגול גבוהות
        if (Math.abs(x1 - x0) + Math.abs(y1 - y0) < 4e-5) { if (i > 0) out.push(pts[i]); continue; }
        out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }
  /**
   * מחליק קווים. נקודות שבהן קו אחר מתחיל/נגמר (צמתים) נשארות במקומן,
   * כדי ששביל שמתחבר לאמצע דרך לא "יתנתק" ממנה אחרי ההחלקה.
   * makeSmoother מחזיר פונקציה שמחליקה כל קו באותה צורה (גם את המסלול המתוכנן, כדי שיתאים לשבילים במפה).
   */
  function makeSmoother(fc, iters = 2) {
    const key = (p) => p[0] + ',' + p[1];
    const ends = new Set();
    for (const f of fc.features) {
      if (f.geometry.type !== 'LineString') continue;
      const c = f.geometry.coordinates;
      ends.add(key(c[0])); ends.add(key(c[c.length - 1]));
    }
    return (pts) => {
      const out = [];
      let start = 0;
      for (let i = 1; i < pts.length; i++) {
        if (i === pts.length - 1 || ends.has(key(pts[i]))) {
          const piece = chaikin(pts.slice(start, i + 1), iters);
          out.push(...(out.length ? piece.slice(1) : piece));
          start = i;
        }
      }
      return out.length ? out : pts;
    };
  }
  function smoothFC(fc, iters = 2) {
    const sm = makeSmoother(fc, iters);
    return { type: 'FeatureCollection', features: fc.features.map((f) => f.geometry.type !== 'LineString' ? f
      : { ...f, geometry: { type: 'LineString', coordinates: sm(f.geometry.coordinates) } }) };
  }

  const Geo = { chaikin, smoothFC, makeSmoother, haversine, parseGpx, buildRoute, locate, circle, fmtDist, bounds };
  if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
  root.Geo = Geo;
})(typeof self !== 'undefined' ? self : globalThis);
