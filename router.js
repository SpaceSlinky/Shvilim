/* ניתוב על גבי נתוני המפה השמורים (אופליין): בניית גרף מהשבילים והדרכים, הצמדת נקודה לשביל וחיפוש A*. */
(function (root) {
  const KX = (lat) => Math.cos((lat * Math.PI) / 180) * 111320;
  const KY = 110540;

  // מקדם "עלות" לכל סוג דרך (1 = שביל רגיל). Infinity = אסור.
  const FACTOR = {
    path: 1, footway: 1, bridleway: 1.05, steps: 1.3, track: 1.05, pedestrian: 1.1, living_street: 1.2,
    residential: 1.3, unclassified: 1.4, tertiary: 2, tertiary_link: 2, secondary: 3, secondary_link: 3,
    primary: 6, primary_link: 6, trunk: Infinity, trunk_link: Infinity, motorway: Infinity, motorway_link: Infinity,
    cycleway: 1,
  };
  const TRAIL_FACTOR = 0.75; // העדפה לשבילים מסומנים

  const keyOf = (p) => Math.round(p[0] * 1e6) * 1e8 + Math.round(p[1] * 1e6);

  /**
   * opts.bike – לכלול שבילים ייעודיים לאופניים ולהימנע ממדרגות
   */
  function buildGraph(fc, opts = {}) {
    const ids = new Map();
    const X = [], Y = [], adj = [];
    const E = []; // { a, b, len, f, c (צבע שביל או null), h }
    const ekey = new Map();
    const node = (p) => {
      const k = keyOf(p);
      let i = ids.get(k);
      if (i === undefined) { i = X.length; ids.set(k, i); X.push(p[0]); Y.push(p[1]); adj.push([]); }
      return i;
    };
    const roads = [], trails = [];
    for (const f of fc.features) {
      if (f.geometry.type !== 'LineString') continue;
      const p = f.properties;
      if (p.k === 'road') roads.push(f);
      else if (p.k === 'trail' || p.k === 'bike') trails.push(f);
    }
    for (const f of roads) {
      const p = f.properties;
      let fac = FACTOR[p.h] ?? 1.3;
      if (p.fn) fac = Infinity;                       // foot=no
      if (p.b || p.h === 'cycleway') fac = opts.bike ? 1 : Infinity;
      if (opts.bike && p.h === 'steps') fac = Infinity;
      if (!Number.isFinite(fac)) continue;
      addLine(f.geometry.coordinates, fac, null, p.h);
    }
    // שבילים מסומנים: מעדכנים את הקטעים הקיימים (צבע + העדפה), ומוסיפים קטעים שאין להם דרך מתחת
    for (const f of trails) {
      const p = f.properties;
      if (p.k === 'bike' && !opts.bike) continue;
      const c = f.geometry.coordinates;
      for (let i = 1; i < c.length; i++) {
        const a = node(c[i - 1]), b = node(c[i]);
        const e = ekey.get(a < b ? a + ':' + b : b + ':' + a);
        if (e !== undefined) {
          const ed = E[e];
          if (p.k === 'trail' && !ed.c) ed.c = p.c;
          // קטע של כמה שבילים מסומנים (למשל ירוק וכחול על אותה דרך) – שומרים את כל הצבעים
          if (p.k === 'trail' && !(ed.cs ||= []).includes(p.c)) ed.cs.push(p.c);
          if (p.k === 'trail') ed.f = Math.min(ed.f, TRAIL_FACTOR);
        } else if (p.k === 'trail') { addEdge(a, b, TRAIL_FACTOR, p.c, 'path'); E[E.length - 1].cs = [p.c]; }
      }
    }
    function addLine(c, fac, color, h) {
      for (let i = 1; i < c.length; i++) addEdge(node(c[i - 1]), node(c[i]), fac, color, h);
    }
    function addEdge(a, b, f, c, h) {
      if (a === b) return;
      const k = a < b ? a + ':' + b : b + ':' + a;
      const ex = ekey.get(k);
      if (ex !== undefined) { E[ex].f = Math.min(E[ex].f, f); return; }
      const len = Math.hypot((X[b] - X[a]) * KX(Y[a]), (Y[b] - Y[a]) * KY);
      const idx = E.length;
      E.push({ a, b, len, f, c, h });
      ekey.set(k, idx);
      adj[a].push(idx);
      adj[b].push(idx);
    }
    // אינדקס מרחבי של הקטעים – להצמדת נקודות
    const CELL = 0.001;
    const grid = new Map();
    const cell = (x, y) => Math.floor(x / CELL) * 100000 + Math.floor(y / CELL);
    E.forEach((e, i) => {
      const x0 = Math.min(X[e.a], X[e.b]), x1 = Math.max(X[e.a], X[e.b]);
      const y0 = Math.min(Y[e.a], Y[e.b]), y1 = Math.max(Y[e.a], Y[e.b]);
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
          const k = cx * 100000 + cy;
          let l = grid.get(k);
          if (!l) grid.set(k, (l = []));
          l.push(i);
        }
      }
    });
    return { X, Y, adj, E, grid, CELL, cell, opts };
  }

  /** הצמדה לקטע הקרוב ביותר (עד maxDist מטרים). מחזיר { e, t, p:[lon,lat], d } */
  function snap(g, p, maxDist = 150) {
    const { X, Y, E, grid, CELL } = g;
    const kx = KX(p[1]);
    const r = Math.ceil(maxDist / 111000 / CELL) + 1;
    const cx0 = Math.floor(p[0] / CELL), cy0 = Math.floor(p[1] / CELL);
    let best = null;
    const seen = new Set();
    for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
      for (let cy = cy0 - r; cy <= cy0 + r; cy++) {
        for (const i of grid.get(cx * 100000 + cy) || []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const e = E[i];
          const ax = (X[e.a] - p[0]) * kx, ay = (Y[e.a] - p[1]) * KY;
          const bx = (X[e.b] - p[0]) * kx, by = (Y[e.b] - p[1]) * KY;
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
          const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          // העדפה קלה לשבילים מסומנים כששני קטעים כמעט באותו מרחק
          const score = d - (e.c ? 3 : 0);
          if (d <= maxDist && (!best || score < best.score)) best = { e: i, t, d, score };
        }
      }
    }
    if (!best) return null;
    const e = E[best.e];
    best.p = [X[e.a] + (X[e.b] - X[e.a]) * best.t, Y[e.a] + (Y[e.b] - Y[e.a]) * best.t];
    return best;
  }

  // ערימה בינארית מינימלית
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v;
      let i = k.length;
      k.push(key); v.push(val);
      while (i > 0) {
        const pa = (i - 1) >> 1;
        if (k[pa] <= key) break;
        k[i] = k[pa]; v[i] = v[pa]; i = pa;
      }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v;
      const top = v[0];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        let i = 0;
        const n = k.length;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  /**
   * מסלול בין שתי נקודות מוצמדות. מחזיר { coords, segs:[{coords, c, h}], len, edges } או null.
   * avoid – קטעים (אינדקסים) שעדיף לא לעבור בהם (פי 5), למשל הדרך שבה באת.
   */
  function route(g, s, t, { avoid } = {}) {
    const { X, Y, adj, E } = g;
    const N = X.length;
    const S = N, T = N + 1; // צמתים וירטואליים
    const px = (i) => (i === S ? s.p[0] : i === T ? t.p[0] : X[i]);
    const py = (i) => (i === S ? s.p[1] : i === T ? t.p[1] : Y[i]);
    // קשתות וירטואליות: מהנקודה המוצמדת לשני קצות הקטע שלה
    const vEdges = new Map(); // node -> [{to, len, f, c, h}]
    const addV = (u, v, len, e) => {
      if (!vEdges.has(u)) vEdges.set(u, []);
      if (!vEdges.has(v)) vEdges.set(v, []);
      vEdges.get(u).push({ to: v, len, f: e.f, c: e.c, h: e.h, cs: e.cs });
      vEdges.get(v).push({ to: u, len, f: e.f, c: e.c, h: e.h, cs: e.cs });
    };
    const es = E[s.e], et = E[t.e];
    addV(S, es.a, es.len * s.t, es); addV(S, es.b, es.len * (1 - s.t), es);
    addV(T, et.a, et.len * t.t, et); addV(T, et.b, et.len * (1 - t.t), et);
    if (s.e === t.e) addV(S, T, es.len * Math.abs(s.t - t.t), es);

    const kx = KX(t.p[1]);
    const h = (i) => Math.hypot((px(i) - t.p[0]) * kx, (py(i) - t.p[1]) * KY) * TRAIL_FACTOR;
    const gs = new Map([[S, 0]]);
    const prev = new Map();
    const open = new Heap();
    open.push(h(S), S);
    const done = new Set();
    while (open.size) {
      const u = open.pop();
      if (done.has(u)) continue;
      if (u === T) break;
      done.add(u);
      const gu = gs.get(u);
      const relax = (v, len, f, c, hw, ei, cs) => {
        const ng = gu + len * f * (ei != null && avoid?.has(ei) ? 5 : 1);
        if (ng < (gs.get(v) ?? Infinity)) {
          gs.set(v, ng);
          prev.set(v, { u, c, hw, ei, cs });
          open.push(ng + h(v), v);
        }
      };
      if (u < N) for (const ei of adj[u]) { const e = E[ei]; relax(e.a === u ? e.b : e.a, e.len, e.f, e.c, e.h, ei, e.cs); }
      for (const ve of vEdges.get(u) || []) relax(ve.to, ve.len, ve.f, ve.c, ve.hw ?? ve.h, null, ve.cs);
    }
    if (!prev.has(T)) return null;
    // שחזור המסלול
    const nodes = [T], info = [];
    for (let v = T; v !== S;) { const pr = prev.get(v); info.push(pr); v = pr.u; nodes.push(v); }
    nodes.reverse(); info.reverse();
    const coords = nodes.map((i) => [px(i), py(i)]);
    const segs = [];
    let len = 0;
    for (let i = 0; i < info.length; i++) {
      const a = coords[i], b = coords[i + 1];
      len += Math.hypot((b[0] - a[0]) * KX(a[1]), (b[1] - a[1]) * KY);
      const c = info[i].c || null, hw = info[i].hw || null, cs = info[i].cs?.length > 1 ? info[i].cs : null;
      const last = segs[segs.length - 1];
      if (last && last.c === c && (c || last.h === hw) && String(last.cs || '') === String(cs || '')) last.coords.push(b);
      else segs.push(cs ? { coords: [a, b], c, h: hw, cs } : { coords: [a, b], c, h: hw });
    }
    const edges = info.map((x) => x.ei).filter((x) => x != null).concat([s.e, t.e]);
    return { coords, segs, len, edges };
  }

  /**
   * קטע שמסומן בכמה צבעים (cs): מקבל את הצבע של השביל שהולכים בו – כמו הקטע שלפניו,
   * ואם אין – הצבע שממשיך הכי רחוק קדימה, ובתיקו – הצבע שרואים על המפה (השביל שמצויר אחרון, למעלה).
   * משנה את segs במקום ומחזיר אותם.
   */
  function pickColors(segs) {
    const L = (sg) => sg.coords.reduce((a, p, j) => (j ? a + Math.hypot((p[0] - sg.coords[j - 1][0]) * KX(p[1]), (p[1] - sg.coords[j - 1][1]) * KY) : 0), 0);
    const has = (sg, c) => (sg.cs ? sg.cs.includes(c) : sg.c === c);
    let prev = null;
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i];
      if (sg.cs?.length > 1) {
        if (prev && sg.cs.includes(prev)) sg.c = prev;
        else {
          let best = sg.c, run = -1;
          for (const c of sg.cs) {
            let r = 0;
            for (let j = i; j < segs.length && has(segs[j], c); j++) r += L(segs[j]);
            if (r >= run) { run = r; best = c; } // תיקו – האחרון: הוא זה שמצויר למעלה במפה, כלומר מה שרואים
          }
          sg.c = best;
        }
      }
      if (sg.c && sg.h !== 'free') prev = sg.c;
    }
    return segs;
  }

  const Router = { buildGraph, snap, route, pickColors };
  if (typeof module !== 'undefined' && module.exports) module.exports = Router;
  root.Router = Router;
})(typeof self !== 'undefined' ? self : globalThis);
