/* כלי פיתוח – זמני, ונועד להימחק כשהאפליקציה גמורה. מועבר מ-ezpz (src/components/dev).
 *
 * עובדים מהטלפון, ולכן כל כיוונון של מספר עולה סבב שלם: אומרים, כותבים, מעלים, מסתכלים.
 * הכלי הופך את זה למחוון. הערכים נשמרים על המכשיר (localStorage) ונכתבים על המסמך
 * כאותם משתני CSS שמוגדרים ב-style.css, כך שהמסך מגיב מיד והקוד לא משתנה.
 * ערך שרוצים לשמור – מעתיקים ("העתק שינויים") ומכניסים לקוד פעם אחת.
 *
 * שתי נקודות בקצוות סרגל הלשוניות: שמאל – הכלי, ימין – טעינה מחדש "קשה" (מעקפת את המטמון).
 * הנקודה פותחת את החלון במצב כיוון: הנגיעה הבאה במסך בוחרת רכיב, והחלון מציג את המחוונים
 * של המשתנים שמגיעים אליו. ◎ – לכוון שוב; השם בראש החלון – רשימת האזורים וחיפוש.
 */
(function () {
  const KEY = 'shvilim-dev-overrides';
  const AT_KEY = 'shvilim-dev-at';
  const POS_KEY = 'shvilim-dev-pos';
  const root = document.documentElement;

  // ---------- הערכים שעל המכשיר ----------
  const read = () => {
    try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  };
  const write = (o) => {
    try { Object.keys(o).length ? localStorage.setItem(KEY, JSON.stringify(o)) : localStorage.removeItem(KEY); } catch { /* לא נשמר */ }
  };
  const announce = () => window.dispatchEvent(new Event('dev-tokens'));
  function set(name, value) { const o = read(); o[name] = value; write(o); root.style.setProperty(name, value); announce(); }
  function clearProps(names) { const o = read(); for (const n of names) { root.style.removeProperty(n); delete o[n]; } write(o); announce(); }
  function clearAll() { clearProps(Object.keys(read())); }
  // מיד בטעינה, לפני הציור הראשון
  for (const [n, v] of Object.entries(read())) root.style.setProperty(n, v);

  // ---------- מחוונים ----------
  const px = (prop, label, min, max) => ({ prop, label, min, max, step: 1, places: 0, unit: 'px' });
  const frac = (prop, label, min, max, step = 0.05) => ({ prop, label, min, max, step, places: step < 0.1 ? 2 : 1 });
  const weight = (prop, label) => ({ prop, label, min: 100, max: 900, step: 100, places: 0 });

  const AREAS = [
    { id: 'glass', label: 'זכוכית', groups: [
      { title: 'הזכוכית', dials: [
        frac('--glass-a-day', 'אטימות ביום', 0, 1, 0.02), frac('--glass-a-night', 'אטימות בלילה', 0, 1, 0.02),
        px('--glass-blur', 'בלר', 0, 40), frac('--glass-sat', 'רוויה', 0, 3, 0.05),
        frac('--glass-edge-a', 'קו המסגרת', 0, 0.5, 0.01), frac('--dock-shadow-a', 'צל מעל הדוק', 0, 0.6, 0.02)] },
    ] },
    { id: 'card', label: 'כרטיס', groups: [
      { title: 'שם ושורה', dials: [
        px('--card-name-size', 'שם: גודל', 12, 36), weight('--card-name-w', 'שם: עובי'),
        px('--card-line-size', 'שורה: גודל', 10, 24), weight('--card-line-w', 'שורה: עובי'), px('--card-gap', 'רווח בין השורות', 0, 24)] },
      { title: 'רווחים ופינות', dials: [
        px('--card-pad-t', 'רווח מעל', 0, 40), px('--card-pad-x', 'רווח בצדדים', 0, 40), px('--card-pad-b', 'רווח מתחת', 0, 30),
        px('--dock-r', 'פינות הדוק', 0, 40)] },
    ] },
    { id: 'cells', label: 'כפתורים', groups: [
      { title: 'תאים', dials: [
        px('--cell', 'גודל תא', 32, 64), px('--cell-icon', 'אייקון', 14, 36), frac('--cell-stroke', 'עובי קו האייקון', 0.5, 3, 0.1),
        px('--word-size', 'גודל מילה', 11, 22)] },
      { title: 'קבוצות', dials: [
        px('--grp-r', 'פינות קבוצה', 0, 24), px('--grp-gap', 'רווח בין קבוצות', 0, 24), px('--drawer-pad', 'רווח סביב השורה', 0, 24),
        frac('--cell-a-day', 'רקע תא ביום', 0, 0.3, 0.01), frac('--cell-a-night', 'רקע תא בלילה', 0, 0.8, 0.02)] },
    ] },
    { id: 'tabs', label: 'לשוניות', groups: [
      { title: 'לשוניות', dials: [px('--tab-w', 'רוחב', 60, 130), px('--tab-icon', 'אייקון', 14, 32), px('--tab-font', 'גודל כיתוב', 9, 16), px('--tab-pad', 'רווח', 2, 20)] },
    ] },
    { id: 'map', label: 'מפה', groups: [
      { title: 'כפתורי המפה', dials: [px('--fab', 'גודל', 36, 64), px('--fab-icon', 'אייקון', 16, 36), px('--fab-gap', 'רווח', 0, 20)] },
      { title: 'ניווט וגרף', dials: [px('--nav-val', 'מספרי הניווט', 12, 30), px('--profile-h', 'גובה הגרף', 60, 200)] },
    ] },
  ];

  const readProp = (prop) => parseFloat(getComputedStyle(root).getPropertyValue(prop)) || 0;
  const fmt = (d, n) => (d.places === 0 ? String(Math.round(n)) : n.toFixed(d.places));
  const put = (d, n) => set(d.prop, fmt(d, n) + (d.unit || ''));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* לא נשמר */ } };
  const load = (k, dflt) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? dflt; } catch { return dflt; } };

  /* מחוון שרק הידית מזיזה: המסילה לא עונה לנגיעה בכלל (ככה האצבע לא "קופצת" עליה).
     בזמן שהאצבע על הידית, שאר החלון כמעט נעלם – כדי לראות את מה שמכוונים. */
  function dialRow(d, vals, hub) {
    const row = h('label', 'dev-dial');
    const out = h('output');
    const track = h('div', 'dev-track');
    const thumb = h('span', 'dev-thumb');
    track.appendChild(thumb);
    row.append(h('span', 'dev-dial-label', d.label), out, track);
    const THUMB = 12;
    const show = () => {
      const v = vals[d.prop] ?? d.min;
      out.textContent = fmt(d, v) + (d.unit || '');
      thumb.style.setProperty('--at', String((v - d.min) / (d.max - d.min || 1)));
    };
    const from = (x) => {
      const r = track.getBoundingClientRect();
      const f = clamp((x - r.left - THUMB / 2) / Math.max(1, r.width - THUMB), 0, 1);
      const n = clamp(Math.round((d.min + f * (d.max - d.min)) / d.step) * d.step, d.min, d.max);
      vals[d.prop] = n; put(d, n); show();
    };
    let held = false;
    const peek = (on) => { row.classList.toggle('held', on); hub.classList.toggle('peek', on); };
    thumb.addEventListener('pointerdown', (e) => { held = true; thumb.setPointerCapture(e.pointerId); peek(true); });
    thumb.addEventListener('pointermove', (e) => { if (held) from(e.clientX); });
    thumb.addEventListener('pointerup', () => { held = false; peek(false); });
    thumb.addEventListener('pointercancel', () => { held = false; peek(false); });
    show();
    return row;
  }

  // ---------- מה מגיע לרכיב שנגעו בו: הכללים שחלים עליו, על מה שבתוכו ועל שתי הקופסאות שמחזיקות אותו ----------
  const VAR = /var\(\s*(--[\w-]+)/g;
  const INHERITED = /^(font|color$|line-height|letter-spacing|word-spacing|text-|white-space)/;
  function varsReaching(el) {
    const inside = Array.from(el.querySelectorAll('*')).slice(0, 24);
    const near = [], far = [];
    let up = el.parentElement;
    for (let n = 0; up; up = up.parentElement, n++) (n < 2 ? near : far).push(up);
    const tiers = [[el], inside, near, far];
    const used = new Map(), deps = new Map();
    const visit = (rules) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule) {
          const text = r.style.cssText;
          if (text.includes('var(')) {
            let rank = null;
            for (const decl of text.split(';')) {
              const at = decl.indexOf(':');
              if (at < 0) continue;
              const name = decl.slice(0, at).trim();
              const vars = Array.from(decl.slice(at + 1).matchAll(VAR), (m) => m[1]);
              if (!vars.length) continue;
              if (name.startsWith('--')) {
                const s = deps.get(name) || new Set();
                vars.forEach((v) => s.add(v)); deps.set(name, s);
                continue;
              }
              if (rank === null) {
                const sel = r.selectorText.replace(/::?(before|after|placeholder|marker|selection)\b/g, '');
                rank = -1;
                try { rank = tiers.findIndex((ts) => ts.some((t) => t.matches(sel))); } catch { /* סלקטור שהדפדפן לא קורא */ }
              }
              if (rank < 0 || (rank === 3 && !INHERITED.test(name))) continue;
              for (const v of vars) used.set(v, Math.min(rank, used.get(v) ?? rank));
            }
          }
          if (r.cssRules?.length) visit(r.cssRules);
        } else if (r.cssRules) visit(r.cssRules);
      }
    };
    for (const sh of Array.from(document.styleSheets)) { try { visit(sh.cssRules); } catch { /* גיליון ממקור אחר */ } }
    const out = new Map();
    const walk = (v, rank) => {
      if ((out.get(v) ?? 9) <= rank) return;
      out.set(v, rank);
      for (const d of deps.get(v) || []) walk(d, rank);
    };
    for (const [v, rank] of used) walk(v, rank);
    return out;
  }
  function dialsReaching(el) {
    const reach = varsReaching(el);
    const seen = new Set(), all = [];
    for (const a of AREAS) for (const g of a.groups) for (const d of g.dials)
      if (!seen.has(d.prop) && reach.has(d.prop)) { seen.add(d.prop); all.push({ d, where: `${a.label} · ${g.title}` }); }
    all.sort((x, y) => (reach.get(x.d.prop) ?? 9) - (reach.get(y.d.prop) ?? 9));
    const dials = [], parts = [];
    for (const f of all) {
      if (!parts.length || parts[parts.length - 1].title !== f.where) parts.push({ at: dials.length, title: f.where });
      dials.push(f.d);
    }
    return { title: 'נבחר', dials, parts };
  }
  const nameOf = (el) => {
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    return t ? (t.length > 18 ? t.slice(0, 18) + '…' : t) : el.tagName.toLowerCase();
  };

  // ---------- רק מה ששונה מהקוד ----------
  function changedValues() {
    const turned = read();
    const where = new Map();
    for (const a of AREAS) for (const g of a.groups) for (const d of g.dials)
      if (!where.has(d.prop)) where.set(d.prop, `${a.label} · ${g.title} · ${d.label}`);
    const same = (a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      if (Number.isFinite(na) && Number.isFinite(nb))
        return Math.abs(na - nb) < 1e-6 && a.replace(/^[-+.\d\s]+/, '').trim() === b.replace(/^[-+.\d\s]+/, '').trim();
      return a.trim() === b.trim();
    };
    const out = [], settled = [];
    for (const [prop, mine] of Object.entries(turned)) {
      root.style.removeProperty(prop);
      const code = getComputedStyle(root).getPropertyValue(prop).trim();
      root.style.setProperty(prop, mine);
      // ערך שהקוד כבר קיבל, או מחוון שכבר לא קיים – יורד מהמכשיר
      if ((code && same(mine, code)) || (!code && !where.has(prop))) { settled.push(prop); continue; }
      out.push(`  ${prop}: ${mine};  /* ${where.get(prop) || ''} · בקוד: ${code || 'אין'} */`);
    }
    if (settled.length) clearProps(settled);
    return { text: [`/* שינויים מול הקוד: ${out.length} */`, ...out].join('\n'), n: out.length };
  }
  function copyText(text, say) {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => say('הועתק'), () => say('לא הועתק'));
    else say('לא הועתק');
  }

  // ---------- החלון ----------
  let hub = null, ring = null, stopAim = null;
  const st = { at: load(AT_KEY, { area: AREAS[0].id, group: {} }), pos: load(POS_KEY, { x: 16, y: 8 }),
    small: false, picking: false, pickArea: null, query: '', said: '', aiming: true, picked: null, wipe: 0 };

  function close() {
    stopAim?.(); stopAim = null;
    hub?.remove(); hub = null;
    ring?.remove(); ring = null;
    dot.classList.remove('on');
  }
  function open() {
    st.picked = null; st.picking = false; st.small = false; st.said = '';
    aim(true);
    changedValues(); // בפתיחה: משחרר ערכים שהקוד כבר קיבל
    dot.classList.add('on');
    render();
  }

  function aim(on) {
    stopAim?.(); stopAim = null;
    st.aiming = on;
    if (!on) return;
    const inPanel = (t) => t instanceof Element && !!t.closest('.dev-hub, .dev-pill, .dev-dot');
    const stop = (e) => { if (inPanel(e.target)) return; e.preventDefault(); e.stopPropagation(); };
    const take = (e) => {
      if (inPanel(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      const el = e.target instanceof Element ? e.target : null;
      // שאר הנגיעה נבלע, כדי שהלחיצה לא תפעיל את מה שרק נבחר
      const tail = ['pointerup', 'mouseup', 'touchend', 'click'];
      const eat = (ev) => { ev.preventDefault(); ev.stopPropagation(); if (ev.type === 'click') done(); };
      const done = () => tail.forEach((k) => removeEventListener(k, eat, true));
      tail.forEach((k) => addEventListener(k, eat, true));
      setTimeout(done, 700);
      aim(false);
      if (el) {
        if (el.querySelectorAll('*').length > 150) st.said = 'גדול מדי – געו בדבר עצמו';
        else {
          const group = dialsReaching(el);
          st.picked = { group, name: nameOf(el), rect: el.getBoundingClientRect() };
          st.said = group.dials.length ? '' : 'שום מחוון לא מגיע לזה';
        }
      }
      render();
    };
    const rest = ['pointerup', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup'];
    addEventListener('pointerdown', take, true);
    rest.forEach((k) => addEventListener(k, stop, true));
    stopAim = () => { removeEventListener('pointerdown', take, true); rest.forEach((k) => removeEventListener(k, stop, true)); };
  }

  // החלון זז מהראש שלו: תזוזה של 6 פיקסלים היא גרירה, פחות – הקשה
  function draggable(handle, box) {
    let moved = false;
    handle.addEventListener('pointerdown', (e) => {
      const id = e.pointerId, sx = e.clientX, sy = e.clientY, r = box.getBoundingClientRect();
      moved = false;
      const move = (ev) => {
        if (ev.pointerId !== id) return;
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        box.style.left = clamp(r.left + dx, 0, innerWidth - r.width) + 'px';
        box.style.top = clamp(r.top + dy, 0, innerHeight - 60) + 'px';
      };
      const up = (ev) => {
        if (ev.pointerId !== id) return;
        removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
        if (!moved) return;
        const at = box.getBoundingClientRect();
        st.pos = { x: Math.round(at.left), y: Math.round(at.top) }; keep(POS_KEY, st.pos);
      };
      addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    });
    handle.addEventListener('click', (e) => { if (moved) { moved = false; e.preventDefault(); e.stopPropagation(); } }, true);
  }

  function choose(areaId, n) {
    st.at = { area: areaId, group: { ...st.at.group, [areaId]: n } }; keep(AT_KEY, st.at);
    st.picked = null; st.picking = false; st.query = ''; st.said = '';
    render();
  }

  function render() {
    hub?.remove(); ring?.remove(); ring = null;
    const area = AREAS.find((a) => a.id === st.at.area) || AREAS[0];
    const gi = Math.min(st.at.group[area.id] || 0, area.groups.length - 1);
    const title = st.aiming ? 'געו במה לכוונן' : st.picked ? `נבחר · ${st.picked.name}`
      : area.groups.length > 1 ? `${area.label} · ${area.groups[gi].title}` : area.label;
    const wide = st.small ? 160 : Math.min(420, innerWidth - 32);
    const x = clamp(st.pos.x, 0, Math.max(0, innerWidth - wide)), y = clamp(st.pos.y, 0, Math.max(0, innerHeight - 60));

    if (st.small) {
      hub = h('div', 'dev-pill');
      const b = h('button', null, title);
      b.addEventListener('click', () => { st.small = false; render(); });
      hub.appendChild(b);
      hub.style.left = x + 'px'; hub.style.top = y + 'px';
      draggable(hub, hub);
      document.body.appendChild(hub);
      return;
    }

    hub = h('div', 'dev-hub');
    hub.style.left = x + 'px'; hub.style.top = y + 'px';
    const head = h('div', 'dev-hub-head');
    head.appendChild(h('span', 'dev-grip'));
    const tb = h('button', 'dev-hub-title' + (st.picking ? ' on' : ''));
    tb.append(h('span', null, title), h('span', 'dev-hub-caret', '▾'));
    tb.addEventListener('click', () => { st.pickArea = area.id; st.picking = !st.picking; st.query = ''; render(); });
    const icon = (txt, label, fn, on) => { const b = h('button', 'dev-hub-icon' + (on ? ' on' : ''), txt); b.setAttribute('aria-label', label); b.addEventListener('click', fn); return b; };
    head.append(tb,
      icon('◎', 'בחר במסך', () => { st.picking = false; st.said = ''; aim(!st.aiming); render(); }, st.aiming),
      icon('–', 'מזער', () => { aim(false); st.small = true; render(); }),
      icon('✕', 'סגור', close));
    hub.appendChild(head);
    draggable(head, hub);

    const said = h('span', 'dev-said', st.said);
    const acts = h('div', 'dev-acts');
    const act = (txt, fn) => { const b = h('button', null, txt); b.addEventListener('click', fn); acts.appendChild(b); };
    const say = (t) => { st.said = t; said.textContent = t; };

    if (st.picking) {
      const body = h('div', 'dev-body dev-pick');
      const q = h('input', 'dev-search');
      q.placeholder = 'חיפוש מחוון'; q.value = st.query;
      body.appendChild(q);
      const list = h('div');
      body.appendChild(list);
      const fill = () => {
        list.replaceChildren();
        const qq = st.query.trim();
        if (qq) {
          const hits = AREAS.flatMap((a) => a.groups.flatMap((g, i) => g.dials
            .filter((d) => d.label.includes(qq) || g.title.includes(qq) || d.prop.includes(qq)).map((d) => ({ a, g, i, d }))));
          if (!hits.length) { list.appendChild(h('div', 'dev-none', 'אין מחוון כזה')); return; }
          const box = h('div', 'dev-hits');
          for (const it of hits) {
            const b = h('button');
            b.append(h('span', 'dev-hit-where', `${it.a.label} · ${it.g.title}`), h('span', null, it.d.label));
            b.addEventListener('click', () => choose(it.a.id, it.i));
            box.appendChild(b);
          }
          list.appendChild(box);
          return;
        }
        const shown = AREAS.find((a) => a.id === st.pickArea) || area;
        const tabs = h('div', 'dev-tabs');
        for (const a of AREAS) {
          const b = h('button', a.id === shown.id ? 'on' : null, a.label);
          b.addEventListener('click', () => (a.groups.length > 1 ? ((st.pickArea = a.id), fill()) : choose(a.id, 0)));
          tabs.appendChild(b);
        }
        list.appendChild(tabs);
        if (shown.groups.length > 1) {
          const gt = h('div', 'dev-tabs dev-pick-groups');
          shown.groups.forEach((g, i) => {
            const b = h('button', shown.id === area.id && i === gi ? 'on' : null, g.title);
            b.addEventListener('click', () => choose(shown.id, i));
            gt.appendChild(b);
          });
          list.appendChild(gt);
        }
      };
      q.addEventListener('input', () => { st.query = q.value; fill(); });
      fill();
      hub.appendChild(body);
      act('העתק שינויים', () => {
        const { text, n } = changedValues();
        if (!n) return say('אין שינויים מול הקוד');
        copyText(text, (r) => say(r === 'הועתק' ? `הועתקו ${n} שינויים` : r));
      });
      act('אפס הכל', () => {
        if (st.wipe % 2 === 0) { st.wipe++; return say('לחצו שוב כדי לאפס הכל'); }
        clearAll(); st.wipe++; say('הכל חזר לקוד');
      });
    } else {
      const g = st.picked ? st.picked.group : area.groups[gi];
      if (st.picked) {
        const rc = st.picked.rect;
        ring = h('div', 'dev-ring');
        Object.assign(ring.style, { left: rc.left + 'px', top: rc.top + 'px', width: rc.width + 'px', height: rc.height + 'px' });
        document.body.appendChild(ring);
      }
      const vals = {};
      for (const d of g.dials) vals[d.prop] = readProp(d.prop);
      const body = h('div', 'dev-body');
      g.dials.forEach((d, i) => {
        const part = g.parts?.find((p) => p.at === i);
        if (part) body.appendChild(h('div', 'dev-part', part.title));
        body.appendChild(dialRow(d, vals, hub));
      });
      if (!st.aiming && !g.dials.length && !st.said) body.appendChild(h('div', 'dev-none', 'אין כאן מחוונים'));
      hub.appendChild(body);
      act('העתק', () => copyText([`  /* ${st.picked ? 'נבחר' : area.label} · ${g.title} */`,
        ...g.dials.map((d) => `  ${d.prop}: ${fmt(d, vals[d.prop])}${d.unit || ''};`)].join('\n'), say));
      act('אפס', () => { clearProps(g.dials.map((d) => d.prop)); st.said = 'חזרה לקוד'; render(); });
    }
    hub.append(acts, said);
    document.body.appendChild(hub);
  }

  // ---------- הנקודות בסרגל הלשוניות ----------
  const bar = document.getElementById('dock-bar');
  const dot = h('button', 'dev-dot at-left');
  dot.setAttribute('aria-label', 'כלי פיתוח');
  dot.addEventListener('click', () => (hub ? close() : open()));
  const reload = h('button', 'dev-dot at-right');
  reload.setAttribute('aria-label', 'טעינה מחדש בלי מטמון');
  // טעינה "קשה": מוחקים מהמטמון את קבצי האפליקציה (לא את הספריות), וטוענים מהרשת
  reload.addEventListener('click', async () => {
    reload.classList.add('on');
    try {
      for (const k of await caches.keys()) {
        const c = await caches.open(k);
        for (const req of await c.keys()) if (new URL(req.url).origin === location.origin) await c.delete(req);
      }
      await (await navigator.serviceWorker?.getRegistration())?.update();
    } catch { /* בכל מקרה טוענים מחדש */ }
    location.reload();
  });
  bar?.append(dot, reload);
})();
