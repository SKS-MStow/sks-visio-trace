/* SKS Visio Trace — shared engine.
 *
 * The drawing is the real Visio PDF export (vector SVG, sheets/<id>.svg), so it looks exactly
 * like the issued set. data/drawing.json is extracted from the matching .vsdx and holds every
 * device, port cell, cable path, number chip and service feed in the same PDF-point space.
 * The engine lays an interaction layer over the drawing:
 *
 *   tap a wire / chip / badge   -> that cable only (its two ports and end devices stay lit)
 *   tap a port cell             -> the cable on that port
 *   tap a unit                  -> the unit and every connection on it
 *
 * Everything else fades behind a veil. Hidden signal classes are knocked out of the drawing.
 *
 * API
 *   const T = await VT.load('data/drawing.json')
 *   const v = VT.create(el, { sheet: 'AVS01', insets: () => ({top,right,bottom,left}) })
 *   v.setSheet(id)                         v.sheet
 *   v.on('select', ref => …)               ref: {kind:'cable',id} | {kind:'device',tag} | {kind:'port',tag,port,cable} | null
 *   v.on('view' | 'sheet' | 'gesture')     gesture fires 'start' / 'end' around pans and pinches
 *   v.select(ref, {zoom, focus})           selects + applies the default focus for that ref
 *   v.focus({cables, devices, ports, services}, {zoom, dim})   custom focus (ports: ['TAG|PORT'])
 *   v.clear()
 *   v.setHidden(classes[])                 knock out signal classes: video audio control network usb spk power
 *   v.setOverlay({zones, clouds})          knock out location boxes / revision clouds
 *   v.zoomToFit(ms) v.zoomBy(f) v.zoomToBox(box, opts) v.zoomToRef(ref) v.fitFocus()
 *   v.peek(ref) / v.unpeek()               soft highlight without selecting (hover, scrubbing)
 *   v.pointOn(cableId)                     screen point mid-way along a cable's longest run (tests, coach marks)
 *
 *   T.sheets, T.devices[tag], T.cables[id], T.cablesOf(tag), T.focusFor(ref), T.trace(start, opts)
 *   T.classes, T.label(cable), T.where(tag), T.services(tag), T.search(q)
 */
(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };

  const CLASSES = {
    video:   { label: 'Video',   prefix: 'V',  name: 'VIDEO' },
    audio:   { label: 'Audio',   prefix: 'A',  name: 'AUDIO' },
    control: { label: 'Control', prefix: 'C',  name: 'CONTROL' },
    network: { label: 'Network', prefix: 'N',  name: 'NETWORK' },
    usb:     { label: 'USB',     prefix: 'U',  name: 'USB' },
    spk:     { label: 'Speaker', prefix: 'SK', name: 'SPEAKER' },
    power:   { label: 'Power & services', prefix: 'P', name: 'POWER' },
  };

  // ---------------------------------------------------------------- data
  async function load(url) {
    const data = await (await fetch(url)).json();
    const devices = {}, cables = {}, sheets = {};
    data.sheets.forEach((s) => {
      sheets[s.id] = s;
      (s.devices || []).forEach((d) => {
        d.sheet = s.id;
        d.portMap = {};
        d.ports.forEach((p) => (d.portMap[p.name] = p));
        // a tag can appear on several sheets (AVS02 re-shows existing kit); the first, wired sheet is canonical
        if (!devices[d.tag]) devices[d.tag] = d;
      });
      (s.cables || []).forEach((c) => {
        c.sheet = s.id;
        c.pts = [...c.path.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map((m) => [+m[1], +m[2]]);
        cables[c.id] = c;
      });
      (s.services || []).forEach((sv, i) => {
        sv.id = s.id + ':S' + i;
        sv.sheet = s.id;
        sv.pts = [...sv.path.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map((m) => [+m[1], +m[2]]);
      });
    });
    const allServices = data.sheets.flatMap((s) => s.services || []);
    const cables_ = cables;
    const cablesOf = (tag) => Object.values(cables).filter((c) => c.ends.some((e) => e.dev === tag));
    const servicesOf = (tag) => allServices.filter((s) => s.dev === tag);
    const peer = (c, tag) => c.ends.find((e) => e.dev !== tag) || c.ends[1];
    const mine = (c, tag) => c.ends.find((e) => e.dev === tag) || c.ends[0];

    function focusFor(ref) {
      if (!ref) return null;
      if (ref.kind === 'symbol') {
        const s = sheets[ref.sheet];
        const sym = (s.symbols || []).filter((x) => x.tag === ref.tag && x.room === ref.room);
        return { cables: [], devices: [], ports: [], services: [], boxes: sym.map((x) => x.box), primaryBox: sym[0] && sym[0].box };
      }
      if (ref.kind === 'room') {
        const s = sheets[ref.sheet];
        const r = (s.rooms || []).find((x) => x.id === ref.id);
        const sym = (s.symbols || []).filter((x) => x.room === ref.id);
        return { cables: [], devices: [], ports: [], services: [], boxes: [r.box], outline: r.box, softBoxes: sym.map((x) => x.box) };
      }
      if (ref.kind === 'cable' || (ref.kind === 'port' && ref.cable)) {
        const c = cables[ref.kind === 'cable' ? ref.id : ref.cable];
        return {
          cables: [c.id],
          devices: c.ends.filter((e) => devices[e.dev]).map((e) => e.dev),
          ports: c.ends.filter((e) => e.port).map((e) => e.dev + '|' + e.port),
          services: [],
        };
      }
      const tag = ref.tag;
      const cs = cablesOf(tag);
      return {
        cables: cs.map((c) => c.id),
        devices: [tag, ...cs.map((c) => peer(c, tag).dev).filter((t) => devices[t])],
        ports: cs.flatMap((c) => c.ends.filter((e) => e.port).map((e) => e.dev + '|' + e.port)),
        services: servicesOf(tag).map((s) => s.id),
        primary: tag,
      };
    }

    /* Multi-hop trace. dir: 'down' follows schedule direction (From -> To), 'up' the reverse,
       'both' either. depth: hops (Infinity = whole chain). classes: allowed signal classes.
       The isolated AV switch is a hub: by default a trace stops there instead of lighting the
       whole network. */
    function trace(start, opts) {
      opts = Object.assign({ dir: 'both', depth: Infinity, classes: null, throughSwitch: false }, opts || {});
      const seenD = new Set(), seenC = new Set(), hops = [];
      let frontier = [];
      if (cables[start]) {
        const c = cables[start];
        seenC.add(c.id);
        c.ends.forEach((e) => { if (devices[e.dev]) { seenD.add(e.dev); frontier.push([e.dev, 1]); } });
        hops.push({ depth: 0, cable: c.id, from: c.ends[0].dev, to: c.ends[1].dev });
      } else {
        seenD.add(start);
        frontier.push([start, 0]);
      }
      while (frontier.length) {
        const [tag, depth] = frontier.shift();
        if (depth >= opts.depth) continue;
        if (depth > 0 && /^SW-/.test(tag) && !opts.throughSwitch) continue;
        cablesOf(tag).forEach((c) => {
          if (seenC.has(c.id)) return;
          if (opts.classes && !opts.classes.includes(c.cls)) return;
          const isFrom = c.ends[0].dev === tag;
          if (opts.dir === 'down' && !isFrom) return;
          if (opts.dir === 'up' && isFrom) return;
          const other = isFrom ? c.ends[1].dev : c.ends[0].dev;
          seenC.add(c.id);
          hops.push({ depth: depth + 1, cable: c.id, from: tag, to: other, dir: isFrom ? 'down' : 'up' });
          if (devices[other] && !seenD.has(other)) { seenD.add(other); frontier.push([other, depth + 1]); }
        });
      }
      const cs = [...seenC].map((id) => cables[id]);
      return {
        cables: [...seenC], devices: [...seenD], hops,
        ports: cs.flatMap((c) => c.ends.filter((e) => e.port).map((e) => e.dev + '|' + e.port)),
        services: [],
        primary: cables[start] ? null : start,
      };
    }

    const LAYERS = {
      elevation: [['display', 'Display & bracket'], ['concealed', 'Concealed equipment'], ['devices', 'Visible devices'],
                  ['services', 'Services & outlets'], ['dims', 'Dimensions & set-out'], ['annot', 'Callouts & notes'], ['clouds', 'Revision clouds']],
    };
    function layersFor(id) {
      const s = sheets[id];
      if (!s) return [];
      if (s.kind === 'plan') return s.layers.map(([lid, label]) => ({ id: lid, label, count: (s.symbols || []).filter((x) => x.layer === lid).length }));
      if (s.kind === 'elevation') return LAYERS.elevation.map(([lid, label]) => ({ id: lid, label, count: (s.items || []).filter((x) => x.layer === lid).length })).filter((l) => l.count);
      return [];
    }
    // the same tag can live on several sheets (AVS02 re-shows existing kit); resolve per sheet
    const deviceOn = (sheetId, tag) => ((sheets[sheetId] || {}).devices || []).find((d) => d.tag === tag) || null;

    // ---- job structure: drawing types, pages, and the room each page belongs to (room tag = join key)
    const job = {
      types: [
        { id: 'schematic', label: 'Schematics', short: 'Schem', icon: 'account_tree', pages: ['AVS01', 'AVS02'] },
        { id: 'elevation', label: 'Elevations', short: 'Elev', icon: 'view_quilt', pages: ['AVE01', 'AVE02'] },
        { id: 'plan', label: 'Floor plans', short: 'Plans', icon: 'floor', pages: ['AVF01'] },
      ],
      pages: {
        AVS01: { name: '2B · 20P Boardroom', room: '2B' }, AVS02: { name: '6M · 6P Meeting room', room: '6M', hold: true },
        AVE01: { name: '2B · Display wall & table', room: '2B' }, AVE02: { name: '6M · Display wall', room: '6M', hold: true },
        AVF01: { name: 'Level 9 equipment plan', room: null },
      },
      rooms: { '2B': { schematic: 'AVS01', elevation: 'AVE01' }, '6M': { schematic: 'AVS02', elevation: 'AVE02' } },
    };
    const kindOf = (id) => sheets[id] && sheets[id].kind;
    // the matching page of another type for a page (AVS01 -> AVE01 / AVF01)
    function counterpart(fromId, toKind, room) {
      room = room || (job.pages[fromId] || {}).room;
      if (toKind === 'plan') return 'AVF01';
      return room && job.rooms[room] ? job.rooms[room][toKind] : null;
    }
    /* What a selection on one drawing corresponds to on another.
       Returns { focus, tags, missing, room } where focus feeds viewer.focus() on the other drawing.
       Concealed kit maps to the plan's "equipment behind display" note; cables map to both end units. */
    function relate(ref, fromId, toId) {
      if (!ref) return null;
      const from = sheets[fromId], to = sheets[toId];
      if (!from || !to) return null;
      let room = (job.pages[fromId] || {}).room;
      let tags = [], cables = [];
      if (ref.kind === 'cable' || ref.kind === 'port') {
        const c = cables_[ref.cable || ref.id];
        if (c) { tags = c.ends.map((e) => e.dev).filter((t) => from.devices && from.devices.some((d) => d.tag === t)); cables = [c.id]; }
      } else if (ref.kind === 'device') tags = [ref.tag];
      else if (ref.kind === 'symbol') {
        room = ref.room;
        const sym = (from.symbols || []).find((x) => x.tag === ref.tag && x.room === ref.room);
        tags = sym && sym.tags ? sym.tags.slice() : [ref.tag];
      } else if (ref.kind === 'room') {
        room = ref.id;
        tags = [...new Set((from.symbols || []).filter((x) => x.room === ref.id).flatMap((x) => x.tags || [x.tag]))];
      }
      const focus = { cables: [], devices: [], ports: [], services: [], boxes: [] };
      const found = new Set();
      if (to.kind === 'schematic') {
        tags.forEach((t) => { if ((to.devices || []).some((d) => d.tag === t)) { focus.devices.push(t); found.add(t); } });
        cables.forEach((id) => { if ((to.cables || []).some((c) => c.id === id)) focus.cables.push(id); });
        if (ref.kind === 'device' && to.kind === 'schematic' && focus.devices.length) {
          // a unit on the schematic is shown with its connections, like a tap there
          const f = focusFor({ kind: 'device', tag: ref.tag });
          if (f) { focus.cables = f.cables.filter((id) => (to.cables || []).some((c) => c.id === id)); focus.ports = f.ports; focus.devices = f.devices; }
        }
        focus.primary = tags.length === 1 ? tags[0] : null;
      } else if (to.kind === 'elevation') {
        tags.forEach((t) => { if ((to.marks || []).some((m) => m.tag === t)) { focus.devices.push(t); found.add(t); } });
        focus.primary = tags.length === 1 ? tags[0] : null;
      } else if (to.kind === 'plan') {
        (to.symbols || []).forEach((sym) => {
          if (room && sym.room !== room) return;
          const hit = tags.filter((t) => sym.tag === t || (sym.tags || []).includes(t));
          if (hit.length) { focus.boxes.push(sym.box); hit.forEach((t) => found.add(t)); }
        });
        if (ref.kind === 'room') { const r = (to.rooms || []).find((x) => x.id === room); if (r) { focus.outline = r.box; focus.boxes = []; focus.softBoxes = (to.symbols || []).filter((x) => x.room === room).map((x) => x.box); } }
      }
      return { focus, tags, room, missing: tags.filter((t) => !found.has(t)) };
    }

    // physical cable label, in the SKS legend format: V101 VIDEO ORIG: VC-01 DEST: LCD 01
    const label = (c) => `${c.id} ${CLASSES[c.cls] ? CLASSES[c.cls].name : ''} ORIG: ${c.ends[0].dev} DEST: ${c.ends[1].dev}`;

    function where(tag) {
      const out = [];
      data.sheets.forEach((s) => {
        if ((s.devices || []).some((d) => d.tag === tag)) out.push({ sheet: s.id, kind: s.kind });
        else if ((s.marks || []).some((m) => m.tag === tag)) out.push({ sheet: s.id, kind: s.kind });
        else if ((s.symbols || []).some((m) => m.tag === tag || (m.tags || []).includes(tag))) out.push({ sheet: s.id, kind: s.kind });
      });
      return out;
    }

    function search(q) {
      q = (q || '').trim().toUpperCase();
      if (!q) return [];
      const res = [];
      Object.values(devices).forEach((d) => {
        const hay = [d.tag, d.make, d.model, d.desc, ...d.ports.map((p) => p.name)].join(' ').toUpperCase();
        if (d.tag.startsWith(q)) res.push({ kind: 'device', tag: d.tag, score: 3 });
        else if (hay.includes(q)) res.push({ kind: 'device', tag: d.tag, score: 1 });
      });
      Object.values(cables).forEach((c) => {
        const hay = [c.id, c.badge, c.cable, ...c.ends.map((e) => e.dev + ' ' + e.port), CLASSES[c.cls] && CLASSES[c.cls].label].join(' ').toUpperCase();
        if (c.id.startsWith(q)) res.push({ kind: 'cable', id: c.id, score: 3.5 });
        else if (hay.includes(q)) res.push({ kind: 'cable', id: c.id, score: 1 });
      });
      return res.sort((a, b) => b.score - a.score);
    }

    return {
      raw: data, project: data.project, sheets, sheetList: data.sheets, devices, cables, classes: CLASSES,
      serviceSchedule: data.serviceSchedule, cablesOf, servicesOf, peer, mine, focusFor, trace, label, where, search, layersFor, deviceOn,
      services: servicesOf, job, relate, counterpart, kindOf,
    };
  }

  // ---------------------------------------------------------------- viewer
  let viewerCount = 0;
  function create(T, container, opts) {
    const uid = ++viewerCount;
    opts = Object.assign({ sheet: 'AVS01', insets: null, maxZoom: 8 }, opts || {});
    const listeners = {};
    const emit = (ev, d) => (listeners[ev] || []).forEach((fn) => fn(d));

    container.classList.add('vt-root');
    /* Rendering model (speed): the drawing is painted into an oversized "stage" layer that the GPU
       moves during a drag or pinch, so a gesture never repaints the vector drawing. When the camera
       settles the stage is re-painted once, crisp, cropped to the visible area plus a margin via the
       SVG viewBox, so paint cost tracks the screen size, not the zoom level. A transparent full-size
       svg on top receives input (and keeps v.svg's old meaning for callers). */
    const stage = document.createElement('div');
    stage.className = 'vt-stage';
    container.appendChild(stage);
    const draw = el('svg', { class: 'vt-draw', width: '100%', height: '100%', preserveAspectRatio: 'none' });
    stage.appendChild(draw);
    const defs = el('defs', null, draw);
    const vp = el('g', { class: 'vt-vp' }, draw);
    const svg = el('svg', { class: 'vt-svg', width: '100%', height: '100%' });
    container.appendChild(svg);
    const sheetG = {}, state = { sheet: null, hidden: new Set(), layersOff: {}, zones: true, clouds: true, focus: null, peek: null, selected: null };
    const cams = {};
    let cam = { k: 0.3, x: 0, y: 0 };

    // ---------- sheet loading
    async function ensureSheet(id) {
      if (sheetG[id]) return sheetG[id];
      const s = T.sheets[id];
      const g = el('g', { class: 'vt-sheet', 'data-sheet': id, style: 'display:none' }, vp);
      el('rect', { x: 0, y: 0, width: s.w, height: s.h, class: 'vt-paper' }, g);
      if (s.native) {
        // drawn sheets with live layer groups (the plan) are inlined so layers can be toggled
        const txt = await (await fetch('sheets/' + id + '.svg')).text();
        const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
        const base = document.importNode(doc.documentElement, true);
        base.setAttribute('width', s.w); base.setAttribute('height', s.h);
        base.setAttribute('class', 'vt-base');
        g.appendChild(base);
      } else {
        // the PDF export is never edited in place (highlights and knock-outs sit on top), so it goes in
        // as one image: a single display item instead of ~6k glyph nodes, decoded off the main thread
        const base = el('image', { href: 'sheets/' + id + '.svg', x: 0, y: 0, width: s.w, height: s.h, preserveAspectRatio: 'none', class: 'vt-base' }, g);
        await new Promise((res) => { base.addEventListener('load', res, { once: true }); base.addEventListener('error', res, { once: true }); setTimeout(res, 4000); });
      }
      const ko = el('g', { class: 'vt-knockout' }, g);
      const maskId = 'vt-mask-' + uid + '-' + id;
      const mask = el('mask', { id: maskId, maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse', x: 0, y: 0, width: s.w, height: s.h }, defs);
      el('rect', { x: 0, y: 0, width: s.w, height: s.h, fill: '#fff' }, mask);
      const holes = el('g', { fill: '#000', stroke: '#000' }, mask);
      const veil = el('rect', { x: 0, y: 0, width: s.w, height: s.h, class: 'vt-veil', mask: `url(#${maskId})` }, g);
      const glow = el('g', { class: 'vt-glow' }, g);
      const peekG = el('g', { class: 'vt-peek' }, g);
      sheetG[id] = { g, ko, holes, veil, glow, peekG, s };
      buildKnockout(id);
      return sheetG[id];
    }

    // knock hidden classes out of the drawing: white over the wire, its chips and its badge
    function buildKnockout(id) {
      const G = sheetG[id];
      if (!G) return;
      G.ko.innerHTML = '';
      const s = G.s;
      (s.cables || []).forEach((c) => {
        if (!state.hidden.has(c.cls)) return;
        el('path', { d: c.path, class: 'ko-line' }, G.ko);
        c.chips.forEach((b) => el('rect', { x: b[0] - 1.5, y: b[1] - 1.5, width: b[2] + 3, height: b[3] + 3, class: 'ko-box' }, G.ko));
        const b = c.badgeBox;
        // the badge text box is generous; shrink to the text itself
        const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2, w = Math.min(b[2], b[3] > b[2] ? 18 : c.badge.length * 7.5 + 6), h = Math.min(b[3], b[3] > b[2] ? c.badge.length * 7.5 + 6 : 16);
        el('rect', { x: cx - w / 2, y: cy - h / 2, width: w, height: h, class: 'ko-box' }, G.ko);
      });
      if (state.hidden.has('power')) {
        (s.services || []).forEach((sv) => {
          el('path', { d: sv.path, class: 'ko-line ko-thick' }, G.ko);
          const b = sv.box;
          // label box comes from the PDF text layer; also cover the arrowhead
          el('rect', { x: b[0] - 3, y: b[1] - 2, width: b[2] + 6, height: b[3] + 4, class: 'ko-box' }, G.ko);
          [sv.a, sv.b].forEach((q) => el('rect', { x: q[0] - 7, y: q[1] - 6, width: 14, height: 12, class: 'ko-box' }, G.ko));
        });
      }
      const off = state.layersOff[id] || new Set();
      if (s.kind === 'elevation') {
        (s.items || []).forEach((it) => {
          if (!off.has(it.layer)) return;
          const b = it.box;
          // master-inherited geometry (e.g. Visio dimension masters) has no local paths: knock out its own box
          const small = (!it.oned && b[2] * b[3] < 60000 && it.layer !== 'annot' && it.layer !== 'clouds') || (!it.paths.length && it.layer === 'dims' && !it.dim);
          if (small) el('rect', { x: b[0] - 2, y: b[1] - 2, width: b[2] + 4, height: b[3] + 4, class: 'ko-box' }, G.ko);
          else it.paths.forEach((d) => el('path', { d, class: 'ko-line' + (it.layer === 'clouds' ? ' ko-cloudline' : it.layer === 'dims' ? ' ko-thin' : '') }, G.ko));
          (it.kboxes || []).forEach((k) => el('rect', { x: k[0], y: k[1], width: k[2], height: k[3], class: 'ko-box' }, G.ko));
          if (it.dim && it.textBox) { const k = it.textBox; el('rect', { x: k[0], y: k[1], width: k[2], height: k[3], class: 'ko-box' }, G.ko); }
        });
      }
      if (s.native) {
        G.g.querySelectorAll('[data-layer]').forEach((n) => { n.style.display = off.has(n.dataset.layer) ? 'none' : ''; });
      }
      if (!state.zones) {
        (s.zones || []).forEach((z) => {
          const b = z.box;
          el('rect', { x: b[0], y: b[1], width: b[2], height: b[3], class: 'ko-zone' }, G.ko);
          el('rect', { x: b[0] + 2, y: b[1] + 3, width: Math.min(150, b[2] - 4), height: 16, class: 'ko-box' }, G.ko);
        });
      }
      if (!state.clouds) {
        (s.clouds || []).forEach((z) => {
          const b = z.box;
          el('rect', { x: b[0], y: b[1], width: b[2], height: b[3], rx: 14, class: 'ko-cloud' }, G.ko);
          el('rect', { x: b[0] + b[2] - 6, y: b[1] - 22, width: 26, height: 24, class: 'ko-box' }, G.ko);
        });
      }
    }

    // ---------- focus rendering
    function devBoxes(tag, s) {
      const out = [];
      (s.devices || []).forEach((d) => {
        if (d.tag !== tag) return;
        out.push(d.box);
        if (d.tagBox) out.push(d.tagBox);
      });
      (s.marks || []).forEach((m) => { if (m.tag === tag) out.push(m.box); });
      (s.symbols || []).forEach((m) => { if (m.tag === tag && (!state.roomScope || m.room === state.roomScope)) out.push(m.box); });
      return out;
    }
    function portBox(key, s) {
      const [tag, port] = key.split('|');
      const d = (s.devices || []).find((x) => x.tag === tag);
      if (!d) return null;
      const p = d.portMap ? d.portMap[port] : d.ports.find((q) => q.name === port);
      return p ? p.box : null;
    }
    function badgeRect(c) {
      const b = c.badgeBox, vertical = b[3] > b[2];
      const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
      const w = vertical ? 16 : c.badge.length * 7.5 + 8, h = vertical ? c.badge.length * 7.5 + 8 : 16;
      return [cx - w / 2, cy - h / 2, w, h];
    }

    function render() {
      const G = sheetG[state.sheet];
      if (!G) return;
      const s = G.s, f = state.focus;
      G.holes.innerHTML = ''; G.glow.innerHTML = '';
      container.classList.toggle('vt-focusing', !!f);
      if (!f) return;
      const cset = new Set(f.cables || []), dset = new Set(f.devices || []), pset = new Set(f.ports || []), sset = new Set(f.services || []);
      const sel = state.selected;
      (s.cables || []).forEach((c) => {
        if (!cset.has(c.id) || state.hidden.has(c.cls)) return;
        el('path', { d: c.path, fill: 'none', 'stroke-width': 9, 'stroke-linejoin': 'round' }, G.holes);
        c.chips.forEach((b) => el('rect', { x: b[0] - 3, y: b[1] - 3, width: b[2] + 6, height: b[3] + 6, stroke: 'none' }, G.holes));
        const br = badgeRect(c);
        el('rect', { x: br[0], y: br[1], width: br[2], height: br[3], stroke: 'none' }, G.holes);
        const isSel = sel && ((sel.kind === 'cable' && sel.id === c.id) || (sel.kind === 'port' && sel.cable === c.id));
        el('path', { d: c.path, class: 'glow-line' + (isSel ? ' is-sel' : '') }, G.glow);
        c.chips.forEach((b) => el('rect', { x: b[0] - 2, y: b[1] - 2, width: b[2] + 4, height: b[3] + 4, rx: 3, class: 'glow-chip' }, G.glow));
      });
      (s.services || []).forEach((sv) => {
        if (!sset.has(sv.id) || state.hidden.has('power')) return;
        el('path', { d: sv.path, fill: 'none', 'stroke-width': 9 }, G.holes);
        const b = sv.box;
        el('rect', { x: b[0] - 3, y: b[1] - 2, width: b[2] + 6, height: b[3] + 4, stroke: 'none' }, G.holes);
        el('path', { d: sv.path, class: 'glow-line glow-service' }, G.glow);
      });
      (f.boxes || []).forEach((b) => {
        el('rect', { x: b[0] - 6, y: b[1] - 6, width: b[2] + 12, height: b[3] + 12, rx: 6, stroke: 'none' }, G.holes);
        if (!f.outline) el('rect', { x: b[0] - 7, y: b[1] - 7, width: b[2] + 14, height: b[3] + 14, rx: 6, class: 'glow-dev is-primary' }, G.glow);
      });
      if (f.outline) { const b = f.outline; el('rect', { x: b[0], y: b[1], width: b[2], height: b[3], class: 'glow-room' }, G.glow); }
      (f.softBoxes || []).forEach((b) => el('rect', { x: b[0] - 5, y: b[1] - 5, width: b[2] + 10, height: b[3] + 10, rx: 5, class: 'glow-dev' }, G.glow));
      dset.forEach((tag) => {
        devBoxes(tag, s).forEach((b, i) => {
          el('rect', { x: b[0] - 4, y: b[1] - 4, width: b[2] + 8, height: b[3] + 8, stroke: 'none' }, G.holes);
        });
        const d = (s.devices || []).find((x) => x.tag === tag);
        const main = d ? d.box : ((s.marks || []).find((m) => m.tag === tag) || {}).box;
        if (main) el('rect', { x: main[0] - 5, y: main[1] - 5, width: main[2] + 10, height: main[3] + 10, rx: 4,
          class: 'glow-dev' + (f.primary === tag || (sel && sel.tag === tag && sel.kind === 'device') ? ' is-primary' : '') }, G.glow);
      });
      pset.forEach((key) => {
        const b = portBox(key, s);
        if (!b) return;
        el('rect', { x: b[0] - 0.5, y: b[1] - 0.5, width: b[2] + 1, height: b[3] + 1, class: 'glow-port' }, G.glow);
      });
    }

    function renderPeek() {
      const G = sheetG[state.sheet];
      if (!G) return;
      G.peekG.innerHTML = '';
      const p = state.peek;
      if (!p) return;
      const s = G.s;
      const f = T.focusFor(p);
      if (!f) return;
      (s.cables || []).forEach((c) => { if (f.cables.includes(c.id) && !state.hidden.has(c.cls)) el('path', { d: c.path, class: 'peek-line' }, G.peekG); });
      f.devices.forEach((tag) => devBoxes(tag, s).slice(0, 1).forEach((b) => el('rect', { x: b[0] - 5, y: b[1] - 5, width: b[2] + 10, height: b[3] + 10, rx: 4, class: 'peek-dev' }, G.peekG)));
    }

    // ---------- camera
    const MARGIN = 0.5;                 // painted margin around the viewport, as a fraction of its size
    let committed = null, vw = 0, vh = 0, settleT = 0, lastCommit = 0, raf = 0;
    function commit() {
      clearTimeout(settleT);
      const r = container.getBoundingClientRect();
      vw = r.width; vh = r.height;
      if (!vw || !vh) return;
      const mw = vw * MARGIN, mh = vh * MARGIN;
      stage.style.left = -mw + 'px'; stage.style.top = -mh + 'px';
      stage.style.width = vw + 2 * mw + 'px'; stage.style.height = vh + 2 * mh + 'px';
      stage.style.transformOrigin = `${mw}px ${mh}px`;
      stage.style.transform = '';
      draw.setAttribute('viewBox', `${((-mw - cam.x) / cam.k).toFixed(3)} ${((-mh - cam.y) / cam.k).toFixed(3)} ${((vw + 2 * mw) / cam.k).toFixed(3)} ${((vh + 2 * mh) / cam.k).toFixed(3)}`);
      committed = Object.assign({}, cam);
      lastCommit = performance.now();
    }
    function applyCam() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!committed) { commit(); emit('view', { k: cam.k }); return; }
        // move the already-painted stage on the compositor: no repaint during gestures
        const sc = cam.k / committed.k, tx = cam.x - committed.x * sc, ty = cam.y - committed.y * sc;
        stage.style.transform = `translate3d(${tx.toFixed(2)}px,${ty.toFixed(2)}px,0) scale(${sc.toFixed(5)})`;
        const mw = vw * MARGIN, mh = vh * MARGIN;
        const exposed = (-mw) * sc + tx > 0 || (vw + mw) * sc + tx < vw || (-mh) * sc + ty > 0 || (vh + mh) * sc + ty < vh;
        const blurry = sc > 1.8 || sc < 0.55;
        // repaint mid-gesture only when blank edges show or the scale has drifted too far (throttled)
        if ((exposed || blurry) && performance.now() - lastCommit > 450) commit();
        clearTimeout(settleT);
        settleT = setTimeout(commit, 140);
        emit('view', { k: cam.k });
      });
    }
    const rect = () => svg.getBoundingClientRect();
    const insets = () => Object.assign({ top: 0, right: 0, bottom: 0, left: 0 }, (opts.insets && opts.insets()) || {});
    const fitK = () => {
      const s = T.sheets[state.sheet], r = rect(), ins = insets();
      return Math.min((r.width - ins.left - ins.right) / s.w, (r.height - ins.top - ins.bottom) / s.h);
    };
    const clampK = (k) => Math.max(fitK() * 0.6, Math.min(opts.maxZoom, k));
    let anim = 0;
    function animateTo(t, ms) {
      cancelAnimationFrame(anim);
      if (!ms) { cam = t; applyCam(); return; }
      const from = Object.assign({}, cam), t0 = performance.now(), r = rect();
      const cx = r.width / 2, cy = r.height / 2;
      const wf = [(cx - from.x) / from.k, (cy - from.y) / from.k], wt = [(cx - t.x) / t.k, (cy - t.y) / t.k];
      const step = (now) => {
        const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3);
        const k = Math.exp(Math.log(from.k) + (Math.log(t.k) - Math.log(from.k)) * e);
        const wx = wf[0] + (wt[0] - wf[0]) * e, wy = wf[1] + (wt[1] - wf[1]) * e;
        cam = { k, x: cx - wx * k, y: cy - wy * k };
        applyCam();
        if (p < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    }
    function zoomToBox(b, o) {
      o = o || {};
      const r = rect(), ins = insets(), pad = o.pad == null ? 24 : o.pad;
      const W = r.width - ins.left - ins.right - pad * 2, H = r.height - ins.top - ins.bottom - pad * 2;
      if (W <= 10 || H <= 10) return;
      const k = Math.max(fitK() * 0.6, Math.min(o.maxK || 2.5, opts.maxZoom, W / b[2], H / b[3]));
      animateTo({ k, x: ins.left + pad + (W - b[2] * k) / 2 - b[0] * k, y: ins.top + pad + (H - b[3] * k) / 2 - b[1] * k }, o.ms == null ? 340 : o.ms);
    }
    function zoomToFit(ms) {
      const s = T.sheets[state.sheet];
      zoomToBox([0, 0, s.w, s.h], { ms: ms == null ? 300 : ms, pad: 8, maxK: 10 });
    }
    function union(boxes) {
      boxes = boxes.filter(Boolean);
      if (!boxes.length) return null;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      boxes.forEach((b) => { x1 = Math.min(x1, b[0]); y1 = Math.min(y1, b[1]); x2 = Math.max(x2, b[0] + b[2]); y2 = Math.max(y2, b[1] + b[3]); });
      return [x1, y1, x2 - x1, y2 - y1];
    }
    function focusBox(f, sheetId) {
      const s = T.sheets[sheetId || state.sheet];
      const boxes = [];
      (s.cables || []).forEach((c) => { if (f.cables && f.cables.includes(c.id)) { boxes.push(union(c.pts.map((p) => [p[0], p[1], 0, 0]))); c.chips.forEach((b) => boxes.push(b)); } });
      (f.devices || []).forEach((t) => devBoxes(t, s).forEach((b) => boxes.push(b)));
      (f.boxes || []).forEach((b) => boxes.push(b));
      return union(boxes);
    }
    function fitFocus(o) {
      if (!state.focus) return;
      const b = focusBox(state.focus);
      if (b) zoomToBox([b[0] - 20, b[1] - 20, b[2] + 40, b[3] + 40], Object.assign({ maxK: 1.6 }, o || {}));
    }

    // ---------- hit testing (manual: exact, and cheap for a sheet's worth of geometry)
    function segDist(p, a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    }
    const inBox = (p, b, m) => p[0] >= b[0] - m && p[0] <= b[0] + b[2] + m && p[1] >= b[1] - m && p[1] <= b[1] + b[3] + m;
    function hitTest(sx, sy) {
      const s = T.sheets[state.sheet];
      const p = [(sx - cam.x) / cam.k, (sy - cam.y) / cam.k];
      const tol = 14 / cam.k; // ~14 screen px either side: thumb-friendly
      const off = state.layersOff[state.sheet] || new Set();
      if (s.kind === 'plan') {
        let best = null;
        (s.symbols || []).forEach((m) => {
          if (off.has(m.layer)) return;
          const b = m.box, mg = 8 / cam.k;
          if (inBox(p, b, mg)) { const a = b[2] * b[3]; if (!best || a < best[0]) best = [a, m]; }
        });
        if (best) return { kind: 'symbol', sheet: s.id, tag: best[1].tag, room: best[1].room };
        const r = (s.rooms || []).find((x) => inBox(p, x.box, 0));
        return r ? { kind: 'room', sheet: s.id, id: r.id } : null;
      }
      if (s.kind === 'elevation') {
        let best = null;
        (s.items || []).forEach((it) => {
          if (!it.tag || off.has(it.layer)) return;
          if (inBox(p, it.box, 6 / cam.k)) { const a = it.box[2] * it.box[3]; if (!best || a < best[0]) best = [a, it.tag]; }
        });
        (s.marks || []).forEach((m) => {
          if (inBox(p, m.box, 6 / cam.k)) { const a = m.box[2] * m.box[3]; if (!best || a < best[0]) best = [a, m.tag]; }
        });
        return best ? { kind: 'device', tag: best[1], sheet: s.id } : null;
      }
      // number chips sit at the port edge and never overlap: an explicit, unambiguous cable handle
      for (const c of s.cables || []) {
        if (state.hidden.has(c.cls)) continue;
        if (c.chips.some((b) => inBox(p, b, 2 / cam.k))) return { kind: 'cable', id: c.id };
      }
      // port cells (a wire ends on the cell edge) and units
      for (const d of s.devices || []) {
        if (!inBox(p, d.box, 0)) continue;
        for (const pt of d.ports) {
          if (inBox(p, pt.box, 0)) {
            const c = Object.values(T.cables).find((cc) => !state.hidden.has(cc.cls) && cc.ends.some((e) => e.dev === d.tag && e.port === pt.name));
            if (c) return { kind: 'port', tag: d.tag, port: pt.name, cable: c.id };
          }
        }
        return { kind: 'device', tag: d.tag };
      }
      // wires: nearest line wins. A badge only widens its own cable's catch area, so a wire
      // running under another cable's badge is still picked when the finger is on it.
      let best = null;
      for (const c of s.cables || []) {
        if (state.hidden.has(c.cls)) continue;
        let dd = Infinity;
        for (let i = 1; i < c.pts.length; i++) dd = Math.min(dd, segDist(p, c.pts[i - 1], c.pts[i]));
        const onBadge = inBox(p, badgeRect(c), 2 / cam.k);
        const eff = onBadge ? Math.max(0, dd - 8) : dd;
        if ((eff < tol || onBadge) && (!best || eff < best[0] || (eff === best[0] && dd < best[1]))) best = [eff, dd, c.id];
      }
      if (best) return { kind: 'cable', id: best[2] };
      for (const d of s.devices || []) if (d.tagBox && inBox(p, d.tagBox, 4 / cam.k)) return { kind: 'device', tag: d.tag };
      for (const m of s.marks || []) if (inBox(p, m.box, 6 / cam.k)) return { kind: 'device', tag: m.tag };
      for (const sv of s.services || []) {
        if (state.hidden.has('power')) continue;
        if (inBox(p, sv.box, 3 / cam.k) || sv.pts.some((q, i) => i && segDist(p, sv.pts[i - 1], q) < tol)) return { kind: 'device', tag: sv.dev, via: 'service' };
      }
      return null;
    }

    // ---------- input
    const ptrs = new Map();
    let pan = null, pinch = null, inertia = 0, lastTap = null, moved = 0, gesturing = false, longT = 0;
    const startGesture = () => { if (!gesturing) { gesturing = true; container.classList.add('vt-moving'); emit('gesture', 'start'); } };
    const endGesture = () => { if (gesturing) { gesturing = false; container.classList.remove('vt-moving'); emit('gesture', 'end'); } };
    const local = (e) => { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    svg.addEventListener('pointerdown', (e) => {
      cancelAnimationFrame(inertia); cancelAnimationFrame(anim);
      svg.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, local(e));
      if (ptrs.size === 1) {
        moved = 0;
        const p = ptrs.get(e.pointerId);
        pan = { x: p.x, y: p.y, t: performance.now(), vx: 0, vy: 0, sx: p.x, sy: p.y, t0: performance.now() };
        const mine = pan;
        clearTimeout(longT);
        longT = setTimeout(() => {
          if (pan === mine && ptrs.size === 1 && moved <= 8 && !pan.long) {
            pan.long = true;
            emit('longpress', { x: p.x, y: p.y, hit: hitTest(p.x, p.y) });
          }
        }, 480);
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, cam: Object.assign({}, cam) };
        pan = null; moved = 99; startGesture();
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) {
        if (e.pointerType === 'mouse' && opts.hover !== false) {
          const p = local(e), h = hitTest(p.x, p.y);
          svg.style.cursor = h ? 'pointer' : '';
          emit('hover', h);
        }
        return;
      }
      const p = local(e);
      ptrs.set(e.pointerId, p);
      if (pinch && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const k = clampK(pinch.cam.k * d / pinch.d);
        const wx = (pinch.mx - pinch.cam.x) / pinch.cam.k, wy = (pinch.my - pinch.cam.y) / pinch.cam.k;
        cam = { k, x: mx - wx * k, y: my - wy * k };
        applyCam();
      } else if (pan) {
        const now = performance.now(), dt = Math.max(1, now - pan.t), dx = p.x - pan.x, dy = p.y - pan.y;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 8) {
          startGesture();
          cam.x += dx; cam.y += dy;
          pan.vx = 0.8 * (dx / dt) + 0.2 * pan.vx; pan.vy = 0.8 * (dy / dt) + 0.2 * pan.vy;
          applyCam();
        }
        pan.x = p.x; pan.y = p.y; pan.t = now;
      }
    });
    const end = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const p = ptrs.get(e.pointerId);
      ptrs.delete(e.pointerId);
      if (ptrs.size === 1 && pinch) {
        pinch = null;
        const q = [...ptrs.values()][0];
        pan = { x: q.x, y: q.y, t: performance.now(), vx: 0, vy: 0, sx: q.x, sy: q.y, t0: performance.now(), long: true };
        return;
      }
      if (ptrs.size) return;
      pinch = null;
      if (pan && moved > 8) {
        let { vx, vy } = pan;
        if (performance.now() - pan.t > 60) vx = vy = 0;
        const step = () => {
          vx *= 0.92; vy *= 0.92;
          if (Math.abs(vx) + Math.abs(vy) < 0.03) { endGesture(); return; }
          cam.x += vx * 16; cam.y += vy * 16; applyCam();
          inertia = requestAnimationFrame(step);
        };
        if (Math.abs(vx) + Math.abs(vy) > 0.03) inertia = requestAnimationFrame(step); else endGesture();
      } else if (pan && !pan.long && e.type === 'pointerup') {
        endGesture();
        const now = performance.now();
        if (lastTap && now - lastTap.t < 280 && Math.hypot(lastTap.x - p.x, lastTap.y - p.y) < 30) {
          lastTap = null;
          const k = clampK(cam.k * 2), wx = (p.x - cam.x) / cam.k, wy = (p.y - cam.y) / cam.k;
          animateTo({ k, x: p.x - wx * k, y: p.y - wy * k }, 240);
          return;
        }
        lastTap = { t: now, x: p.x, y: p.y };
        const h = hitTest(p.x, p.y);
        emit('tap', { x: p.x, y: p.y, hit: h });
        if (opts.autoSelect !== false) select(h);
      } else endGesture();
      pan = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      cancelAnimationFrame(anim); cancelAnimationFrame(inertia);
      const p = local(e);
      const wheelZoom = e.ctrlKey || e.metaKey || e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));
      if (wheelZoom) {
        const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : e.deltaMode === 1 ? 0.05 : 0.0018));
        const k = clampK(cam.k * f), wx = (p.x - cam.x) / cam.k, wy = (p.y - cam.y) / cam.k;
        cam = { k, x: p.x - wx * k, y: p.y - wy * k };
      } else { cam.x -= e.deltaX; cam.y -= e.deltaY; }
      applyCam();
    }, { passive: false });
    let gk = 1;
    svg.addEventListener('gesturestart', (e) => { e.preventDefault(); gk = 1; });
    svg.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const p = local(e), k = clampK(cam.k * e.scale / gk), wx = (p.x - cam.x) / cam.k, wy = (p.y - cam.y) / cam.k;
      cam = { k, x: p.x - wx * k, y: p.y - wy * k }; gk = e.scale; applyCam();
    });
    window.addEventListener('resize', () => { committed = null; applyCam(); });
    // panes change size without a window resize (split dividers, sheets); keep the camera in step
    if (window.ResizeObserver) new ResizeObserver(() => { committed = null; applyCam(); }).observe(container);

    // ---------- public
    async function setSheet(id, o) {
      o = o || {};
      if (state.sheet) cams[state.sheet] = Object.assign({}, cam);
      const G = await ensureSheet(id);
      Object.values(sheetG).forEach((x) => (x.g.style.display = 'none'));
      state.sheet = id;
      G.g.style.display = '';
      buildKnockout(id);
      render(); renderPeek();
      if (cams[id] && !o.fit) { cam = cams[id]; applyCam(); }
      else zoomToFit(0);
      emit('sheet', id);
    }
    function select(ref, o) {
      o = o || {};
      state.selected = ref || null;
      state.focus = ref ? (o.focus || T.focusFor(ref)) : null;
      render();
      emit('select', ref || null);
      if (ref && o.zoom) fitFocus(o.zoomOpts);
    }
    function focus(f, o) {
      o = o || {};
      state.focus = f ? Object.assign({ cables: [], devices: [], ports: [], services: [] }, f) : null;
      render();
      if (f && o.zoom) fitFocus(o.zoomOpts);
    }
    function zoomToRef(ref, o) {
      const f = T.focusFor(ref);
      const b = f && focusBox(f);
      if (b) zoomToBox([b[0] - 20, b[1] - 20, b[2] + 40, b[3] + 40], Object.assign({ maxK: 1.8 }, o || {}));
    }

    const api = {
      T, svg, container,
      get sheet() { return state.sheet; },
      get selected() { return state.selected; },
      get focused() { return state.focus; },
      get hidden() { return [...state.hidden]; },
      get cam() { return Object.assign({}, cam); },
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return api; },
      setSheet, select, focus,
      clear() { select(null); },
      setHidden(list) { state.hidden = new Set(list); buildKnockout(state.sheet); render(); renderPeek(); emit('hidden', [...state.hidden]); },
      toggleClass(c) { const s = new Set(state.hidden); s.has(c) ? s.delete(c) : s.add(c); api.setHidden([...s]); },
      setLayersOff(list, sheetId) { const id = sheetId || state.sheet; state.layersOff[id] = new Set(list); buildKnockout(id); render(); emit('layers', { sheet: id, off: [...state.layersOff[id]] }); },
      toggleLayer(lid, sheetId) { const id = sheetId || state.sheet; const s = new Set(state.layersOff[id] || []); s.has(lid) ? s.delete(lid) : s.add(lid); api.setLayersOff([...s], id); },
      layersOff(sheetId) { return [...(state.layersOff[sheetId || state.sheet] || [])]; },
      setOverlay(o) { if ('zones' in o) state.zones = o.zones; if ('clouds' in o) state.clouds = o.clouds; buildKnockout(state.sheet); },
      peek(ref) { state.peek = ref; renderPeek(); },
      unpeek() { state.peek = null; renderPeek(); },
      zoomToFit, zoomToBox, zoomToRef, fitFocus, focusBox,
      zoomBy(f) { const r = rect(), k = clampK(cam.k * f), cx = r.width / 2, cy = r.height / 2, wx = (cx - cam.x) / cam.k, wy = (cy - cam.y) / cam.k; animateTo({ k, x: cx - wx * k, y: cy - wy * k }, 200); },
      hitTest,
      worldToScreen(x, y) { return [x * cam.k + cam.x, y * cam.k + cam.y]; },
      // screen point in the middle of a cable's longest run (away from crossings): for tests and coach marks
      pointOn(id) {
        const c = T.cables[id];
        let best = null;
        for (let i = 1; i < c.pts.length; i++) {
          const a = c.pts[i - 1], b = c.pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (!best || L > best[0]) best = [L, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        }
        return [best[1] * cam.k + cam.x, best[2] * cam.k + cam.y];
      },
      ready: setSheet(opts.sheet),
    };
    return api;
  }

  window.VT = { load, create, CLASSES };
})();
