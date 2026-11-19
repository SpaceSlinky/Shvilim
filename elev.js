/* נתוני גובה (DEM) מאריחי Terrarium הפתוחים של AWS: הורדה מוקדמת לאזור, דגימה ופרופיל גובה למסלול. */
(function (root) {
  const Z = 13; // ~15 מ' לפיקסל בקו הרוחב של ישראל
  const URL_T = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const tiles = new Map(); // "x/y" -> Promise<Float32Array|null>

  const n = 1 << Z;
  const worldX = (lon) => ((lon + 180) / 360) * n * 256;
  const worldY = (lat) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n * 256;
  };

  function loadTile(x, y) {
    const k = x + '/' + y;
    if (!tiles.has(k)) {
      tiles.set(k, (async () => {
        try {
          const res = await fetch(URL_T.replace('{z}', Z).replace('{x}', x).replace('{y}', y));
          if (!res.ok) return null;
          const bmp = await createImageBitmap(await res.blob());
          const c = document.createElement('canvas');
          c.width = c.height = 256;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(bmp, 0, 0);
          const d = g.getImageData(0, 0, 256, 256).data;
          const out = new Float32Array(256 * 256);
          for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
          return out;
        } catch { return null; }
      })());
    }
    return tiles.get(k);
  }

  async function prefetch(bbox) {
    const [w, s, e, nn] = bbox;
    const x0 = Math.floor(worldX(w) / 256), x1 = Math.floor(worldX(e) / 256);
    const y0 = Math.floor(worldY(nn) / 256), y1 = Math.floor(worldY(s) / 256);
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(loadTile(x, y));
    const res = await Promise.all(jobs);
    return res.filter(Boolean).length;
  }

  // דגימה בילינארית (אחרי שהאריחים נטענו)
  function sampleSync(lon, lat, loaded) {
    const wx = worldX(lon) - 0.5, wy = worldY(lat) - 0.5;
    const px = Math.floor(wx), py = Math.floor(wy);
    const fx = wx - px, fy = wy - py;
    const get = (X, Y) => {
      const t = loaded.get(Math.floor(X / 256) + '/' + Math.floor(Y / 256));
      return t ? t[(Y & 255) * 256 + (X & 255)] : NaN;
    };
    const a = get(px, py), b = get(px + 1, py), c = get(px, py + 1), d = get(px + 1, py + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  /**
   * פרופיל גובה לאורך קו: דגימה כל step מטרים.
   * מחזיר { dist[], ele[], gain, loss, min, max, total } או null אם אין נתוני גובה.
   */
  async function profile(coords, step = 15) {
    if (!coords || coords.length < 2) return null;
    const pts = [coords[0]], dist = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      const kx = Math.cos((a[1] * Math.PI) / 180) * 111320;
      const L = Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540);
      const nSteps = Math.max(1, Math.ceil(L / step));
      for (let j = 1; j <= nSteps; j++) {
        const t = j / nSteps;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        dist.push(total + L * t);
      }
      total += L;
    }
    const need = new Set(pts.map((p) => Math.floor(worldX(p[0]) / 256) + '/' + Math.floor(worldY(p[1]) / 256)));
    // גם אריחים שכנים לדגימה בקצוות
    for (const k of [...need]) {
      const [x, y] = k.split('/').map(Number);
      need.add(x + 1 + '/' + y); need.add(x + '/' + (y + 1)); need.add(x + 1 + '/' + (y + 1));
    }
    const loaded = new Map();
    await Promise.all([...need].map(async (k) => {
      const [x, y] = k.split('/').map(Number);
      const t = await loadTile(x, y);
      if (t) loaded.set(k, t);
    }));
    let ele = pts.map((p) => sampleSync(p[0], p[1], loaded));
    if (ele.some((v) => !Number.isFinite(v))) return null;
    // החלקה (ממוצע נע) להפחתת רעש
    const W = 3;
    ele = ele.map((_, i) => {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(ele.length - 1, i + W); j++) { s += ele[j]; c++; }
      return s / c;
    });
    // עלייה/ירידה מצטברת עם סף (היסטרזיס) כדי לא לספור רעש
    const TH = 2;
    let gain = 0, loss = 0, ref = ele[0];
    for (const v of ele) {
      if (v - ref >= TH) { gain += v - ref; ref = v; }
      else if (ref - v >= TH) { loss += ref - v; ref = v; }
    }
    return { dist, ele, gain, loss, min: Math.min(...ele), max: Math.max(...ele), total };
  }

  root.Elev = { prefetch, profile, Z };
})(typeof self !== 'undefined' ? self : globalThis);
