/* EditBase — Nextcloud native SPA (buildless Vue 3, precompiled render function).
 *
 * The editing surface is one contenteditable element holding the document itself.
 * Nothing about the document is Vue-managed: Vue owns the chrome (sidebar, toolbar,
 * dialogs) and the canvas is plain DOM the editing engine below manipulates, because
 * a virtual DOM and a caret cannot both own the same tree.
 */
(function () {
  'use strict';
  // vue-private.js moved the runtime off window.Vue (see the note there).
  const Vue = window.__EditBaseVue || window.Vue;
  const { createApp } = Vue;

  const BASE = ((window.OC && OC.generateUrl) ? OC.generateUrl('/apps/editbase') : '/apps/editbase') + '/';
  const TOKEN = (window.OC && OC.requestToken) ? OC.requestToken : '';

  // ---- i18n -----------------------------------------------------------------
  // English strings are the source/keys; Nextcloud loads l10n/<ncLang>.js server-side.
  // A non-'auto' language setting installs a client-side override map instead, so the
  // app can be read in one language while the rest of the server stays in another.
  let i18nOverride = null;
  function subst(s, vars) {
    return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : s;
  }
  function T(text, vars) {
    if (i18nOverride) {
      return subst(i18nOverride[text] != null ? i18nOverride[text] : text, vars);
    }
    try {
      if (typeof window.t === 'function') { return window.t('editbase', text, vars, undefined, { escape: false }); }
    } catch (e) { /* fall through to the raw key */ }
    return subst(text, vars);
  }

  // ---- server ---------------------------------------------------------------
  async function api(path, opts) {
    const res = await fetch(BASE + 'api/' + path, {
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json', requesttoken: TOKEN }, (opts || {}).headers || {}),
      method: (opts || {}).method || 'GET',
      body: (opts || {}).body != null ? JSON.stringify(opts.body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) { throw new Error((body && body.error) || ('HTTP ' + res.status)); }
    return body;
  }

  // ---- paper ----------------------------------------------------------------
  // Millimetres, because that is how paper is sold and how margins are specified.
  const PAPERS = {
    A3: { w: 297, h: 420 },
    A4: { w: 210, h: 297 },
    A5: { w: 148, h: 210 },
    B4: { w: 257, h: 364 },
    B5: { w: 182, h: 257 },
    Letter: { w: 215.9, h: 279.4 },
    Legal: { w: 215.9, h: 355.6 },
    // Japanese postcards. A word processor here is asked for these as often as
    // for a letter, and they are the size a printer's own tray expects.
    Postcard: { w: 100, h: 148 },
    Postcard2: { w: 148, h: 200 },
  };
  // fonts: '' on any of the three means "whatever suits the document's language".
  const DEFAULT_PAPER = {
    size: 'A4', orientation: 'portrait', margin: { top: 25, right: 20, bottom: 25, left: 20 },
    font: 'serif', fontSize: 10.5, lineHeight: 1.75, fonts: { body: '', heading: '', mono: '' },
    header: { l: '', c: '', r: '' }, footer: { l: '', c: '', r: '' },
    // A page has a body always, and a header and a footer only when they are
    // asked for. They are regions of the page, not objects laid on it: no box
    // round them, no handles, nothing to pick up -- you write in them.
    headerOn: false, footerOn: false,
    headingNumbers: '',
    vertical: false,
    // The paper itself: what it is painted with and what is drawn round it.
    // '' on the colour means plain white paper, as it comes out of the tray.
    bg: { colour: '', image: '', fit: 'cover', fade: 0, w: 0, h: 0 },
    border: { style: 'none', width: 1, colour: '#333333', gap: 6, radius: 0 },
  };
  const PAGE_FITS = ['cover', 'contain', 'stretch', 'tile'];
  const PAGE_BORDERS = ['none', 'solid', 'dashed', 'dotted', 'double'];
  /** A picture the file may carry: one it holds itself, or one it can fetch. */
  function safeImageUrl(v) {
    const s = String(v || '').trim();
    if (!s || s.length > 8 * 1024 * 1024) { return ''; }
    if (/^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+$/i.test(s)) { return s; }
    if (/^https?:\/\/[^\s"'()<>]+$/i.test(s)) { return s; }
    return '';
  }

  function normalisePaper(p) {
    const out = JSON.parse(JSON.stringify(DEFAULT_PAPER));
    if (!p || typeof p !== 'object') { return out; }
    if (PAPERS[p.size]) { out.size = p.size; }
    if (p.orientation === 'landscape') { out.orientation = 'landscape'; }
    if (p.font === 'sans') { out.font = 'sans'; }
    if (p.headingNumbers === 'decimal' || p.headingNumbers === 'japanese') { out.headingNumbers = p.headingNumbers; }
    out.vertical = !!p.vertical;
    out.headerOn = !!p.headerOn;
    out.footerOn = !!p.footerOn;
    const fs = Number(p.fontSize);
    if (fs >= 6 && fs <= 36) { out.fontSize = fs; }
    const lh = Number(p.lineHeight);
    if (lh >= 1 && lh <= 3) { out.lineHeight = lh; }
    if (p.fonts && typeof p.fonts === 'object') {
      ['body', 'heading', 'mono'].forEach((k) => {
        const v = p.fonts[k];
        // A family name, nothing else: it goes into a URL and into CSS.
        if (typeof v === 'string' && /^[\w .+&'-]{0,64}$/.test(v)) { out.fonts[k] = v.trim(); }
      });
    }
    ['top', 'right', 'bottom', 'left'].forEach((k) => {
      const v = Number(p.margin && p.margin[k]);
      if (v >= 0 && v <= 100) { out.margin[k] = v; }
    });
    // The paper's own paint. A background picture is kept inside the file as a
    // data URL, the same as any other picture here, so the artefact stays one file.
    if (p.bg && typeof p.bg === 'object') {
      if (typeof p.bg.colour === 'string' && /^#[0-9a-f]{6}$/i.test(p.bg.colour)) { out.bg.colour = p.bg.colour; }
      out.bg.image = safeImageUrl(p.bg.image);
      if (PAGE_FITS.indexOf(p.bg.fit) >= 0) { out.bg.fit = p.bg.fit; }
      const fd = Number(p.bg.fade);
      if (fd >= 0 && fd <= 90) { out.bg.fade = Math.round(fd); }
      // The picture's own size in pixels, so that a tile can be laid at the size
      // it was drawn rather than at a guess.
      ['w', 'h'].forEach((k) => {
        const n = Number(p.bg[k]);
        if (n > 0 && n <= 20000) { out.bg[k] = Math.round(n); }
      });
    }
    if (p.border && typeof p.border === 'object') {
      if (PAGE_BORDERS.indexOf(p.border.style) >= 0) { out.border.style = p.border.style; }
      const bw = Number(p.border.width);
      if (bw >= 0.1 && bw <= 20) { out.border.width = Math.round(bw * 10) / 10; }
      if (typeof p.border.colour === 'string' && /^#[0-9a-f]{6}$/i.test(p.border.colour)) { out.border.colour = p.border.colour; }
      const bg2 = Number(p.border.gap);
      if (bg2 >= 0 && bg2 <= 40) { out.border.gap = Math.round(bg2 * 10) / 10; }
      const br = Number(p.border.radius);
      if (br >= 0 && br <= 40) { out.border.radius = Math.round(br * 10) / 10; }
    }
    // Plain text only: these go into the file as markup, and a running header is
    // not a place anyone needs to write markup.
    ['header', 'footer'].forEach((which) => {
      const src = p[which];
      if (!src || typeof src !== 'object') { return; }
      ['l', 'c', 'r'].forEach((k) => {
        if (typeof src[k] === 'string') { out[which][k] = src[k].replace(/[<>]/g, '').slice(0, 120); }
      });
    });
    return out;
  }
  /**
   * What the paper is painted with, drawn once as a picture of the page: the
   * colour, the picture behind the writing and the frame, in that order, in
   * millimetres on a canvas the size of the sheet.
   *
   * It is one picture rather than a set of CSS rules because of the printer. A
   * background on the body or on html stops at the page margins when it is
   * printed -- the paper's own edge is out of their reach -- and a fixed element
   * is clipped to the same box on every page. The only box that is the whole
   * sheet is the page box itself, and the one thing that can be put on it in
   * every browser that supports it is a background image. The same picture then
   * serves the editor's sheets and the saved file's screen view, so what is on
   * the screen is what comes out of the printer.
   */
  function pageArt(paper) {
    const s = sheet(paper);
    const bg = paper.bg || {};
    const bd = paper.border || {};
    const hasBorder = bd.style && bd.style !== 'none' && bd.width > 0;
    if (!bg.colour && !bg.image && !hasBorder) { return { url: '', any: false }; }
    const q = (v) => String(v).replace(/#/g, '%23');
    const box = "0 0 " + s.w + " " + s.h;
    let art = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='" + box + "' preserveAspectRatio='none'>";
    if (bg.colour) { art += "<rect width='" + s.w + "' height='" + s.h + "' fill='" + q(bg.colour) + "'/>"; }
    if (bg.image) {
      if (bg.fit === 'tile') {
        // A tile is the picture at its own size, so the paper is measured in
        // millimetres and the picture in pixels: 96 of them to the inch.
        const tw = round1((Number(bg.w) || 120) * MM) || 30;
        const th = round1((Number(bg.h) || 120) * MM) || 30;
        art += "<defs><pattern id='t' patternUnits='userSpaceOnUse' width='" + tw + "' height='" + th + "'>"
          + "<image href='" + bg.image + "' width='" + tw + "' height='" + th + "' preserveAspectRatio='none'/>"
          + "</pattern></defs>"
          + "<rect width='" + s.w + "' height='" + s.h + "' fill='url(%23t)'/>";
      } else {
        const par = { cover: 'xMidYMid slice', contain: 'xMidYMid meet', stretch: 'none' }[bg.fit] || 'xMidYMid slice';
        art += "<image href='" + bg.image + "' x='0' y='0' width='" + s.w + "' height='" + s.h
          + "' preserveAspectRatio='" + par + "'/>";
      }
    }
    // Fading is a sheet of white over the picture, not opacity: opacity would
    // fade the words standing on it as well.
    if (bg.image && bg.fade > 0) {
      art += "<rect width='" + s.w + "' height='" + s.h + "' fill='%23ffffff' opacity='" + (bg.fade / 100).toFixed(2) + "'/>";
    }
    if (hasBorder) {
      const w = bd.width;
      const dash = { dashed: " stroke-dasharray='" + round1(w * 3) + " " + round1(w * 2) + "'",
        dotted: " stroke-dasharray='0.01 " + round1(w * 2) + "' stroke-linecap='round'" }[bd.style] || '';
      const rect = (inset, width) => "<rect x='" + round1(inset + width / 2) + "' y='" + round1(inset + width / 2)
        + "' width='" + round1(s.w - 2 * inset - width) + "' height='" + round1(s.h - 2 * inset - width)
        + "' rx='" + Math.max(0, round1(bd.radius - (inset - bd.gap))) + "' fill='none' stroke='" + q(bd.colour)
        + "' stroke-width='" + width + "'" + dash + "/>";
      if (bd.style === 'double') {
        // Two lines and the space between them, each a third of the width, the
        // way a double border is drawn.
        const t = round1(w / 3);
        art += rect(bd.gap, t) + rect(round1(bd.gap + 2 * t), t);
      } else {
        art += rect(bd.gap, w);
      }
    }
    art += '</svg>';
    return { url: 'data:image/svg+xml;utf8,' + art, any: true };
  }

  /** Sheet size in mm with the orientation applied. */
  function sheet(paper) {
    const s = PAPERS[paper.size] || PAPERS.A4;
    return paper.orientation === 'landscape' ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
  }
  /** The @page rule — the one piece of CSS that differs per document. */
  function pageRule(paper) {
    const s = PAPERS[paper.size] || PAPERS.A4;
    const sh = sheet(paper);
    const m = paper.margin;
    // B4 and B5 are deliberately not in this list. CSS's own B4 and B5 are the
    // ISO sizes -- 250x353 and 176x250 -- while the B4 and B5 sold and printed on
    // in Japan are the JIS ones, 257x364 and 182x257. Naming them would have the
    // editor draw one sheet and the printer produce another, 6mm narrower and 7mm
    // shorter, so they are printed as the millimetres they actually are.
    const named = { A3: 'A3', A4: 'A4', A5: 'A5', Letter: 'letter', Legal: 'legal' }[paper.size];
    // A size given in millimetres carries its own orientation: saying "landscape"
    // as well is not allowed, and leaving the paper's own width and height in
    // portrait order printed a landscape postcard upright.
    const size = named ? named + ' ' + paper.orientation : (sh.w + 'mm ' + sh.h + 'mm');
    // The page's own paint goes on the page box, the only box that is the whole
    // sheet when the file is printed. Its background starts at the text area, so
    // it is given the paper's size and pulled back out to the paper's corner by
    // the margins; the writing is not touched, and a browser that ignores it
    // simply prints on white paper with everything in the same place.
    const art = pageArt(paper);
    const paint = art.any
      ? ' background-image: url("' + art.url + '");'
        + ' background-size: ' + sh.w + 'mm ' + sh.h + 'mm;'
        + ' background-repeat: no-repeat;'
        + ' background-position: ' + (-m.left) + 'mm ' + (-m.top) + 'mm;'
      : '';
    return '@page { size: ' + size + '; margin: ' + m.top + 'mm ' + m.right + 'mm ' + m.bottom + 'mm ' + m.left + 'mm;' + paint + ' }';
  }

  // ---- typefaces ---------------------------------------------------------------
  // Any family on Google Fonts can be used. The catalogue ships with the app
  // (data/google-fonts.json), so the picker works without calling Google at all;
  // the font files themselves are fetched only once a family is actually in use,
  // and the same stylesheet URL is written into the saved document, which is what
  // makes the file look the same on a machine that has none of these fonts.
  const GF_CSS = 'https://fonts.googleapis.com/css2';
  const FALLBACK = {
    serif: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Times New Roman", serif',
    sans: '"Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif',
    mono: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    display: '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", Arial, sans-serif',
    handwriting: '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", cursive',
  };

  // A document reads best in a face cut for its own script, so the document's
  // language picks the starting typefaces — not the server locale, and not Latin
  // defaults that would leave Japanese or Thai to a substitute font.
  const LATIN = { serif: 'Source Serif 4', sans: 'Source Sans 3', mono: 'Noto Sans Mono' };
  const LANG_FONTS = {
    ja: { serif: 'BIZ UDPMincho', sans: 'BIZ UDPGothic', mono: 'BIZ UDGothic' },
    zh: { serif: 'Noto Serif SC', sans: 'Noto Sans SC', mono: 'Noto Sans Mono' },
    zh_Hant: { serif: 'Noto Serif TC', sans: 'Noto Sans TC', mono: 'Noto Sans Mono' },
    ko: { serif: 'Noto Serif KR', sans: 'Noto Sans KR', mono: 'Noto Sans Mono' },
    ar: { serif: 'Noto Naskh Arabic', sans: 'Noto Kufi Arabic', mono: 'Noto Sans Mono' },
    fa: { serif: 'Noto Naskh Arabic', sans: 'Noto Kufi Arabic', mono: 'Noto Sans Mono' },
    he: { serif: 'Noto Serif Hebrew', sans: 'Noto Sans Hebrew', mono: 'Noto Sans Mono' },
    hi: { serif: 'Noto Serif Devanagari', sans: 'Noto Sans Devanagari', mono: 'Noto Sans Mono' },
    th: { serif: 'Noto Serif Thai', sans: 'Noto Sans Thai', mono: 'Noto Sans Mono' },
    ru: { serif: 'Noto Serif', sans: 'Noto Sans', mono: 'Noto Sans Mono' },
    uk: { serif: 'Noto Serif', sans: 'Noto Sans', mono: 'Noto Sans Mono' },
    en: LATIN, es: LATIN, fr: LATIN, de: LATIN, it: LATIN, pt: LATIN,
    vi: LATIN, tr: LATIN, pl: LATIN, cs: LATIN, id: LATIN,
  };
  /** Which script a language is written in, for filtering the picker. */
  const LANG_SCRIPT = {
    ja: 'japanese', zh: 'chinese-simplified', zh_Hant: 'chinese-traditional', ko: 'korean',
    ar: 'arabic', fa: 'arabic', he: 'hebrew', hi: 'devanagari', th: 'thai',
    ru: 'cyrillic', uk: 'cyrillic', vi: 'vietnamese',
  };

  function langKey(lang) {
    const l = String(lang || 'en').replace('-', '_');
    if (LANG_FONTS[l]) { return l; }
    const base = l.split('_')[0];
    if (base === 'zh' && /(_TW|_HK|Hant)/i.test(l)) { return 'zh_Hant'; }
    return LANG_FONTS[base] ? base : 'en';
  }
  function defaultFonts(lang) { return LANG_FONTS[langKey(lang)] || LATIN; }
  function scriptFor(lang) { return LANG_SCRIPT[langKey(lang)] || 'latin'; }

  // The default families, known without the catalogue: a document must produce the
  // right stylesheet URL from the first keystroke, not only after the picker is opened.
  const BUILTIN_FONTS = {
    'Source Serif 4': { c: 'serif', w: [400, 700], i: true },
    'Source Sans 3': { c: 'sans', w: [400, 700], i: true },
    'Noto Sans Mono': { c: 'sans', w: [400, 700], i: false },
    'BIZ UDPMincho': { c: 'serif', w: [400, 700], i: false },
    'BIZ UDPGothic': { c: 'sans', w: [400, 700], i: false },
    'BIZ UDGothic': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif SC': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans SC': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif TC': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans TC': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif KR': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans KR': { c: 'sans', w: [400, 700], i: false },
    'Noto Naskh Arabic': { c: 'serif', w: [400, 700], i: false },
    'Noto Kufi Arabic': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif Hebrew': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans Hebrew': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif Devanagari': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans Devanagari': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif Thai': { c: 'serif', w: [400, 700], i: false },
    'Noto Sans Thai': { c: 'sans', w: [400, 700], i: false },
    'Noto Serif': { c: 'serif', w: [400, 700], i: true },
    'Noto Sans': { c: 'sans', w: [400, 700], i: true },
  };

  // The catalogue, loaded once per session from the app itself.
  let fontCatalogue = null;
  let fontIndex = Object.assign({}, BUILTIN_FONTS);
  async function loadFonts() {
    if (fontCatalogue) { return fontCatalogue; }
    const data = await api('fonts');
    fontCatalogue = data && data.families ? data : { families: [], scripts: [] };
    fontIndex = Object.assign({}, BUILTIN_FONTS);
    fontCatalogue.families.forEach((f) => { fontIndex[f.f] = f; });
    return fontCatalogue;
  }
  function knownFont(family) { return family ? fontIndex[family] || null : null; }

  /** The families a document actually uses, resolved from its settings. */
  function resolveFonts(paper, lang) {
    const def = defaultFonts(lang);
    const chosen = (paper && paper.fonts) || {};
    return {
      body: chosen.body || def[paper && paper.font === 'sans' ? 'sans' : 'serif'],
      head: chosen.heading || def.sans,
      mono: chosen.mono || def.mono,
    };
  }
  /** font-family value: the chosen family first, then something to fall back on. */
  function fontStack(family, kind) {
    const meta = knownFont(family);
    const fb = FALLBACK[meta ? meta.c : kind] || FALLBACK[kind] || FALLBACK.sans;
    return family ? '"' + String(family).replace(/"/g, '') + '", ' + fb : fb;
  }
  /**
   * One Google Fonts stylesheet URL for a set of families. Weights are held to the
   * two a document needs (regular and bold, plus italics where the family has them)
   * so a document does not pull megabytes it will never draw.
   */
  function fontsUrl(families, sampleText) {
    const wanted = [];
    families.filter(Boolean).forEach((name) => {
      if (wanted.some((w) => w.name === name)) { return; }
      wanted.push({ name, meta: knownFont(name) });
    });
    if (!wanted.length) { return ''; }
    const parts = wanted.map(({ name, meta }) => {
      const key = 'family=' + encodeURIComponent(name).replace(/%20/g, '+');
      // Without the catalogue there is nothing to say about weights; ask for the
      // family plainly and let Google serve its default rather than 400 the request.
      if (!meta) { return key; }
      const weights = [400, 700].filter((w) => meta.w.includes(w));
      const list = weights.length ? weights : [meta.w[0]];
      const spec = meta.i
        ? ':ital,wght@' + list.map((w) => '0,' + w).concat(list.map((w) => '1,' + w)).join(';')
        : ':wght@' + list.join(';');
      return key + spec;
    });
    let url = GF_CSS + '?' + parts.join('&') + '&display=swap';
    if (sampleText) { url += '&text=' + encodeURIComponent(sampleText); }
    return url;
  }
  /** Put (or replace) a stylesheet link in the page head, by id. */
  function linkStylesheet(id, url) {
    let link = document.getElementById(id);
    if (!url) { if (link) { link.remove(); } return; }
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.getAttribute('href') !== url) { link.setAttribute('href', url); }
  }

  // ---- what counts as an object ---------------------------------------------
  // The one list of everything that is an object rather than writing. Every part
  // of the app that has to know -- the box round it, the handles, the properties,
  // the anchor that makes its position mean anything -- reads this and only this,
  // so a new kind of object cannot be added and end up without its box.
  const OBJECT_SEL = 'figure.eb-img, table.eb-table, aside.eb-box, div.eb-note, div.eb-math-block, nav.eb-toc, div.eb-frame, span.eb-frame, p.eb-textbox, div.eb-shape, div.eb-embed, hr';
  /** The same list, as the selector for one state of the canvas. */
  const objectRule = (prefix) => OBJECT_SEL.split(', ').map((s) => prefix + ' ' + s).join(', ');
  // Writing is an object too. A paragraph, a heading, a list, a quotation: each
  // one is a block on the page with a size and a place, and a writer laying a
  // page out has to see where it ends -- so each one wears a box like anything
  // else. Only the blocks that stand on the page themselves; the ones inside a
  // table cell or a shape are part of that object's box, not boxes of their own.
  const TEXT_SEL = 'p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, dl, div.eb-cols';
  const textRule = (prefix) => TEXT_SEL.split(', ').map((s) => prefix + ' ' + s).join(', ');
  /** Every text block that stands inside an object: each object crossed with each block. */
  const insideObjects = (prefix) => OBJECT_SEL.split(', ')
    .map((o) => textRule(prefix + ' ' + o)).join(',\n');

  // ---- the document stylesheet ----------------------------------------------
  // Written into every saved file *and* applied to the editor canvas, so the
  // editor cannot drift from the artefact. Everything is scoped to .eb-doc: in a
  // saved file that class sits on <body>, in the editor it sits on the canvas.
  const DOC_CSS = `
/* The editor sits inside an interface stylesheet that sets border-box on
   everything; a saved file, opened on its own, gets the browser's content-box.
   A box 139.6mm wide with a border and padding then came out 150.2mm in the file
   and 139.6mm in the editor, and everything below it moved. Say it here and the
   two agree. */
.eb-doc, .eb-doc *, .eb-doc *::before, .eb-doc *::after { box-sizing: border-box; }
.eb-doc {
  font-family: var(--eb-font-body, "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Times New Roman", serif);
  font-size: 10.5pt; line-height: 1.75; color: #111111; text-align: left;
  word-break: normal; overflow-wrap: anywhere; hyphens: auto;
}
.eb-doc > *:first-child { margin-top: 0; }
.eb-doc p { margin: 0 0 0.9em; }
/* Everything a heading, a list, a block of code or a table needs is said here
   rather than left to the browser: an interface stylesheet round the editor can
   have its own opinion about a bare <ul> or <h2>, and then the editor draws one
   thing while the saved file draws another. Saying it makes the two agree, and
   makes the file render the same wherever it is opened. */
.eb-doc h1, .eb-doc h2, .eb-doc h3, .eb-doc h4, .eb-doc h5, .eb-doc h6 {
  font-family: var(--eb-font-head, "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif);
  line-height: 1.4; margin: 1.6em 0 0.7em; break-after: avoid-page; text-align: left;
  color: #111111; font-weight: 700;
}
.eb-doc h1 { font-size: 1.9em; letter-spacing: .02em; }
.eb-doc h2 { font-size: 1.5em; border-bottom: 1.5pt solid #222; padding-bottom: .2em; }
.eb-doc h3 { font-size: 1.25em; }
.eb-doc h4 { font-size: 1.1em; }
.eb-doc h5, .eb-doc h6 { font-size: 1em; }
.eb-doc ul, .eb-doc ol { margin: 0 0 0.9em; padding-left: 1.7em; }
.eb-doc ul { list-style-type: disc; }
.eb-doc ul ul { list-style-type: circle; }
.eb-doc ul ul ul { list-style-type: square; }
.eb-doc ol { list-style-type: decimal; }
.eb-doc li { margin: 0.15em 0; }
.eb-doc blockquote {
  margin: 1em 0; padding: .4em 0 .4em 1em; border-left: 3pt solid #999; color: #333;
}
.eb-doc pre {
  margin: 1em 0;
  font-family: var(--eb-font-mono, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace); font-size: .92em;
  background: #f4f4f4; border: .75pt solid #d5d5d5; border-radius: 4pt; padding: .7em .9em;
  overflow-x: auto; white-space: pre-wrap; break-inside: avoid;
}
.eb-doc code { font-family: var(--eb-font-mono, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace); font-size: .92em; }
.eb-doc a { color: #14509b; }
.eb-doc hr { border: none; border-top: .75pt solid #999; margin: 1.4em 0; }
.eb-doc hr.eb-rule-thick { border-top-width: 2pt; }
.eb-doc hr.eb-rule-dashed { border-top-style: dashed; }
.eb-doc img { max-width: 100%; height: auto; }
.eb-doc figure { margin: 1.2em auto; text-align: center; break-inside: avoid; }
.eb-doc figcaption { font-size: .88em; color: #444; margin-top: .4em; }
.eb-doc figcaption:empty { display: none; }
.eb-doc figure.eb-img-s { max-width: 34%; }
.eb-doc figure.eb-img-m { max-width: 62%; }
.eb-doc figure.eb-img-l { max-width: 100%; }
.eb-doc figure.eb-img img { width: 100%; height: auto; }\n.eb-doc figure.eb-img-left { float: left; margin: .3em 1.4em .8em 0; }\n.eb-doc figure.eb-img-right { float: right; margin: .3em 0 .8em 1.4em; }\n.eb-doc h1, .eb-doc h2, .eb-doc h3, .eb-doc h4, .eb-doc h5, .eb-doc h6, .eb-doc table { clear: both; }\n.eb-doc a { text-decoration: underline; text-underline-offset: 2px; }\n.eb-doc nav.eb-toc { margin: 1.4em 0; break-inside: avoid; }\n.eb-doc nav.eb-toc .eb-toc-title { font-weight: 700; margin: 0 0 .5em; }\n.eb-doc nav.eb-toc ul { list-style: none; margin: 0; padding: 0; }\n.eb-doc nav.eb-toc li { margin: .2em 0; }\n.eb-doc nav.eb-toc li.eb-toc-l2 { padding-left: 1.5em; }\n.eb-doc nav.eb-toc li.eb-toc-l3 { padding-left: 3em; }\n.eb-doc nav.eb-toc li.eb-toc-l4 { padding-left: 4.5em; }\n.eb-doc nav.eb-toc a { color: inherit; text-decoration: none; }

/* callout boxes — borders rather than fills, because browsers do not print
   background colours unless the reader turns them on */
.eb-doc .eb-box {
  border: 1pt solid #444; border-radius: 8pt; padding: .8em 1em; margin: 1.1em 0; break-inside: avoid;
}
.eb-doc .eb-box.sq { border-radius: 0; }
.eb-doc .eb-box.dashed { border-style: dashed; }
.eb-doc .eb-box.thick { border-width: 2pt; }
.eb-doc .eb-box.tint { background: #f5f7fb; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.eb-doc .eb-box > *:first-child { margin-top: 0; }
.eb-doc .eb-box > *:last-child { margin-bottom: 0; }
.eb-doc .eb-box .eb-box-title { font-weight: 700; margin-bottom: .4em; }
.eb-doc .eb-note {
  border-left: 4pt solid #2563eb; padding: .5em 0 .5em .9em; margin: 1.1em 0; break-inside: avoid;
}

/* tables — sized to the text column and kept whole across a page break */
.eb-doc table.eb-table { border-collapse: collapse; width: 100%; margin: 1.1em 0; font-size: .96em; white-space: normal; vertical-align: baseline; }
.eb-doc table.eb-table th, .eb-doc table.eb-table td {
  border: .75pt solid #666; padding: .38em .6em; vertical-align: top;
}
/* A default has to be weaker than a choice. Written the plain way this selector
   counts for more than .eb-al-r does, and a cell told to range right stayed left
   however many times the button was pressed. :where() gives the default no
   weight at all, so the alignment on the cell wins. */
:where(.eb-doc table.eb-table th, .eb-doc table.eb-table td) { text-align: left; }
.eb-doc table.eb-table th { background: #eef1f6; font-weight: 700; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.eb-doc table.eb-table.borderless th, .eb-doc table.eb-table.borderless td { border: none; }
.eb-doc table.eb-table.rows th, .eb-doc table.eb-table.rows td { border-left: none; border-right: none; }
.eb-doc table.eb-table caption { caption-side: bottom; font-size: .88em; color: #444; padding-top: .4em; }
.eb-doc table.eb-table tr { break-inside: avoid; }

/* inline decoration */
.eb-doc mark { background: #fff3a3; color: inherit; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.eb-doc mark.eb-hl-g { background: #c9f2c7; }
.eb-doc mark.eb-hl-b { background: #cfe4ff; }
.eb-doc mark.eb-hl-p { background: #f0d3fb; }
.eb-doc mark.eb-hl-r { background: #ffd0d0; }
.eb-doc .eb-kenten { text-emphasis: filled dot; -webkit-text-emphasis: filled dot; text-emphasis-position: over right; }
/* One box may run down the page while the one beside it runs across, in either
   kind of document: 縦書き and 横書き are settings of the box, not only of the page. */
.eb-doc .eb-tate { writing-mode: vertical-rl; text-orientation: mixed; }
.eb-doc .eb-yoko { writing-mode: horizontal-tb; }

/* alignment and indentation, as classes so the markup stays readable */
.eb-doc .eb-al-l { text-align: left; }
.eb-doc .eb-al-c { text-align: center; }
.eb-doc .eb-al-r { text-align: right; }
/* The document is set ranged left, as a word processor's default paragraph is.
   It used to be justified, which left the justify button with nothing to do:
   pressing it set what was already set, and the writer saw no change. */
.eb-doc .eb-al-j { text-align: justify; }
.eb-doc .eb-in1 { margin-left: 2em; }
.eb-doc .eb-in2 { margin-left: 4em; }
.eb-doc .eb-in3 { margin-left: 6em; }

/* frames — the box round anything that was inserted rather than typed. Everything
   a frame can be told to do is written on it as inline CSS, so the file carries its
   own layout and any browser draws it the same. */
/* Shapes. A shape is a box with nothing in it but its own outline and colour --
   or with words in it, if the writer puts some there. Everything else about it
   (picking it up, moving it, its settings) is what every other object does. */
.eb-doc .eb-shape {
  display: block; box-sizing: border-box; min-height: 20mm;
  border: 1pt solid #333333; background: transparent; break-inside: avoid;
  padding: 2mm; margin: 1.1em 0;
}
.eb-doc .eb-shape.eb-sh-round { border-radius: 4mm; }
/* Only on the things that are boxes to write in. Laying a table out as a column
   of flex items would take it apart. */
.eb-doc .eb-shape.eb-v-mid, .eb-doc .eb-frame.eb-v-mid, .eb-doc .eb-box.eb-v-mid,
.eb-doc .eb-shape.eb-v-bot, .eb-doc .eb-frame.eb-v-bot, .eb-doc .eb-box.eb-v-bot {
  display: flex; flex-direction: column;
}
.eb-doc .eb-shape.eb-v-mid, .eb-doc .eb-frame.eb-v-mid, .eb-doc .eb-box.eb-v-mid { justify-content: center; }
.eb-doc .eb-shape.eb-v-bot, .eb-doc .eb-frame.eb-v-bot, .eb-doc .eb-box.eb-v-bot { justify-content: flex-end; }
.eb-doc .eb-shape.eb-sh-ellipse { border-radius: 50%; }
.eb-doc .eb-shape.eb-sh-line {
  min-height: 0; height: 0; padding: 0; border: none; border-top: 1pt solid #333333;
}
.eb-doc .eb-shape.eb-sh-arrow {
  min-height: 0; height: 0; padding: 0; border: none; border-top: 1pt solid #333333;
  position: relative;
}
.eb-doc .eb-shape.eb-sh-arrow::after {
  content: ''; position: absolute; right: -1px; top: -3.5pt;
  border: 3.5pt solid transparent; border-left-color: #333333; border-right: none;
}
.eb-doc .eb-frame {
  border: .75pt solid #666; padding: .6em .8em; margin: 1.1em 0; break-inside: avoid;
}
.eb-doc .eb-frame > *:first-child { margin-top: 0; }
.eb-doc .eb-frame > *:last-child { margin-bottom: 0; }
/* A run of words made into a frame: a box, but not a box that shows until it is
   told to. It is inline-block so it can be given a size, floated or placed. */
.eb-doc span.eb-frame { display: inline-block; border: 0; padding: 0; margin: 0; }
/* 文字枠 -- a text frame. A paragraph with a box round it that the writer put
   there: no border of its own until one is asked for, because a text box that
   draws a rectangle round every line is not what anyone wants to print. */
.eb-doc p.eb-textbox { margin: 0; }
/* An object placed by hand is parked in a zero-height anchor left at the point in
   the text it belongs to. That is what makes it print on the page its text is on:
   HTML has no coordinate system that spans pages, but a box positioned against a
   paragraph goes wherever that paragraph goes. */
.eb-doc div.eb-anchor { position: relative; height: 0; margin: 0; }
/* Where the words under a picture stand. Below it is the default and needs no
   rule; above it is a matter of which comes first in the markup; inside it is a
   band laid over the foot of the picture itself. */
.eb-doc figure.eb-img.eb-cap-in { position: relative; }
/* An inline picture sits on a text line, and the line leaves a few pixels under
   it for descenders -- so a band pinned to the foot of the figure hangs past the
   foot of the picture. Made a block, the picture is the whole of the box. */
.eb-doc figure.eb-img.eb-cap-in > img { display: block; margin-left: auto; margin-right: auto; }
.eb-doc figure.eb-img.eb-cap-in > figcaption {
  position: absolute; left: 0; right: 0; bottom: 0; margin: 0;
  background: rgba(0, 0, 0, .48); color: #ffffff; padding: .35em .6em;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
/* Above the picture. The markup is always picture-then-words -- that is what a
   figure is -- so the class alone turns it round, and a file that carries the
   class shows it the same way whatever order it was written in. */
.eb-doc figure.eb-img.eb-cap-t { display: flex; flex-direction: column-reverse; align-items: center; }
.eb-doc figure.eb-img.eb-cap-t > figcaption { margin: 0 0 .4em; width: 100%; }
.eb-doc figure.eb-img.eb-cap-none > figcaption { display: none; }
/* A page is a header, a body and a footer. The body is always there; the other
   two appear when they are asked for. They are regions, not objects: nothing to
   pick up, no handles, no box -- the writer puts the caret in and types.
   On paper they are fixed to the top and the foot of every page, which is what
   makes them a running header and a running footer rather than two paragraphs
   that happen to be at either end of the writing. */
.eb-doc > header.eb-header, .eb-doc > footer.eb-footer {
  margin: 0; padding: 1mm 0; min-height: 6mm; color: inherit;
}
.eb-doc > header.eb-header { border-bottom: .5pt solid rgba(0, 0, 0, .25); margin-bottom: 4mm; }
.eb-doc > footer.eb-footer { border-top: .5pt solid rgba(0, 0, 0, .25); margin-top: 4mm; }
@media print {
  .eb-doc > header.eb-header { position: fixed; top: -9mm; left: 0; right: 0; margin: 0; border-bottom: 0; }
  .eb-doc > footer.eb-footer { position: fixed; bottom: -9mm; left: 0; right: 0; margin: 0; border-top: 0; }
}

/* A box standing on the page holds what is put inside it. Without this the room
   reserved to keep the words clear of something laid over the box did not make
   the box any taller, and the words were pushed out of the bottom of their own
   frame -- one word 80mm below a 30mm box. Held, the box grows to fit them.
   Only boxes that stand on the page: objects in the flow are not made to keep
   clear of each other, which is the writer's business and not the editor's. */
.eb-doc .eb-anchor > * { display: flow-root; }
.eb-doc .eb-anchor > figure.eb-img.eb-cap-t { display: flex; flex-direction: column-reverse; align-items: center; }

/* The room an object takes out of the writing. Empty, no ink, no room of its own
   beyond the float: it is the wrap itself, written down. */
.eb-doc span.eb-flow { display: block; pointer-events: none; }
/* Objects do NOT push each other about. A writer puts them where they are wanted
   and may lay one over another on purpose -- a caption over a photograph, a shape
   over a diagram. It is the WORDS that keep out of an object's way, and only the
   words. (An earlier attempt made every object keep clear of every other, which
   took the page out of the writer's hands.) */
.eb-doc span.eb-anchor { position: relative; display: inline; }
.eb-doc .eb-anchor > * { position: absolute; margin: 0; }
/* Browsers leave background colours out of a printout unless the page insists. */
.eb-doc .eb-ink { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.eb-doc .eb-shadow { box-shadow: 0 1pt 4pt rgba(0, 0, 0, .28); }

/* changes under review. <ins> and <del> are what HTML has for this, so the marks
   are the document's own markup rather than a layer over it: the file can be sent
   to anyone and it reads as a marked-up draft in any browser. */
.eb-doc ins.eb-ins { text-decoration: underline; text-decoration-color: #1a7f37; color: #14683a; }
.eb-doc del.eb-del { text-decoration: line-through; text-decoration-color: #b42318; color: #9b2c1f; }
.eb-doc.eb-clean ins.eb-ins { text-decoration: none; color: inherit; }
.eb-doc.eb-clean del.eb-del { display: none; }

/* 縦書き -- the text runs down the page and the columns run right to left. Every
   rule that says "under" has to say "beside" instead: a heading's rule, a note's
   bar, a caption. The writing mode does the rest, because a browser has had this
   since 2016 and Japanese typesetting is what it was put there for. */
.eb-doc.eb-tategaki { writing-mode: vertical-rl; text-orientation: mixed; text-align: left; }
.eb-doc.eb-tategaki h2 { border-bottom: none; border-left: 1.5pt solid #222; padding-bottom: 0; padding-left: .2em; }
.eb-doc.eb-tategaki blockquote { border-left: none; border-top: 3pt solid #999; padding: 0 .4em 0 .4em; margin: 0 1em; }
.eb-doc.eb-tategaki .eb-note { border-left: none; border-top: 4pt solid #2563eb; padding: .9em .5em 0 .5em; margin: 0 1.1em; }
.eb-doc.eb-tategaki hr { border-top: none; border-left: .75pt solid #999; margin: 0 1.4em; }
.eb-doc.eb-tategaki table.eb-table { width: auto; height: 100%; }
.eb-doc.eb-tategaki .eb-pagebreak { break-before: page; }
.eb-doc.eb-tategaki ul, .eb-doc.eb-tategaki ol { padding-left: 0; padding-top: 1.7em; }
.eb-doc.eb-tategaki figure { margin: 0 1.2em; }
/* Latin runs and figures stay upright in a column of Japanese unless they are
   short enough to be turned on their side, which is what a reader expects. */
.eb-doc.eb-tategaki .eb-yoko { text-combine-upright: all; }

/* chapter numbers, counted by the file itself rather than typed into the text --
   so inserting a section renumbers everything after it without anyone touching it */
.eb-doc.eb-hn { counter-reset: ebh1 ebh2 ebh3; }
.eb-doc.eb-hn h1 { counter-increment: ebh1; counter-reset: ebh2 ebh3; }
.eb-doc.eb-hn h2 { counter-increment: ebh2; counter-reset: ebh3; }
.eb-doc.eb-hn h3 { counter-increment: ebh3; }
.eb-doc.eb-hn h1::before { content: counter(ebh1) ". "; }
.eb-doc.eb-hn h2::before { content: counter(ebh1) "." counter(ebh2) " "; }
.eb-doc.eb-hn h3::before { content: counter(ebh1) "." counter(ebh2) "." counter(ebh3) " "; }
.eb-doc.eb-hn-ja h1::before { content: "第" counter(ebh1) "章　"; }
.eb-doc.eb-hn-ja h2::before { content: "第" counter(ebh2) "節　"; }
.eb-doc.eb-hn-ja h3::before { content: "(" counter(ebh3) ") "; }
.eb-doc .eb-toc h1::before, .eb-doc .eb-toc h2::before, .eb-doc .eb-toc h3::before { content: none; }

/* a reading over a word: Japanese typesetting expects it at half size */
.eb-doc ruby { ruby-position: over; ruby-align: center; }
.eb-doc ruby rt { font-size: .5em; font-weight: normal; letter-spacing: 0; text-emphasis: none; }

/* notes — gathered at the end of the document and numbered by the file itself.
   A browser cannot put a note at the foot of the page it is cited on: nothing in
   CSS can move content between pages. Kept together at the end, they print. */
.eb-doc .eb-fnref { font-size: .72em; vertical-align: super; line-height: 0; }
.eb-doc .eb-fnref a { color: #14509b; text-decoration: none; }
.eb-doc .eb-notes { margin: 2em 0 0; border-top: .75pt solid #999; padding-top: .6em; font-size: .92em; }
.eb-doc .eb-notes .eb-notes-title { font-weight: 700; margin: 0 0 .4em; }
.eb-doc .eb-notes ol { margin: 0; padding-left: 1.8em; }
.eb-doc .eb-notes li { margin: .15em 0; }
.eb-doc .eb-notes li p { margin: 0; }

/* columns */
.eb-doc .eb-cols { column-gap: 8mm; column-rule: none; }
.eb-doc .eb-cols > *:first-child { margin-top: 0; }

/* a running header and footer, repeated on every printed page. On screen the
   file is a single flow and there are no pages to repeat them on, so they are
   only drawn when it is printed -- and the editor draws its own on each sheet. */
.eb-doc .eb-runhead, .eb-doc .eb-runfoot {
  display: none; font-size: .85em; color: #444;
}
.eb-doc .eb-runhead .l, .eb-doc .eb-runfoot .l,
.eb-doc .eb-runhead .c, .eb-doc .eb-runfoot .c,
.eb-doc .eb-runhead .r, .eb-doc .eb-runfoot .r { flex: 1 1 0; min-width: 0; }
.eb-doc .eb-runhead .c, .eb-doc .eb-runfoot .c { text-align: center; }
.eb-doc .eb-runhead .r, .eb-doc .eb-runfoot .r { text-align: right; }
@media print {
  .eb-doc .eb-runhead, .eb-doc .eb-runfoot { display: flex; gap: 1em; position: fixed; left: 0; right: 0; }
  .eb-doc .eb-runhead { top: -9mm; }
  .eb-doc .eb-runfoot { bottom: -9mm; }
}

/* mathematics — native MathML, no images and no renderer to install */
.eb-doc math { font-size: 1.06em; }
/* A formula does not reflow: it is set once, at the size it needs, and a box
   narrower than that would simply have the formula hanging out of it -- which is
   what a width dragged on to one used to do. The box is never smaller than the
   formula in it; to make a formula smaller, its handles change its size. */
.eb-doc .eb-math-block { display: block; margin: 1em 0; break-inside: avoid; min-width: max-content; }
:where(.eb-doc .eb-math-block) { text-align: center; }

/* A page from somewhere else, carried in a frame. It is the one thing in a
   document that is not really part of the file: it is fetched when the file is
   opened, and a printer cannot always be made to wait for it -- so on paper it
   leaves its address behind rather than a blank rectangle. */
.eb-doc .eb-embed { display: block; position: relative; width: 120mm; min-height: 70mm; margin: 1em 0; break-inside: avoid; }
.eb-doc .eb-embed > iframe { display: block; width: 100%; height: 100%; min-height: inherit; border: 0; background: #f4f5f7; }
.eb-doc .eb-embed:empty { border: .75pt dashed #98a2b3; }
@media print {
  .eb-doc .eb-embed > iframe { border: .75pt dashed #999; }
  .eb-doc .eb-embed::after {
    content: attr(data-url); position: absolute; left: 0; right: 0; bottom: .2em;
    font-size: 8pt; color: #555; text-align: center; word-break: break-all;
  }
}

/* an explicit page break: invisible on paper, a labelled line on screen */
.eb-doc .eb-pagebreak { break-before: page; height: 0; margin: 0; border: none; }
@media screen {
  .eb-doc .eb-pagebreak {
    height: 1.6em; margin: 1.2em 0; border-top: 1.5pt dashed #2563eb; position: relative;
  }
}
@media print {
  .eb-doc .eb-pagebreak { height: 0 !important; margin: 0 !important; border: none !important; }
  .eb-doc a { text-decoration: none; }
}
`;

  /** The stylesheet the editor canvas needs on top of DOC_CSS (never exported). */
  const EDITOR_CSS = `
.eb-paper .eb-pagebreak::after {
  content: attr(data-label); position: absolute; top: -.9em; left: 50%; transform: translateX(-50%);
  font-size: 9pt; color: #2563eb; background: #fff; padding: 0 .6em;
  font-family: -apple-system, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
}
.eb-paper p:empty::after, .eb-paper h1:empty::after, .eb-paper h2:empty::after,
.eb-paper h3:empty::after, .eb-paper h4:empty::after, .eb-paper li:empty::after { content: ""; display: inline-block; }
.eb-paper [contenteditable="false"] { user-select: none; }
.eb-paper figcaption:empty { display: block; min-height: 1.3em; }
.eb-paper figcaption:empty::before { content: attr(data-ph); color: #9aa3b0; font-size: .88em; }
.eb-paper table.eb-table td:focus, .eb-paper table.eb-table th:focus { outline: 2px solid #2563eb33; }
/* While it is being written, an embedded page is a labelled box: the address it
   will show, and nothing fetched from anyone. The page itself is in the file. */
.eb-paper .eb-embed {
  background: repeating-linear-gradient(45deg, #f4f5f7 0 8px, #eceef2 8px 16px);
  border: .75pt dashed #98a2b3;
}
.eb-paper .eb-embed::before {
  content: attr(data-url); position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center; padding: 1em; text-align: center;
  font-family: -apple-system, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
  font-size: 9pt; color: #475467; word-break: break-all;
}
/* Every object carries a box, not only the one being worked on: on a page laid
   out with things placed on it, a writer needs to see where each of them is
   before clicking. It is an outline, so it takes up no room and moves nothing,
   and it belongs to the editor -- the saved file has none of it. */
${objectRule('.eb-paper.boxed')} {
  outline: 1px dashed rgba(37, 99, 235, .40);
  outline-offset: 1px;
}
${textRule('.eb-paper.boxed')} {
  outline: 1px dashed rgba(37, 99, 235, .26);
  outline-offset: 1px;
}
/* Inside an object, the writing is that object's business and the object's box
   is already round it. Two boxes a millimetre apart say nothing extra. */
${insideObjects('.eb-paper.boxed')} {
  outline: none;
}
/* A rule or a line is a hair thick and its box would sit on top of it. */
.eb-paper.boxed hr, .eb-paper.boxed div.eb-sh-line, .eb-paper.boxed div.eb-sh-arrow { outline-offset: 3px; }
`;

  // ---- the document's own styles ---------------------------------------------
  // A word processor changes every heading at once by changing the style, not by
  // visiting each one. Here that is a small stylesheet the file carries with it:
  // one rule per kind of paragraph, written after the built-in sheet so it wins,
  // and still beaten by anything set on a single paragraph by hand. It also keeps
  // the markup clean -- a heading stays a plain <h2> with nothing written on it.
  const STYLE_TARGETS = [
    { key: 'p', sel: '.eb-doc p' },
    { key: 'h1', sel: '.eb-doc h1' },
    { key: 'h2', sel: '.eb-doc h2' },
    { key: 'h3', sel: '.eb-doc h3' },
    { key: 'h4', sel: '.eb-doc h4' },
    { key: 'li', sel: '.eb-doc li' },
    { key: 'blockquote', sel: '.eb-doc blockquote' },
    { key: 'pre', sel: '.eb-doc pre' },
    { key: 'cell', sel: '.eb-doc table.eb-table th, .eb-doc table.eb-table td' },
    { key: 'caption', sel: '.eb-doc figcaption' },
  ];
  const EMPTY_STYLE = { family: '', size: '', colour: '', bold: false, italic: false, align: '', lineHeight: '', before: '', after: '' };

  function normaliseStyles(raw) {
    const out = {};
    STYLE_TARGETS.forEach((t) => { out[t.key] = Object.assign({}, EMPTY_STYLE); });
    if (!raw || typeof raw !== 'object') { return out; }
    STYLE_TARGETS.forEach((t) => {
      const src = raw[t.key];
      if (!src || typeof src !== 'object') { return; }
      const to = out[t.key];
      if (typeof src.family === 'string' && /^[\w .+&'-]{0,64}$/.test(src.family)) { to.family = src.family.trim(); }
      // An empty box means "nothing said about it". Number('') is 0, so the check
      // has to come before the conversion or every style would be given a zero.
      const numOr = (x, lo, hi, step) => {
        if (x === '' || x == null) { return ''; }
        const n = Number(x);
        if (!Number.isFinite(n) || n < lo || n > hi) { return ''; }
        return Math.round(n * step) / step;
      };
      to.size = numOr(src.size, 4, 200, 2);
      if (typeof src.colour === 'string' && /^#[0-9a-f]{6}$/i.test(src.colour)) { to.colour = src.colour; }
      to.bold = !!src.bold;
      to.italic = !!src.italic;
      if (['left', 'center', 'right', 'justify'].indexOf(src.align) >= 0) { to.align = src.align; }
      to.lineHeight = numOr(src.lineHeight, 1, 4, 100);
      to.before = numOr(src.before, 0, 200, 2);
      to.after = numOr(src.after, 0, 200, 2);
    });
    return out;
  }
  function styleHasAnything(v) {
    return !!(v && (v.family || v.size !== '' || v.colour || v.bold || v.italic || v.align || v.lineHeight !== '' || v.before !== '' || v.after !== ''));
  }
  function anyStyles(styles) { return STYLE_TARGETS.some((t) => styleHasAnything(styles[t.key])); }
  /** The stylesheet those settings come to. */
  function stylesCss(styles, prefix) {
    const out = [];
    STYLE_TARGETS.forEach((t) => {
      const v = styles[t.key];
      if (!styleHasAnything(v)) { return; }
      const decls = [];
      if (v.family) { decls.push('font-family: ' + fontStack(v.family, 'sans')); }
      if (v.size !== '') { decls.push('font-size: ' + v.size + 'pt'); }
      if (v.colour) { decls.push('color: ' + v.colour); }
      if (v.bold) { decls.push('font-weight: 700'); }
      if (v.italic) { decls.push('font-style: italic'); }
      if (v.align) { decls.push('text-align: ' + v.align); }
      if (v.lineHeight !== '') { decls.push('line-height: ' + v.lineHeight); }
      if (v.before !== '') { decls.push('margin-top: ' + v.before + 'pt'); }
      if (v.after !== '') { decls.push('margin-bottom: ' + v.after + 'pt'); }
      // In the editor the app's own stylesheet already names the headings with the
      // app's id in front of them, so the document's own rules need the same reach
      // or they would lose to it -- and the editor would not show what the file does.
      const sel = prefix ? t.sel.split(',').map((x) => prefix + x.trim()).join(', ') : t.sel;
      out.push(sel + ' { ' + decls.join('; ') + '; }');
    });
    return out.join('\n');
  }
  /** The families those styles name, so the file asks for them too. */
  function stylesFamilies(styles) {
    return STYLE_TARGETS.map((t) => styles[t.key] && styles[t.key].family).filter(Boolean);
  }

  // ---- sanitising -----------------------------------------------------------
  // A document is a file the user (or someone they shared with) may have edited by
  // hand, and it gets put into the page with innerHTML. Anything that could run is
  // removed on the way in; the structural markup is left exactly as written.
  const HTML_TAGS = new Set(['P', 'BR', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'INS', 'MARK', 'CODE', 'PRE', 'SUB', 'SUP', 'SMALL', 'A',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'COLGROUP', 'COL',
    'IMG', 'FIGURE', 'FIGCAPTION', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'DL', 'DT', 'DD', 'RUBY', 'RT', 'RP', 'WBR', 'ABBR', 'TIME', 'BDI', 'BDO']);
  const MATHML_TAGS = new Set(['math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
    'munderover', 'mmultiscripts', 'mprescripts', 'mstyle', 'mpadded', 'mphantom', 'merror', 'menclose', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'maction', 'semantics', 'annotation', 'annotation-xml']);
  const ATTR_OK = new Set(['class', 'style', 'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'span', 'start', 'type', 'lang', 'dir', 'id', 'datetime', 'data-label', 'data-url', 'data-wrap', 'data-wrap-gap', 'display', 'mathvariant', 'stretchy', 'fence', 'separator', 'accent', 'notation', 'columnalign', 'rowalign', 'scope']);
  const STYLE_OK = /^(color|background-color|font-weight|font-style|font-size|font-family|text-decoration|text-decoration-line|text-align|text-emphasis|line-height|margin|margin-left|margin-right|margin-top|margin-bottom|padding|text-indent|padding-left|padding-right|padding-top|padding-bottom|width|height|max-width|border|border-top|border-right|border-bottom|border-left|border-radius|border-color|border-width|border-style|border-collapse|z-index|vertical-align|letter-spacing|writing-mode|float|clear|break-before|break-after|break-inside|page-break-before|page-break-after|page-break-inside|column-count|column-gap|column-rule|orphans|widows|text-transform|font-variant|white-space|list-style-type|table-layout|position|left|top|right|bottom|min-width|min-height|max-height|box-sizing|overflow|overflow-x|overflow-y|aspect-ratio|object-fit|object-position|orphans|widows|opacity|transform|transform-origin|box-shadow|mix-blend-mode|shape-outside|shape-margin|background|background-image|background-size|background-repeat|background-position|background-clip|text-shadow|paint-order|-webkit-text-stroke|-webkit-text-stroke-width|-webkit-text-stroke-color|-webkit-background-clip|-webkit-text-fill-color)$/;

  /**
   * Split a style attribute into its declarations. Not on every semicolon: a
   * picture the document carries is written url("data:image/png;base64,…"), and
   * cutting that at its semicolon threw the picture away and left half a URI.
   */
  function styleDecls(value) {
    const out = [];
    let depth = 0; let quote = ''; let start = 0;
    const text = String(value == null ? '' : value);
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) { if (ch === quote && text[i - 1] !== '\\') { quote = ''; } continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') { depth += 1; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
      if (ch === ';' && !depth) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
  }
  function cleanStyle(value) {
    const kept = [];
    styleDecls(value).forEach((decl) => {
      const i = decl.indexOf(':');
      if (i < 0) { return; }
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (!STYLE_OK.test(prop)) { return; }
      // A picture the document carries is written into the document: url(data:image/…)
      // and nothing else. Anything that would send the reader's browser off to
      // fetch something is dropped, which is the whole of the rule that was here
      // before -- it just could not tell the two apart.
      if (/expression|javascript:/i.test(val)) { return; }
      if (/url\s*\(/i.test(val) && !/^url\(\s*["']?data:image\/[a-z+.-]+[,;]/i.test(val)) { return; }
      // A document may lay its own frames out; it may not pin anything to the
      // window, which in the editor means over the app's own chrome.
      if (prop === 'position' && !/^(static|relative|absolute)$/i.test(val)) { return; }
      kept.push(prop + ': ' + val);
    });
    return kept.join('; ');
  }

  /**
   * What the document cannot hold, recorded rather than silently thrown away, so
   * that the writer can be asked what to do with it. Everything here is something
   * a browser renders by running or fetching something else -- a frame, a film, a
   * canvas -- which is the one kind of thing a printed page cannot be made of.
   */
  const FOREIGN = /^(IFRAME|OBJECT|EMBED|VIDEO|AUDIO|CANVAS|SVG)$/;
  function foreignUrl(el) {
    const src = el.getAttribute('src') || el.getAttribute('data') || '';
    if (src) { return src; }
    const kid = el.querySelector && el.querySelector('source[src]');
    return kid ? kid.getAttribute('src') : '';
  }
  function sanitiseInto(container, opts) {
    const found = (opts && opts.found) || null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    const drop = [];
    const unwrap = [];
    let el = walker.nextNode();
    while (el) {
      const isMath = el.namespaceURI === 'http://www.w3.org/1998/Math/MathML';
      const name = isMath ? el.localName : el.nodeName;
      // A frame never lives in the canvas: the box keeps the address, and the
      // frame is made when the file is written. So an iframe arriving from
      // anywhere -- the clipboard, a file being opened -- is dropped here, and
      // only the box that was agreed to survives.
      if (isMath ? !MATHML_TAGS.has(name) : !HTML_TAGS.has(name)) {
        // Scripts and frames go entirely; anything else merely loses its tag.
        const inOurBox = el.parentNode && el.parentNode.classList && el.parentNode.classList.contains('eb-embed');
        if (found && !inOurBox && FOREIGN.test(el.nodeName.toUpperCase())) {
          found.push({ kind: el.nodeName.toLowerCase(), url: foreignUrl(el) });
        }
        (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|BASE|FORM|INPUT|BUTTON|SELECT|TEXTAREA|VIDEO|AUDIO|CANVAS|SVG)$/.test(el.nodeName) ? drop : unwrap).push(el);
      } else {
        Array.from(el.attributes).forEach((a) => {
          const an = a.name.toLowerCase();
          if (an.startsWith('on') || !ATTR_OK.has(an)) { el.removeAttribute(a.name); return; }
          if (an === 'style') {
            const v = cleanStyle(a.value);
            if (v) { el.setAttribute('style', v); } else { el.removeAttribute('style'); }
          }
          if ((an === 'href' || an === 'src') && /^\s*(javascript|data:text\/html|vbscript)/i.test(a.value)) {
            el.removeAttribute(a.name);
          }
        });
        el.removeAttribute('contenteditable');
      }
      el = walker.nextNode();
    }
    drop.forEach((n) => n.remove());
    unwrap.forEach((n) => {
      const parent = n.parentNode;
      if (!parent) { return; }
      while (n.firstChild) { parent.insertBefore(n.firstChild, n); }
      parent.removeChild(n);
    });
    return container;
  }

  function sanitiseHtml(html) {
    const box = document.createElement('div');
    box.innerHTML = String(html == null ? '' : html);
    sanitiseInto(box);
    return box.innerHTML;
  }

  // ---- the file ---------------------------------------------------------------
  const APP_VERSION = (document.getElementById('editbase-root') || {}).dataset ?
    (document.getElementById('editbase-root').dataset.version || '') : '';

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /** Zero-width spaces are a caret trick of the editor's, not part of the text. */
  function stripEditorArtefacts(html) {
    return String(html).replace(/\u200B/g, '');
  }

  /**
   * The whole artefact: one file, styles inside it, no scripts, nothing to install.
   * This exact string is what gets written to Files and what gets printed.
   */
  /** The header or the footer as three slots, or nothing at all if it is empty. */
  function runningBlock(cls, slots) {
    const s = slots || {};
    if (!(s.l || s.c || s.r)) { return ''; }
    return '<div class="' + cls + '" aria-hidden="true">'
      + '<span class="l">' + escapeAttr(s.l || '') + '</span>'
      + '<span class="c">' + escapeAttr(s.c || '') + '</span>'
      + '<span class="r">' + escapeAttr(s.r || '') + '</span>'
      + '</div>\n';
  }

  /** The classes the document itself wears: the numbering scheme, if any. */
  function docClasses(paper, clean) {
    const out = ['eb-doc'];
    // Printing while the marks are hidden should print what is on the screen.
    if (clean) { out.push('eb-clean'); }
    if (paper.headingNumbers === 'decimal') { out.push('eb-hn'); }
    if (paper.headingNumbers === 'japanese') { out.push('eb-hn', 'eb-hn-ja'); }
    if (paper.vertical) { out.push('eb-tategaki'); }
    return out.join(' ');
  }

  function buildHtml(doc) {
    const paper = normalisePaper(doc.paper);
    const styles = normaliseStyles(doc.styles);
    const lang = doc.lang || (document.documentElement.lang || 'ja');
    const body = stripEditorArtefacts(doc.body || '');
    const fonts = resolveFonts(paper, lang);
    const url = fontsUrl([fonts.body, fonts.head, fonts.mono].concat(familiesInBody(body)).concat(stylesFamilies(styles)));
    const s = sheet(paper);
    // On screen the file should read as a sheet of paper, the way the editor
    // draws it -- a white page on a grey ground -- not as a web page that happens
    // to be narrow. Print takes none of this: paper is already white.
    const art = pageArt(paper);
    const page = 'html { background: #ffffff; }\n'
      + '@media screen { html { background: #f1f2f4; -webkit-print-color-adjust: exact; }\n'
      + '  body.eb-doc { background: #ffffff; box-shadow: 0 1px 8px rgba(0, 0, 0, .18); }\n'
      + '  @media (prefers-color-scheme: dark) { html { background: #2b2d31; } } }\n'
      + 'body.eb-doc { margin: 0; font-size: ' + paper.fontSize + 'pt; line-height: ' + paper.lineHeight + '; }\n'
      + '.eb-doc { --eb-font-body: ' + fontStack(fonts.body, 'serif') + ';'
      + ' --eb-font-head: ' + fontStack(fonts.head, 'sans') + ';'
      + ' --eb-font-mono: ' + fontStack(fonts.mono, 'mono') + '; }\n'
      // On screen the body IS the sheet, exactly as the editor's page is: the
      // paper's width, with the margins as padding. Setting the margins as CSS
      // margins instead left the column 4mm narrower and let the first
      // paragraph's margin collapse away through the top edge, so every line
      // below it sat 3.3mm higher in the file than in the editor.
      // …and a sheet is a whole sheet, not a strip the height of its words: a page
      // with a frame or a colour on it has to show the paper it is printed on.
      + '@media screen { body.eb-doc { margin: 0 auto; max-width: 100%;'
      + (paper.vertical ? ' height: ' + s.h + 'mm; min-width: ' + s.w + 'mm;' : ' width: ' + s.w + 'mm; min-height: ' + s.h + 'mm;')
      + ' padding: ' + paper.margin.top + 'mm ' + paper.margin.right + 'mm '
      + paper.margin.bottom + 'mm ' + paper.margin.left + 'mm; } }'
      // On screen the body is the sheet, so the same picture is laid on it, one
      // sheet's worth at a time. In print it is on the page box instead.
      + (art.any ? '\n/* the paper itself */\n'
        // The white the page is normally printed on has to come off, or it is
        // painted over the page box and the paint only shows in the margins.
        + '@media print { html { background: transparent; } }\n'
        + '@media screen { body.eb-doc { background-image: url("' + art.url + '");'
        + ' background-size: ' + s.w + 'mm ' + s.h + 'mm; background-repeat: repeat-y;'
        + ' background-position: center top; } }\n' : '');
    // The typeface travels with the document as a stylesheet link, so the file looks
    // the same on a machine that has none of these fonts installed. It is the only
    // thing in the file that points anywhere outside it, and it is left out entirely
    // when every family in use is a local one.
    const fontLinks = url
      ? '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
        + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        + '<link rel="stylesheet" href="' + escapeAttr(url) + '">\n'
      : '';
    return '<!DOCTYPE html>\n'
      + '<html lang="' + escapeAttr(lang) + '">\n<head>\n'
      + '<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<meta name="generator" content="EditBase ' + escapeAttr(APP_VERSION) + '">\n'
      + '<meta name="editbase-paper" content="' + escapeAttr(JSON.stringify(paper)) + '">\n'
      + (anyStyles(styles) ? '<meta name="editbase-styles" content="' + escapeAttr(JSON.stringify(styles)) + '">\n' : '')
      + '<title>' + escapeAttr(doc.title || 'Document') + '</title>\n'
      + fontLinks
      + '<style>\n' + pageRule(paper) + '\n' + page + '\n' + DOC_CSS
      + (anyStyles(styles) ? '\n/* the styles of this document */\n' + stylesCss(styles) + '\n' : '')
      + '</style>\n'
      + '</head>\n<body class="' + docClasses(paper, doc.clean) + '">\n'
      // The writing comes first and nothing else does. The running header, the
      // footer and the page's paint are all placed by CSS and could sit anywhere,
      // but a document whose first element is not its first paragraph loses the
      // rule that takes the space off the top of the page -- and every line in
      // the file then sat 42.5px lower than the same line in the editor.
      + body + '\n'
      + runningBlock('eb-runhead', paper.header)
      + runningBlock('eb-runfoot', paper.footer)
      + '</body>\n</html>\n';
  }

  /** Read a file back. Anything not written by EditBase still opens; it just
   *  arrives without paper settings, and saving it will re-write its stylesheet. */
  function parseHtml(text) {
    const dom = new DOMParser().parseFromString(String(text || ''), 'text/html');
    const meta = dom.querySelector('meta[name="editbase-paper"]');
    const styleMeta = dom.querySelector('meta[name="editbase-styles"]');
    const gen = dom.querySelector('meta[name="generator"]');
    let paper = null;
    if (meta) { try { paper = JSON.parse(meta.getAttribute('content') || '{}'); } catch (e) { paper = null; } }
    const body = dom.body || dom.createElement('body');
    // The running header and footer are written out of the paper setup, so they
    // are not part of the text and must not come back into the canvas as blocks.
    Array.from(body.querySelectorAll('.eb-runhead, .eb-runfoot, .eb-pagedeco')).forEach((n) => n.remove());
    sanitiseInto(body);
    toObjects(body);
    return {
      hasHeader: !!body.querySelector(':scope > header.eb-header'),
      hasFooter: !!body.querySelector(':scope > footer.eb-footer'),
      title: (dom.title || '').trim(),
      lang: dom.documentElement.getAttribute('lang') || 'ja',
      paper: normalisePaper(paper),
      styles: normaliseStyles((function () {
        try { return JSON.parse((styleMeta && styleMeta.getAttribute('content')) || '{}'); } catch (e) { return {}; }
      }())),
      body: body.innerHTML.trim(),
      foreign: !(gen && /^EditBase\b/.test(gen.getAttribute('content') || '')),
    };
  }

  // ---- editing engine ---------------------------------------------------------
  // execCommand is deliberately not used: it is deprecated, its output differs
  // between browsers, and it leaves <font> and nested <span> litter in a file that
  // is meant to stay readable. Everything below works on Ranges and produces the
  // same markup everywhere.
  let canvasEl = null;
  // The selection a dialog interrupted, so that applying it lands where it was.
  let ctxRange = null;
  // The object the bounding box is drawn round. It is not Vue state: the canvas is
  // plain DOM, and this is a node in it.
  let frameEl = null;
  // Whether the paste about to arrive was asked for with Shift held down.
  let pastePlain = false;
  let wrapTimer = null;
  let layerEls = [];
  let wordsRange = null;
  let wordsWas = null;
  let framePinned = false;
  let frameDrag = null;
  let frameBox = null;
  // The run of text the box is round when no object is selected: a 文節, or the
  // selection if there is one. It is a Range, not Vue state, for the same reason.
  let textRange = null;
  let textBox = null;
  // After a command that acts on the whole paragraph, the box belongs round the
  // paragraph: that is what was just acted on, and unlike a run of words it does
  // not move when the paragraph is aligned. Typing or clicking puts it back on
  // the 文節 the caret is standing in.
  // When the menu opened, so that the tap that opened it cannot also close it.
  let ctxAt = 0;
  function canvas() { return canvasEl; }

  const INLINE_SPECS = {
    bold: { tag: 'STRONG' },
    italic: { tag: 'EM' },
    underline: { tag: 'U' },
    strike: { tag: 'S' },
    code: { tag: 'CODE' },
    sup: { tag: 'SUP' },
    sub: { tag: 'SUB' },
    kenten: { tag: 'SPAN', cls: 'eb-kenten' },
    mark: { tag: 'MARK' },
    'mark-g': { tag: 'MARK', cls: 'eb-hl-g' },
    'mark-b': { tag: 'MARK', cls: 'eb-hl-b' },
    'mark-p': { tag: 'MARK', cls: 'eb-hl-p' },
    'mark-r': { tag: 'MARK', cls: 'eb-hl-r' },
  };

  function inCanvas(node) {
    const c = canvas();
    return !!(c && node && (c === node || c.contains(node)));
  }
  function getRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { return null; }
    const r = sel.getRangeAt(0);
    return inCanvas(r.commonAncestorContainer) ? r : null;
  }
  function selectRange(r) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function rangeHolds(range, node) {
    const nr = document.createRange();
    nr.selectNodeContents(node);
    return range.compareBoundaryPoints(Range.START_TO_START, nr) <= 0
      && range.compareBoundaryPoints(Range.END_TO_END, nr) >= 0;
  }

  /**
   * Every text node the range covers, with the boundary nodes split first so a
   * partially selected word becomes a node of its own. This is what lets the
   * wrappers below be exact instead of approximate.
   */
  function textNodesInRange(range) {
    // Split the end first: splitting the start would move the end boundary.
    if (range.endContainer.nodeType === 3 && range.endOffset > 0 && range.endOffset < range.endContainer.data.length) {
      range.endContainer.splitText(range.endOffset);
    }
    if (range.startContainer.nodeType === 3 && range.startOffset > 0 && range.startOffset < range.startContainer.data.length) {
      const startNode = range.startContainer;
      const off = range.startOffset;
      const sameNode = range.endContainer === startNode;
      const endOff = range.endOffset;
      const tail = startNode.splitText(off);
      // splitText only moves boundaries *past* the split point, so the range
      // start still points at the first half; move it onto the tail by hand.
      range.setStart(tail, 0);
      if (sameNode) { range.setEnd(tail, Math.max(0, endOff - off)); }
    }
    const out = [];
    let root = range.commonAncestorContainer;
    if (root.nodeType === 3) { root = root.parentNode; }
    if (!inCanvas(root)) { root = canvas(); }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n = walker.nextNode();
    while (n) {
      if (n.data.length && inCanvas(n) && rangeHolds(range, n)) { out.push(n); }
      n = walker.nextNode();
    }
    if (!out.length && range.startContainer.nodeType === 3 && range.startContainer.data.length) {
      out.push(range.startContainer);
    }
    return out;
  }

  function makeInline(spec) {
    const el = document.createElement(spec.tag);
    if (spec.cls) { el.className = spec.cls; }
    if (spec.style) { Object.keys(spec.style).forEach((k) => { el.style[k] = spec.style[k]; }); }
    return el;
  }
  function matchesSpec(el, spec) {
    if (!el || el.nodeType !== 1 || el.nodeName !== spec.tag) { return false; }
    if (spec.cls && !el.classList.contains(spec.cls)) { return false; }
    if (!spec.cls && spec.tag === 'MARK' && el.className) { return false; }
    if (spec.style) {
      return Object.keys(spec.style).every((k) => el.style[k] === spec.style[k]);
    }
    return true;
  }
  function ancestorMatching(node, spec) {
    let n = node.parentNode;
    while (n && n !== canvas()) {
      if (matchesSpec(n, spec)) { return n; }
      n = n.parentNode;
    }
    return null;
  }
  function ancestorWithStyle(node, prop) {
    let n = node.parentNode;
    while (n && n !== canvas()) {
      if (n.nodeType === 1 && n.style && n.style[prop]) { return n; }
      n = n.parentNode;
    }
    return null;
  }

  /**
   * Take `node` out of `wrapper` without disturbing the rest of it: whatever came
   * before and after stays wrapped, in clones on either side.
   */
  function splitOut(node, wrapper) {
    const parent = wrapper.parentNode;
    if (!parent) { return; }
    const before = document.createRange();
    before.setStart(wrapper, 0);
    before.setEndBefore(node);
    if (!before.collapsed) {
      const clone = wrapper.cloneNode(false);
      clone.appendChild(before.extractContents());
      if (clone.textContent.length) { parent.insertBefore(clone, wrapper); }
    }
    const after = document.createRange();
    after.setStartAfter(node);
    after.setEnd(wrapper, wrapper.childNodes.length);
    if (!after.collapsed) {
      const clone = wrapper.cloneNode(false);
      clone.appendChild(after.extractContents());
      if (clone.textContent.length) { parent.insertBefore(clone, wrapper.nextSibling); }
    }
    while (wrapper.firstChild) { parent.insertBefore(wrapper.firstChild, wrapper); }
    parent.removeChild(wrapper);
  }

  /** Bold, italic, highlight … applied to the selection, or removed if all of it already has it. */
  function toggleInline(key) {
    const spec = INLINE_SPECS[key];
    const range = getRange();
    if (!spec || !range) { return; }
    if (range.collapsed) {
      const word = wordRangeAt(range);
      if (word) { selectRange(word); } else { return caretPlaceholder(spec); }
    }
    const r = getRange();
    const nodes = textNodesInRange(r);
    if (!nodes.length) { return; }
    const allOn = nodes.every((n) => ancestorMatching(n, spec));
    nodes.forEach((n) => {
      const anc = ancestorMatching(n, spec);
      if (allOn) {
        if (anc) { splitOut(n, anc); }
      } else if (!anc) {
        const el = makeInline(spec);
        n.parentNode.insertBefore(el, n);
        el.appendChild(n);
      }
    });
    reselectNodes(nodes);
  }

  // ---- links ---------------------------------------------------------------------
  function linkAt(node) {
    let n = node;
    if (!n) { const r = getRange(); n = r ? r.startContainer : null; }
    if (n && n.nodeType === 3) { n = n.parentNode; }
    while (n && n !== canvas()) {
      if (n.nodeName === 'A') { return n; }
      n = n.parentNode;
    }
    return null;
  }

  /**
   * What a person types in the address box is usually a bare host, so complete it;
   * anything a browser must not follow from a saved file is refused outright.
   */
  function tidyUrl(url) {
    const raw = String(url == null ? '' : url).trim();
    if (!raw) { return ''; }
    if (/^\s*(javascript|vbscript|data):/i.test(raw)) { return ''; }
    if (/^([a-z][a-z0-9+.-]*:|#|\/|\.\/|\.\.\/)/i.test(raw)) { return raw; }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) { return 'mailto:' + raw; }
    return 'https://' + raw;
  }

  function applyLink(url, text) {
    const href = tidyUrl(url);
    if (!href) { return false; }
    const existing = linkAt();
    if (existing) {
      existing.setAttribute('href', href);
      if (text && text !== existing.textContent) { existing.textContent = text; }
      return true;
    }
    const range = getRange();
    if (!range) { return false; }
    if (range.collapsed) {
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.textContent = text || href;
      range.insertNode(a);
      const after = document.createRange();
      after.setStartAfter(a);
      after.collapse(true);
      selectRange(after);
      return true;
    }
    const nodes = textNodesInRange(range);
    if (!nodes.length) { return false; }
    if (text && nodes.length === 1 && text !== nodes[0].data) { nodes[0].data = text; }
    nodes.forEach((n) => {
      if (ancestorMatching(n, { tag: 'A' })) { return; }
      const a = document.createElement('a');
      a.setAttribute('href', href);
      n.parentNode.insertBefore(a, n);
      a.appendChild(n);
    });
    reselectNodes(nodes);
    return true;
  }

  function removeLink() {
    const a = linkAt();
    if (!a) { return false; }
    const parent = a.parentNode;
    while (a.firstChild) { parent.insertBefore(a.firstChild, a); }
    parent.removeChild(a);
    parent.normalize();
    return true;
  }

  /** Nothing is selected: start a wrapper and leave the caret inside it. */
  function caretPlaceholder(spec) {
    const range = getRange();
    if (!range) { return; }
    const el = makeInline(spec);
    el.appendChild(document.createTextNode('​'));
    range.insertNode(el);
    const r = document.createRange();
    r.setStart(el.firstChild, 1);
    r.collapse(true);
    selectRange(r);
  }

  function wordRangeAt(range) {
    const node = range.startContainer;
    if (node.nodeType !== 3) { return null; }
    const text = node.data;
    let a = range.startOffset;
    let b = range.startOffset;
    const isWord = (ch) => ch && !/\s/.test(ch);
    while (a > 0 && isWord(text[a - 1])) { a--; }
    while (b < text.length && isWord(text[b])) { b++; }
    if (a === b) { return null; }
    const r = document.createRange();
    r.setStart(node, a);
    r.setEnd(node, b);
    return r;
  }

  function reselectNodes(nodes) {
    const live = nodes.filter((n) => inCanvas(n));
    if (!live.length) { return; }
    const r = document.createRange();
    r.setStart(live[0], 0);
    r.setEnd(live[live.length - 1], live[live.length - 1].data.length);
    selectRange(r);
  }

  /** Text colour and any other inline style value, set rather than toggled. */
  function applyInlineStyle(prop, value) {
    const range = getRange();
    if (!range) { return; }
    if (range.collapsed) {
      const word = wordRangeAt(range);
      if (!word) { return caretPlaceholder({ tag: 'SPAN', style: { [prop]: value } }); }
      selectRange(word);
    }
    const nodes = textNodesInRange(getRange());
    nodes.forEach((n) => {
      const owner = ancestorWithStyle(n, prop);
      if (owner && owner.childNodes.length === 1 && owner.firstChild === n && owner.nodeName === 'SPAN') {
        if (value) { owner.style[prop] = value; } else { owner.style[prop] = ''; }
        if (!owner.getAttribute('style')) { splitOut(n, owner); }
        return;
      }
      if (owner) { splitOut(n, owner); }
      if (!value) { return; }
      const el = document.createElement('span');
      el.style[prop] = value;
      n.parentNode.insertBefore(el, n);
      el.appendChild(n);
    });
    reselectNodes(nodes);
  }

  /**
   * What is written on a chosen run of words, read back off it. Where the run is
   * not all of one mind -- half of it bold, say -- the answer is left empty, and
   * an empty answer is one the dialogue will not write back.
   */
  const RUN_PROPS = ['fontFamily', 'fontSize', 'color', 'backgroundColor', 'fontWeight',
    'fontStyle', 'textDecorationLine', 'letterSpacing', 'verticalAlign',
    'webkitTextStrokeWidth', 'webkitTextStrokeColor', 'textShadow'];
  function readRun() {
    const range = getRange();
    if (!range || range.collapsed) { return null; }
    const nodes = textNodesInRange(range).filter((n) => n.data && n.data.trim());
    if (!nodes.length) { return null; }
    const seen = {};
    nodes.forEach((n) => {
      const cs = window.getComputedStyle(n.parentNode);
      RUN_PROPS.forEach((prop) => {
        const v = cs[prop] == null ? '' : String(cs[prop]);
        if (!(prop in seen)) { seen[prop] = v; } else if (seen[prop] !== v) { seen[prop] = null; }
      });
    });
    const one = (prop) => (seen[prop] == null ? '' : seen[prop]);
    const shadow = one('textShadow');
    const parts = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(shadow || '');
    const pt = (px) => Math.round((parseFloat(px) || 0) * 72 / 96 * 10) / 10;
    return {
      family: one('fontFamily').replace(/^["\']|["\']$/g, '').split(',')[0].trim(),
      size: one('fontSize') ? Math.round(parseFloat(one('fontSize')) * 72 / 96 * 10) / 10 : '',
      colour: rgbToHex(one('color')) || '#000000',
      fill: rgbToHex(one('backgroundColor')) || '',
      bold: /^(bold|[6-9]00)$/.test(one('fontWeight')),
      italic: one('fontStyle') === 'italic',
      underline: /underline/.test(one('textDecorationLine')),
      strike: /line-through/.test(one('textDecorationLine')),
      spacing: one('letterSpacing') && one('letterSpacing') !== 'normal' ? pt(one('letterSpacing')) : '',
      raise: one('verticalAlign') === 'super' ? 'super' : (one('verticalAlign') === 'sub' ? 'sub' : ''),
      strokeWidth: one('webkitTextStrokeWidth') ? Math.round(parseFloat(one('webkitTextStrokeWidth')) * 25.4 / 96 * 100) / 100 : '',
      strokeColour: rgbToHex(one('webkitTextStrokeColor')) || '#000000',
      shadow: !!(shadow && shadow !== 'none'),
      shadowX: parts ? pt(parts[1]) : 1,
      shadowY: parts ? pt(parts[2]) : 1,
      shadowBlur: parts ? pt(parts[3]) : 1.5,
      shadowColour: rgbToHex(shadow) || '#808080',
    };
  }
  /** Write the dialogue back on to the chosen words, one property at a time. */
  function writeRun(v, was) {
    const changed = (key) => was && JSON.stringify(v[key]) !== JSON.stringify(was[key]);
    const set = (prop, value) => applyInlineStyle(prop, value);
    if (changed('family')) { set('fontFamily', v.family ? "'" + v.family + "'" : ''); }
    if (changed('size')) { set('fontSize', v.size ? v.size + 'pt' : ''); }
    if (changed('colour')) { set('color', v.colour || ''); }
    if (changed('fill')) { set('backgroundColor', v.fill || ''); }
    if (changed('bold')) { set('fontWeight', v.bold ? '700' : ''); }
    if (changed('italic')) { set('fontStyle', v.italic ? 'italic' : ''); }
    if (changed('underline') || changed('strike')) {
      const line = [v.underline ? 'underline' : '', v.strike ? 'line-through' : ''].filter(Boolean).join(' ');
      set('textDecorationLine', line);
    }
    if (changed('spacing')) { set('letterSpacing', v.spacing === '' ? '' : v.spacing + 'pt'); }
    if (changed('raise')) { set('verticalAlign', v.raise || ''); }
    if (changed('strokeWidth') || changed('strokeColour')) {
      set('webkitTextStroke', v.strokeWidth ? v.strokeWidth + 'mm ' + (v.strokeColour || '#000000') : '');
      set('paintOrder', v.strokeWidth ? 'stroke fill' : '');
    }
    if (changed('shadow') || changed('shadowX') || changed('shadowY') || changed('shadowBlur') || changed('shadowColour')) {
      set('textShadow', v.shadow
        ? (v.shadowX || 0) + 'pt ' + (v.shadowY || 0) + 'pt ' + (v.shadowBlur || 0) + 'pt ' + (v.shadowColour || '#808080')
        : '');
    }
  }

  // ---- size and typeface -----------------------------------------------------------
  // LibreOffice's two toolbar boxes act on what is selected -- and with nothing
  // selected, on the block the caret stands in. The document's own defaults are a
  // different thing and live in the paper setup, which is where a style belongs.
  // Changing the size of a word by changing the whole document is no use to anyone.
  const FONT_SIZES = [8, 9, 9.5, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
  const dashed = (prop) => prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

  /** A span that has lost its last style is nothing but litter in the file. */
  function unwrapBareSpan(el) {
    if (!el || el.nodeName !== 'SPAN' || el.attributes.length || !el.parentNode) { return; }
    const parent = el.parentNode;
    while (el.firstChild) { parent.insertBefore(el.firstChild, el); }
    parent.removeChild(el);
  }

  function styleTextOrBlock(prop, value) {
    const range = getRange();
    if (!range) { return; }
    if (!range.collapsed) { applyInlineStyle(prop, value); return; }
    const name = dashed(prop);
    selectedBlocks(true).forEach((block) => {
      // Setting it on the block says nothing while the words inside carry their own.
      Array.from(block.querySelectorAll('[style]')).forEach((el) => {
        if (!el.style.getPropertyValue(name)) { return; }
        el.style.removeProperty(name);
        if (!el.getAttribute('style')) { el.removeAttribute('style'); unwrapBareSpan(el); }
      });
      if (value) { block.style.setProperty(name, value); } else { block.style.removeProperty(name); }
      if (!block.getAttribute('style')) { block.removeAttribute('style'); }
    });
  }

  /**
   * What the text under the caret actually prints at, in points -- read off the
   * layout, so a heading reports the size its style gives it rather than the
   * document's default. The screen view draws the canvas at a reading size, and
   * the ratio between the two takes the number back to what the paper will print.
   */
  function sizeAt(paperPt) {
    const c = canvas();
    const range = getRange();
    if (!c || !range || !window.getComputedStyle) { return null; }
    let n = range.startContainer;
    if (n && n.nodeType === 3) { n = n.parentNode; }
    if (!n || n.nodeType !== 1 || !inCanvas(n)) { return null; }
    const canvasPx = parseFloat(window.getComputedStyle(c).fontSize) || 0;
    const px = parseFloat(window.getComputedStyle(n).fontSize) || 0;
    if (!canvasPx || !px || !paperPt) { return null; }
    const scale = canvasPx / (paperPt * 4 / 3);
    return Math.round(px * 0.75 / (scale || 1) * 2) / 2;
  }

  /** The family the text under the caret is actually set in. */
  function familyAt() {
    const range = getRange();
    if (!range || !window.getComputedStyle) { return ''; }
    let n = range.startContainer;
    if (n && n.nodeType === 3) { n = n.parentNode; }
    if (!n || n.nodeType !== 1 || !inCanvas(n)) { return ''; }
    const first = String(window.getComputedStyle(n).fontFamily || '').split(',')[0].trim();
    return first.replace(/^["']|["']$/g, '');
  }

  /**
   * The families a document names in its own markup. A typeface put on a word has
   * to travel with the file just as the document's own three do, or the file opens
   * somewhere else in whatever that machine happens to have.
   */
  function familiesInBody(html) {
    const out = [];
    String(html == null ? '' : html).replace(/font-family:\s*(?:"|&quot;)([^"&]+)(?:"|&quot;)/g, (m, name) => {
      const n = String(name).trim();
      if (n && out.indexOf(n) < 0) { out.push(n); }
      return m;
    });
    return out;
  }

  /** Take the highlight off, whichever colour it happens to be. */
  function clearMarks() {
    const range = getRange();
    if (!range || range.collapsed) { return; }
    textNodesInRange(range).forEach((n) => {
      let mark = null;
      let el = n.parentNode;
      while (el && el !== canvas()) {
        if (el.nodeName === 'MARK') { mark = el; }
        el = el.parentNode;
      }
      if (mark) { splitOut(n, mark); }
    });
  }

  /** Strip every inline wrapper from the selection, leaving the text alone. */
  function clearFormatting() {
    const range = getRange();
    if (!range || range.collapsed) { return; }
    const nodes = textNodesInRange(range);
    nodes.forEach((n) => {
      let parent = n.parentNode;
      while (parent && parent !== canvas() && !isBlock(parent)) {
        const up = parent.parentNode;
        splitOut(n, parent);
        parent = up === canvas() ? null : n.parentNode;
        if (parent && isBlock(parent)) { break; }
      }
    });
    reselectNodes(nodes);
  }

  // ---- blocks -----------------------------------------------------------------
  // HEADER and FOOTER belong here: without them the page's own header was taken
  // for something that lives on a line, and was tucked inside a paragraph --
  // which is not even legal HTML, and put it out of reach of every rule that
  // says where a header goes.
  const BLOCK_NAMES = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
    'BLOCKQUOTE', 'PRE', 'TABLE', 'ASIDE', 'FIGURE', 'DIV', 'HR', 'SECTION',
    'HEADER', 'FOOTER', 'MAIN', 'ARTICLE', 'NAV', 'DL', 'DT', 'DD']);
  function isBlock(el) { return !!(el && el.nodeType === 1 && BLOCK_NAMES.has(el.nodeName)); }

  /** The canvas keeps a flat run of blocks, so "the selected blocks" are its own children. */
  function topBlockOf(node) {
    const c = canvas();
    if (!c || !node || !inCanvas(node) || node === c) { return null; }
    let n = node;
    while (n && n.parentNode !== c) {
      n = n.parentNode;
      if (!n || n === document.body || n === document.documentElement) { return null; }
    }
    return n && n.nodeType === 1 ? n : null;
  }
  /** A boundary point may sit on the canvas itself; then the offset names the block. */
  function blockAt(container, offset) {
    const c = canvas();
    if (container === c) {
      const kids = c.children;
      if (!kids.length) { return null; }
      return kids[Math.min(offset, kids.length - 1)];
    }
    return topBlockOf(container);
  }
  function isFurniture(el) {
    return !!(el && el.classList && (el.classList.contains('eb-pagespacer')));
  }
  const INNER_BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE',
    'PRE', 'TD', 'TH', 'FIGCAPTION', 'DIV']);
  /**
   * The paragraph the caret is actually standing in -- the cell, the caption, the
   * one paragraph inside the box -- rather than the whole thing that holds it.
   * Centring inside a table centred every cell in it before this.
   */
  function innerBlockOf(node) {
    const c = canvas();
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== c && n.nodeType === 1) {
      // A frame is a container written in, whatever tag it is made of: the
      // alignment of the words in it belongs to the frame, not to the paragraph
      // the frame is anchored in, which may be somewhere else entirely.
      if (n.classList && n.classList.contains('eb-frame')) { return n; }
      if (INNER_BLOCKS.has(n.nodeName)) { return n; }
      n = n.parentNode;
    }
    return null;
  }
  /** Is the caret in this thing's own text? */
  function caretInside(el) {
    const r = getRange();
    return !!(el && r && el.contains && el.contains(r.startContainer));
  }
  function selectedBlocks(inner) {
    const range = getRange();
    if (!range) { return []; }
    if (inner && range) {
      const a = innerBlockOf(range.startContainer);
      const b = innerBlockOf(range.endContainer);
      if (a && b && a === b) { return isFurniture(a) ? [] : [a]; }
      if (a && b && a.parentNode === b.parentNode) {
        const run = [];
        let n = a;
        while (n) {
          if (!isFurniture(n)) { run.push(n); }
          if (n === b) { return run; }
          n = n.nextElementSibling;
        }
      }
    }
    const first = blockAt(range.startContainer, range.startOffset);
    const last = blockAt(range.endContainer, range.endOffset);
    if (!first) { return []; }
    const out = [];
    let n = first;
    while (n) {
      if (!isFurniture(n)) { out.push(n); }
      if (n === last || !last) { break; }
      n = n.nextElementSibling;
    }
    return out;
  }

  function replaceBlock(block, tag, cls) {
    const el = document.createElement(tag);
    if (cls) { el.className = cls; }
    while (block.firstChild) { el.appendChild(block.firstChild); }
    // carry alignment / indentation across a heading change
    ['eb-al-l', 'eb-al-c', 'eb-al-r', 'eb-al-j', 'eb-in1', 'eb-in2', 'eb-in3'].forEach((c) => {
      if (block.classList && block.classList.contains(c)) { el.classList.add(c); }
    });
    block.parentNode.replaceChild(el, block);
    return el;
  }

  /** Turn the selected blocks into paragraphs, headings, quotes or code. */
  function setBlockType(tag) {
    const blocks = selectedBlocks();
    if (!blocks.length) { return; }
    const made = [];
    blocks.forEach((b) => {
      if (b.nodeName === 'UL' || b.nodeName === 'OL') {
        // a list becomes one block per item
        const items = Array.from(b.children);
        const frag = document.createDocumentFragment();
        items.forEach((li) => {
          const el = document.createElement(tag);
          while (li.firstChild) { el.appendChild(li.firstChild); }
          frag.appendChild(el);
          made.push(el);
        });
        b.parentNode.replaceChild(frag, b);
        return;
      }
      if (b.nodeName === 'TABLE' || b.nodeName === 'HR' || b.classList.contains('eb-pagebreak')) { return; }
      made.push(replaceBlock(b, tag));
    });
    if (made.length) { placeCaretIn(made[0]); }
  }

  function toggleList(tag) {
    const blocks = selectedBlocks();
    if (!blocks.length) { return; }
    const allSame = blocks.every((b) => b.nodeName === tag);
    if (allSame) {
      blocks.forEach((list) => {
        const frag = document.createDocumentFragment();
        Array.from(list.children).forEach((li) => {
          const p = document.createElement('p');
          while (li.firstChild) { p.appendChild(li.firstChild); }
          frag.appendChild(p);
        });
        list.parentNode.replaceChild(frag, list);
      });
      return;
    }
    const list = document.createElement(tag);
    blocks[0].parentNode.insertBefore(list, blocks[0]);
    blocks.forEach((b) => {
      if (b.nodeName === 'UL' || b.nodeName === 'OL') {
        Array.from(b.children).forEach((li) => list.appendChild(li));
        b.remove();
        return;
      }
      const li = document.createElement('li');
      while (b.firstChild) { li.appendChild(b.firstChild); }
      list.appendChild(li);
      b.remove();
    });
    placeCaretIn(list.firstChild || list);
  }

  /** Alignment and indentation live as classes, one per group. */
  const ALIGN_CLASS = { left: 'eb-al-l', center: 'eb-al-c', right: 'eb-al-r', justify: 'eb-al-j' };
  /** The class for an alignment, whichever of the two names it was asked for by. */
  function alignClass(cls) {
    if (!cls) { return ''; }
    if (ALIGN_CLASS[cls]) { return ALIGN_CLASS[cls]; }
    return Object.keys(ALIGN_CLASS).some((k) => ALIGN_CLASS[k] === cls) ? cls : '';
  }
  /** What a block is aligned to now, whether it was said as a class or a style. */
  function alignOf(block) {
    if (!block || !block.classList) { return ''; }
    const inline = block.style && block.style.textAlign;
    if (inline) { return ALIGN_CLASS[inline] || ''; }
    return Object.keys(ALIGN_CLASS).map((k) => ALIGN_CLASS[k]).find((c) => block.classList.contains(c)) || '';
  }

  function setBlockClass(group, cls) {
    const groups = {
      align: ['eb-al-l', 'eb-al-c', 'eb-al-r', 'eb-al-j'],
      indent: ['eb-in1', 'eb-in2', 'eb-in3'],
    };
    const all = groups[group] || [];
    const wanted = group === 'align' ? alignClass(cls) : cls;
    const blocks = selectedBlocks(true);
    // Pressing the same one again takes it off. A button that shows itself as
    // pressed has to be able to be un-pressed, and the paragraph goes back to
    // whatever the style says.
    const already = !!wanted && blocks.length
      && blocks.every((b) => b.classList && (group === 'align' ? alignOf(b) === wanted : b.classList.contains(wanted)));
    blocks.forEach((b) => {
      if (!b.classList) { return; }
      all.forEach((c) => b.classList.remove(c));
      if (group === 'align' && b.style) {
        // An alignment set in the paragraph settings is the same choice said
        // another way; the button clears that too or it would look stuck.
        b.style.removeProperty('text-align');
        if (!b.getAttribute('style')) { b.removeAttribute('style'); }
      }
      if (wanted && !already) { b.classList.add(wanted); }
      if (b.getAttribute('class') === '') { b.removeAttribute('class'); }
    });
  }
  function stepIndent(dir) {
    const order = ['', 'eb-in1', 'eb-in2', 'eb-in3'];
    selectedBlocks(true).forEach((b) => {
      if (!b.classList) { return; }
      let level = 0;
      order.forEach((c, i) => { if (c && b.classList.contains(c)) { level = i; } });
      const next = Math.min(3, Math.max(0, level + dir));
      order.forEach((c) => { if (c) { b.classList.remove(c); } });
      if (order[next]) { b.classList.add(order[next]); }
    });
  }

  /** Move the paragraph the caret is in past the one above or below it. */
  function moveBlock(dir) {
    const blocks = selectedBlocks().filter((b) => b && b.parentNode);
    if (!blocks.length) { return false; }
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    const parent = first.parentNode;
    if (last.parentNode !== parent) { return false; }
    const before = first.previousElementSibling;
    const after = last.nextElementSibling;
    const skip = (n) => (n && n.classList && n.classList.contains('eb-pagespacer') ? n.previousElementSibling : n);
    if (dir < 0) {
      const target = skip(before);
      if (!target) { return false; }
      parent.insertBefore(target, last.nextSibling);
    } else {
      const target = after && after.classList.contains('eb-pagespacer') ? after.nextElementSibling : after;
      if (!target) { return false; }
      parent.insertBefore(target, first);
    }
    return true;
  }

  // Half-width and full-width are two spellings of the same characters, and a
  // Japanese document usually wants one of them throughout. ASCII sits at U+0021..
  // U+007E and its full-width twins at U+FF01..U+FF5E, exactly 0xFEE0 apart.
  const KANA_HALF = 'ｶﾞｷﾞｸﾞｹﾞｺﾞｻﾞｼﾞｽﾞｾﾞｿﾞﾀﾞﾁﾞﾂﾞﾃﾞﾄﾞﾊﾞﾋﾞﾌﾞﾍﾞﾎﾞﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟｳﾞ';
  const KANA_FULL = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ';
  const KANA_ONE_H = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｧｨｩｪｫｬｭｮｯｰ｡｢｣､･';
  const KANA_ONE_F = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォャュョッー。「」、・';
  function toWide(text) {
    return String(text)
      .replace(/[｡-ﾟ]+/g, (run) => {
        let out = '';
        for (let i = 0; i < run.length; i++) {
          // Only a real pair counts: indexOf on a single character would find the
          // first half of one and turn a plain ｳ into a ヴ.
          const two = run.slice(i, i + 2);
          const k = two.length === 2 ? KANA_HALF.indexOf(two) : -1;
          if (k >= 0 && k % 2 === 0) { out += KANA_FULL[k / 2]; i++; continue; }
          const j = KANA_ONE_H.indexOf(run[i]);
          out += j >= 0 ? KANA_ONE_F[j] : run[i];
        }
        return out;
      })
      .replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0))
      .replace(/ /g, '　');
  }
  function toNarrow(text) {
    return String(text)
      .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ')
      .replace(/[ァ-ー、。「」・]/g, (ch) => {
        const k = KANA_FULL.indexOf(ch);
        if (k >= 0) { return KANA_HALF.slice(k * 2, k * 2 + 2); }
        const j = KANA_ONE_F.indexOf(ch);
        return j >= 0 ? KANA_ONE_H[j] : ch;
      });
  }
  const TEXT_CASES = {
    upper: (t) => t.toUpperCase(),
    lower: (t) => t.toLowerCase(),
    title: (t) => t.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()),
    wide: toWide,
    narrow: toNarrow,
  };
  /** Rewrite the selected text without disturbing anything wrapped round it. */
  function transformText(kind) {
    const fn = TEXT_CASES[kind];
    const range = getRange();
    if (!fn || !range || range.collapsed) { return false; }
    const nodes = textNodesInRange(range);
    if (!nodes.length) { return false; }
    nodes.forEach((n) => { n.data = fn(n.data); });
    reselectNodes(nodes);
    return true;
  }

  // ---- insertions ---------------------------------------------------------------
  // ---- paragraph properties --------------------------------------------------------
  function numberIn(value, unit) {
    const m = String(value || '').match(/^(-?[\d.]+)\s*([a-z%]*)$/);
    if (!m || (unit && m[2] !== unit)) { return ''; }
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : '';
  }
  function styleOrClear(el, prop, value) {
    if (value === '' || value == null) { el.style.removeProperty(prop); } else { el.style.setProperty(prop, value); }
  }

  /** What the dialog shows: only what the paragraph itself sets, not what it inherits. */
  function paragraphProps() {
    const block = selectedBlocks(true)[0];
    if (!block) { return null; }
    const s = block.style;
    return {
      align: s.getPropertyValue('text-align') || '',
      lineHeight: numberIn(s.getPropertyValue('line-height'), ''),
      before: numberIn(s.getPropertyValue('margin-top'), 'pt'),
      after: numberIn(s.getPropertyValue('margin-bottom'), 'pt'),
      left: numberIn(s.getPropertyValue('margin-left'), 'mm'),
      right: numberIn(s.getPropertyValue('margin-right'), 'mm'),
      firstLine: numberIn(s.getPropertyValue('text-indent'), 'mm'),
      noLoneLines: Number(s.getPropertyValue('orphans')) >= 2 && Number(s.getPropertyValue('widows')) >= 2,
      pageBefore: s.getPropertyValue('break-before') === 'page',
      keepWithNext: s.getPropertyValue('break-after') === 'avoid',
      keepTogether: s.getPropertyValue('break-inside') === 'avoid',
      border: BORDER_STYLES.indexOf(s.getPropertyValue('border-top-style')) >= 0 ? s.getPropertyValue('border-top-style') : '',
      borderSides: borderSidesOf(s),
      borderWidth: unitOf(s.getPropertyValue('border-top-width'), 'pt'),
      borderColour: rgbToHex(s.getPropertyValue('border-top-color')) || '#666666',
      fill: rgbToHex(s.getPropertyValue('background-color')) || '',
      pad: numberIn(s.getPropertyValue('padding-top'), 'mm'),
    };
  }
  /** Which edges a paragraph's rule is drawn on, as the dialogue words it. */
  const BORDER_SIDES = ['all', 'top', 'bottom', 'topbottom', 'left'];
  function borderSidesOf(s) {
    const on = (side) => BORDER_STYLES.indexOf(s.getPropertyValue('border-' + side + '-style')) >= 0
      && s.getPropertyValue('border-' + side + '-style') !== 'none';
    const t = on('top'); const b = on('bottom'); const l = on('left'); const r = on('right');
    if (t && b && l && r) { return 'all'; }
    if (t && b) { return 'topbottom'; }
    if (t) { return 'top'; }
    if (b) { return 'bottom'; }
    if (l) { return 'left'; }
    return 'all';
  }

  /**
   * Every property is written as an inline style, because that is what the saved
   * file carries: no class the reader would have to be given a stylesheet for.
   */
  function setParagraphProps(v) {
    const blocks = selectedBlocks(true);
    if (!blocks.length) { return false; }
    const num = (x) => (x === '' || x == null || Number.isNaN(Number(x)) ? '' : Number(x));
    blocks.forEach((block) => {
      styleOrClear(block, 'text-align', v.align || '');
      styleOrClear(block, 'line-height', num(v.lineHeight) === '' ? '' : String(num(v.lineHeight)));
      styleOrClear(block, 'margin-top', num(v.before) === '' ? '' : num(v.before) + 'pt');
      styleOrClear(block, 'margin-bottom', num(v.after) === '' ? '' : num(v.after) + 'pt');
      styleOrClear(block, 'margin-left', num(v.left) === '' ? '' : num(v.left) + 'mm');
      styleOrClear(block, 'margin-right', num(v.right) === '' ? '' : num(v.right) + 'mm');
      styleOrClear(block, 'text-indent', num(v.firstLine) === '' ? '' : num(v.firstLine) + 'mm');
      styleOrClear(block, 'break-before', v.pageBefore ? 'page' : '');
      styleOrClear(block, 'break-after', v.keepWithNext ? 'avoid' : '');
      styleOrClear(block, 'break-inside', v.keepTogether ? 'avoid' : '');
      styleOrClear(block, 'orphans', v.noLoneLines ? '2' : '');
      styleOrClear(block, 'widows', v.noLoneLines ? '2' : '');
      // A rule round a paragraph, and a tint behind it -- the two things a notice
      // or a warning in a business document is always asking for.
      ['border', 'border-top', 'border-bottom', 'border-left', 'border-right'].forEach((prop) => styleOrClear(block, prop, ''));
      if (v.border && v.border !== 'none') {
        const rule = (num(v.borderWidth) || 0.75) + 'pt ' + v.border + ' '
          + (/^#[0-9a-f]{6}$/i.test(v.borderColour || '') ? v.borderColour : '#666666');
        const sides = BORDER_SIDES.indexOf(v.borderSides) >= 0 ? v.borderSides : 'all';
        if (sides === 'all') { styleOrClear(block, 'border', rule); } else {
          if (sides === 'top' || sides === 'topbottom') { styleOrClear(block, 'border-top', rule); }
          if (sides === 'bottom' || sides === 'topbottom') { styleOrClear(block, 'border-bottom', rule); }
          if (sides === 'left') { styleOrClear(block, 'border-left', rule); }
        }
      }
      const pad = num(v.pad);
      ['padding-top', 'padding-bottom', 'padding-left', 'padding-right']
        .forEach((prop) => styleOrClear(block, prop, pad === '' ? '' : pad + 'mm'));
      if (/^#[0-9a-f]{6}$/i.test(v.fill || '')) {
        styleOrClear(block, 'background-color', v.fill);
        block.classList.add('eb-ink');
      } else {
        styleOrClear(block, 'background-color', '');
        block.classList.remove('eb-ink');
      }
      if (block.getAttribute('class') === '') { block.removeAttribute('class'); }
      if (!block.getAttribute('style')) { block.removeAttribute('style'); }
    });
    return true;
  }

  // ---- table of contents -----------------------------------------------------------
  /** A heading needs an id before anything can link to it; keep any it already has. */
  function headingId(head, used) {
    let id = head.getAttribute('id') || '';
    if (!id) {
      const base = (head.textContent || '').trim().toLowerCase()
        .replace(/[\s\u3000]+/g, '-').replace(/[^\w\u3040-\u30ff\u4e00-\u9fff-]/g, '').slice(0, 40);
      id = base || 'section';
    }
    let out = id;
    let n = 2;
    while (used.has(out)) { out = id + '-' + n; n++; }
    used.add(out);
    head.setAttribute('id', out);
    return out;
  }

  /**
   * The contents are plain links to the headings, which is what HTML has instead of
   * page numbers: they work in the browser and read as a list on paper.
   */
  function buildToc(title) {
    const c = canvas();
    if (!c) { return false; }
    const heads = Array.from(c.querySelectorAll('h1, h2, h3, h4')).filter((h) => !h.closest('nav.eb-toc'));
    if (!heads.length) { return false; }
    const used = new Set();
    const nav = document.createElement('nav');
    nav.className = 'eb-toc';
    if (title) {
      const cap = document.createElement('p');
      cap.className = 'eb-toc-title';
      cap.textContent = title;
      nav.appendChild(cap);
    }
    const list = document.createElement('ul');
    heads.forEach((head) => {
      const li = document.createElement('li');
      li.className = 'eb-toc-l' + head.nodeName.slice(1);
      const a = document.createElement('a');
      a.setAttribute('href', '#' + headingId(head, used));
      a.textContent = (head.textContent || '').trim();
      li.appendChild(a);
      list.appendChild(li);
    });
    nav.appendChild(list);
    const old = c.querySelector('nav.eb-toc');
    if (old) {
      old.replaceWith(nav);
    } else {
      insertBlockNode(nav);
      const after = document.createElement('p');
      after.appendChild(document.createElement('br'));
      if (nav.parentNode) { nav.parentNode.insertBefore(after, nav.nextSibling); }
    }
    return true;
  }

  /** A character from the palette, dropped in where the caret is. */
  function insertText(text) {
    const range = getRange();
    if (!range) { return false; }
    range.deleteContents();
    const node = document.createTextNode(String(text));
    range.insertNode(node);
    const after = document.createRange();
    after.setStartAfter(node);
    after.collapse(true);
    selectRange(after);
    return true;
  }

  /**
   * Put a block where the caret is standing. Inside a cell or a box that means
   * inside it -- a picture dropped into a table belongs in the cell it was
   * dropped into, not after the whole table -- so the innermost thing that can
   * hold blocks is what it goes into.
   */
  function insertBlockNode(node) {
    const range = getRange();
    const inner = range ? innerBlockOf(range.startContainer) : null;
    const host = inner && inner.parentNode
      && (inner.matches('td, th') || (inner.parentNode.matches && inner.parentNode.matches(BLOCK_HOSTS)))
      ? inner : null;
    if (host) {
      // In a cell, the block goes in beside the words; in a box, after the
      // paragraph the caret is in.
      if (host.matches('td, th')) { host.appendChild(node); } else { host.parentNode.insertBefore(node, host.nextSibling); }
      return node;
    }
    const blocks = selectedBlocks();
    const anchor = blocks.length ? blocks[blocks.length - 1] : null;
    if (anchor) {
      anchor.parentNode.insertBefore(node, anchor.nextSibling);
    } else if (range) {
      range.insertNode(node);
    } else {
      canvas().appendChild(node);
    }
    return node;
  }
  /** Somewhere to type after a block, but only when there is nowhere already. */
  function landingAfter(node) {
    const next = node.nextElementSibling;
    if (next && !next.matches(OBJECT_SEL) && isBlock(next)) { return null; }
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    node.parentNode.insertBefore(p, node.nextSibling);
    return p;
  }

  function insertTable(rows, cols, withHeader, variant) {
    const table = document.createElement('table');
    table.className = 'eb-table' + (variant ? ' ' + variant : '');
    const tbody = document.createElement('tbody');
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement(withHeader && r === 0 ? 'th' : 'td');
        cell.appendChild(document.createElement('br'));
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    headerGroup(table);
    insertBlockNode(table);
    // somewhere to type after the table, or it traps the caret at the end of the document
    const tail = document.createElement('p');
    tail.appendChild(document.createElement('br'));
    table.parentNode.insertBefore(tail, table.nextSibling);
    placeCaretIn(table.querySelector('th, td'));
    return table;
  }

  // ---- pictures ----------------------------------------------------------------
  // A picture is embedded, not linked. A document that points back at Nextcloud for
  // its images stops being a document as soon as it leaves Nextcloud.
  function insertImage(dataUrl, alt, size) {
    const fig = document.createElement('figure');
    fig.className = 'eb-img ' + (size || 'eb-img-m');
    const img = document.createElement('img');
    img.setAttribute('src', dataUrl);
    img.setAttribute('alt', alt || '');
    fig.appendChild(img);
    const cap = document.createElement('figcaption');
    fig.appendChild(cap);
    const range = getRange();
    if (range && !range.collapsed) { range.deleteContents(); }
    insertBlockNode(fig);
    landingAfter(fig);
    placeCaretIn(cap);
    return fig;
  }
  /**
   * Where the caption stands: under the picture (the way a figure reads), over
   * it, or inside it as a band across the foot -- and none at all. Which one it
   * is, is which order the two are written in plus a class, so the saved file
   * needs no help to show it.
   */
  const CAPTION_PLACES = ['below', 'above', 'inside', 'none'];
  function captionPlace(fig) {
    if (!fig) { return 'below'; }
    const cap = fig.querySelector('figcaption');
    if (!cap || fig.classList.contains('eb-cap-none')) { return 'none'; }
    if (fig.classList.contains('eb-cap-in')) { return 'inside'; }
    if (fig.classList.contains('eb-cap-t')) { return 'above'; }
    return 'below';
  }
  function setCaptionPlace(fig, place) {
    if (!fig || CAPTION_PLACES.indexOf(place) < 0) { return; }
    const img = fig.querySelector(':scope > img');
    let cap = fig.querySelector(':scope > figcaption');
    if (!cap) { cap = document.createElement('figcaption'); }
    fig.classList.remove('eb-cap-t', 'eb-cap-in', 'eb-cap-none');
    if (place === 'none') {
      // The words are kept, not thrown away: turning it back on brings them back.
      fig.classList.add('eb-cap-none');
      if (!cap.parentNode) { fig.appendChild(cap); }
      return;
    }
    if (place === 'above') { fig.classList.add('eb-cap-t'); }
    if (place === 'inside') { fig.classList.add('eb-cap-in'); }
    // The words always come after the picture in the markup; which class is on
    // the figure is what decides where they are shown.
    if (cap.parentNode !== fig || cap.previousElementSibling !== img) { fig.appendChild(cap); }
  }

  // Cropping without cutting the picture: the frame is given a shape, the picture
  // fills it, and which part of it shows is a position. Three CSS properties, no
  // second copy of the image and nothing lost -- the whole picture is still in the
  // file and the crop can be undone at any time.
  const CROP_RATIOS = ['', '1 / 1', '4 / 3', '3 / 2', '16 / 9', '3 / 4', '2 / 3'];
  function cropOf(fig) {
    const img = fig ? fig.querySelector('img') : null;
    if (!img) { return null; }
    const pos = String(img.style.objectPosition || '').match(/(-?[\d.]+)%\s+(-?[\d.]+)%/);
    return {
      ratio: CROP_RATIOS.indexOf(img.style.aspectRatio) >= 0 ? img.style.aspectRatio : '',
      x: pos ? Number(pos[1]) : 50,
      y: pos ? Number(pos[2]) : 50,
    };
  }
  function setCrop(fig, v) {
    const img = fig ? fig.querySelector('img') : null;
    if (!img) { return false; }
    ['aspect-ratio', 'object-fit', 'object-position', 'height'].forEach((p2) => img.style.removeProperty(p2));
    if (v && v.ratio) {
      img.style.aspectRatio = v.ratio;
      img.style.objectFit = 'cover';
      img.style.objectPosition = Math.round(Number(v.x) || 50) + '% ' + Math.round(Number(v.y) || 50) + '%';
      img.style.height = 'auto';
    }
    if (!img.getAttribute('style')) { img.removeAttribute('style'); }
    return true;
  }

  function imageAt(node) {
    let n = node;
    if (!n) {
      const r = getRange();
      n = r ? r.startContainer : null;
    }
    if (n && n.nodeType === 3) { n = n.parentNode; }
    while (n && n !== canvas()) {
      if (n.nodeName === 'FIGURE' && n.classList.contains('eb-img')) { return n; }
      n = n.parentNode;
    }
    return null;
  }
  function setImageSize(cls) {
    const fig = imageAt();
    if (!fig) { return; }
    // Pressing the same size again takes it off and the picture is its own size.
    const already = cls && fig.classList.contains(cls);
    ['eb-img-s', 'eb-img-m', 'eb-img-l'].forEach((c) => fig.classList.remove(c));
    if (cls && !already) { fig.classList.add(cls); }
  }
  const IMG_FLOATS = ['eb-img-left', 'eb-img-right'];
  /** Text wrapping is a float in HTML, which is exactly what prints too. */
  function setImageFloat(kind) {
    const fig = imageAt();
    if (!fig) { return; }
    const already = (kind === 'left' || kind === 'right') && fig.classList.contains('eb-img-' + kind);
    IMG_FLOATS.forEach((c) => fig.classList.remove(c));
    if (!already && (kind === 'left' || kind === 'right')) { fig.classList.add('eb-img-' + kind); }
  }
  function imageFloat() {
    const fig = imageAt();
    if (!fig) { return ''; }
    if (fig.classList.contains('eb-img-left')) { return 'left'; }
    if (fig.classList.contains('eb-img-right')) { return 'right'; }
    return '';
  }
  function setImageAlt(text) {
    const fig = imageAt();
    const img = fig && fig.querySelector('img');
    if (img) { img.setAttribute('alt', String(text == null ? '' : text)); }
  }
  function imageAlt() {
    const fig = imageAt();
    const img = fig && fig.querySelector('img');
    return img ? (img.getAttribute('alt') || '') : '';
  }

  function deleteImage() {
    const fig = imageAt();
    if (!fig) { return; }
    const after = fig.nextElementSibling;
    fig.remove();
    placeCaretIn(after || canvas().lastElementChild);
  }

  // ---- tables ------------------------------------------------------------------
  // A table you can only create is not much use; these work on whichever cell the
  // caret is in, which is how every other editor behaves and how people expect it.
  function cellAt(node) {
    let n = node;
    if (!n) {
      const r = getRange();
      n = r ? r.startContainer : null;
    }
    if (n && n.nodeType === 3) { n = n.parentNode; }
    while (n && n !== canvas()) {
      if (n.nodeName === 'TD' || n.nodeName === 'TH') { return n; }
      n = n.parentNode;
    }
    return null;
  }
  function tableOf(cell) {
    let n = cell;
    while (n && n !== canvas()) {
      if (n.nodeName === 'TABLE') { return n; }
      n = n.parentNode;
    }
    return null;
  }
  function tableRows(table) { return Array.from(table.querySelectorAll('tr')); }
  function cellIndex(cell) { return Array.prototype.indexOf.call(cell.parentNode.children, cell); }
  function blankCell(tag) {
    const c = document.createElement(tag || 'TD');
    c.appendChild(document.createElement('br'));
    return c;
  }

  function addRow(dir) {
    const cell = cellAt();
    if (!cell) { return; }
    const row = cell.parentNode;
    const tr = document.createElement('tr');
    // A new row is always body cells, even when copied from the header.
    Array.from(row.children).forEach(() => tr.appendChild(blankCell('TD')));
    row.parentNode.insertBefore(tr, dir < 0 ? row : row.nextSibling);
    placeCaretIn(tr.firstChild);
  }
  function addColumn(dir) {
    const cell = cellAt();
    if (!cell) { return; }
    const table = tableOf(cell);
    const idx = cellIndex(cell);
    if (!table) { return; }
    tableRows(table).forEach((row) => {
      const ref = row.children[idx];
      const fresh = blankCell(ref ? ref.nodeName : 'TD');
      row.insertBefore(fresh, dir < 0 ? ref : (ref ? ref.nextSibling : null));
    });
    // A width belongs to a column, so a new column needs one of its own, taken
    // out of the one it was put beside. Without this the widths land on the
    // wrong columns and the table goes crooked.
    splitColumnWidth(table, idx, dir < 0 ? idx : idx + 1);
    placeCaretIn(cell.parentNode.children[dir < 0 ? idx : idx + 1]);
  }
  /** Halve one column's width and give the other half to the new one beside it. */
  function splitColumnWidth(table, from, to) {
    const cg = table.querySelector('colgroup');
    if (!cg) { return; }
    const cols = Array.from(cg.children);
    const src = cols[Math.min(from, cols.length - 1)];
    const w = src ? mmOf(src.style.width) : '';
    const fresh = document.createElement('col');
    if (w !== '' && w > 2) {
      src.style.width = round1(w / 2) + 'mm';
      fresh.style.width = round1(w / 2) + 'mm';
    }
    cg.insertBefore(fresh, cg.children[to] || null);
  }
  /** Take a column's width away and give it to the one that takes its place. */
  function mergeColumnWidth(table, idx) {
    const cg = table.querySelector('colgroup');
    if (!cg) { return; }
    const gone = cg.children[idx];
    if (!gone) { return; }
    const w = mmOf(gone.style.width);
    const near = cg.children[idx + 1] || cg.children[idx - 1];
    if (near && w !== '' && w > 0) {
      const have = mmOf(near.style.width);
      near.style.width = round1((have === '' ? 0 : have) + w) + 'mm';
    }
    gone.remove();
    if (!cg.children.length) { cg.remove(); }
  }
  function deleteRow() {
    const cell = cellAt();
    if (!cell) { return; }
    const row = cell.parentNode;
    const table = tableOf(cell);
    const rows = tableRows(table);
    if (rows.length <= 1) { return deleteTable(); }
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    placeCaretIn(next && next.firstChild ? next.firstChild : table);
  }
  function deleteColumn() {
    const cell = cellAt();
    if (!cell) { return; }
    const table = tableOf(cell);
    const idx = cellIndex(cell);
    if (cell.parentNode.children.length <= 1) { return deleteTable(); }
    tableRows(table).forEach((row) => {
      if (row.children[idx]) { row.children[idx].remove(); }
    });
    mergeColumnWidth(table, idx);
    const row = tableRows(table)[0];
    placeCaretIn(row ? (row.children[Math.min(idx, row.children.length - 1)] || row) : table);
  }
  function deleteTable() {
    const cell = cellAt();
    const table = cell ? tableOf(cell) : null;
    if (!table) { return; }
    const after = table.nextElementSibling;
    table.remove();
    placeCaretIn(after || canvas().lastElementChild);
  }
  /** Turn the first row into header cells, or back into ordinary ones. */
  function toggleHeaderRow() {
    const cell = cellAt();
    const table = cell ? tableOf(cell) : null;
    if (!table) { return; }
    const row = tableRows(table)[0];
    if (!row) { return; }
    const toHeader = row.children[0] && row.children[0].nodeName === 'TD';
    Array.from(row.children).forEach((c) => {
      const fresh = document.createElement(toHeader ? 'th' : 'td');
      while (c.firstChild) { fresh.appendChild(c.firstChild); }
      Array.from(c.attributes).forEach((a) => fresh.setAttribute(a.name, a.value));
      c.parentNode.replaceChild(fresh, c);
    });
    headerGroup(table);
  }
  /**
   * A header row in a <thead> is repeated at the top of every printed page the
   * table runs on to. That is a browser's own doing, and it costs one element.
   */
  function headerGroup(table) {
    const rows = tableRows(table);
    const first = rows[0];
    if (!first) { return; }
    const isHeader = !!(first.children[0] && first.children[0].nodeName === 'TH');
    const thead = table.querySelector('thead');
    if (isHeader) {
      if (thead && thead.contains(first)) { return; }
      const head = thead || document.createElement('thead');
      if (!thead) { table.insertBefore(head, table.firstChild); }
      head.appendChild(first);
    } else if (thead) {
      const body = table.querySelector('tbody') || table;
      while (thead.firstChild) { body.insertBefore(thead.firstChild, body.firstChild); }
      thead.remove();
    }
  }
  function setTableVariant(variant) {
    const cell = cellAt();
    const table = cell ? tableOf(cell) : null;
    if (!table) { return; }
    table.className = 'eb-table' + (variant ? ' ' + variant : '');
  }
  /**
   * The table as a grid of positions, so that a cell already carrying a colspan or
   * rowspan occupies every square it covers. Merging and splitting both need this:
   * the DOM order of <td>s says nothing about which column they are in.
   */
  function tableGrid(table) {
    const grid = [];
    tableRows(table).forEach((tr, r) => {
      if (!grid[r]) { grid[r] = []; }
      let c = 0;
      Array.from(tr.children).forEach((cell) => {
        while (grid[r][c]) { c++; }
        const cs = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10));
        const rs = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10));
        for (let i = 0; i < rs; i++) {
          if (!grid[r + i]) { grid[r + i] = []; }
          for (let j = 0; j < cs; j++) { grid[r + i][c + j] = cell; }
        }
        c += cs;
      });
    });
    return grid;
  }
  function cellBox(grid, cell) {
    let r0 = Infinity; let r1 = -1; let c0 = Infinity; let c1 = -1;
    grid.forEach((row, r) => row.forEach((it, c) => {
      if (it !== cell) { return; }
      r0 = Math.min(r0, r); r1 = Math.max(r1, r);
      c0 = Math.min(c0, c); c1 = Math.max(c1, c);
    }));
    return r1 < 0 ? null : { r0, r1, c0, c1 };
  }
  function setSpan(cell, name, value) {
    if (value > 1) { cell.setAttribute(name, String(value)); } else { cell.removeAttribute(name); }
  }

  /**
   * Merge every cell the selection touches. The rectangle is taken from the two
   * ends, and a merge that would cut through a cell already spanning out of it is
   * refused rather than guessed at.
   */
  /** Every cell the selection touches, which is what a cell command should act on. */
  function selectedCells() {
    const range = getRange();
    const start = cellAt(range ? range.startContainer : null);
    if (!start) { return []; }
    const table = tableOf(start);
    const end = cellAt(range ? range.endContainer : null) || start;
    if (!table || tableOf(end) !== table) { return [start]; }
    const grid = tableGrid(table);
    const a = cellBox(grid, start);
    const b = cellBox(grid, end);
    if (!a || !b) { return [start]; }
    const r0 = Math.min(a.r0, b.r0); const r1 = Math.max(a.r1, b.r1);
    const c0 = Math.min(a.c0, b.c0); const c1 = Math.max(a.c1, b.c1);
    const out = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = grid[r] && grid[r][c];
        if (cell && out.indexOf(cell) < 0) { out.push(cell); }
      }
    }
    return out;
  }

  function mergeCells() {
    const range = getRange();
    const start = cellAt(range ? range.startContainer : null);
    if (!start) { return false; }
    const table = tableOf(start);
    const end = cellAt(range ? range.endContainer : null) || start;
    if (!table || tableOf(end) !== table) { return false; }
    const grid = tableGrid(table);
    const a = cellBox(grid, start);
    const b = cellBox(grid, end);
    if (!a || !b) { return false; }
    const r0 = Math.min(a.r0, b.r0); const r1 = Math.max(a.r1, b.r1);
    const c0 = Math.min(a.c0, b.c0); const c1 = Math.max(a.c1, b.c1);
    if (r0 === r1 && c0 === c1) { return false; }
    const inside = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = grid[r] && grid[r][c];
        if (cell && inside.indexOf(cell) < 0) { inside.push(cell); }
      }
    }
    const ragged = inside.some((cell) => {
      const box = cellBox(grid, cell);
      return !box || box.r0 < r0 || box.r1 > r1 || box.c0 < c0 || box.c1 > c1;
    });
    if (ragged) { return false; }
    const keep = grid[r0][c0];
    inside.forEach((cell) => {
      if (cell === keep) { return; }
      const text = cell.textContent.replace(/\u200b/g, '').trim();
      if (text) {
        if (keep.textContent.trim()) { keep.appendChild(document.createElement('br')); }
        keep.appendChild(document.createTextNode(text));
      }
      cell.remove();
    });
    setSpan(keep, 'colspan', c1 - c0 + 1);
    setSpan(keep, 'rowspan', r1 - r0 + 1);
    placeCaretIn(keep);
    return true;
  }

  /** Undo a merge: the cell keeps its content and the squares it took come back empty. */
  function splitCell() {
    const cell = cellAt();
    if (!cell) { return false; }
    const table = tableOf(cell);
    if (!table) { return false; }
    const box = cellBox(tableGrid(table), cell);
    if (!box || (box.r0 === box.r1 && box.c0 === box.c1)) { return false; }
    cell.removeAttribute('colspan');
    cell.removeAttribute('rowspan');
    const rows = tableRows(table);
    for (let r = box.r0; r <= box.r1; r++) {
      for (let c = box.c0; c <= box.c1; c++) {
        if (r === box.r0 && c === box.c0) { continue; }
        const grid = tableGrid(table);
        if (grid[r] && grid[r][c]) { continue; }
        const tr = rows[r];
        if (!tr) { continue; }
        let ref = null;
        Array.from(tr.children).some((child) => {
          const cb = cellBox(grid, child);
          if (cb && cb.c0 > c) { ref = child; return true; }
          return false;
        });
        tr.insertBefore(blankCell(cell.nodeName), ref);
      }
    }
    return true;
  }

  /** Alignment belongs to the cell, so it travels with the table into the file. */
  function setCellAlign(align) {
    const range = getRange();
    const start = cellAt(range ? range.startContainer : null);
    if (!start) { return false; }
    const table = tableOf(start);
    const end = cellAt(range ? range.endContainer : null) || start;
    const cells = [start];
    if (table && end !== start && tableOf(end) === table) {
      const grid = tableGrid(table);
      const a = cellBox(grid, start); const b = cellBox(grid, end);
      if (a && b) {
        for (let r = Math.min(a.r0, b.r0); r <= Math.max(a.r1, b.r1); r++) {
          for (let c = Math.min(a.c0, b.c0); c <= Math.max(a.c1, b.c1); c++) {
            const cell = grid[r] && grid[r][c];
            if (cell && cells.indexOf(cell) < 0) { cells.push(cell); }
          }
        }
      }
    }
    // Pressing the same one again takes it off, as everywhere else.
    const already = align && cells.every((cell) => cell.style.textAlign === align);
    cells.forEach((cell) => {
      if (align && !already) { cell.style.textAlign = align; } else { cell.style.removeProperty('text-align'); }
      if (!cell.getAttribute('style')) { cell.removeAttribute('style'); }
    });
    return true;
  }

  /**
   * Column widths. A table with a colgroup and a fixed layout is the one thing a
   * browser lays out exactly as told, and <col> is where a width belongs -- one
   * declaration per column rather than one on every cell in it.
   */
  function tableColumns(table) {
    const grid = tableGrid(table);
    const count = grid.length ? grid[0].length : 0;
    if (!count) { return null; }
    let cg = table.querySelector('colgroup');
    if (!cg) {
      cg = document.createElement('colgroup');
      table.insertBefore(cg, table.firstChild);
    }
    while (cg.children.length > count) { cg.lastElementChild.remove(); }
    while (cg.children.length < count) { cg.appendChild(document.createElement('col')); }
    return cg;
  }
  function setColumnWidths(table, widths) {
    const cg = tableColumns(table);
    if (!cg) { return false; }
    Array.from(cg.children).forEach((col, i) => {
      const w = Number(widths[i]);
      if (w > 1) { col.style.width = round1(w) + 'mm'; } else { col.style.removeProperty('width'); }
      if (!col.getAttribute('style')) { col.removeAttribute('style'); }
    });
    table.style.tableLayout = 'fixed';
    return true;
  }
  /** A tint behind the cells the selection touches. */
  function setCellFill(colour) {
    const cells = selectedCells();
    if (!cells.length) { return false; }
    cells.forEach((cell) => {
      if (/^#[0-9a-f]{6}$/i.test(colour || '')) {
        cell.style.backgroundColor = colour;
        cell.classList.add('eb-ink');
      } else {
        cell.style.removeProperty('background-color');
        cell.classList.remove('eb-ink');
      }
      if (cell.getAttribute('class') === '') { cell.removeAttribute('class'); }
      if (!cell.getAttribute('style')) { cell.removeAttribute('style'); }
    });
    return true;
  }
  function setCellVerticalAlign(where) {
    const cells = selectedCells();
    if (!cells.length) { return false; }
    const already = where && cells.every((cell) => cell.style.verticalAlign === where);
    cells.forEach((cell) => {
      if (where && !already) { cell.style.verticalAlign = where; } else { cell.style.removeProperty('vertical-align'); }
      if (!cell.getAttribute('style')) { cell.removeAttribute('style'); }
    });
    return true;
  }

  /** Where the columns meet, measured off the row that has the most cells in it. */
  function columnEdges(table) {
    const rows = tableRows(table);
    let best = null;
    rows.forEach((tr) => { if (!best || tr.children.length > best.children.length) { best = tr; } });
    if (!best || best.children.length < 2) { return []; }
    const out = [];
    let i = 0;
    Array.from(best.children).forEach((cell) => {
      const cs = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10));
      i += cs;
      out.push({ index: i - 1, right: cell.getBoundingClientRect().right, width: cell.getBoundingClientRect().width / cs, span: cs });
    });
    out.pop();
    return out;
  }
  /** What each column is at this moment, in millimetres. */
  function columnWidths(table, zoom) {
    const rows = tableRows(table);
    let best = null;
    rows.forEach((tr) => { if (!best || tr.children.length > best.children.length) { best = tr; } });
    if (!best) { return []; }
    const out = [];
    Array.from(best.children).forEach((cell) => {
      const cs = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10));
      const w = cell.getBoundingClientRect().width / (zoom || 1) * MM / cs;
      for (let j = 0; j < cs; j++) { out.push(w); }
    });
    return out;
  }

  /** A rule on the cells the selection touches, on the edges asked for. */
  function setCellBorder(v) {
    const cells = selectedCells();
    if (!cells.length) { return false; }
    const rule = v.style && v.style !== 'none'
      ? (Number(v.width) || 0.75) + 'pt ' + v.style + ' ' + (/^#[0-9a-f]{6}$/i.test(v.colour || '') ? v.colour : '#666666')
      : (v.style === 'none' ? 'none' : '');
    cells.forEach((cell) => {
      ['border', 'border-top', 'border-bottom', 'border-left', 'border-right']
        .forEach((prop) => cell.style.removeProperty(prop));
      if (rule) {
        const sides = BORDER_SIDES.indexOf(v.sides) >= 0 ? v.sides : 'all';
        if (sides === 'all') { cell.style.border = rule; } else {
          if (sides === 'top' || sides === 'topbottom') { cell.style.borderTop = rule; }
          if (sides === 'bottom' || sides === 'topbottom') { cell.style.borderBottom = rule; }
          if (sides === 'left') { cell.style.borderLeft = rule; }
        }
      }
      if (!cell.getAttribute('style')) { cell.removeAttribute('style'); }
    });
    return true;
  }

  function atLastCell() {
    const cell = cellAt();
    if (!cell) { return false; }
    const cells = Array.from(tableOf(cell).querySelectorAll('th, td'));
    return cells.indexOf(cell) === cells.length - 1;
  }

  /** Tab through the cells, adding a row when it runs off the end. */
  function moveCell(dir) {
    const cell = cellAt();
    if (!cell) { return false; }
    const table = tableOf(cell);
    const cells = Array.from(table.querySelectorAll('th, td'));
    const at = cells.indexOf(cell);
    const next = cells[at + dir];
    if (next) { placeCaretIn(next); return true; }
    if (dir > 0) {
      addRow(1);
      return true;
    }
    return false;
  }

  // ---- readings, notes, columns and list markers ---------------------------------
  /** A reading over a word. HTML has had an element for this since 2010. */
  function applyRuby(reading) {
    const range = getRange();
    if (!range || range.collapsed) { return false; }
    if (!String(range.toString()).trim()) { return false; }
    const ruby = document.createElement('ruby');
    ruby.appendChild(range.extractContents());
    const rt = document.createElement('rt');
    rt.textContent = String(reading == null ? '' : reading);
    ruby.appendChild(rt);
    range.insertNode(ruby);
    const after = document.createRange();
    after.setStartAfter(ruby);
    after.collapse(true);
    selectRange(after);
    return true;
  }
  function rubyAt(node) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    const c = canvas();
    while (n && n !== c) {
      if (n.nodeName === 'RUBY') { return n; }
      n = n.parentNode;
    }
    return null;
  }
  function removeRuby() {
    const r = getRange();
    const ruby = r ? rubyAt(r.startContainer) : null;
    if (!ruby || !ruby.parentNode) { return false; }
    Array.from(ruby.querySelectorAll('rt, rp')).forEach((n) => n.remove());
    const parent = ruby.parentNode;
    while (ruby.firstChild) { parent.insertBefore(ruby.firstChild, ruby); }
    parent.removeChild(ruby);
    return true;
  }

  // A browser cannot put a note at the foot of the page that cites it: nothing in
  // CSS moves content between pages. They are gathered at the end instead, which is
  // what a printed report does with endnotes anyway, and the file numbers itself.
  let noteSeq = 0;
  function noteId() {
    noteSeq += 1;
    return 'ebn' + noteSeq + '-' + Math.floor(noteSeq * 7919 % 997);
  }
  function notesBox(title) {
    const c = canvas();
    let box = c.querySelector('section.eb-notes');
    if (box) { return box; }
    box = document.createElement('section');
    box.className = 'eb-notes';
    const head = document.createElement('p');
    head.className = 'eb-notes-title';
    head.textContent = title || 'Notes';
    box.appendChild(head);
    box.appendChild(document.createElement('ol'));
    c.appendChild(box);
    return box;
  }
  function insertFootnote(text, title) {
    const range = getRange();
    const c = canvas();
    if (!range || !c) { return false; }
    const id = noteId();
    const sup = document.createElement('sup');
    sup.className = 'eb-fnref';
    sup.setAttribute('id', 'r' + id);
    const a = document.createElement('a');
    a.setAttribute('href', '#' + id);
    a.textContent = '*';
    sup.appendChild(a);
    range.deleteContents();
    range.insertNode(sup);
    const li = document.createElement('li');
    li.setAttribute('id', id);
    const p = document.createElement('p');
    p.textContent = String(text == null ? '' : text);
    li.appendChild(p);
    notesBox(title).querySelector('ol').appendChild(li);
    const after = document.createRange();
    after.setStartAfter(sup);
    after.collapse(true);
    selectRange(after);
    return true;
  }
  /**
   * The notes follow the order they are cited in, are numbered from one, and a
   * note whose citation has been deleted goes with it.
   */
  function renumberNotes() {
    const c = canvas();
    if (!c) { return; }
    const box = c.querySelector('section.eb-notes');
    const refs = Array.from(c.querySelectorAll('sup.eb-fnref'));
    if (!box) { return; }
    const list = box.querySelector('ol');
    if (!list) { box.remove(); return; }
    const byId = {};
    Array.from(list.children).forEach((li) => { byId[li.getAttribute('id') || ''] = li; });
    const used = {};
    refs.forEach((sup, i) => {
      const a = sup.querySelector('a');
      const id = a ? String(a.getAttribute('href') || '').replace(/^#/, '') : '';
      const li = byId[id];
      if (!li) { sup.remove(); return; }
      used[id] = true;
      if (a) { a.textContent = String(i + 1); }
      list.appendChild(li);
    });
    Array.from(list.children).forEach((li) => {
      if (!used[li.getAttribute('id') || '']) { li.remove(); }
    });
    if (!list.children.length) { box.remove(); return; }
    // The notes belong at the end, whatever has been typed after them.
    if (box.parentNode === c && c.lastElementChild !== box) { c.appendChild(box); }
  }

  /** Lay a passage out in columns, or take the columns off it. */
  function setColumns(count, gapMm) {
    const blocks = selectedBlocks().filter((b) => b && b.parentNode);
    if (!blocks.length) { return false; }
    // The box may be the top-level block itself, so look for it from the caret up
    // rather than at the parent of whatever selectedBlocks came back with.
    const host = columnsBoxAt();
    if (host) {
      if (!count || count < 2) {
        const parent = host.parentNode;
        const first = host.firstElementChild;
        while (host.firstChild) { parent.insertBefore(host.firstChild, host); }
        parent.removeChild(host);
        placeCaretIn(first);
        return true;
      }
      host.style.columnCount = String(count);
      if (gapMm) { host.style.columnGap = gapMm + 'mm'; }
      return true;
    }
    if (!count || count < 2) { return false; }
    const box = document.createElement('div');
    box.className = 'eb-cols';
    box.style.columnCount = String(count);
    if (gapMm) { box.style.columnGap = gapMm + 'mm'; }
    blocks[0].parentNode.insertBefore(box, blocks[0]);
    blocks.forEach((b) => box.appendChild(b));
    placeCaretIn(box.firstElementChild);
    return true;
  }
  function columnsBoxAt() {
    const r = getRange();
    if (!r) { return null; }
    let n = r.startContainer;
    if (n && n.nodeType === 3) { n = n.parentNode; }
    const c = canvas();
    while (n && n !== c) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('eb-cols')) { return n; }
      n = n.parentNode;
    }
    return null;
  }
  function columnsAt() {
    const box = columnsBoxAt();
    return box ? (Number(box.style.columnCount) || 2) : 0;
  }

  // The markers a list can be numbered or bulleted with. The ordered ones make a
  // bulleted list into a numbered one and the other way round, because that is
  // what a person means by choosing them.
  const LIST_MARKERS = [
    { type: 'disc', tag: 'UL' }, { type: 'circle', tag: 'UL' }, { type: 'square', tag: 'UL' },
    { type: 'none', tag: 'UL' },
    { type: 'decimal', tag: 'OL' }, { type: 'decimal-leading-zero', tag: 'OL' },
    { type: 'lower-alpha', tag: 'OL' }, { type: 'upper-alpha', tag: 'OL' },
    { type: 'lower-roman', tag: 'OL' }, { type: 'upper-roman', tag: 'OL' },
    { type: 'cjk-decimal', tag: 'OL' }, { type: 'cjk-ideographic', tag: 'OL' },
    { type: 'katakana-iroha', tag: 'OL' }, { type: 'hiragana-iroha', tag: 'OL' },
  ];
  function listAt(node) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    const c = canvas();
    while (n && n !== c) {
      if (n.nodeName === 'UL' || n.nodeName === 'OL') { return n; }
      n = n.parentNode;
    }
    return null;
  }
  function setListMarker(type) {
    const r = getRange();
    let list = r ? listAt(r.startContainer) : null;
    if (!list) {
      toggleList(LIST_MARKERS.some((m) => m.type === type && m.tag === 'OL') ? 'OL' : 'UL');
      const again = getRange();
      list = again ? listAt(again.startContainer) : null;
      if (!list) { return false; }
    }
    const spec = LIST_MARKERS.find((m) => m.type === type);
    if (spec && list.nodeName !== spec.tag) {
      const swap = document.createElement(spec.tag);
      if (list.className) { swap.className = list.className; }
      while (list.firstChild) { swap.appendChild(list.firstChild); }
      list.parentNode.insertBefore(swap, list);
      list.remove();
      list = swap;
    }
    if (type) { list.style.listStyleType = type; } else { list.style.removeProperty('list-style-type'); }
    if (!list.getAttribute('style')) { list.removeAttribute('style'); }
    return true;
  }

  function insertPageBreak(label) {
    const div = document.createElement('div');
    div.className = 'eb-pagebreak';
    div.setAttribute('data-label', label || 'Page break');
    insertBlockNode(div);
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    div.parentNode.insertBefore(p, div.nextSibling);
    placeCaretIn(p);
  }

  function insertRule(cls) {
    const hr = document.createElement('hr');
    if (cls) { hr.className = cls; }
    insertBlockNode(hr);
  }

  function insertBox(variant, titleText) {
    const box = document.createElement('aside');
    box.className = 'eb-box' + (variant ? ' ' + variant : '');
    if (titleText) {
      const t = document.createElement('div');
      t.className = 'eb-box-title';
      t.textContent = titleText;
      box.appendChild(t);
    }
    const p = document.createElement('p');
    const range = getRange();
    if (range && !range.collapsed) {
      p.appendChild(range.extractContents());
    } else {
      p.appendChild(document.createElement('br'));
    }
    box.appendChild(p);
    insertBlockNode(box);
    placeCaretIn(p);
  }

  function insertNote() {
    const note = document.createElement('div');
    note.className = 'eb-note';
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    note.appendChild(p);
    insertBlockNode(note);
    placeCaretIn(p);
  }

  /** MathML goes in as MathML — no image, no renderer, no external font. */
  function insertMath(source, asBlock) {
    const holder = document.createElement('div');
    holder.innerHTML = String(source || '').trim();
    sanitiseInto(holder);
    const math = holder.querySelector('math');
    if (!math) { throw new Error('no <math> element'); }
    if (asBlock) {
      math.setAttribute('display', 'block');
      const wrap = document.createElement('div');
      wrap.className = 'eb-math-block';
      wrap.appendChild(math);
      insertBlockNode(wrap);
    } else {
      const range = getRange();
      if (range) {
        range.deleteContents();
        range.insertNode(math);
        const after = document.createRange();
        after.setStartAfter(math);
        after.collapse(true);
        selectRange(after);
      } else {
        insertBlockNode(math);
      }
    }
  }

  function insertHtmlBlock(html) {
    const holder = document.createElement('div');
    holder.innerHTML = String(html || '');
    sanitiseInto(holder);
    let last = null;
    Array.from(holder.childNodes).forEach((n) => {
      if (n.nodeType === 3 && !n.data.trim()) { return; }
      const node = isBlock(n) ? n : (function () { const p = document.createElement('p'); p.appendChild(n); return p; })();
      // Each block goes after the one before it: inserting them all against the
      // same anchor would lay the passage out backwards.
      if (last && last.parentNode) {
        last.parentNode.insertBefore(node, last.nextSibling);
      } else {
        insertBlockNode(node);
      }
      last = node;
    });
    if (last) { placeCaretIn(last); }
  }

  function placeCaretIn(node) {
    if (!node) { return; }
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(true);
    selectRange(r);
    if (canvas()) { canvas().focus(); }
  }

  // ---- frames -------------------------------------------------------------------
  // LibreOffice calls them frames, and everything that is inserted rather than typed
  // is one: a picture, a table, a callout, a formula, a contents list, a text frame.
  // A frame here is not a new kind of markup -- it is the object itself wearing
  // inline CSS -- so the file stays plain HTML and any browser lays it out the same.
  /** Elements that may hold blocks of their own, so a frame can be dropped into them. */
  const BLOCK_HOSTS = 'aside.eb-box, div.eb-frame, div.eb-note, blockquote, li, td, th';
  const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double'];
  /** One CSS pixel in millimetres: the whole app measures paper, not screens. */
  const MM = 25.4 / 96;
  const round1 = (n) => Math.round(n * 10) / 10;

  /**
   * A rule and a line are a pixel tall, which is nothing to aim at, and a click
   * that misses by one lands in the text instead. Anything that thin is caught
   * from a few pixels away. Measuring is better than an invisible band in the
   * page: a band would swallow the clicks meant for the words around it.
   */
  function thinObjectNear(x, y) {
    const c = canvas();
    if (!c) { return null; }
    let best = null;
    Array.from(c.querySelectorAll('hr, .eb-sh-line, .eb-sh-arrow')).forEach((el) => {
      if (!el.getBoundingClientRect) { return; }
      const r = el.getBoundingClientRect();
      if (r.height > 4 || !r.width) { return; }
      if (x < r.left - 2 || x > r.right + 2) { return; }
      const gap = Math.abs(y - (r.top + r.height / 2));
      if (gap <= 6 && (!best || gap < best[0])) { best = [gap, el]; }
    });
    return best ? best[1] : null;
  }
  function objectAt(node) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    const c = canvas();
    while (n && n !== c && n.nodeType === 1) {
      if (n.matches && n.matches(OBJECT_SEL)) { return n; }
      n = n.parentNode;
    }
    return null;
  }
  /** Free means: taken out of the flow and parked in an anchor of its own. */
  // A 文節 is the unit a reader of Japanese actually sees: one 自立語 with whatever
  // 付属語 cling to it. A morphological analyser would do this properly, but the
  // script itself gives most of the answer -- 自立語 start with kanji, katakana or
  // latin, and the hiragana after them belong to the word in front. For text in a
  // latin script the unit is the word.
  function charClass(ch) {
    if (!ch) { return 'end'; }
    if (/\s|　/.test(ch)) { return 'space'; }
    if (/[、。，．！？；：)）」』】〉》\]}]/.test(ch)) { return 'close'; }
    if (/[(（「『【〈《\[{]/.test(ch)) { return 'open'; }
    if (/[ぁ-ゟー]/.test(ch)) { return 'kana'; }
    if (/[゠-ヿ]/.test(ch)) { return 'kata'; }
    if (/[一-鿿々]/.test(ch)) { return 'kanji'; }
    if (/[0-9０-９]/.test(ch)) { return 'digit'; }
    if (/[A-Za-zÀ-ÿ]/.test(ch)) { return 'latin'; }
    return 'other';
  }
  // The words the script cannot mark out: 自立語 written in kana. Breaking before
  // one of these is only right after a kana that can end a 用言 or a 助詞 -- without
  // that guard 「まことに」 would be cut in the middle of a word.
  const KANA_WORDS = /^(こと|もの|ため|とき|ところ|わけ|はず|つもり|よう|ほう|すべて|ほとんど|かなり|とても|もっと|すぐ|まだ|もう|ぜひ|とくに|つねに|また|さらに|しかし|そして|ただし|および|または|なお|つまり|たとえば|なぜなら)/;
  const KANA_TAIL = /[るたいなのてではがをにともかられりんうすずけ]/;

  /** May a 文節 break between s[i-1] and s[i]? */
  function bunsetsuBreak(s, i) {
    if (i <= 0 || i >= s.length) { return false; }
    const before = charClass(s[i - 1]);
    const here = charClass(s[i]);
    if (before === 'kana' && here === 'kana' && KANA_TAIL.test(s[i - 1]) && KANA_WORDS.test(s.slice(i))) { return true; }
    if (before === 'space') { return true; }
    if (here === 'space') { return false; }
    // Punctuation that closes a phrase stays with it; one that opens starts a new one.
    if (here === 'close') { return false; }
    if (before === 'close') { return true; }
    if (here === 'open') { return true; }
    if (before === 'open') { return false; }
    if (before === here) { return false; }
    // A 自立語 starts a new 文節; the kana that follow do not.
    if (here === 'kana') { return false; }
    if (before === 'kanji' && here === 'kata') { return true; }
    if (before === 'kata' && here === 'kanji') { return true; }
    if (before === 'kana') { return true; }
    if ((before === 'latin' || before === 'digit') && (here === 'latin' || here === 'digit')) { return false; }
    return true;
  }
  /** The 文節 the caret is in, as a Range over the one text node it lives in. */
  function bunsetsuAt(node, offset) {
    if (!node || node.nodeType !== 3) { return null; }
    const s = node.data;
    if (!s || !s.trim()) { return null; }
    let at = Math.max(0, Math.min(offset, s.length));
    // A caret sitting on a break belongs to the 文節 in front of it.
    if (at >= s.length) { at = s.length - 1; }
    let from = at;
    while (from > 0 && !bunsetsuBreak(s, from)) { from--; }
    let to = at + 1;
    while (to < s.length && !bunsetsuBreak(s, to)) { to++; }
    while (from < to && charClass(s[from]) === 'space') { from++; }
    while (to > from && charClass(s[to - 1]) === 'space') { to--; }
    if (to <= from) { return null; }
    const r = document.createRange();
    r.setStart(node, from);
    r.setEnd(node, to);
    return r;
  }
  /**
   * Make the text a frame of its own, so everything a frame can do it can do too.
   * Inline, because a run of words inside a sentence is not a block.
   */
  function frameText(range) {
    if (!range || range.collapsed) { return null; }
    const span = document.createElement('span');
    span.className = 'eb-frame';
    try {
      span.appendChild(range.extractContents());
    } catch (e) {
      return null;
    }
    range.insertNode(span);
    return span;
  }

  function objectKind(el) {
    if (!el) { return ''; }
    if (el.nodeName === 'SPAN' && el.classList.contains('eb-frame')) { return 'TEXT'; }
    if (el.classList && el.classList.contains('eb-shape')) { return 'SHAPE'; }
    if (el.classList && el.classList.contains('eb-frame')) { return 'FRAME'; }
    if (el.classList && el.classList.contains('eb-note')) { return 'NOTE'; }
    if (el.classList && el.classList.contains('eb-math-block')) { return 'MATH'; }
    if (el.classList && el.classList.contains('eb-embed')) { return 'EMBED'; }
    if (el.classList && el.classList.contains('eb-textbox')) { return 'TEXTBOX'; }
    if (el.classList && el.classList.contains('eb-cols')) { return 'COLUMNS'; }
    if (/^H[1-6]$/.test(el.nodeName)) { return 'HEADING'; }
    if (el.nodeName === 'P') { return 'PARA'; }
    if (el.nodeName === 'UL' || el.nodeName === 'OL' || el.nodeName === 'DL') { return 'LIST'; }
    if (el.nodeName === 'BLOCKQUOTE') { return 'QUOTE'; }
    if (el.nodeName === 'PRE') { return 'PRE'; }
    return el.nodeName;
  }
  /** Writing is an object as well: the block the caret is in, when nothing else holds it. */
  function textBlockAt(node) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    const c = canvas();
    while (n && n !== c && n.nodeType === 1) {
      // An object holds its own writing: that object is what is taken hold of.
      if (n.matches && n.matches(OBJECT_SEL)) { return null; }
      if (n.matches && n.matches(TEXT_SEL)) { return n; }
      n = n.parentNode;
    }
    return null;
  }
  function objectFree(el) {
    const p = el && el.parentNode;
    return !!(p && p.nodeType === 1 && p.classList && p.classList.contains('eb-anchor'));
  }
  function setObjectFree(el, free) {
    if (!el || free === objectFree(el)) { return; }
    if (free) {
      // A block frame is parked between two blocks; a run of text is parked where it
      // stood in the line, so the anchor has to be of the same kind as the frame.
      const anchor = document.createElement(el.nodeName === 'SPAN' ? 'span' : 'div');
      anchor.className = 'eb-anchor';
      el.parentNode.insertBefore(anchor, el);
      anchor.appendChild(el);
      el.style.removeProperty('float');
    } else {
      const anchor = el.parentNode;
      anchor.parentNode.insertBefore(el, anchor);
      anchor.remove();
      el.style.removeProperty('left');
      el.style.removeProperty('top');
    }
    if (!el.getAttribute('style')) { el.removeAttribute('style'); }
  }
  /** The block of the document that this height on the page falls in. */
  function blockAtY(y) {
    const c = canvas();
    if (!c) { return null; }
    let found = null;
    Array.from(c.children).forEach((el) => {
      if (found) { return; }
      if (el.classList && (el.classList.contains('eb-pagespacer') || el.classList.contains('eb-anchor'))) { return; }
      if (!el.getBoundingClientRect) { return; }
      if (el.getBoundingClientRect().bottom > y) { found = el; }
    });
    return found;
  }
  /** Move a frame to another place in the text, anchor and all. */
  function moveObjectTo(el, ref, after) {
    if (!el || !ref || !ref.parentNode) { return false; }
    const host = objectFree(el) ? el.parentNode : el;
    if (host === ref || host.contains(ref)) { return false; }
    ref.parentNode.insertBefore(host, after ? ref.nextSibling : ref);
    return true;
  }
  /**
   * Whether a click on this spot picks the object up whole, rather than putting a
   * caret in text that happens to live inside it. It is decided from what was
   * clicked, not from where the browser then puts the caret -- the caret is the
   * browser's to place, and reading it back gave a different answer depending on
   * how the click arrived.
   *
   * Picked up whole: a picture, a rule, a formula, a frame standing in the run of
   * a sentence. Written in: a caption, a table cell, a box, a block frame -- those
   * are picked up by their own edge instead.
   */
  function onText(el, x, y) {
    if (!el || typeof el.getBoundingClientRect !== 'function') { return false; }
    const r = document.createRange();
    r.selectNodeContents(el);
    // No layout to measure (the test harness): nothing is under the pointer.
    if (typeof r.getClientRects !== 'function') { return true; }
    return Array.from(r.getClientRects())
      .some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
  }
  function takesClick(el, target, x, y) {
    if (!el || !target) { return false; }
    const cls = el.classList;
    if (el.nodeName === 'SPAN' && cls && cls.contains('eb-frame')) { return true; }
    if (el.nodeName === 'HR') { return true; }
    if (cls && cls.contains('eb-math-block')) { return true; }
    if (el.nodeName === 'FIGURE') { return !(target.closest && target.closest('figcaption')); }
    if (el.nodeName === 'TABLE') { return !(target.closest && target.closest('td, th')); }
    // A box or a frame is written in: the click has to miss the words to take
    // hold of the thing itself.
    return !onText(el, x, y);
  }
  let frameTaken = false;
  // Objects held alongside the one with the bar on it. Shift adds and removes.
  let frameMore = [];
  const frameAll = () => [frameEl].concat(frameMore).filter((el) => el && el.parentNode);
  function deleteObject(el) {
    if (!el) { return; }
    const host = objectFree(el) ? el.parentNode : el;
    const near = host.nextElementSibling || host.previousElementSibling;
    host.remove();
    if (near) { placeCaretIn(near); }
  }
  /** A frame with nothing in it but what the writer puts there. */
  /**
   * A shape is put down where the caret is and immediately taken out of the flow,
   * so it can be dragged anywhere the moment it appears. That is the whole point
   * of it: a page is laid out by putting things on it, not by typing until they
   * arrive.
   */
  function insertShape(kind, wMm, hMm) {
    const el = document.createElement('div');
    el.className = 'eb-shape eb-sh-' + kind;
    el.appendChild(document.createElement('br'));
    insertBlockNode(el);
    setObjectFree(el, true);
    el.style.left = '0mm';
    el.style.top = '0mm';
    el.style.width = (wMm || 45) + 'mm';
    if (kind !== 'line' && kind !== 'arrow') { el.style.minHeight = (hMm || 25) + 'mm'; }
    // The caret goes inside it, which both keeps the shape selected -- its box and
    // handles up, ready to be dragged -- and lets a label be typed straight away.
    placeCaretIn(el);
    return el;
  }

  /** A table put down where it is dropped, with a shape to start from. */
  function insertFreeTable() {
    const t = insertTable(2, 2, true, '');
    if (!t) { return null; }
    setObjectFree(t, true);
    t.style.left = '0mm';
    t.style.top = '0mm';
    t.style.width = '80mm';
    return t;
  }

  /** A frame of words put down where it is dropped, not where the text is. */
  /**
   * 文字枠 -- a text frame. It is a <p>, because a paragraph is what words live
   * in; a <div> is for holding several blocks together, and that is the whole
   * difference between the two in this document. Placed on the page, sized, and
   * ready to be typed into.
   */
  function insertTextBox(free) {
    const p = document.createElement('p');
    p.className = 'eb-textbox';
    const range = getRange();
    if (range && !range.collapsed) { p.appendChild(range.extractContents()); } else { p.appendChild(document.createElement('br')); }
    insertBlockNode(p);
    if (free) {
      setObjectFree(p, true);
      p.style.left = '0mm';
      p.style.top = '0mm';
      p.style.width = '60mm';
      p.style.minHeight = '12mm';
    }
    placeCaretIn(p);
    return p;
  }

  function insertFreeFrame() {
    const box = insertFrame();
    setObjectFree(box, true);
    box.style.left = '0mm';
    box.style.top = '0mm';
    box.style.width = '60mm';
    box.style.minHeight = '20mm';
    return box;
  }

  function insertFrame() {
    const box = document.createElement('div');
    box.className = 'eb-frame';
    const p = document.createElement('p');
    const range = getRange();
    if (range && !range.collapsed) { p.appendChild(range.extractContents()); } else { p.appendChild(document.createElement('br')); }
    box.appendChild(p);
    insertBlockNode(box);
    placeCaretIn(p);
    return box;
  }

  /**
   * Freely placed frames overlap, so they need an order to overlap in. Rather than
   * let numbers drift apart, the whole stack is renumbered 1..n every time, and the
   * one being moved is put where it was asked for.
   */
  function stackedFrames() {
    const c = canvas();
    return c ? Array.from(c.querySelectorAll('.eb-anchor > *')) : [];
  }
  function restack(el, where) {
    const list = stackedFrames();
    if (list.length < 2 || list.indexOf(el) < 0) {
      if (el && list.indexOf(el) >= 0) { el.style.zIndex = '1'; }
      return;
    }
    const order = list.map((n, i) => ({ n, z: Number(n.style.zIndex) || 0, i }));
    order.sort((a, b) => (a.z - b.z) || (a.i - b.i));
    const from = order.findIndex((x) => x.n === el);
    let to = from;
    if (where === 'front') { to = order.length - 1; } else if (where === 'back') { to = 0; } else { to = Math.max(0, Math.min(order.length - 1, from + where)); }
    const moved = order.splice(from, 1)[0];
    order.splice(to, 0, moved);
    order.forEach((x, k) => { x.n.style.zIndex = String(k + 1); });
  }

  // ---- 折り返し: how the words get round an object ----------------------------
  // LibreOffice calls it 折り返し. A browser has one tool for it -- the float --
  // and a float only holds words off from the edge of the column, and only the
  // words that come after it. An object parked over the middle of a paragraph
  // pushes nothing at all: the words run straight underneath.
  //
  // So the wrap is written into the document itself. Where an object stands over
  // a piece of writing, a spacer is floated at the head of that writing: no words
  // in it and no ink, exactly wide and tall enough to hold the lines off the
  // object, with shape-outside cutting away the part above it so the lines before
  // it keep their full width. It is plain HTML and plain CSS, so the saved file
  // wraps in any browser with nothing to run.
  //
  // One thing LibreOffice does that no browser can: run a single line of text
  // down BOTH sides of an object. A line box is one unbroken run, so the words
  // go to one side or the other. "Optimal" picks whichever side has more room.
  // There is no "in background" here. An object standing over the text can be
  // painted over it, and that is all: give it z-index 0 and it covers the words,
  // give it -1 and it disappears behind the page's own white. A browser paints
  // the root background under everything, so there is no layer between the paper
  // and the writing to put anything in. Measured, both ways, before it was cut.
  const WRAP_MODES = ['none', 'left', 'right', 'through'];
  const WRAP_GAP = 3;
  // LibreOffice's own rule for the optimal wrap, read off its source: a side is
  // only wrapped on if at least TEXT_MIN of column is left there, and TEXT_MIN is
  // 1134 twips -- twenty millimetres. Narrower than that and the words would come
  // out three to a line, so it wraps on neither side and goes above and below
  // instead. (sw/source/core/text/txtfly.cxx, GetSurroundForTextWrap.)
  const WRAP_MIN_COLUMN = 20;
  /**
   * Every object stands clear of the writing unless it is told otherwise: the
   * words stop above it and start again below. That is what a picture dropped on
   * a page does in any word processor, and it is the one arrangement that never
   * hides anything.
   */
  function wrapMode(el) {
    const m = el && el.getAttribute ? (el.getAttribute('data-wrap') || '') : '';
    return WRAP_MODES.indexOf(m) >= 0 ? m : 'none';
  }
  function wrapGap(el) {
    const g = parseFloat(el && el.getAttribute ? el.getAttribute('data-wrap-gap') : '');
    return isFinite(g) && g >= 0 ? g : WRAP_GAP;
  }
  /** Where a float actually sits: inside the block's content, not its border. */
  function contentBox(el) {
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const n = (v) => parseFloat(v) || 0;
    return {
      left: r.left + n(cs.borderLeftWidth) + n(cs.paddingLeft),
      right: r.right - n(cs.borderRightWidth) - n(cs.paddingRight),
      top: r.top + n(cs.borderTopWidth) + n(cs.paddingTop),
      bottom: r.bottom - n(cs.borderBottomWidth) - n(cs.paddingBottom),
    };
  }
  /** A float reaches only the lines in its own formatting context. */
  function flowRoot(el) {
    const c = canvas();
    let n = el && el.parentNode;
    while (n && n.nodeType === 1 && n !== c) {
      const cs = window.getComputedStyle(n);
      if (cs.overflow !== 'visible' || cs.float !== 'none' || cs.position === 'absolute'
        || /flex|grid|table|inline-block|flow-root/.test(cs.display)) { return n; }
      n = n.parentNode;
    }
    return c;
  }
  /**
   * Clear the formatting inside a block, the way LibreOffice's 直接設定した書式の
   * クリア does: the words and the paragraphs stay, everything laid on top of them
   * goes. Text that arrived as a <pre> -- pasted from a terminal or a plain file --
   * becomes real paragraphs, because a <pre> never wraps and so can never flow
   * round anything.
   */
  const PLAIN_KEEP = /^(width|height|min-height|max-width|float|clear|position|left|top|right|bottom|margin|margin-left|margin-right|margin-top|margin-bottom|z-index|break-inside|shape-outside)$/;
  function plainBlock(el) {
    if (!el) { return; }
    Array.from(el.querySelectorAll('pre')).forEach((pre) => {
      const parent = pre.parentNode;
      const lines = String(pre.textContent || '').replace(/\t/g, ' ').split(/\r?\n/);
      // A run of blank lines between two paragraphs is one break, not five.
      const out = [];
      lines.forEach((line) => {
        const text = line.replace(/\s+$/, '');
        if (!text.trim() && !out.length) { return; }
        if (!text.trim() && out.length && !out[out.length - 1]) { return; }
        out.push(text.trim() ? text : '');
      });
      while (out.length && !out[out.length - 1]) { out.pop(); }
      out.forEach((line) => {
        const p = document.createElement('p');
        if (line) { p.textContent = line; } else { p.appendChild(document.createElement('br')); }
        parent.insertBefore(p, pre);
      });
      parent.removeChild(pre);
    });
    // Everything laid over the words: unwrapped, the words themselves left behind.
    for (let pass = 0; pass < 20; pass += 1) {
      const dressed = el.querySelector('b, i, u, s, em, strong, code, mark, font, small, big, sub, sup, span:not(.eb-flow):not(.eb-frame)');
      if (!dressed) { break; }
      const parent = dressed.parentNode;
      while (dressed.firstChild) { parent.insertBefore(dressed.firstChild, dressed); }
      parent.removeChild(dressed);
    }
    Array.from(el.querySelectorAll('[style], [class]')).forEach((kid) => {
      if (kid.classList && kid.classList.contains('eb-flow')) { return; }
      kid.removeAttribute('style');
      const keep = Array.from(kid.classList || []).filter((c) => /^eb-al-/.test(c));
      if (keep.length) { kid.setAttribute('class', keep.join(' ')); } else { kid.removeAttribute('class'); }
    });
    // The block itself keeps its size and its place; only the ink goes.
    const style = el.style;
    Array.from(style).slice().forEach((prop) => {
      if (!PLAIN_KEEP.test(prop)) { style.removeProperty(prop); }
    });
    if (!el.getAttribute('style')) { el.removeAttribute('style'); }
  }

  /**
   * Where a thing stands in the pile. Two boxes laid over each other are both
   * objects and both writing, so each would push the other's words about and the
   * page would fight itself. The one on top wins: what is underneath gets out of
   * the way, and what is on top is left alone -- which is what a writer means by
   * putting one thing over another.
   */
  function stackRank(el) {
    const placed = el && el.closest ? el.closest('.eb-anchor') : null;
    if (!placed || !placed.firstElementChild) { return -1; }
    const box = placed.firstElementChild;
    const z = Number(box.style.zIndex);
    if (z) { return z * 1000; }
    const c = canvas();
    const all = c ? Array.from(c.querySelectorAll('.eb-anchor')) : [];
    return all.indexOf(placed);
  }

  function clearWrapSpacers(root) {
    if (root) { Array.from(root.querySelectorAll('span.eb-flow')).forEach((s) => s.remove()); }
  }
  /**
   * Write the spacers. Measured, so it must run after the page has been laid out.
   * An object hangs off an anchor that stands in the text, so making the text
   * taller moves the object -- which changes the spacer that made it taller. Two
   * or three passes settle it; if they do not, the last one stands.
   */
  function applyWrap(root, zoom) {
    if (!root) { return; }
    const z = zoom || 1;
    const mm = (px) => Math.round(px / z * MM * 10) / 10;
    for (let pass = 0; pass < 3; pass += 1) {
      clearWrapSpacers(root);
      // Every object standing over the page, not only the ones that have been
      // told what to do: standing clear of the writing is the default.
      const objects = Array.from(root.querySelectorAll('.eb-anchor > *'))
        .filter((o) => o.nodeType === 1 && ['none', 'left', 'right'].indexOf(wrapMode(o)) >= 0);
      if (!objects.length) { return; }
      const before = objects.map((o) => o.getBoundingClientRect().top);
      // Writing that is itself standing on the page counts too. It was left out,
      // so a picture laid over a piece of writing that had been placed freely --
      // a text object, with its own box -- went straight through it: the words
      // did not move at all. They are pushed the same way as any other words:
      // the room is taken out of the block they are in, wherever that block is.
      // What is never pushed is the object's own writing, by itself.
      const blocks = Array.from(root.querySelectorAll(TEXT_SEL))
        .filter((b) => !b.querySelector('.eb-anchor'))
        .filter((b) => !b.closest('header.eb-header, footer.eb-footer'));
      // Nearest first, so two objects over the same paragraph reserve their room
      // one after the other instead of both measuring from the same edge.
      const held = new Map();
      objects.slice().sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        .forEach((o) => {
          const or = o.getBoundingClientRect();
          if (!or.width || !or.height) { return; }
          const mode = wrapMode(o);
          const gapPx = wrapGap(o) / MM * z;
          const done = new Set();
          const mine = stackRank(o);
          blocks.forEach((b) => {
            if (o.contains(b) || b.contains(o) || !b.parentNode) { return; }
            // Only what is underneath moves. See stackRank.
            if (stackRank(b) >= mine && stackRank(b) >= 0) { return; }
            const cb = contentBox(b);
            if (cb.bottom <= or.top - gapPx || cb.top >= or.bottom + gapPx) { return; }
            if (cb.right <= or.left - gapPx || cb.left >= or.right + gapPx) { return; }
            const rootEl = flowRoot(b);
            // One spacer to each formatting context: a float goes on holding the
            // lines below it off, so the paragraphs after this one are already
            // taken care of.
            if (done.has(rootEl)) { return; }
            done.add(rootEl);
            const room = cb.right - cb.left;
            let side = mode;
            let how = mode;
            // A column too narrow to write in is no wrap at all: LibreOffice's own
            // rule is twenty millimetres (TEXT_MIN, 1134 twips), and below that it
            // puts the words above and below instead. See WRAP_MIN_COLUMN.
            if (mode === 'left' || mode === 'right') {
              const room = mode === 'left'
                ? (or.left - gapPx - cb.left) * MM / z
                : (cb.right - (or.right + gapPx)) * MM / z;
              if (room < WRAP_MIN_COLUMN) { how = 'none'; }
            }
            const floatSide = how === 'none' ? 'left' : (side === 'right' ? 'left' : 'right');
            const key = b;
            const taken = held.get(key) || { left: 0, right: 0 };
            let w = how === 'none' ? room
              : (floatSide === 'left' ? (or.right + gapPx) - cb.left : cb.right - (or.left - gapPx));
            w = Math.min(Math.max(w - taken[floatSide], 0), room);
            const h = (or.bottom + gapPx) - cb.top;
            if (w <= 0 || h <= 0) { return; }
            taken[floatSide] += w;
            held.set(key, taken);
            const inset = Math.max(0, (or.top - gapPx) - cb.top);
            const spacer = document.createElement('span');
            spacer.className = 'eb-flow';
            spacer.setAttribute('contenteditable', 'false');
            spacer.setAttribute('aria-hidden', 'true');
            spacer.setAttribute('style', 'float:' + floatSide + ';width:' + mm(w) + 'mm;height:' + mm(h) + 'mm;'
              + (inset > 0.5 ? 'shape-outside:inset(' + mm(inset) + 'mm 0 0 0);' : ''));
            b.insertBefore(spacer, b.firstChild);
          });
        });
      const after = objects.map((o) => o.getBoundingClientRect().top);
      if (after.every((t, i) => Math.abs(t - before[i]) < 0.5)) { return; }
    }
  }

  function unitOf(value, unit) {
    const m = /^(-?[\d.]+)([a-z%]*)$/.exec(String(value == null ? '' : value).trim());
    return m && m[2] === unit ? Number(m[1]) : '';
  }
  const mmOf = (v) => unitOf(v, 'mm');
  const ptOf = (v) => unitOf(v, 'pt');

  /** What the properties dialogue shows: the frame read back off the element. */
  function objectProps(el) {
    if (!el) { return null; }
    const s = el.style;
    const flt = s.cssFloat || s.float || '';
    let place = '';
    if (objectFree(el)) { place = 'free'; } else if (s.marginLeft === 'auto' && s.marginRight === 'auto') { place = 'center'; } else if (s.marginLeft === 'auto') { place = 'right'; } else if (s.marginRight === 'auto') { place = 'left'; }
    return {
      place,
      // How the words inside the frame are set, which is a different question
      // from where the frame itself sits.
      inner: alignOf(el),
      wrap: (flt === 'left' || flt === 'right') ? flt : '',
      z: Number(s.zIndex) || '',
      x: mmOf(s.left), y: mmOf(s.top),
      width: mmOf(s.width), height: mmOf(s.minHeight) === '' ? mmOf(s.height) : mmOf(s.minHeight),
      mt: mmOf(s.marginTop), mb: mmOf(s.marginBottom),
      ml: mmOf(s.marginLeft), mr: mmOf(s.marginRight),
      pad: mmOf(s.paddingTop),
      border: BORDER_STYLES.indexOf(s.borderTopStyle) >= 0 ? s.borderTopStyle : '',
      borderWidth: ptOf(s.borderTopWidth),
      borderColour: rgbToHex(s.borderTopColor) || '#666666',
      radius: ptOf(s.borderRadius) === '' ? ptOf(s.borderTopLeftRadius) : ptOf(s.borderRadius),
      fill: rgbToHex(s.backgroundColor) || '',
      opacity: s.opacity === '' ? '' : Math.round(parseFloat(s.opacity) * 100),
      rotate: (() => { const m = /rotate\(([-\d.]+)deg\)/.exec(s.transform || ''); return m ? Number(m[1]) : ''; })(),
      vpos: (el.classList && el.classList.contains('eb-v-mid')) ? 'eb-v-mid'
        : ((el.classList && el.classList.contains('eb-v-bot')) ? 'eb-v-bot' : ''),
      flow: (el.classList && el.classList.contains('eb-tate')) ? 'eb-tate'
        : ((el.classList && el.classList.contains('eb-yoko')) ? 'eb-yoko' : ''),
      shadow: !!(el.classList && el.classList.contains('eb-shadow')),
      keep: s.breakInside === 'avoid',
      bgImage: (() => { const m = /url\(["']?(data:image\/[^"')]+)["']?\)/.exec(s.backgroundImage || ''); return m ? m[1] : ''; })(),
      bgFit: s.backgroundRepeat === 'repeat' ? 'tile' : (s.backgroundSize === 'contain' ? 'contain' : 'cover'),
      strokeWidth: (() => { const m = /^([\d.]+)mm/.exec(s.getPropertyValue('-webkit-text-stroke-width') || ''); return m ? Number(m[1]) : ''; })(),
      strokeColour: rgbToHex(s.getPropertyValue('-webkit-text-stroke-color')) || '#000000',
      textShadow: !!(s.textShadow && s.textShadow !== 'none'),
      shadowX: (() => { const m = /(-?[\d.]+)pt\s+(-?[\d.]+)pt\s+([\d.]+)pt/.exec(s.textShadow || ''); return m ? Number(m[1]) : ''; })(),
      shadowY: (() => { const m = /(-?[\d.]+)pt\s+(-?[\d.]+)pt\s+([\d.]+)pt/.exec(s.textShadow || ''); return m ? Number(m[2]) : ''; })(),
      shadowBlur: (() => { const m = /(-?[\d.]+)pt\s+(-?[\d.]+)pt\s+([\d.]+)pt/.exec(s.textShadow || ''); return m ? Number(m[3]) : ''; })(),
      shadowColour: (() => { const m = /(#[0-9a-f]{6}|rgba?\([^)]+\))\s*$/i.exec(s.textShadow || ''); return m ? (rgbToHex(m[1]) || m[1]) : '#808080'; })(),
    };
  }

  const FRAME_PROPS = ['left', 'top', 'float', 'width', 'max-width', 'height', 'min-height',
    'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
    'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
    'border', 'border-radius', 'background-color', 'break-inside', 'z-index',
    'background-image', 'background-size', 'background-repeat', 'background-position',
    'text-shadow', '-webkit-text-stroke', 'paint-order'];

  /** Write the dialogue back on to the element, as CSS the file carries with it. */
  function setObjectProps(el, v) {
    if (!el) { return; }
    const s = el.style;
    const num = (x) => (x === '' || x == null || isNaN(Number(x)) ? null : Number(x));
    // Wrapping and free placement are two answers to the same question, and CSS can
    // only give one: a floated box is in the flow and the text goes round it, an
    // absolutely placed one is out of the flow and the text goes under it.
    const wrap = (v.wrap === 'left' || v.wrap === 'right') ? v.wrap : '';
    setObjectFree(el, !wrap && v.place === 'free');
    FRAME_PROPS.forEach((p) => s.removeProperty(p));
    const w = num(v.width);
    if (w) { s.width = w + 'mm'; s.maxWidth = 'none'; }
    const h = num(v.height);
    if (h) { if (el.nodeName === 'HR') { s.height = h + 'mm'; } else { s.minHeight = h + 'mm'; } }
    const mt = num(v.mt); const mb = num(v.mb); const ml = num(v.ml); const mr = num(v.mr);
    if (mt != null) { s.marginTop = mt + 'mm'; }
    if (mb != null) { s.marginBottom = mb + 'mm'; }
    if (wrap) {
      s.cssFloat = wrap;
      if (wrap === 'left') {
        s.marginRight = (mr == null ? 6 : mr) + 'mm';
        if (ml != null) { s.marginLeft = ml + 'mm'; }
      } else {
        s.marginLeft = (ml == null ? 6 : ml) + 'mm';
        if (mr != null) { s.marginRight = mr + 'mm'; }
      }
    } else if (v.place === 'free') {
      s.left = (num(v.x) || 0) + 'mm';
      s.top = (num(v.y) || 0) + 'mm';
      if (num(v.z)) { s.zIndex = String(num(v.z)); }
    } else if (v.place === 'center') {
      s.marginLeft = 'auto'; s.marginRight = 'auto';
    } else if (v.place === 'left') {
      s.marginLeft = (ml || 0) + 'mm'; s.marginRight = 'auto';
    } else if (v.place === 'right') {
      s.marginLeft = 'auto'; s.marginRight = (mr || 0) + 'mm';
    } else {
      if (ml != null) { s.marginLeft = ml + 'mm'; }
      if (mr != null) { s.marginRight = mr + 'mm'; }
    }
    const pad = num(v.pad);
    if (pad != null) {
      s.paddingTop = pad + 'mm'; s.paddingBottom = pad + 'mm';
      s.paddingLeft = pad + 'mm'; s.paddingRight = pad + 'mm';
    }
    // A line and an arrow are drawn with a top border and nothing else. Writing
    // the shorthand on one puts a box round it instead of a line through it.
    const rule = el.classList && (el.classList.contains('eb-sh-line') || el.classList.contains('eb-sh-arrow'));
    if (v.border === 'none') {
      s.border = 'none';
    } else if (v.border) {
      const edge = (num(v.borderWidth) || 0.75) + 'pt ' + v.border + ' '
        + (/^#[0-9a-f]{6}$/i.test(v.borderColour || '') ? v.borderColour : '#666666');
      if (rule) { s.border = 'none'; s.borderTop = edge; } else { s.border = edge; }
    }
    const rad = num(v.radius);
    if (rad != null) { s.borderRadius = rad + 'pt'; }
    if (/^#[0-9a-f]{6}$/i.test(v.fill || '')) {
      s.backgroundColor = v.fill;
      el.classList.add('eb-ink');
    } else {
      // Transparent means transparent: the colour has to come off, or the box
      // keeps the fill it was given and nothing shows through it.
      s.removeProperty('background-color');
      el.classList.remove('eb-ink');
    }
    // Turning it. The box drawn round a turned object is the upright box that
    // contains it, which is what a browser measures and what a reader sees.
    const rot = num(v.rotate);
    if (rot != null && Math.abs(rot) > 0.01) {
      s.transform = 'rotate(' + round1(rot) + 'deg)';
      s.transformOrigin = 'center';
    } else {
      s.removeProperty('transform');
      s.removeProperty('transform-origin');
    }
    // Where the words sit in the box. A label in a shape belongs in the middle
    // of it more often than not, and there is nowhere else to say so.
    if (v.vpos !== undefined) {
      ['eb-v-mid', 'eb-v-bot'].forEach((cx) => el.classList.remove(cx));
      if (v.vpos) { el.classList.add(v.vpos); }
    }
    // Which way the words run in this box, whichever way the page runs.
    if (v.flow !== undefined) {
      ['eb-tate', 'eb-yoko'].forEach((cx) => el.classList.remove(cx));
      if (v.flow) { el.classList.add(v.flow); }
    }
    const op = num(v.opacity);
    if (op != null && op >= 0 && op < 100) { s.opacity = String(Math.round(op) / 100); } else { s.removeProperty('opacity'); }
    if (v.shadow) { el.classList.add('eb-shadow'); } else { el.classList.remove('eb-shadow'); }
    // How the words inside are set. Undefined means the caller is not asking about
    // it -- only an empty string clears what is there.
    if (v.inner !== undefined) {
      ['eb-al-l', 'eb-al-c', 'eb-al-r', 'eb-al-j'].forEach((c) => el.classList.remove(c));
      s.removeProperty('text-align');
      if (v.inner) { el.classList.add(v.inner); }
    }
    // A picture behind the words. It is written into the document as a data: URI,
    // so the file still opens on its own with nothing to fetch.
    if (v.bgImage) {
      s.backgroundImage = 'url("' + v.bgImage + '")';
      s.backgroundRepeat = v.bgFit === 'tile' ? 'repeat' : 'no-repeat';
      s.backgroundSize = v.bgFit === 'tile' ? 'auto' : (v.bgFit === 'contain' ? 'contain' : 'cover');
      s.backgroundPosition = 'center center';
      el.classList.add('eb-ink');
    }
    // The outline round each letter. paint-order puts it behind the letter so the
    // stroke grows outwards and the shape of the type is not eaten into.
    const stroke = num(v.strokeWidth);
    if (stroke != null && stroke > 0) {
      s.setProperty('-webkit-text-stroke', round1(stroke) + 'mm '
        + (/^#[0-9a-f]{6}$/i.test(v.strokeColour || '') ? v.strokeColour : '#000000'));
      s.paintOrder = 'stroke fill';
    }
    // The shadow under the letters: how far across, how far down, how soft.
    if (v.textShadow) {
      const sx = num(v.shadowX); const sy = num(v.shadowY); const blur = num(v.shadowBlur);
      s.textShadow = (sx == null ? 1 : sx) + 'pt ' + (sy == null ? 1 : sy) + 'pt '
        + (blur == null ? 1.5 : blur) + 'pt '
        + (/^#[0-9a-f]{6}$/i.test(v.shadowColour || '') ? v.shadowColour : '#808080');
    }
    if (v.keep) { s.breakInside = 'avoid'; }
    if (!el.getAttribute('style')) { el.removeAttribute('style'); }
    if (el.getAttribute('class') === '') { el.removeAttribute('class'); }
  }

  // ---- pagination ----------------------------------------------------------------
  // The editing surface used to be one continuous sheet that simply grew with the
  // text, with a dashed line where a page would end. That is not what a page looks
  // like: the paper was A4 wide but three A4s tall. Now the canvas is laid over a
  // stack of real sheets, and a spacer is pushed in wherever a block would straddle
  // the join, so what is on screen is what comes out of the printer.
  const PAGE_GAP = 16;

  /**
   * Where the spacers go, as pure arithmetic over measured boxes — kept separate
   * from the DOM so the rule can be tested without a browser.
   *
   * @param blocks [{ top, height, forced }] in document order, tops relative to the
   *        start of the text area, measured before any spacer is inserted
   * @param usable the text height of one page
   * @param extra  bottom margin + gap + top margin: the dead band between two pages
   * @return [{ index, spacer }]
   */
  function planPages(blocks, usable, extra) {
    const out = [];
    let shift = 0;
    let pageTop = 0;
    for (let i = 0; i < blocks.length; i++) {
      const top = blocks[i].top + shift;
      const height = blocks[i].height;
      const boundary = pageTop + usable;
      const forced = !!blocks[i].forced && i > 0;
      if (forced || (height <= usable && top < boundary && top + height > boundary + 0.5)) {
        const spacer = Math.max(0, boundary - top) + extra;
        out.push({ index: i, spacer });
        shift += spacer;
        pageTop = boundary + extra;
        continue;
      }
      // Taller than a page — nothing can be done but let it run on; carry the page
      // boundary past it so everything after it lines up again.
      while (height > usable && top + height > pageTop + usable) {
        pageTop += usable + extra;
      }
    }
    return out;
  }

  function makeSpacer(size, tate) {
    const el = document.createElement('div');
    el.className = 'eb-pagespacer';
    el.setAttribute('contenteditable', 'false');
    el.setAttribute('aria-hidden', 'true');
    // A block box measures itself along the block axis: down the page normally,
    // across it when the writing runs down.
    el.style[tate ? 'width' : 'height'] = size + 'px';
    return el;
  }

  /**
   * Lay the text out over the sheets. Returns how many sheets are needed.
   * Does nothing where there is no layout to measure (a document not yet shown,
   * or the test harness), so it can be called freely.
   */
  function paginate() {
    const c = canvas();
    if (!c) { return 1; }
    c.querySelectorAll('.eb-pagespacer').forEach((el) => el.remove());
    const wrap = c.parentNode;
    const sheet = wrap ? wrap.querySelector('.eb-sheet') : null;
    // In 縦書き the text runs down the page and the pages run right to left, so
    // the axis everything below measures along is the horizontal one. The
    // arithmetic is the same; only what is measured changes.
    const tate = !!(c.classList && c.classList.contains('eb-tategaki'));
    const pageH = sheet ? (tate ? sheet.offsetWidth : sheet.offsetHeight) : 0;
    if (!pageH || !(tate ? c.offsetWidth : c.offsetHeight)) { return 1; }
    const style = window.getComputedStyle(c);
    const mt = parseFloat(tate ? style.paddingRight : style.paddingTop) || 0;
    const mb = parseFloat(tate ? style.paddingLeft : style.paddingBottom) || 0;
    const usable = pageH - mt - mb;
    if (usable < 40) { return 1; }
    const extra = mt + mb + PAGE_GAP;

    let pageTop = 0;
    let child = c.firstElementChild;
    let index = 0;
    let pendingBreak = false;
    while (child) {
      const next = child.nextElementSibling;
      if (child.classList.contains('eb-pagebreak')) {
        // The marker stays where the writer put it, at the foot of the page; what
        // moves to the next sheet is the text after it.
        if (index > 0) { pendingBreak = true; }
        index++;
        child = next;
        continue;
      }
      if (!child.classList.contains('eb-pagespacer')) {
        // Right to left: how far the block starts from the right edge of the canvas.
        const top = tate ? (c.offsetWidth - child.offsetLeft - child.offsetWidth - mt) : (child.offsetTop - mt);
        const height = tate ? child.offsetWidth : child.offsetHeight;
        while (top >= pageTop + usable) { pageTop += usable + extra; }
        const boundary = pageTop + usable;
        const forced = pendingBreak;
        pendingBreak = false;
        if (forced || (height <= usable && top < boundary && top + height > boundary + 0.5)) {
          const wanted = boundary + extra;
          const spacer = makeSpacer(Math.max(0, boundary - top) + extra, tate);
          c.insertBefore(spacer, child);
          // Putting an element between two blocks stops their margins collapsing, so
          // the block lands a little lower than the arithmetic says. Measure where it
          // actually went and take the difference back out of the spacer.
          const landed = tate ? (c.offsetWidth - child.offsetLeft - child.offsetWidth - mt) : (child.offsetTop - mt);
          const drift = landed - wanted;
          if (Math.abs(drift) > 0.5) {
            const prop = tate ? 'width' : 'height';
            spacer.style[prop] = Math.max(0, parseFloat(spacer.style[prop]) - drift) + 'px';
          }
          pageTop = wanted;
        } else {
          while (height > usable && top + height > pageTop + usable) {
            pageTop += usable + extra;
          }
        }
        index++;
      }
      child = next;
    }
    // A hair over a page needs another sheet; a hair under must not add one.
    return Math.max(1, Math.ceil(((tate ? c.offsetWidth : c.offsetHeight) + PAGE_GAP - 1) / (pageH + PAGE_GAP)));
  }

  // ---- housekeeping -------------------------------------------------------------
  /** Keep the canvas a flat run of blocks: loose text is what makes contenteditable
   *  produce <div> soup, so it gets a paragraph of its own before that can happen. */
  // A paragraph may not contain a block, and a display=block formula needs its own
  // line.  A native drag and drop breaks both of those rules -- the browser moves
  // the markup its own way -- so every command puts the tree back in order.
  // BLOCKQUOTE and LI are left out on purpose: a quotation holding paragraphs and a
  // list item holding a nested list are both correct HTML.
  const TEXT_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, figcaption';

  /**
   * The classes a document is allowed to wear. Everything else beginning with eb-
   * or app- is this app's own chrome: a drag that starts outside the page hands the
   * browser the editor's own markup, and dropping that in leaves a copy of the whole
   * editor -- desk, paper wrap, canvas and all -- inside the document. That is what
   * turned the page into a grey slab lying over the text.
   */
  const DOC_CLASSES = new Set([
    'eb-doc', 'eb-al-l', 'eb-al-c', 'eb-al-r', 'eb-al-j', 'eb-in1', 'eb-in2', 'eb-in3',
    'eb-box', 'eb-box-title', 'sq', 'dashed', 'thick', 'tint', 'note', 'borderless', 'rows',
    'eb-frame', 'eb-textbox', 'eb-anchor', 'eb-ink', 'eb-shadow', 'eb-flow',
    'eb-shape', 'eb-sh-rect', 'eb-sh-round', 'eb-sh-ellipse', 'eb-sh-line', 'eb-sh-arrow',
    'eb-v-mid', 'eb-v-bot', 'eb-tate', 'eb-yoko',
    'eb-fnref', 'eb-notes', 'eb-notes-title', 'eb-cols', 'eb-runhead', 'eb-runfoot', 'l', 'c', 'r',
    'eb-header', 'eb-footer',
    'eb-ins', 'eb-del',
    'eb-rule-thick', 'eb-rule-dashed', 'eb-table', 'eb-tate', 'eb-note',
    'eb-img', 'eb-img-s', 'eb-img-m', 'eb-img-l', 'eb-img-left', 'eb-img-right',
    'eb-cap-t', 'eb-cap-in', 'eb-cap-none',
    'eb-math-block', 'eb-embed', 'eb-kenten', 'eb-hl-g', 'eb-hl-b', 'eb-hl-p', 'eb-hl-r',
    'eb-pagebreak', 'eb-toc', 'eb-toc-title', 'eb-toc-l1', 'eb-toc-l2', 'eb-toc-l3', 'eb-toc-l4',
    // not part of a document, but the editor's own page spacer lives in the canvas
    'eb-pagespacer',
  ]);
  const APP_IDS = /^(content|app-content|app-navigation|editbase|editbase-root|eb-canvas|header)$/;

  /**
   * Take the chrome out: unwrap anything wearing a class the document model does not
   * know, and drop the ids -- a second element carrying the canvas's own id is what
   * leaves two editors inside one another.
   */
  function stripFurniture(root, allIds) {
    Array.from(root.querySelectorAll('[id]')).forEach((el) => {
      if (allIds || APP_IDS.test(el.getAttribute('id') || '')) { el.removeAttribute('id'); }
    });
    for (let pass = 0; pass < 30; pass++) {
      let again = false;
      Array.from(root.querySelectorAll('[class]')).forEach((el) => {
        if (!el.parentNode) { return; }
        const classes = Array.from(el.classList);
        if (classes.some((c) => !DOC_CLASSES.has(c) && /^(eb-|app-)/.test(c))) {
          const parent = el.parentNode;
          while (el.firstChild) { parent.insertBefore(el.firstChild, el); }
          parent.removeChild(el);
          again = true;
          return;
        }
        const keep = classes.filter((c) => DOC_CLASSES.has(c));
        if (keep.length === classes.length) { return; }
        if (keep.length) { el.setAttribute('class', keep.join(' ')); } else { el.removeAttribute('class'); }
      });
      if (!again) { break; }
    }
  }

  function repairNesting() {
    const c = canvas();
    if (!c) { return; }
    stripFurniture(c, false);
    // A window-sized pixel width means nothing on paper: it is chrome that was
    // dropped in, and it is what covered the page. Pictures and tables may size
    // themselves; a paragraph or a bare div may not.
    // The editor writes every size it sets in millimetres, because it is setting
    // a size on paper. A width in pixels or percent came in from a web page and
    // means nothing here -- so that is the one that goes, and a paragraph the
    // writer has sized by its own box keeps what it was given.
    const paperSize = (v) => /mm$/.test(String(v || '').trim());
    Array.from(c.querySelectorAll('[style]')).forEach((el) => {
      if (/^(IMG|FIGURE|TABLE|TD|TH|COL|COLGROUP)$/.test(el.nodeName)) { return; }
      // A frame is allowed its own size: that is the whole point of a frame.
      if (el.matches && el.matches(OBJECT_SEL)) { return; }
      if (!paperSize(el.style.width)) { el.style.removeProperty('width'); }
      if (!paperSize(el.style.height)) { el.style.removeProperty('height'); }
      if (!el.getAttribute('style')) { el.removeAttribute('style'); }
    });
    Array.from(c.querySelectorAll('math')).forEach((math) => {
      if (math.getAttribute('display') !== 'block') { return; }
      const parent = math.parentNode;
      if (parent && parent.nodeType === 1 && parent.classList && parent.classList.contains('eb-math-block')) { return; }
      const wrap = document.createElement('div');
      wrap.className = 'eb-math-block';
      parent.insertBefore(wrap, math);
      wrap.appendChild(math);
    });
    const lifted = [];
    for (let pass = 0; pass < 20; pass++) {
      let moved = false;
      Array.from(c.querySelectorAll(TEXT_BLOCKS)).forEach((host) => {
        if (!host.parentNode) { return; }
        let anchor = host;
        Array.from(host.children).forEach((child) => {
          if (!isBlock(child)) { return; }
          host.parentNode.insertBefore(child, anchor.nextSibling);
          anchor = child;
          moved = true;
          if (lifted.indexOf(host) < 0) { lifted.push(host); }
        });
      });
      if (!moved) { break; }
    }
    // An anchor holds exactly one frame. Anything else that ends up inside one --
    // a paragraph the browser put there during a drag, say -- goes back to the flow,
    // where it can be read, and an anchor with nothing left in it goes entirely.
    Array.from(c.querySelectorAll('.eb-anchor')).forEach((a) => {
      while (a.children.length > 1) { a.parentNode.insertBefore(a.lastElementChild, a.nextSibling); }
      Array.from(a.childNodes).forEach((n) => { if (n.nodeType === 3) { a.parentNode.insertBefore(n, a.nextSibling); } });
      if (!a.firstElementChild) { a.remove(); }
    });
    // Only a host this pass emptied is removed: an empty figcaption, say, is the
    // placeholder a caption is typed into and has to stay.
    lifted.forEach((host) => {
      if (host.childNodes.length || !host.parentNode) { return; }
      if (host.parentNode === c && c.children.length === 1) {
        host.appendChild(document.createElement('br'));
        return;
      }
      host.remove();
    });
  }

  /**
   * The header is the first thing in the document and the footer the last, and
   * there is one of each or none. They are regions of the page, so they cannot
   * drift into the middle of the writing however the writing is edited.
   */
  function keepRegionsInPlace(c) {
    const heads = Array.from(c.querySelectorAll(':scope > header.eb-header'));
    const feet = Array.from(c.querySelectorAll(':scope > footer.eb-footer'));
    heads.slice(1).forEach((n) => n.remove());
    feet.slice(1).forEach((n) => n.remove());
    const head = heads[0];
    const foot = feet[0];
    if (head && c.firstChild !== head) { c.insertBefore(head, c.firstChild); }
    if (foot && c.lastChild !== foot) { c.appendChild(foot); }
    // Something has to be left to write in between them.
    const rest = Array.from(c.children).filter((n) => n !== head && n !== foot);
    if (!rest.length) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      if (foot) { c.insertBefore(p, foot); } else { c.appendChild(p); }
    }
  }
  /**
   * Words inside a box that are not in a paragraph. Pasted text often arrives as
   * bare runs sitting straight inside a frame, and a run that is not a paragraph
   * is not a block: nothing can be reserved in it, so the words went straight
   * under whatever was laid over them while the paragraphs beside them moved.
   * A paragraph is what words live in -- so they are put in one.
   */
  // Everything that holds blocks rather than words. Words put straight into one
  // of these belong in a paragraph, because a paragraph is what words live in --
  // and because a run that is not a paragraph has no box, and a thing with no
  // box is a thing this editor cannot lay out, move, or keep out of the way of
  // anything else. The owner's rule: no words without a box to put them in.
  const WORD_HOSTS = 'div.eb-frame, aside.eb-box, div.eb-note, div.eb-shape, div.eb-cols,'
    + ' nav.eb-toc, header.eb-header, footer.eb-footer, section.eb-notes';
  function paragraphLooseWords(c) {
    Array.from(c.querySelectorAll(WORD_HOSTS)).forEach((host) => {
      let run = null;
      Array.from(host.childNodes).forEach((n) => {
        const loose = (n.nodeType === 3 && n.data.trim())
          || (n.nodeType === 1 && !isBlock(n) && !n.classList.contains('eb-flow'));
        if (!loose) { run = null; return; }
        if (!run || run.nextSibling !== n) {
          run = document.createElement('p');
          host.insertBefore(run, n);
        }
        run.appendChild(n);
      });
    });
  }
  function normaliseCanvas(pageBreakLabel, captionLabel) {
    const c = canvas();
    if (!c) { return; }
    repairNesting();
    keepRegionsInPlace(c);
    paragraphLooseWords(c);
    tidyMarks();
    renumberNotes();
    Array.from(c.querySelectorAll('table.eb-table')).forEach(headerGroup);
    let stray = null;
    Array.from(c.childNodes).forEach((n) => {
      if (n.nodeType === 3) {
        if (!n.data.trim()) { return; }
        if (!stray || stray.nextSibling !== n) {
          stray = document.createElement('p');
          c.insertBefore(stray, n);
        }
        stray.appendChild(n);
        return;
      }
      if (n.nodeType === 1 && !isBlock(n)) {
        const p = document.createElement('p');
        c.insertBefore(p, n);
        p.appendChild(n);
        return;
      }
      stray = null;
    });
    if (!c.firstChild) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      c.appendChild(p);
    }
    // An object placed by hand is held in an anchor, and that is the only thing
    // that makes its left and top mean anything. Copied through the clipboard it
    // arrives without one, and then it stands in the run of the text carrying a
    // position nothing reads. Give it its anchor back.
    Array.from(c.querySelectorAll(OBJECT_SEL)).forEach((o) => {
      if (objectFree(o) || !o.style || !o.style.left || !o.style.top) { return; }
      if (o.closest && o.closest('.eb-anchor')) { return; }
      const anchor = document.createElement('div');
      anchor.className = 'eb-anchor';
      o.parentNode.insertBefore(anchor, o);
      anchor.appendChild(o);
    });
    c.querySelectorAll('.eb-pagebreak').forEach((el) => {
      el.setAttribute('contenteditable', 'false');
      if (pageBreakLabel) { el.setAttribute('data-label', pageBreakLabel); }
    });
    if (captionLabel) {
      c.querySelectorAll('figure.eb-img figcaption').forEach((el) => el.setAttribute('data-ph', captionLabel));
    }
  }

  /** Caret position as a plain character offset, so it survives a whole-tree restore. */
  function caretOffset() {
    const c = canvas();
    const range = getRange();
    if (!c || !range) { return null; }
    const pre = document.createRange();
    pre.selectNodeContents(c);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }
  function setCaretOffset(offset) {
    const c = canvas();
    if (!c || offset == null) { return; }
    let left = offset;
    const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, null);
    let n = walker.nextNode();
    while (n) {
      if (left <= n.data.length) {
        const r = document.createRange();
        r.setStart(n, left);
        r.collapse(true);
        selectRange(r);
        return;
      }
      left -= n.data.length;
      n = walker.nextNode();
    }
    placeCaretIn(c.lastElementChild || c);
  }

  // ---- undo ---------------------------------------------------------------------
  // The engine rewrites the tree directly, which is exactly what the browser's own
  // undo stack cannot follow — so the editor keeps its own.
  const history = {
    past: [],
    future: [],
    limit: 200,
    lastPush: 0,
    // The document is more than its text: the paper, the styles, the running
    // header. Undo has to put those back too, or changing a style and pressing
    // Ctrl+Z quietly undoes the last thing typed instead.
    readState: null,
    applyState: null,
    state() { return this.readState ? this.readState() : ''; },
    /**
     * A settings change is noticed after it has happened -- the field has already
     * written its value by the time anything is told about it -- so what goes on
     * the stack is the state as it was before, handed in by the caller.
     */
    pushPrev(state) {
      const c = canvas();
      if (!c) { return; }
      this.past.push({ html: c.innerHTML, caret: caretOffset(), state });
      if (this.past.length > this.limit) { this.past.shift(); }
      this.future.length = 0;
      this.lastPush = Date.now();
    },
    push(force) {
      const c = canvas();
      if (!c) { return; }
      const now = Date.now();
      const html = c.innerHTML;
      const state = this.state();
      const top = this.past[this.past.length - 1];
      if (top && top.html === html && top.state === state) { return; }
      // typing is coalesced into bursts; a command always starts a new entry
      if (!force && top && now - this.lastPush < 700) { return; }
      this.past.push({ html, caret: caretOffset(), state });
      if (this.past.length > this.limit) { this.past.shift(); }
      this.future.length = 0;
      this.lastPush = now;
    },
    restore(entry) {
      const c = canvas();
      c.innerHTML = entry.html;
      if (entry.state && this.applyState) { this.applyState(entry.state); }
      setCaretOffset(entry.caret);
      this.lastPush = 0;
    },
    undo() {
      const c = canvas();
      if (!c || !this.past.length) { return false; }
      const current = { html: c.innerHTML, caret: caretOffset(), state: this.state() };
      let entry = this.past.pop();
      if (entry.html === current.html && entry.state === current.state && this.past.length) { entry = this.past.pop(); }
      this.future.push(current);
      this.restore(entry);
      return true;
    },
    redo() {
      const c = canvas();
      if (!c || !this.future.length) { return false; }
      const entry = this.future.pop();
      this.past.push({ html: c.innerHTML, caret: caretOffset(), state: this.state() });
      this.restore(entry);
      return true;
    },
    reset() { this.past.length = 0; this.future.length = 0; this.lastPush = 0; },
  };

  /** Run an editing command as one undoable step. */
  function command(fn, pageBreakLabel, captionLabel) {
    if (!canvas()) { return; }
    history.push(true);
    try {
      fn();
    } finally {
      normaliseCanvas(pageBreakLabel, captionLabel);
      history.lastPush = Date.now();
    }
  }

  // ---- what is switched on at the caret ------------------------------------------
  function activeFormats() {
    const state = { block: '', align: '', list: '', table: false, tableVariant: '', tableHeader: false, image: false, imageSize: '' };
    Object.keys(INLINE_SPECS).forEach((k) => { state[k] = false; });
    const range = getRange();
    if (!range) { return state; }
    const start = range.startContainer;
    Object.keys(INLINE_SPECS).forEach((k) => {
      state[k] = !!closestMatching(start, INLINE_SPECS[k]);
    });
    state.image = !!imageAt(start);
    if (state.image) {
      const fig = imageAt(start);
      state.imageSize = ['eb-img-s', 'eb-img-m', 'eb-img-l'].find((c) => fig.classList.contains(c)) || 'eb-img-m';
    }
    const cell = cellAt(start);
    state.table = !!cell;
    if (cell) {
      const table = tableOf(cell);
      state.tableVariant = table ? (table.className.replace('eb-table', '').trim()) : '';
      state.tableHeader = !!(table && table.querySelector('tr th'));
    }
    const block = topBlockOf(start);
    if (block) {
      state.block = block.nodeName === 'UL' || block.nodeName === 'OL' ? 'P' : block.nodeName;
      state.list = block.nodeName === 'UL' || block.nodeName === 'OL' ? block.nodeName : '';
      state.align = alignOf(block);
      if (block.nodeName === 'LI' && block.parentNode) { state.list = block.parentNode.nodeName; }
    }
    // Inside a table cell, a figure or anything else the style menu does not offer,
    // the menu shows Body text rather than going blank.
    if (['P', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE'].indexOf(state.block) < 0) { state.block = 'P'; }
    return state;
  }
  function closestMatching(node, spec) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== canvas()) {
      if (matchesSpec(n, spec)) { return n; }
      n = n.parentNode;
    }
    return null;
  }

  /**
   * The format under the caret, as a thing that can be carried and put down
   * somewhere else -- what LibreOffice calls the paintbrush.
   */
  function pickFormat() {
    const state = activeFormats();
    const r = getRange();
    let n = r ? r.startContainer : null;
    if (n && n.nodeType === 3) { n = n.parentNode; }
    const style = (n && n.nodeType === 1 && window.getComputedStyle) ? window.getComputedStyle(n) : null;
    const inline = {};
    Object.keys(INLINE_SPECS).forEach((k) => { inline[k] = !!state[k]; });
    // The size and the typeface are taken as they are computed, so a heading hands
    // on the size its style gives it rather than nothing at all.
    return {
      inline,
      colour: rgbToHex(style ? style.color : '') || '',
      fontSize: style ? style.fontSize : '',
      fontFamily: style ? style.fontFamily : '',
    };
  }
  /** Put that format on whatever is selected now. */
  function paintFormat(fmt) {
    if (!fmt) { return; }
    const range = getRange();
    if (!range || range.collapsed) { return; }
    const now = activeFormats();
    Object.keys(INLINE_SPECS).forEach((k) => {
      if (!!fmt.inline[k] !== !!now[k]) { toggleInline(k); }
    });
    applyInlineStyle('color', fmt.colour || '');
    applyInlineStyle('fontSize', fmt.fontSize || '');
    applyInlineStyle('fontFamily', fmt.fontFamily || '');
  }

  // ---- changes under review -------------------------------------------------------
  // What a word processor calls recording changes. HTML has had <ins> and <del>
  // since forever, so a marked-up draft is a plain file anyone can open and read;
  // nothing here is a layer over the document, it is the document.
  function insAt(node) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    const c = canvas();
    while (n && n !== c) {
      if (n.nodeName === 'INS' && n.classList && n.classList.contains('eb-ins')) { return n; }
      n = n.parentNode;
    }
    return null;
  }
  function delAt(node) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    const c = canvas();
    while (n && n !== c) {
      if (n.nodeName === 'DEL' && n.classList && n.classList.contains('eb-del')) { return n; }
      n = n.parentNode;
    }
    return null;
  }
  /** Put the caret inside a run marked as added, making one if there is not one. */
  function ensureIns() {
    const range = getRange();
    if (!range) { return null; }
    const here = insAt(range.startContainer);
    if (here) { return here; }
    const ins = document.createElement('ins');
    ins.className = 'eb-ins';
    // An empty inline element cannot hold a caret; the zero-width space is the
    // editor's own and never reaches the file.
    ins.appendChild(document.createTextNode('​'));
    range.deleteContents();
    range.insertNode(ins);
    const after = document.createRange();
    after.setStart(ins.firstChild, 1);
    after.collapse(true);
    selectRange(after);
    return ins;
  }
  /**
   * Strike a range out rather than taking it away. One <del> per text node, so a
   * deletion that runs across two paragraphs leaves two paragraphs, each with its
   * own mark, and no block ever ends up inside an inline element.
   */
  function markDeleted(range) {
    if (!range || range.collapsed) { return false; }
    const nodes = textNodesInRange(range);
    if (!nodes.length) { return false; }
    let last = null;
    nodes.forEach((n) => {
      if (delAt(n)) { last = n; return; }
      const own = insAt(n);
      if (own) {
        // Text added in this pass is simply taken away again.
        const parent = n.parentNode;
        n.remove();
        if (!own.textContent.replace(/​/g, '')) { own.remove(); } else if (!parent.firstChild) { parent.remove(); }
        return;
      }
      const del = document.createElement('del');
      del.className = 'eb-del';
      n.parentNode.insertBefore(del, n);
      del.appendChild(n);
      last = n;
    });
    return !!last;
  }
  /** Take the marks off: what was added stays, what was struck out goes. */
  function acceptChanges(root) {
    const where = root || canvas();
    if (!where) { return 0; }
    let n = 0;
    Array.from(where.querySelectorAll('del.eb-del')).forEach((el) => { el.remove(); n++; });
    Array.from(where.querySelectorAll('ins.eb-ins')).forEach((el) => {
      const parent = el.parentNode;
      while (el.firstChild) { parent.insertBefore(el.firstChild, el); }
      parent.removeChild(el);
      n++;
    });
    return n;
  }
  /** Put it back as it was: what was added goes, what was struck out stays. */
  function rejectChanges(root) {
    const where = root || canvas();
    if (!where) { return 0; }
    let n = 0;
    Array.from(where.querySelectorAll('ins.eb-ins')).forEach((el) => { el.remove(); n++; });
    Array.from(where.querySelectorAll('del.eb-del')).forEach((el) => {
      const parent = el.parentNode;
      while (el.firstChild) { parent.insertBefore(el.firstChild, el); }
      parent.removeChild(el);
      n++;
    });
    return n;
  }
  /**
   * A mark with nothing in it is litter -- pressing Enter inside one leaves the
   * empty half behind -- and two of the same kind side by side should be one.
   * The one the caret is sitting in is left alone: it is where the next letter
   * is going to land.
   */
  function tidyMarks() {
    const c = canvas();
    if (!c) { return; }
    const at = getRange();
    const here = at ? at.startContainer : null;
    Array.from(c.querySelectorAll('ins.eb-ins, del.eb-del')).forEach((el) => {
      if (el.textContent.replace(/​/g, '')) { return; }
      if (here && el.contains(here)) { return; }
      el.remove();
    });
    Array.from(c.querySelectorAll('ins.eb-ins, del.eb-del')).forEach((el) => {
      const next = el.nextSibling;
      if (!next || next.nodeType !== 1 || next.nodeName !== el.nodeName) { return; }
      if (next.getAttribute('class') !== el.getAttribute('class')) { return; }
      while (next.firstChild) { el.appendChild(next.firstChild); }
      next.remove();
    });
  }
  /** One mark, on its own: keeping it or undoing it must not touch its neighbours. */
  function acceptOne(el) {
    if (!el || !el.parentNode) { return; }
    if (el.nodeName === 'DEL') { el.remove(); return; }
    const parent = el.parentNode;
    while (el.firstChild) { parent.insertBefore(el.firstChild, el); }
    parent.removeChild(el);
  }
  function rejectOne(el) {
    if (!el || !el.parentNode) { return; }
    if (el.nodeName === 'INS') { el.remove(); return; }
    const parent = el.parentNode;
    while (el.firstChild) { parent.insertBefore(el.firstChild, el); }
    parent.removeChild(el);
  }
  function countChanges() {
    const c = canvas();
    if (!c) { return 0; }
    // The one the caret is sitting in has nothing in it yet and is not a change.
    return Array.from(c.querySelectorAll('ins.eb-ins, del.eb-del'))
      .filter((el) => el.textContent.replace(/​/g, '')).length;
  }

  // ---- paste ---------------------------------------------------------------------
  function handlePaste(e, plainOnly, asObject) {
    const data = e.clipboardData;
    if (!data) { return null; }
    e.preventDefault();
    const html = plainOnly ? '' : data.getData('text/html');
    const uri = (data.getData('text/uri-list') || '').split(/\r?\n/).find((l) => /^https?:/i.test(l)) || '';
    history.push(true);
    const out = html ? pasteHtmlAt(html, uri, asObject)
      : { made: pasteTextAt(data.getData('text/plain') || '', asObject), foreign: [] };
    normaliseCanvas();
    return out;
  }

  /**
   * What comes off the clipboard arrives as an object with a box round it, so it
   * can be picked up and put where it belongs rather than being poured into the
   * middle of the writing. Something that is already an object -- a picture, a
   * table, a shape cut from the page -- comes back as itself.
   */
  function objectFromFragment(frag) {
    const kids = Array.from(frag.childNodes).filter((n) => n.nodeType !== 3 || n.data.trim());
    if (!kids.length) { return null; }
    if (kids.length === 1 && kids[0].nodeType === 1 && kids[0].matches && kids[0].matches(OBJECT_SEL)) {
      return kids[0];
    }
    // Blocks need a block to live in; a run of words stays on the line it lands on.
    const hasBlock = kids.some((n) => n.nodeType === 1 && isBlock(n));
    const box = document.createElement(hasBlock ? 'div' : 'span');
    box.className = 'eb-frame';
    box.appendChild(frag);
    return box;
  }
  /** Put a pasted object in, and leave it standing there with its box up. */
  function placePasted(box) {
    if (!box) { return null; }
    if (box.nodeName === 'SPAN' || !isBlock(box)) {
      const frag = document.createDocumentFragment();
      frag.appendChild(box);
      insertFragmentAt(frag);
    } else {
      insertBlockNode(box);
    }
    return box;
  }
  /** The caret is somewhere a new box would be a box inside a box. */
  function pasteWouldNest() {
    const range = getRange();
    const node = range && range.startContainer;
    const el = node && (node.nodeType === 3 ? node.parentNode : node);
    if (!el || !el.closest) { return false; }
    return !!el.closest('.eb-frame, .eb-shape, .eb-box, .eb-note, .eb-math-block, td, th, figcaption');
  }

  /** Drop a fragment in at the caret and leave the caret after it. */
  function insertFragmentAt(frag) {
    const range = getRange();
    if (!range) { return; }
    range.deleteContents();
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      selectRange(after);
    }
  }

  // ---- a page from the web -------------------------------------------------------
  // What a browser puts on the clipboard from a web page is a page, not a document:
  // navigation, sidebars, tracking pixels, and a scaffolding of nested divs holding
  // it all together. None of that belongs in something that is going to be printed.
  // This pulls the writing out of it and leaves the rest behind.
  const WEB_DROP = 'script, style, noscript, template, iframe, object, embed, form,'
    + ' input, select, textarea, button, nav, aside, header, footer, svg, canvas,'
    + ' video, audio, dialog, [hidden], [aria-hidden="true"], [role="navigation"],'
    + ' [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]';
  const WEB_UNWRAP = 'div, section, article, main, span, font, center, small, big,'
    + ' tt, label, picture, hgroup, address, time, abbr';

  function absUrl(url, base) {
    const raw = String(url == null ? '' : url).trim();
    if (!raw || /^(javascript|data:text\/html)/i.test(raw)) { return ''; }
    if (/^(https?:|mailto:|tel:|data:image\/)/i.test(raw)) { return raw; }
    if (!base) { return ''; }
    try { return new URL(raw, base).href; } catch (e) { return ''; }
  }
  function unwrapEl(el) {
    const parent = el.parentNode;
    if (!parent) { return; }
    while (el.firstChild) { parent.insertBefore(el.firstChild, el); }
    parent.removeChild(el);
  }
  /** Loose words and inline bits at the top level become paragraphs of their own. */
  function wrapLoose(root) {
    let run = null;
    Array.from(root.childNodes).forEach((n) => {
      const block = n.nodeType === 1 && isBlock(n);
      if (block || (n.nodeType === 3 && !n.data.trim())) {
        run = null;
        if (n.nodeType === 3 && !n.data.trim()) { root.removeChild(n); }
        return;
      }
      if (!run) {
        run = document.createElement('p');
        root.insertBefore(run, n);
      }
      run.appendChild(n);
    });
  }
  function webToDocument(root, base) {
    root.querySelectorAll(WEB_DROP).forEach((el) => el.remove());
    root.querySelectorAll('a[href]').forEach((a) => {
      const href = absUrl(a.getAttribute('href'), base);
      if (href) { a.setAttribute('href', href); } else { unwrapEl(a); }
    });
    root.querySelectorAll('img').forEach((img) => {
      const src = absUrl(img.getAttribute('src') || img.getAttribute('data-src') || '', base);
      const w = Number(img.getAttribute('width') || 0);
      const h = Number(img.getAttribute('height') || 0);
      // A pixel that measures two by two is counting readers, not showing them
      // anything.
      if (!src || (w && w <= 2) || (h && h <= 2)) { img.remove(); return; }
      img.setAttribute('src', src);
      ['srcset', 'sizes', 'loading', 'decoding', 'width', 'height', 'class', 'id'].forEach((a) => img.removeAttribute(a));
    });
    // Innermost first, and more than once: a page is divs inside divs.
    for (let pass = 0; pass < 8; pass += 1) {
      const found = Array.from(root.querySelectorAll(WEB_UNWRAP));
      if (!found.length) { break; }
      found.reverse().forEach(unwrapEl);
    }
    root.querySelectorAll('table').forEach((t) => {
      t.className = 'eb-table';
      ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'align', 'id'].forEach((a) => t.removeAttribute(a));
      // A table holding one cell is a page's scaffolding, not a table of anything.
      if (t.querySelectorAll('tr').length <= 1 && t.querySelectorAll('td, th').length <= 1) {
        const cell = t.querySelector('td, th');
        if (cell) { t.parentNode.insertBefore(cell, t); unwrapEl(cell); }
        t.remove();
      }
    });
    root.querySelectorAll('dl').forEach((dl) => {
      Array.from(dl.children).forEach((kid) => {
        const p = document.createElement('p');
        while (kid.firstChild) { p.appendChild(kid.firstChild); }
        if (kid.nodeName === 'DT') { const b = document.createElement('strong'); while (p.firstChild) { b.appendChild(p.firstChild); } p.appendChild(b); }
        dl.parentNode.insertBefore(p, dl);
      });
      dl.remove();
    });
    root.querySelectorAll('img').forEach((img) => {
      if (img.closest('figure') || img.closest('td') || img.closest('th')) { return; }
      const fig = document.createElement('figure');
      fig.className = 'eb-img eb-img-m';
      img.parentNode.insertBefore(fig, img);
      fig.appendChild(img);
      const cap = document.createElement('figcaption');
      cap.textContent = img.getAttribute('alt') || '';
      fig.appendChild(cap);
    });
    wrapLoose(root);
    // Anything left holding neither words nor a picture was scaffolding.
    root.querySelectorAll('p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, figcaption')
      .forEach((el) => { if (!el.textContent.trim() && !el.querySelector('img')) { el.remove(); } });
    root.querySelectorAll('ul, ol').forEach((l) => { if (!l.querySelector('li')) { l.remove(); } });
    return root;
  }

  /**
   * The one road in. Whatever arrives -- from the clipboard, from a web page, from
   * a file -- comes through here and leaves as things this document can hold:
   * blocks of writing, and objects with a box round them. Nothing is left as
   * markup the editor cannot pick up.
   *
   * What cannot be made into either is not thrown away quietly: it is handed back
   * so the writer can be asked whether to keep it as an inline frame.
   */
  function adoptContent(html, base) {
    const holder = document.createElement('div');
    holder.innerHTML = String(html == null ? '' : html);
    // A drawing is a picture: it can be carried in the file as one, so it never
    // reaches the list of things that cannot be kept.
    svgToPictures(holder);
    const foreign = [];
    sanitiseInto(holder, { found: foreign });
    holder.querySelectorAll('*').forEach((el) => {
      // Word and Google Docs paste a wall of inline styles; keep the structure only.
      if (el.hasAttribute('style')) {
        const keep = cleanStyle(el.getAttribute('style'))
          .split('; ').filter((d) => /^(color|background-color|text-align)/.test(d)).join('; ');
        if (keep) { el.setAttribute('style', keep); } else { el.removeAttribute('style'); }
      }
    });
    webToDocument(holder, base || baseFromHtml(html));
    stripFurniture(holder, true);
    toObjects(holder);
    return { holder: holder, foreign: dedupeForeign(foreign) };
  }

  /** The same picture, twice over, is one thing to ask about. */
  function dedupeForeign(list) {
    const seen = new Set();
    return list.filter((f) => {
      const key = f.kind + '|' + (f.url || '');
      if (seen.has(key)) { return false; }
      seen.add(key);
      return true;
    }).slice(0, 12);
  }

  /** A drawing becomes a picture of itself, which the file can carry. */
  function svgToPictures(root) {
    Array.from(root.querySelectorAll('svg')).forEach((svg) => {
      try {
        if (svg.closest('svg') !== svg) { return; }
        const box = svg.getAttribute('viewBox');
        const w = Number(svg.getAttribute('width')) || (box ? Number(box.split(/[ ,]+/)[2]) : 0);
        const h = Number(svg.getAttribute('height')) || (box ? Number(box.split(/[ ,]+/)[3]) : 0);
        const clone = svg.cloneNode(true);
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        // A drawing that runs on scripts is not a drawing this file can hold.
        if (clone.querySelector('script, foreignObject')) { return; }
        const text = new XMLSerializer().serializeToString(clone);
        if (text.length > 512 * 1024) { return; }
        const img = document.createElement('img');
        img.setAttribute('src', 'data:image/svg+xml;utf8,' + text.replace(/#/g, '%23').replace(/"/g, "'"));
        img.setAttribute('alt', svg.getAttribute('aria-label') || '');
        if (w && h) { img.setAttribute('width', String(Math.round(w))); img.setAttribute('height', String(Math.round(h))); }
        svg.parentNode.replaceChild(img, svg);
      } catch (e) { /* leave it to be reported as something that cannot be kept */ }
    });
  }

  /**
   * The rule that makes the promise true: after this, everything in the tree is
   * either writing or an object with a box. It runs until it finds nothing left
   * to change, so markup nested inside markup cannot slip through.
   */
  function toObjects(root) {
    for (let pass = 0; pass < 6; pass += 1) {
      let changed = 0;
      // A picture stands in a figure, so it can be picked up, captioned and moved.
      root.querySelectorAll('img').forEach((img) => {
        if (img.closest('td, th, figcaption')) { return; }
        const fig = img.parentNode;
        // Already in a figure of its own: make that figure the document's kind
        // rather than putting a figure inside a figure.
        if (fig && fig.nodeName === 'FIGURE') {
          if (fig.classList.contains('eb-img')) { return; }
          fig.classList.add('eb-img', 'eb-img-m');
          if (!fig.querySelector('figcaption')) {
            const c2 = document.createElement('figcaption');
            c2.textContent = img.getAttribute('alt') || '';
            fig.appendChild(c2);
          }
          changed += 1;
          return;
        }
        const box = document.createElement('figure');
        box.className = 'eb-img eb-img-m';
        img.parentNode.insertBefore(box, img);
        box.appendChild(img);
        const cap = document.createElement('figcaption');
        cap.textContent = img.getAttribute('alt') || '';
        box.appendChild(cap);
        changed += 1;
      });
      root.querySelectorAll('table').forEach((t) => {
        if (t.classList.contains('eb-table')) { return; }
        t.classList.add('eb-table');
        changed += 1;
      });
      root.querySelectorAll('math').forEach((m) => {
        const p = m.parentNode;
        if (p && p.nodeType === 1 && p.classList && p.classList.contains('eb-math-block')) { return; }
        const box = document.createElement('div');
        box.className = 'eb-math-block';
        m.parentNode.insertBefore(box, m);
        box.appendChild(m);
        changed += 1;
      });
      // Anything that was placed rather than written -- given a corner to sit in --
      // is held in an anchor, which is what makes its position mean anything.
      root.querySelectorAll(OBJECT_SEL).forEach((o) => {
        if (!o.style || !o.style.left || !o.style.top) { return; }
        if (o.parentNode && o.parentNode.classList && o.parentNode.classList.contains('eb-anchor')) { return; }
        const anchor = document.createElement('div');
        anchor.className = 'eb-anchor';
        o.parentNode.insertBefore(anchor, o);
        anchor.appendChild(o);
        changed += 1;
      });
      if (!changed) { break; }
    }
    return root;
  }

  /**
   * An inline frame, with a box round it like any other object -- but while it is
   * being written, only its address is held. The frame itself is put in when the
   * file is written.
   *
   * Two reasons. Nextcloud's own policy refuses to let its pages frame anything
   * from elsewhere, so a live frame in the editor is an empty grey rectangle and
   * an error in the console. And a document being written should not be fetching
   * pages from other people's servers every time it is opened for editing.
   */
  function makeEmbed(url, wMm, hMm) {
    const box = document.createElement('div');
    box.className = 'eb-embed';
    box.setAttribute('data-url', url);
    box.style.width = (wMm || 120) + 'mm';
    box.style.minHeight = (hMm || 70) + 'mm';
    return box;
  }
  /** The frame itself, put in on the way out to the file. */
  function fillEmbeds(root) {
    root.querySelectorAll('div.eb-embed[data-url]').forEach((box) => {
      Array.from(box.querySelectorAll('iframe')).forEach((f) => f.remove());
      const url = box.getAttribute('data-url') || '';
      if (!/^https:\/\//i.test(url)) { return; }
      const frame = document.createElement('iframe');
      frame.setAttribute('src', url);
      frame.setAttribute('loading', 'lazy');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      box.appendChild(frame);
    });
    return root;
  }

  /** Everything that arrives comes through the one road: see adoptContent. */
  function pasteHtmlAt(html, base, asObject) {
    const taken = adoptContent(html, base);
    const holder = taken.holder;
    const frag = document.createDocumentFragment();
    while (holder.firstChild) { frag.appendChild(holder.firstChild); }
    const made = asObject ? placePasted(objectFromFragment(frag)) : (insertFragmentAt(frag), null);
    return { made: made, foreign: taken.foreign };
  }

  /** Chrome and Safari put the page's own address in the clipboard markup. */
  function baseFromHtml(html) {
    const m = String(html || '').match(/<base[^>]+href=["']([^"']+)["']/i)
      || String(html || '').match(/<!--\s*(?:StartFragment|SourceURL)\s*:?\s*(https?:\/\/[^\s>-]+)/i);
    return m ? m[1] : '';
  }
  function pasteTextAt(text, asObject) {
    const frag = document.createDocumentFragment();
    String(text == null ? '' : text).split(/\r?\n/).forEach((line, i) => {
      if (i) { frag.appendChild(document.createElement('br')); }
      frag.appendChild(document.createTextNode(line));
    });
    if (asObject) { return placePasted(objectFromFragment(frag)); }
    insertFragmentAt(frag);
    return null;
  }

  // ---- other apps on this server -------------------------------------------------
  /** A table of strings, as the document's own table markup. */
  function tableFromRows(columns, rows, withHeader) {
    const table = document.createElement('table');
    table.className = 'eb-table';
    const tbody = document.createElement('tbody');
    if (withHeader && columns.length) {
      const tr = document.createElement('tr');
      columns.forEach((title) => {
        const th = document.createElement('th');
        th.textContent = String(title == null ? '' : title);
        tr.appendChild(th);
      });
      tbody.appendChild(tr);
    }
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      (columns.length ? columns : row).forEach((_, i) => {
        const td = document.createElement('td');
        const value = String(row[i] == null ? '' : row[i]);
        if (value === '') { td.appendChild(document.createElement('br')); } else { td.textContent = value; }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /** Notes are Markdown; only the parts a document actually needs are converted. */
  function markdownToHtml(md) {
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (t) => esc(t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    const out = [];
    let list = null;
    String(md || '').split(/\r?\n/).forEach((line) => {
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
      if (heading) {
        closeList();
        const level = Math.min(6, heading[1].length);
        out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
        return;
      }
      if (bullet || numbered) {
        const want = bullet ? 'ul' : 'ol';
        if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
        out.push('<li>' + inline((bullet || numbered)[1]) + '</li>');
        return;
      }
      closeList();
      if (line.trim() === '') { return; }
      out.push('<p>' + inline(line) + '</p>');
    });
    if (list) { out.push('</' + list + '>'); }
    return out.join('\n');
  }

  /** Placeholders are written as {{key}} and filled in by the merge. */
  function fillPlaceholders(html, values) {
    return String(html).replace(/\{\{\s*([\w.-]{1,64})\s*\}\}/g, (whole, key) => {
      const v = values[key];
      return v == null ? '' : String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    });
  }
  function placeholdersIn(html) {
    const found = [];
    String(html).replace(/\{\{\s*([\w.-]{1,64})\s*\}\}/g, (whole, key) => {
      if (found.indexOf(key) < 0) { found.push(key); }
      return whole;
    });
    return found;
  }

  // ---- find and replace ----------------------------------------------------------
  // Matching runs over the document's text as one string, so a phrase still matches
  // when part of it happens to be bold — which is exactly where a per-node search
  // fails and where people notice.
  function textMap() {
    const c = canvas();
    const chunks = [];
    let full = '';
    if (!c) { return { chunks, full }; }
    const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, null);
    let n = walker.nextNode();
    while (n) {
      if (n.data.length) {
        chunks.push({ node: n, at: full.length, len: n.data.length });
        full += n.data;
      }
      n = walker.nextNode();
    }
    return { chunks, full };
  }
  function pointFor(chunks, offset) {
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (offset <= ch.at + ch.len) { return { node: ch.node, offset: Math.max(0, offset - ch.at) }; }
    }
    const last = chunks[chunks.length - 1];
    return last ? { node: last.node, offset: last.len } : null;
  }
  function rangeBetween(chunks, from, to) {
    const a = pointFor(chunks, from);
    const b = pointFor(chunks, to);
    if (!a || !b) { return null; }
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  }
  /** Every occurrence, as [start, end] offsets into the document's text. */
  function findAll(query, caseSensitive) {
    const { chunks, full } = textMap();
    const out = [];
    if (!query) { return { chunks, hits: out }; }
    const hay = caseSensitive ? full : full.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    let at = hay.indexOf(needle);
    while (at >= 0) {
      out.push([at, at + needle.length]);
      at = hay.indexOf(needle, at + Math.max(1, needle.length));
    }
    return { chunks, hits: out };
  }
  function selectHit(chunks, hit) {
    const r = rangeBetween(chunks, hit[0], hit[1]);
    if (!r) { return false; }
    selectRange(r);
    const box = r.getBoundingClientRect ? r.getBoundingClientRect() : null;
    const el = r.startContainer.parentElement;
    if (el && el.scrollIntoView && (!box || box.height === 0 || box.top < 0 || box.top > window.innerHeight)) {
      el.scrollIntoView({ block: 'center' });
    }
    return true;
  }
  /** Replace one occurrence; the caller has already taken a snapshot. */
  function replaceRange(chunks, hit, text) {
    const r = rangeBetween(chunks, hit[0], hit[1]);
    if (!r) { return null; }
    r.deleteContents();
    const node = document.createTextNode(text);
    r.insertNode(node);
    const after = document.createRange();
    after.setStartAfter(node);
    after.collapse(true);
    selectRange(after);
    return node;
  }

  // ---- pictures on the way in ----------------------------------------------------
  /**
   * Photographs come off phones at 4000px and 8 MB; embedded whole they would make a
   * document nobody can open or mail. Anything past the size a page can actually show
   * is resampled in the browser before it goes in. Vector and animated images are left
   * exactly as they are — resampling those would destroy them.
   */
  function loadImage(src) {
    // Times out rather than hanging: a picture that will not decode must not leave
    // the editor waiting for an event that is never coming.
    return new Promise((resolve, reject) => {
      const img = new Image();
      const timer = setTimeout(() => reject(new Error('image timed out')), 8000);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('image could not be read')); };
      img.src = src;
    });
  }
  /** How big a picture is in its own pixels. */
  function imageSize(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = url;
    });
  }

  /** Is any pixel less than solid? A picture with holes in it may not be JPEG. */
  function hasTransparency(ctx, w, h) {
    try {
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4) { if (data[i] !== 255) { return true; } }
      return false;
    } catch (e) { return true; }   // tainted or refused: assume it has, and keep PNG
  }
  /**
   * A picture goes into the document itself, so its weight is the document's
   * weight. Two things are done to it: it is brought down to a size a printed
   * page can use, and -- if it is a photograph -- it is kept as a photograph.
   *
   * A photograph saved as PNG is enormous: one 1024-pixel picture came to 912kB
   * and made a two-page document weigh 1.2MB, every save and every open. As JPEG
   * the same picture is a tenth of that and looks the same on paper. Line art and
   * screenshots are left as PNG, because JPEG smears text -- which is why the
   * JPEG is only taken when it is dramatically smaller, as it is for photographs
   * and is not for a screenshot of a spreadsheet.
   */
  async function shrinkImage(dataUrl, mime, maxEdge) {
    const limit = maxEdge || 2200;
    if (mime === 'image/svg+xml' || mime === 'image/gif') { return dataUrl; }
    const probe = document.createElement('canvas');
    if (typeof probe.getContext !== 'function') { return dataUrl; }
    let img;
    try { img = await loadImage(dataUrl); } catch (e) { return dataUrl; }
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    const edge = Math.max(w0, h0);
    const scale = edge > limit ? limit / edge : 1;
    const canvasEl = document.createElement('canvas');
    canvasEl.width = Math.round(w0 * scale);
    canvasEl.height = Math.round(h0 * scale);
    if (!canvasEl.width || !canvasEl.height) { return dataUrl; }
    const ctx = canvasEl.getContext('2d');
    if (!ctx) { return dataUrl; }
    ctx.drawImage(img, 0, 0, canvasEl.width, canvasEl.height);
    const png = scale < 1 ? canvasEl.toDataURL('image/png') : dataUrl;
    let best = png.length < dataUrl.length ? png : dataUrl;
    if (!hasTransparency(ctx, canvasEl.width, canvasEl.height)) {
      const jpeg = canvasEl.toDataURL('image/jpeg', 0.85);
      // Only when it is a great deal smaller: that is what tells a photograph
      // from a screenshot, and a screenshot must stay sharp.
      if (jpeg.length && jpeg.length < best.length * 0.6) { best = jpeg; }
    }
    return best;
  }
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('file could not be read'));
      reader.readAsDataURL(file);
    });
  }

  // ---- printing --------------------------------------------------------------------
  /** Print the artefact itself, in an isolated frame, so no application style can
   *  reach the page and what comes out is byte-for-byte what the file contains. */
  function printHtml(html, rule) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;';
    document.body.appendChild(frame);
    // The sheet is printed from a frame, and a browser asked to print a frame may
    // take its paper from the page around it -- which is the app's own page, and
    // says nothing about paper. Then A4 came out on whatever the printer happened
    // to default to. Say it on both documents for as long as the printing lasts.
    let outer = null;
    if (rule) {
      outer = document.createElement('style');
      outer.media = 'print';
      outer.textContent = rule;
      document.head.appendChild(outer);
    }
    const done = () => { setTimeout(() => { frame.remove(); if (outer) { outer.remove(); } }, 1000); };
    frame.onload = () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (e) { /* the user can still print from the browser menu */ }
      done();
    };
    frame.srcdoc = html;
  }

  function downloadHtml(name, html) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = /\.html?$/i.test(name) ? name : name + '.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---- the chrome (Vue) --------------------------------------------------------
  // The supplied EditBase logo, inline so it needs no extra request and can be
  // themed by the page around it. Kept identical to img/logo.svg.
  const LOGO = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"334 400 1332 1014\" aria-hidden=\"true\"><path fill=\"none\" stroke=\"#ffffff\" stroke-width=\"100\" d=\"M1040.38,1352.06c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43,26.05,14.29,45.51,33.06,58.4,56.3,12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.94-37.12,45.1-67.65,60.51-30.54,15.41-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1353.41,1228.53c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.61-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1284.5,900.79l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.61,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z\"/><path fill=\"#2e3192\" d=\"M1040.38,1352.06c-3.65-4.48-4.91-9.8-3.78-15.97l115.97-542.87c1.12-6.16,4.33-11.48,9.66-15.97,5.32-4.48,11.06-6.72,17.23-6.72h262.19c37.53,0,69.33,7.14,95.38,21.43,26.05,14.29,45.51,33.06,58.4,56.3,12.88,23.25,19.33,47.77,19.33,73.53,0,12.33-1.13,22.98-3.36,31.93-5.61,28.02-15.27,50.57-28.99,67.65-13.73,17.1-27.31,30.12-40.76,39.08,25.21,20.73,37.82,47.62,37.82,80.67,0,12.89-1.68,27.46-5.04,43.7-7.85,35.29-19.05,65.42-33.61,90.34-14.57,24.94-37.12,45.1-67.65,60.51-30.54,15.41-71.01,23.11-121.43,23.11h-296.64c-6.17,0-11.07-2.23-14.71-6.72ZM1353.41,1228.53c19.04,0,35.15-6.16,48.32-18.49,13.16-12.32,19.75-27.17,19.75-44.54,0-11.76-4.2-21.28-12.61-28.57-8.4-7.27-19.62-10.92-33.61-10.92h-138.66l-21.85,102.52h138.66ZM1284.5,900.79l-20.17,95.8h130.25c16.81,0,30.53-4.2,41.18-12.61,10.64-8.4,17.36-20.17,20.17-35.29,1.12-6.72,1.68-11.2,1.68-13.45,0-11.2-3.65-19.75-10.92-25.63-7.29-5.88-17.94-8.82-31.93-8.82h-130.25Z\"/><path fill=\"#e56b00\" d=\"M667.77,1153.57h411.45c9.55,0,16.92,3.47,22.14,10.38,5.2,6.91,6.94,15.11,5.2,24.61l-29.94,137.39c-1.75,9.5-6.73,17.72-14.98,24.62s-17.14,10.36-26.69,10.36H417.75c-9.55,0-17.14-3.45-22.78-10.36-5.66-6.91-7.61-15.12-5.86-24.62l179.69-837.22c1.73-9.5,6.72-17.72,14.97-24.62s17.14-10.38,26.7-10.38h606.78c9.53,0,17.12,3.47,22.78,10.38,5.64,6.91,7.59,15.12,5.86,24.62l-29.95,137.38c-1.73,9.5-6.94,17.72-15.62,24.62s-17.8,10.36-27.34,10.36h-401.05l-29.94,139.97h372.39c9.55,0,17.14,3.47,22.78,10.38s7.59,15.12,5.88,24.62l-29.95,137.38c-1.75,9.5-6.95,17.72-15.62,24.62-8.69,6.91-17.8,10.36-27.34,10.36h-372.41l-29.94,145.16Z\"/><path fill=\"none\" stroke=\"#ffffff\" stroke-width=\"106.22\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M667.77,1153.57h411.45c9.55,0,16.92,3.47,22.14,10.38,5.2,6.91,6.94,15.11,5.2,24.61l-29.94,137.39c-1.75,9.5-6.73,17.72-14.98,24.62s-17.14,10.36-26.69,10.36H417.75c-9.55,0-17.14-3.45-22.78-10.36-5.66-6.91-7.61-15.12-5.86-24.62l179.69-837.22c1.73-9.5,6.72-17.72,14.97-24.62s17.14-10.38,26.7-10.38h606.78c9.53,0,17.12,3.47,22.78,10.38,5.64,6.91,7.59,15.12,5.86,24.62l-29.95,137.38c-1.73,9.5-6.94,17.72-15.62,24.62s-17.8,10.36-27.34,10.36h-401.05l-29.94,139.97h372.39c9.55,0,17.14,3.47,22.78,10.38s7.59,15.12,5.88,24.62l-29.95,137.38c-1.75,9.5-6.95,17.72-15.62,24.62-8.69,6.91-17.8,10.36-27.34,10.36h-372.41l-29.94,145.16Z\"/><path fill=\"#0000ff\" d=\"M667.77,1153.57h411.45c9.55,0,16.92,3.47,22.14,10.38,5.2,6.91,6.94,15.11,5.2,24.61l-29.94,137.39c-1.75,9.5-6.73,17.72-14.98,24.62s-17.14,10.36-26.69,10.36H417.75c-9.55,0-17.14-3.45-22.78-10.36-5.66-6.91-7.61-15.12-5.86-24.62l179.69-837.22c1.73-9.5,6.72-17.72,14.97-24.62s17.14-10.38,26.7-10.38h606.78c9.53,0,17.12,3.47,22.78,10.38,5.64,6.91,7.59,15.12,5.86,24.62l-29.95,137.38c-1.73,9.5-6.94,17.72-15.62,24.62s-17.8,10.36-27.34,10.36h-401.05l-29.94,139.97h372.39c9.55,0,17.14,3.47,22.78,10.38s7.59,15.12,5.88,24.62l-29.95,137.38c-1.75,9.5-6.95,17.72-15.62,24.62-8.69,6.91-17.8,10.36-27.34,10.36h-372.41l-29.94,145.16Z\"/></svg>";

  // ---- icons -------------------------------------------------------------------
  // Drawn, not typed: emoji and box-drawing characters render differently on every
  // platform, and half of them have no glyph at all on a plain Linux server.
  const I = (paths, opts) => '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="' + ((opts && opts.w) || 1.5) + '" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  const ICONS = {
    highlight: I('<path d="M9.5 2.5 13 6l-5 5H5.5L4 9.5z"/><path d="M3 13.5h10"/>'),
    colour: I('<path d="M8 1.8c3.4 0 6.2 2.5 6.2 5.6 0 2-1.6 2.9-2.8 2.9h-1.2c-1 0-1.7.7-1.7 1.6 0 .4.2.8.4 1.1.2.3.3.6.3.9 0 .6-.5 1.1-1.2 1.1C4.4 15 1.8 11.9 1.8 8.2 1.8 4.7 4.6 1.8 8 1.8z"/><circle cx="5.4" cy="7" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="4.9" r=".9" fill="currentColor" stroke="none"/><circle cx="10.8" cy="6.6" r=".9" fill="currentColor" stroke="none"/>'),
    nocolour: I('<circle cx="8" cy="8" r="6"/><path d="M4 12 12 4"/>'),
    ul: I('<path d="M6 4h8M6 8h8M6 12h8"/><circle cx="3" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="1" fill="currentColor" stroke="none"/>'),
    ol: I('<path d="M6 4h8M6 8h8M6 12h8"/><text x="1.2" y="5.4" font-size="4.6" fill="currentColor" stroke="none">1</text><text x="1.2" y="9.4" font-size="4.6" fill="currentColor" stroke="none">2</text><text x="1.2" y="13.4" font-size="4.6" fill="currentColor" stroke="none">3</text>'),
    indent: I('<path d="M7 4h8M7 8h8M7 12h8M2 5.5 4.5 8 2 10.5z" />'),
    outdent: I('<path d="M7 4h8M7 8h8M7 12h8M4.5 5.5 2 8l2.5 2.5z"/>'),
    table: I('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1"/><path d="M1.8 6.3h12.4M1.8 9.8h12.4M6 2.8v10.4M10 2.8v10.4"/>'),
    box: I('<rect x="2" y="3" width="12" height="10" rx="2.5"/><path d="M4.5 6.5h5"/>'),
    rule: I('<path d="M2 8h12"/>'),
    pagebreak: I('<path d="M2 8h12" stroke-dasharray="2 2"/><path d="M8 2v3.4M6.4 4 8 5.6 9.6 4M8 14v-3.4M6.4 12 8 10.4 9.6 12"/>'),
    formula: I('<path d="M4 3h7l-4 5 4 5H4"/>'),
    clear: I('<path d="M6 3h7M9.5 3 7 13M3 13h6"/><path d="M11 9.5 14.5 13M14.5 9.5 11 13"/>'),
    undo: I('<path d="M3 8h7.5a3 3 0 0 1 0 6H7"/><path d="M5.5 5.5 3 8l2.5 2.5"/>'),
    redo: I('<path d="M13 8H5.5a3 3 0 0 0 0 6H9"/><path d="M10.5 5.5 13 8l-2.5 2.5"/>'),
    guides: I('<rect x="1.6" y="1.6" width="12.8" height="12.8" rx="1"/><rect x="4" y="3.6" width="8" height="8.8" stroke-dasharray="2 1.6"/>'),
    frame: I('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.6 6.4h6.8M4.6 9.6h4.4"/>'),
    free: I('<rect x="1.8" y="4.6" width="8.6" height="7.6" rx="1"/><path d="M5.6 4.6V2.6a1 1 0 0 1 1-1h6.6a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1h-2"/>'),
    pageView: I('<rect x="3.4" y="1.8" width="9.2" height="12.4" rx="1"/><path d="M5.8 5h4.4M5.8 8h4.4M5.8 11h2.6"/>'),
    screenView: I('<rect x="1.6" y="3" width="12.8" height="8.4" rx="1"/><path d="M6 13.6h4"/>'),
    review: I('<path d="M2.6 12.4 5 12l7.4-7.4a1.4 1.4 0 0 0-2-2L3 10z"/><path d="M2.6 14.4h10.8"/>'),
    crop: I('<path d="M4.6 1.6v9.8h9.8M1.6 4.6h9.8v9.8"/>'),
    cellBorder: I('<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M8 3v10M2 8h12" stroke-dasharray="1.6 1.4"/>'),
    vTop: I('<path d="M2.6 2.6h10.8"/><path d="M8 5v7.4M5.6 10 8 12.4 10.4 10"/>'),
    vMid: I('<path d="M2.6 8h10.8"/><path d="M8 2.4v3M8 10.6v3"/>'),
    vBot: I('<path d="M2.6 13.4h10.8"/><path d="M8 3.6V11M5.6 6 8 3.6 10.4 6"/>'),
    ruler: I('<rect x="1.6" y="5" width="12.8" height="6" rx="1"/><path d="M4.4 5v2.4M7 5v3.4M9.6 5v2.4M12.2 5v3.4"/>'),
    ruby: I('<path d="M3 12.6h10M4.6 9.6 8 3.4l3.4 6.2"/><path d="M4.4 2.2h7.2" stroke-width="1"/>'),
    note: I('<path d="M3 3.6h10M3 7h10M3 10.4h6"/><circle cx="12.6" cy="11" r="2.2"/>'),
    columns: I('<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M8 3v10" stroke-dasharray="2 1.6"/>'),
    brush: I('<path d="M4.4 9.6 10.8 3.2a1.7 1.7 0 0 1 2.4 2.4L6.8 12"/><path d="M4.4 9.6 6.8 12l-1.6 1.4a2 2 0 0 1-2.8-2.8z"/>'),
    header: I('<rect x="2" y="2.4" width="12" height="11.2" rx="1"/><path d="M2 5.6h12" stroke-dasharray="2 1.6"/><path d="M2 10.8h12" stroke-dasharray="2 1.6"/>'),
    grip: I('<circle cx="6" cy="3.6" r=".95" fill="currentColor" stroke="none"/><circle cx="10" cy="3.6" r=".95" fill="currentColor" stroke="none"/><circle cx="6" cy="8" r=".95" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r=".95" fill="currentColor" stroke="none"/><circle cx="6" cy="12.4" r=".95" fill="currentColor" stroke="none"/><circle cx="10" cy="12.4" r=".95" fill="currentColor" stroke="none"/>'),
    wrapNone: I('<rect x="3.5" y="4.5" width="9" height="7" rx="1"/><path d="M2 2.4h12M2 13.6h12"/>'),
    wrapLeft: I('<rect x="2" y="4.5" width="6" height="7" rx="1"/><path d="M9.6 5.4h4.4M9.6 8h4.4M9.6 10.6h4.4"/>'),
    wrapRight: I('<rect x="8" y="4.5" width="6" height="7" rx="1"/><path d="M2 5.4h4.4M2 8h4.4M2 10.6h4.4"/>'),
    pages: I('<rect x="2.4" y="1.8" width="7.6" height="9.6" rx=".6"/><rect x="5.4" y="4.4" width="7.6" height="9.6" rx=".6"/>'),
    layers: I('<path d="M8 1.8 14 5 8 8.2 2 5z"/><path d="M2 8l6 3.2L14 8"/><path d="M2 11l6 3.2L14 11"/>'),
    header: I('<rect x="2" y="2.6" width="12" height="3.4" rx=".6" fill="currentColor" stroke="none" opacity=".85"/><path d="M2.6 8.6h10.8M2.6 11h10.8M2.6 13.2h7"/>'),
    footer: I('<path d="M2.6 2.8h10.8M2.6 5h10.8M2.6 7.2h7"/><rect x="2" y="10" width="12" height="3.4" rx=".6" fill="currentColor" stroke="none" opacity=".85"/>'),
    wrapBoth: I('<rect x="5.6" y="4.5" width="4.8" height="7" rx="1"/><path d="M1.6 5.4h3M1.6 8h3M1.6 10.6h3M11.4 5.4h3M11.4 8h3M11.4 10.6h3"/>'),
    wrapThrough: I('<rect x="4.5" y="4.5" width="7" height="7" rx="1"/><path d="M1.6 5.4h12.8M1.6 8h12.8M1.6 10.6h12.8"/>'),
    grid: I('<path d="M1.4 6h13.2M1.4 10h13.2M6 1.4v13.2M10 1.4v13.2"/><rect x="1.4" y="1.4" width="13.2" height="13.2" rx="1"/>', { w: 1.1 }),
    boxes: I('<rect x="2.6" y="3.6" width="10.8" height="8.8" rx=".6" stroke-dasharray="2 1.6"/><path d="M1.4 2.4h2.4M12.2 2.4h2.4M1.4 13.6h2.4M12.2 13.6h2.4"/>'),
    palette: I('<rect x="1.4" y="2" width="5.2" height="5.2" rx="1"/><rect x="1.4" y="8.8" width="5.2" height="5.2" rx="1"/><path d="M9.4 4.6h5.2M9.4 8h5.2M9.4 11.4h5.2"/>'),
    spread: I('<rect x="1" y="4" width="3.4" height="8" rx=".8"/><rect x="6.3" y="4" width="3.4" height="8" rx=".8"/><rect x="11.6" y="4" width="3.4" height="8" rx=".8"/>'),
    sameSize: I('<rect x="1.2" y="3" width="6" height="10" rx="1"/><rect x="8.8" y="3" width="6" height="10" rx="1" stroke-dasharray="2 1.6"/>'),
    toFront: I('<rect x="1.2" y="1.2" width="9" height="9" rx="1" fill="none"/><rect x="5.8" y="5.8" width="9" height="9" rx="1" fill="currentColor" stroke="none"/>'),
    toBack: I('<rect x="5.8" y="5.8" width="9" height="9" rx="1" fill="none"/><rect x="1.2" y="1.2" width="9" height="9" rx="1" fill="currentColor" stroke="none"/>'),
    boxL: I('<rect x="1" y="2.2" width="14" height="11.6" rx="1"/><rect x="2.4" y="5.2" width="5.2" height="5.6" rx=".6" fill="currentColor" stroke="none"/>'),
    boxC: I('<rect x="1" y="2.2" width="14" height="11.6" rx="1"/><rect x="5.4" y="5.2" width="5.2" height="5.6" rx=".6" fill="currentColor" stroke="none"/>'),
    boxR: I('<rect x="1" y="2.2" width="14" height="11.6" rx="1"/><rect x="8.4" y="5.2" width="5.2" height="5.6" rx=".6" fill="currentColor" stroke="none"/>'),
    boxW: I('<rect x="1" y="2.2" width="14" height="11.6" rx="1"/><rect x="2.4" y="5.2" width="11.2" height="5.6" rx=".6" fill="currentColor" stroke="none"/>'),
    props: I('<path d="M2.6 4.4h10.8M2.6 8h10.8M2.6 11.6h10.8"/><circle cx="5.6" cy="4.4" r="1.5" fill="currentColor" stroke="none"/><circle cx="10.4" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="6.6" cy="11.6" r="1.5" fill="currentColor" stroke="none"/>'),
    save: I('<path d="M3 2.8h7.5L13.2 5.5V13a.8.8 0 0 1-.8.8H3.6a.8.8 0 0 1-.8-.8V3.6a.8.8 0 0 1 .8-.8z"/><path d="M5.5 2.8v3.4h5V2.8M5.5 13.8v-3.6h5v3.6"/>'),
    print: I('<path d="M4.5 6V2.5h7V6"/><rect x="2.2" y="6" width="11.6" height="5" rx="1"/><path d="M4.5 9.5h7v4h-7z"/>'),
    more: I('<circle cx="3.2" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.8" cy="8" r="1.1" fill="currentColor" stroke="none"/>'),
    menu: I('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
    plus: I('<path d="M8 3.5v9M3.5 8h9"/>'),
    minus: I('<path d="M3.5 8h9"/>'),
    down: I('<path d="M4 6.5 8 10.5l4-4"/>'),
    paper: I('<path d="M3.5 1.8h6l3 3v9.4a.6.6 0 0 1-.6.6H3.5a.6.6 0 0 1-.6-.6V2.4a.6.6 0 0 1 .6-.6z"/><path d="M9.3 1.8v3.3h3.2"/>'),
    settings: I('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5"/>'),
    doc: I('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M8.8 1.8v3.3H12"/><path d="M6 8h4M6 10.5h4"/>'),
    text: I('<path d="M3 3.5h10M8 3.5V13M6 13h4"/>'),
    search: I('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/>'),
    check: I('<path d="M3 8.5 6.5 12 13 4.5"/>'),
    close: I('<path d="M4 4l8 8M12 4l-8 8"/>'),
    link: I('<path d="M6.6 9.4a3 3 0 0 0 4.2 0l2.2-2.2a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M9.4 6.6a3 3 0 0 0-4.2 0L3 8.8a3 3 0 0 0 4.2 4.2l1-1"/>'),
    image: I('<rect x="1.8" y="3" width="12.4" height="10" rx="1.2"/><circle cx="5.6" cy="6.6" r="1.1"/><path d="M2.2 11.4 6 8.2l2.6 2.2 2.3-1.8 2.9 2.6"/>'),
    folder: I('<path d="M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.6h6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>'),
    up: I('<path d="M8 13V3.5M4 7.5 8 3.5l4 4"/>'),
    search2: I('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/>'),
    rowAbove: I('<rect x="1.8" y="6" width="12.4" height="8.2" rx="1"/><path d="M1.8 10.1h12.4M6 6v8.2M10 6v8.2"/><path d="M8 1.2v3.4M6.4 2.8 8 1.2l1.6 1.6"/>'),
    rowBelow: I('<rect x="1.8" y="1.8" width="12.4" height="8.2" rx="1"/><path d="M1.8 5.9h12.4M6 1.8v8.2M10 1.8v8.2"/><path d="M8 14.8v-3.4M6.4 13.2 8 14.8l1.6-1.6"/>'),
    colLeft: I('<rect x="6" y="1.8" width="8.2" height="12.4" rx="1"/><path d="M10.1 1.8v12.4M6 6h8.2M6 10h8.2"/><path d="M1.2 8h3.4M2.8 6.4 1.2 8l1.6 1.6"/>'),
    colRight: I('<rect x="1.8" y="1.8" width="8.2" height="12.4" rx="1"/><path d="M5.9 1.8v12.4M1.8 6h8.2M1.8 10h8.2"/><path d="M14.8 8h-3.4M13.2 6.4 14.8 8l-1.6 1.6"/>'),
    rowDel: I('<rect x="1.8" y="2.4" width="12.4" height="7.2" rx="1"/><path d="M1.8 6h12.4M6 2.4v7.2M10 2.4v7.2"/><path d="M5.6 12 10.4 15.2M10.4 12 5.6 15.2"/>'),
    colDel: I('<rect x="2.4" y="1.8" width="7.2" height="12.4" rx="1"/><path d="M6 1.8v12.4M2.4 6h7.2M2.4 10h7.2"/><path d="M12 5.6 15.2 10.4M15.2 5.6 12 10.4"/>'),
    header: I('<rect x="1.8" y="2.4" width="12.4" height="11.2" rx="1"/><path d="M1.8 6.2h12.4M6 6.2v7.4M10 6.2v7.4"/><rect x="1.8" y="2.4" width="12.4" height="3.8" fill="currentColor" stroke="none" opacity=".35"/>'),
    tableDel: I('<rect x="1.8" y="2.4" width="12.4" height="11.2" rx="1"/><path d="M1.8 6.2h12.4M6 2.4v11.2"/><path d="M9.2 9.2 13.6 13.6M13.6 9.2 9.2 13.6"/>'),
  };

  /**
   * A small, useful set rather than the whole of Unicode: the marks a Japanese
   * business document actually needs, plus maths, arrows and Greek.
   */
  // The group names are looked up at run time, so name them here for the extractor:
  // t('Punctuation'), t('Marks'), t('Currency'), t('Mathematics'), t('Arrows'), t('Greek'), t('Numbers')
  const CHAR_SETS = [
    { key: 'Punctuation', chars: '「」『』（）〔〕［］｛｝〈〉《》【】…‥—―‐・、。，．！？：；／＼〜※' },
    { key: 'Marks', chars: '§¶†‡°′″№℡㊤㊥㊦㊧㊨★☆●○◎■□▲△▼▽◆◇♪♭♯✓✕♂♀©®™' },
    { key: 'Currency', chars: '¥＄€£¢₩₽₹¤' },
    { key: 'Mathematics', chars: '±×÷≠≒≦≧＜＞≪≫∞∴∵∫∑√∂∇⊥∠∽≡⇒⇔∈∋⊂⊃∩∪¬∀∃' },
    { key: 'Arrows', chars: '←↑→↓↔↕⇐⇑⇒⇓⇔⇕↖↗↘↙⇄⇅' },
    { key: 'Greek', chars: 'αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ' },
    { key: 'Numbers', chars: '½⅓⅔¼¾⅛⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉①②③④⑤⑥⑦⑧⑨⑩Ⅰ Ⅱ Ⅲ Ⅳ Ⅴ Ⅵ Ⅶ Ⅷ Ⅸ Ⅹ'.replace(/ /g, '') },
  ];

  // Precompiled render function (eval-free). Source template lives in editbase.js;
  // regenerate with regibase-build/editbase-build.mjs after editing the template.
  const render = (function () {
const { openBlock: _openBlock, createElementBlock: _createElementBlock, createCommentVNode: _createCommentVNode, createElementVNode: _createElementVNode, toDisplayString: _toDisplayString, renderList: _renderList, Fragment: _Fragment, normalizeClass: _normalizeClass, withModifiers: _withModifiers, vModelText: _vModelText, withDirectives: _withDirectives, createTextVNode: _createTextVNode, normalizeStyle: _normalizeStyle, withKeys: _withKeys, vModelCheckbox: _vModelCheckbox, vShow: _vShow, vModelSelect: _vModelSelect, vModelRadio: _vModelRadio, createStaticVNode: _createStaticVNode } = Vue

const _hoisted_1 = { class: "brand" }
const _hoisted_2 = ["innerHTML"]
const _hoisted_3 = /*#__PURE__*/_createElementVNode("span", { class: "name" }, "EditBase", -1 /* HOISTED */)
const _hoisted_4 = {
  key: 0,
  class: "ver"
}
const _hoisted_5 = ["title"]
const _hoisted_6 = ["innerHTML"]
const _hoisted_7 = { class: "side-actions" }
const _hoisted_8 = { class: "eb-doclist" }
const _hoisted_9 = {
  key: 0,
  class: "hint"
}
const _hoisted_10 = ["onClick"]
const _hoisted_11 = { class: "t" }
const _hoisted_12 = { class: "m" }
const _hoisted_13 = { class: "side-foot" }
const _hoisted_14 = { class: "eb-main" }
const _hoisted_15 = { class: "eb-topbar" }
const _hoisted_16 = ["title"]
const _hoisted_17 = ["innerHTML"]
const _hoisted_18 = ["placeholder", "disabled"]
const _hoisted_19 = ["disabled"]
const _hoisted_20 = { class: "lbl" }
const _hoisted_21 = ["disabled"]
const _hoisted_22 = { class: "lbl" }
const _hoisted_23 = ["disabled", "title"]
const _hoisted_24 = ["innerHTML"]
const _hoisted_25 = ["disabled", "title"]
const _hoisted_26 = ["title"]
const _hoisted_27 = {
  key: 0,
  class: "headtools"
}
const _hoisted_28 = ["value", "title"]
const _hoisted_29 = { value: "P" }
const _hoisted_30 = { value: "H1" }
const _hoisted_31 = { value: "H2" }
const _hoisted_32 = { value: "H3" }
const _hoisted_33 = { value: "H4" }
const _hoisted_34 = { value: "BLOCKQUOTE" }
const _hoisted_35 = { value: "PRE" }
const _hoisted_36 = ["title"]
const _hoisted_37 = ["innerHTML"]
const _hoisted_38 = { class: "eb-pop wide-ctl" }
const _hoisted_39 = ["title"]
const _hoisted_40 = ["innerHTML"]
const _hoisted_41 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_42 = ["onClick"]
const _hoisted_43 = { class: "k" }
const _hoisted_44 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_45 = { class: "eb-pop wide-ctl" }
const _hoisted_46 = ["title"]
const _hoisted_47 = ["innerHTML"]
const _hoisted_48 = ["value"]
const _hoisted_49 = ["innerHTML"]
const _hoisted_50 = ["innerHTML"]
const _hoisted_51 = ["onClick"]
const _hoisted_52 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_53 = /*#__PURE__*/_createElementVNode("span", { class: "grow" }, null, -1 /* HOISTED */)
const _hoisted_54 = ["title"]
const _hoisted_55 = ["innerHTML"]
const _hoisted_56 = ["title"]
const _hoisted_57 = ["innerHTML"]
const _hoisted_58 = ["title"]
const _hoisted_59 = { class: "cap" }
const _hoisted_60 = ["innerHTML"]
const _hoisted_61 = ["innerHTML"]
const _hoisted_62 = {
  class: "body",
  style: {"display":"flex","flex-direction":"column","gap":"6px","padding-bottom":"16px"}
}
const _hoisted_63 = {
  key: 0,
  class: "eb-menu-docs"
}
const _hoisted_64 = ["onClick"]
const _hoisted_65 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_66 = {
  key: 0,
  class: "eb-newbuild"
}
const _hoisted_67 = {
  key: 1,
  class: "eb-toolbar sub objbar"
}
const _hoisted_68 = { class: "nm" }
const _hoisted_69 = ["title"]
const _hoisted_70 = ["innerHTML"]
const _hoisted_71 = ["title"]
const _hoisted_72 = ["innerHTML"]
const _hoisted_73 = ["title"]
const _hoisted_74 = ["innerHTML"]
const _hoisted_75 = ["title"]
const _hoisted_76 = ["innerHTML"]
const _hoisted_77 = ["title"]
const _hoisted_78 = ["innerHTML"]
const _hoisted_79 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_80 = ["title"]
const _hoisted_81 = ["innerHTML"]
const _hoisted_82 = ["title"]
const _hoisted_83 = ["innerHTML"]
const _hoisted_84 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_85 = ["title"]
const _hoisted_86 = ["innerHTML"]
const _hoisted_87 = ["title"]
const _hoisted_88 = ["innerHTML"]
const _hoisted_89 = ["title"]
const _hoisted_90 = ["innerHTML"]
const _hoisted_91 = ["title"]
const _hoisted_92 = ["innerHTML"]
const _hoisted_93 = {
  key: 0,
  class: "sep"
}
const _hoisted_94 = ["title"]
const _hoisted_95 = ["innerHTML"]
const _hoisted_96 = ["title"]
const _hoisted_97 = ["innerHTML"]
const _hoisted_98 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_99 = ["title"]
const _hoisted_100 = ["innerHTML"]
const _hoisted_101 = ["title"]
const _hoisted_102 = ["innerHTML"]
const _hoisted_103 = {
  key: 2,
  class: "eb-find"
}
const _hoisted_104 = ["innerHTML"]
const _hoisted_105 = ["placeholder"]
const _hoisted_106 = { class: "count" }
const _hoisted_107 = ["title"]
const _hoisted_108 = ["title"]
const _hoisted_109 = { class: "opt" }
const _hoisted_110 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_111 = ["placeholder"]
const _hoisted_112 = ["disabled"]
const _hoisted_113 = ["disabled"]
const _hoisted_114 = ["title"]
const _hoisted_115 = ["innerHTML"]
const _hoisted_116 = {
  key: 3,
  class: "eb-toolbar sub"
}
const _hoisted_117 = { class: "grp" }
const _hoisted_118 = ["title"]
const _hoisted_119 = ["innerHTML"]
const _hoisted_120 = { class: "lbl" }
const _hoisted_121 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_122 = { class: "lbl" }
const _hoisted_123 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_124 = ["disabled"]
const _hoisted_125 = ["disabled"]
const _hoisted_126 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_127 = ["disabled"]
const _hoisted_128 = ["disabled"]
const _hoisted_129 = { class: "hint" }
const _hoisted_130 = {
  key: 4,
  class: "eb-toolbar sub"
}
const _hoisted_131 = { class: "grp" }
const _hoisted_132 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_133 = ["title"]
const _hoisted_134 = ["innerHTML"]
const _hoisted_135 = ["title"]
const _hoisted_136 = ["innerHTML"]
const _hoisted_137 = { class: "hint" }
const _hoisted_138 = {
  key: 5,
  class: "eb-toolbar sub"
}
const _hoisted_139 = { class: "grp" }
const _hoisted_140 = ["title"]
const _hoisted_141 = ["innerHTML"]
const _hoisted_142 = ["title"]
const _hoisted_143 = ["innerHTML"]
const _hoisted_144 = ["title"]
const _hoisted_145 = ["innerHTML"]
const _hoisted_146 = ["title"]
const _hoisted_147 = ["innerHTML"]
const _hoisted_148 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_149 = ["title"]
const _hoisted_150 = ["innerHTML"]
const _hoisted_151 = ["title"]
const _hoisted_152 = ["innerHTML"]
const _hoisted_153 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_154 = ["title"]
const _hoisted_155 = ["innerHTML"]
const _hoisted_156 = ["value", "title"]
const _hoisted_157 = { value: "" }
const _hoisted_158 = { value: "rows" }
const _hoisted_159 = { value: "borderless" }
const _hoisted_160 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_161 = ["title"]
const _hoisted_162 = ["innerHTML"]
const _hoisted_163 = ["value"]
const _hoisted_164 = ["title"]
const _hoisted_165 = ["innerHTML"]
const _hoisted_166 = ["title"]
const _hoisted_167 = ["innerHTML"]
const _hoisted_168 = ["title"]
const _hoisted_169 = ["innerHTML"]
const _hoisted_170 = ["title"]
const _hoisted_171 = ["innerHTML"]
const _hoisted_172 = ["title"]
const _hoisted_173 = ["innerHTML"]
const _hoisted_174 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_175 = ["title"]
const _hoisted_176 = ["innerHTML"]
const _hoisted_177 = { class: "hint" }
const _hoisted_178 = { class: "eb-workarea" }
const _hoisted_179 = {
  key: 0,
  class: "eb-rail"
}
const _hoisted_180 = ["title"]
const _hoisted_181 = /*#__PURE__*/_createElementVNode("span", { class: "b" }, "B", -1 /* HOISTED */)
const _hoisted_182 = [
  _hoisted_181
]
const _hoisted_183 = ["title"]
const _hoisted_184 = /*#__PURE__*/_createElementVNode("span", { class: "i" }, "I", -1 /* HOISTED */)
const _hoisted_185 = [
  _hoisted_184
]
const _hoisted_186 = ["title"]
const _hoisted_187 = /*#__PURE__*/_createElementVNode("span", { class: "u" }, "U", -1 /* HOISTED */)
const _hoisted_188 = [
  _hoisted_187
]
const _hoisted_189 = ["title"]
const _hoisted_190 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "S", -1 /* HOISTED */)
const _hoisted_191 = [
  _hoisted_190
]
const _hoisted_192 = ["title"]
const _hoisted_193 = /*#__PURE__*/_createElementVNode("span", { class: "kt" }, "A", -1 /* HOISTED */)
const _hoisted_194 = [
  _hoisted_193
]
const _hoisted_195 = ["title"]
const _hoisted_196 = /*#__PURE__*/_createElementVNode("span", { class: "sx" }, [
  /*#__PURE__*/_createTextVNode("x"),
  /*#__PURE__*/_createElementVNode("sup", null, "2")
], -1 /* HOISTED */)
const _hoisted_197 = [
  _hoisted_196
]
const _hoisted_198 = ["title"]
const _hoisted_199 = /*#__PURE__*/_createElementVNode("span", { class: "sx" }, [
  /*#__PURE__*/_createTextVNode("x"),
  /*#__PURE__*/_createElementVNode("sub", null, "2")
], -1 /* HOISTED */)
const _hoisted_200 = [
  _hoisted_199
]
const _hoisted_201 = ["title"]
const _hoisted_202 = /*#__PURE__*/_createElementVNode("span", { class: "mono" }, "</>", -1 /* HOISTED */)
const _hoisted_203 = [
  _hoisted_202
]
const _hoisted_204 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_205 = { class: "eb-pop" }
const _hoisted_206 = ["title"]
const _hoisted_207 = ["innerHTML"]
const _hoisted_208 = ["onClick"]
const _hoisted_209 = /*#__PURE__*/_createElementVNode("span", { class: "eb-swatch none" }, null, -1 /* HOISTED */)
const _hoisted_210 = ["title"]
const _hoisted_211 = ["innerHTML"]
const _hoisted_212 = ["value"]
const _hoisted_213 = ["title"]
const _hoisted_214 = ["innerHTML"]
const _hoisted_215 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_216 = ["title"]
const _hoisted_217 = ["innerHTML"]
const _hoisted_218 = ["title"]
const _hoisted_219 = ["innerHTML"]
const _hoisted_220 = { class: "eb-pop" }
const _hoisted_221 = ["title", "innerHTML"]
const _hoisted_222 = ["onClick"]
const _hoisted_223 = { class: "mk" }
const _hoisted_224 = ["onClick", "title", "innerHTML"]
const _hoisted_225 = ["title"]
const _hoisted_226 = ["innerHTML"]
const _hoisted_227 = ["title"]
const _hoisted_228 = ["innerHTML"]
const _hoisted_229 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_230 = { class: "eb-pop" }
const _hoisted_231 = ["title"]
const _hoisted_232 = ["innerHTML"]
const _hoisted_233 = { class: "lbl" }
const _hoisted_234 = ["innerHTML"]
const _hoisted_235 = ["innerHTML"]
const _hoisted_236 = ["innerHTML"]
const _hoisted_237 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_238 = ["innerHTML"]
const _hoisted_239 = ["innerHTML"]
const _hoisted_240 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_241 = ["onPointerdown"]
const _hoisted_242 = ["innerHTML"]
const _hoisted_243 = ["onClick"]
const _hoisted_244 = ["innerHTML"]
const _hoisted_245 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_246 = ["onClick"]
const _hoisted_247 = ["innerHTML"]
const _hoisted_248 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_249 = ["innerHTML"]
const _hoisted_250 = ["innerHTML"]
const _hoisted_251 = ["innerHTML"]
const _hoisted_252 = ["innerHTML"]
const _hoisted_253 = ["innerHTML"]
const _hoisted_254 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_255 = ["innerHTML"]
const _hoisted_256 = ["innerHTML"]
const _hoisted_257 = ["innerHTML"]
const _hoisted_258 = ["innerHTML"]
const _hoisted_259 = {
  key: 0,
  class: "eb-menu-sep"
}
const _hoisted_260 = ["onClick"]
const _hoisted_261 = ["innerHTML"]
const _hoisted_262 = ["title"]
const _hoisted_263 = ["innerHTML"]
const _hoisted_264 = ["title"]
const _hoisted_265 = ["innerHTML"]
const _hoisted_266 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_267 = ["title"]
const _hoisted_268 = ["innerHTML"]
const _hoisted_269 = ["title"]
const _hoisted_270 = ["innerHTML"]
const _hoisted_271 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_272 = ["title"]
const _hoisted_273 = ["innerHTML"]
const _hoisted_274 = ["title"]
const _hoisted_275 = ["innerHTML"]
const _hoisted_276 = ["title"]
const _hoisted_277 = ["innerHTML"]
const _hoisted_278 = ["title"]
const _hoisted_279 = ["innerHTML"]
const _hoisted_280 = ["title"]
const _hoisted_281 = ["innerHTML"]
const _hoisted_282 = ["title"]
const _hoisted_283 = ["innerHTML"]
const _hoisted_284 = ["title"]
const _hoisted_285 = ["innerHTML"]
const _hoisted_286 = ["title"]
const _hoisted_287 = ["innerHTML"]
const _hoisted_288 = ["title"]
const _hoisted_289 = ["innerHTML"]
const _hoisted_290 = ["title"]
const _hoisted_291 = ["innerHTML"]
const _hoisted_292 = {
  key: 5,
  class: "rail-shelf"
}
const _hoisted_293 = ["onPointerdown", "title"]
const _hoisted_294 = ["innerHTML"]
const _hoisted_295 = ["title"]
const _hoisted_296 = ["title"]
const _hoisted_297 = ["title"]
const _hoisted_298 = ["title"]
const _hoisted_299 = ["title"]
const _hoisted_300 = {
  key: 1,
  class: "eb-sheets",
  "aria-hidden": "true"
}
const _hoisted_301 = {
  key: 0,
  class: "run head"
}
const _hoisted_302 = { class: "l" }
const _hoisted_303 = { class: "c" }
const _hoisted_304 = { class: "r" }
const _hoisted_305 = {
  key: 1,
  class: "run foot"
}
const _hoisted_306 = { class: "l" }
const _hoisted_307 = { class: "c" }
const _hoisted_308 = { class: "r" }
const _hoisted_309 = ["spellcheck"]
const _hoisted_310 = {
  key: 5,
  class: "eb-tsel"
}
const _hoisted_311 = /*#__PURE__*/_createElementVNode("div", { class: "box" }, null, -1 /* HOISTED */)
const _hoisted_312 = {
  key: 0,
  class: "mm"
}
const _hoisted_313 = ["onPointerdown"]
const _hoisted_314 = ["onPointerdown", "title"]
const _hoisted_315 = {
  key: 0,
  class: "eb-empty"
}
const _hoisted_316 = ["innerHTML"]
const _hoisted_317 = {
  key: 1,
  class: "eb-tabs"
}
const _hoisted_318 = { class: "tab" }
const _hoisted_319 = { class: "lb" }
const _hoisted_320 = ["title"]
const _hoisted_321 = { class: "tab" }
const _hoisted_322 = { class: "lb" }
const _hoisted_323 = ["title"]
const _hoisted_324 = {
  key: 2,
  class: "eb-preview"
}
const _hoisted_325 = { class: "head" }
const _hoisted_326 = ["title"]
const _hoisted_327 = ["innerHTML"]
const _hoisted_328 = { class: "pages" }
const _hoisted_329 = ["onClick", "title"]
const _hoisted_330 = { class: "no" }
const _hoisted_331 = {
  key: 3,
  class: "eb-layers"
}
const _hoisted_332 = { class: "head" }
const _hoisted_333 = ["title"]
const _hoisted_334 = ["innerHTML"]
const _hoisted_335 = {
  key: 0,
  class: "none"
}
const _hoisted_336 = { class: "glabel" }
const _hoisted_337 = { class: "list" }
const _hoisted_338 = ["onClick", "title"]
const _hoisted_339 = ["innerHTML"]
const _hoisted_340 = { class: "nm" }
const _hoisted_341 = { class: "tx" }
const _hoisted_342 = { class: "acts" }
const _hoisted_343 = ["disabled", "onClick", "title"]
const _hoisted_344 = ["disabled", "onClick", "title"]
const _hoisted_345 = {
  key: 6,
  class: "eb-status"
}
const _hoisted_346 = { class: "grow" }
const _hoisted_347 = { class: "body" }
const _hoisted_348 = { class: "eb-row" }
const _hoisted_349 = { class: "eb-field" }
const _hoisted_350 = ["value"]
const _hoisted_351 = ["value"]
const _hoisted_352 = { class: "eb-field" }
const _hoisted_353 = { value: "portrait" }
const _hoisted_354 = { value: "landscape" }
const _hoisted_355 = { class: "eb-row" }
const _hoisted_356 = { class: "eb-field" }
const _hoisted_357 = { class: "eb-field" }
const _hoisted_358 = { class: "eb-field" }
const _hoisted_359 = { class: "eb-field" }
const _hoisted_360 = { class: "eb-row" }
const _hoisted_361 = { class: "eb-field" }
const _hoisted_362 = { class: "eb-field" }
const _hoisted_363 = { class: "eb-field" }
const _hoisted_364 = ["value"]
const _hoisted_365 = { value: "h" }
const _hoisted_366 = { value: "v" }
const _hoisted_367 = { class: "eb-field" }
const _hoisted_368 = { value: "" }
const _hoisted_369 = { value: "decimal" }
const _hoisted_370 = { value: "japanese" }
const _hoisted_371 = { class: "eb-tip" }
const _hoisted_372 = { class: "eb-field" }
const _hoisted_373 = { class: "eb-row" }
const _hoisted_374 = { class: "eb-field" }
const _hoisted_375 = { class: "colour-pair" }
const _hoisted_376 = ["value"]
const _hoisted_377 = { class: "eb-field" }
const _hoisted_378 = { class: "colour-pair" }
const _hoisted_379 = {
  key: 0,
  class: "eb-row"
}
const _hoisted_380 = { class: "eb-field" }
const _hoisted_381 = { value: "cover" }
const _hoisted_382 = { value: "contain" }
const _hoisted_383 = { value: "stretch" }
const _hoisted_384 = { value: "tile" }
const _hoisted_385 = { class: "eb-field" }
const _hoisted_386 = { class: "eb-row" }
const _hoisted_387 = { class: "eb-field" }
const _hoisted_388 = { value: "none" }
const _hoisted_389 = { value: "solid" }
const _hoisted_390 = { value: "dashed" }
const _hoisted_391 = { value: "dotted" }
const _hoisted_392 = { value: "double" }
const _hoisted_393 = { class: "eb-field" }
const _hoisted_394 = ["disabled"]
const _hoisted_395 = { class: "eb-field" }
const _hoisted_396 = ["disabled"]
const _hoisted_397 = {
  key: 1,
  class: "eb-row"
}
const _hoisted_398 = { class: "eb-field" }
const _hoisted_399 = { class: "eb-field" }
const _hoisted_400 = { class: "eb-tip" }
const _hoisted_401 = { class: "eb-tip" }
const _hoisted_402 = { class: "eb-field" }
const _hoisted_403 = { class: "font-rows" }
const _hoisted_404 = ["onClick"]
const _hoisted_405 = { class: "role" }
const _hoisted_406 = {
  key: 0,
  class: "tag"
}
const _hoisted_407 = ["innerHTML"]
const _hoisted_408 = { class: "eb-tip" }
const _hoisted_409 = { class: "eb-tip" }
const _hoisted_410 = { class: "foot" }
const _hoisted_411 = { class: "body" }
const _hoisted_412 = { class: "eb-tip" }
const _hoisted_413 = { class: "eb-embed-list" }
const _hoisted_414 = { class: "k" }
const _hoisted_415 = { class: "u" }
const _hoisted_416 = { class: "eb-tip warn" }
const _hoisted_417 = { class: "eb-warn-list" }
const _hoisted_418 = { class: "foot" }
const _hoisted_419 = { class: "body" }
const _hoisted_420 = { class: "eb-row" }
const _hoisted_421 = { class: "eb-field" }
const _hoisted_422 = { class: "eb-field" }
const _hoisted_423 = { class: "eb-field" }
const _hoisted_424 = { value: "" }
const _hoisted_425 = { value: "rows" }
const _hoisted_426 = { value: "borderless" }
const _hoisted_427 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_428 = { class: "foot" }
const _hoisted_429 = { class: "body" }
const _hoisted_430 = { style: {"display":"flex","flex-wrap":"wrap","gap":"6px","margin-bottom":"8px"} }
const _hoisted_431 = ["onClick"]
const _hoisted_432 = { class: "eb-field" }
const _hoisted_433 = /*#__PURE__*/_createElementVNode("label", null, "MathML", -1 /* HOISTED */)
const _hoisted_434 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_435 = { class: "eb-field" }
const _hoisted_436 = ["innerHTML"]
const _hoisted_437 = { class: "eb-tip" }
const _hoisted_438 = { class: "foot" }
const _hoisted_439 = ["innerHTML"]
const _hoisted_440 = { class: "body" }
const _hoisted_441 = {
  key: 0,
  class: "hint"
}
const _hoisted_442 = {
  key: 1,
  class: "eb-tip",
  style: {"color":"var(--danger)"}
}
const _hoisted_443 = {
  key: 0,
  class: "font-list"
}
const _hoisted_444 = ["onClick"]
const _hoisted_445 = { class: "ic" }
const _hoisted_446 = { class: "nm" }
const _hoisted_447 = {
  key: 0,
  class: "hint"
}
const _hoisted_448 = { class: "eb-tip" }
const _hoisted_449 = { class: "opt" }
const _hoisted_450 = { class: "src-preview" }
const _hoisted_451 = { class: "eb-table" }
const _hoisted_452 = { key: 0 }
const _hoisted_453 = { class: "font-search" }
const _hoisted_454 = ["innerHTML"]
const _hoisted_455 = ["placeholder"]
const _hoisted_456 = { class: "font-list" }
const _hoisted_457 = ["onClick"]
const _hoisted_458 = { class: "nm" }
const _hoisted_459 = { class: "meta" }
const _hoisted_460 = {
  key: 0,
  class: "hint"
}
const _hoisted_461 = { class: "eb-tip" }
const _hoisted_462 = { class: "chips" }
const _hoisted_463 = ["onClick"]
const _hoisted_464 = { class: "eb-row" }
const _hoisted_465 = { class: "eb-field" }
const _hoisted_466 = { class: "eb-field" }
const _hoisted_467 = { class: "eb-field" }
const _hoisted_468 = { value: "" }
const _hoisted_469 = ["value"]
const _hoisted_470 = { class: "font-list" }
const _hoisted_471 = { class: "nm" }
const _hoisted_472 = { class: "meta" }
const _hoisted_473 = {
  key: 0,
  class: "hint"
}
const _hoisted_474 = {
  key: 0,
  class: "font-list"
}
const _hoisted_475 = ["onClick"]
const _hoisted_476 = { class: "ic" }
const _hoisted_477 = { class: "nm" }
const _hoisted_478 = { class: "meta" }
const _hoisted_479 = {
  key: 0,
  class: "hint"
}
const _hoisted_480 = { class: "eb-tip" }
const _hoisted_481 = { class: "font-list" }
const _hoisted_482 = ["onClick"]
const _hoisted_483 = { class: "nm" }
const _hoisted_484 = { class: "meta" }
const _hoisted_485 = {
  key: 0,
  class: "hint"
}
const _hoisted_486 = { class: "eb-tip" }
const _hoisted_487 = { class: "chips" }
const _hoisted_488 = ["onClick"]
const _hoisted_489 = {
  key: 0,
  class: "font-list"
}
const _hoisted_490 = ["onClick"]
const _hoisted_491 = { class: "ic" }
const _hoisted_492 = { class: "nm" }
const _hoisted_493 = {
  key: 0,
  class: "hint"
}
const _hoisted_494 = {
  key: 1,
  class: "font-list"
}
const _hoisted_495 = ["onClick"]
const _hoisted_496 = { class: "nm" }
const _hoisted_497 = { class: "meta mono" }
const _hoisted_498 = {
  key: 7,
  class: "font-list"
}
const _hoisted_499 = ["onClick"]
const _hoisted_500 = { class: "nm" }
const _hoisted_501 = { class: "meta" }
const _hoisted_502 = {
  key: 0,
  class: "hint"
}
const _hoisted_503 = { class: "foot" }
const _hoisted_504 = { class: "body" }
const _hoisted_505 = {
  key: 0,
  class: "eb-tip"
}
const _hoisted_506 = { class: "eb-tip" }
const _hoisted_507 = { class: "chips" }
const _hoisted_508 = {
  class: "opt",
  style: {"margin-top":"10px"}
}
const _hoisted_509 = { class: "opt" }
const _hoisted_510 = { class: "foot" }
const _hoisted_511 = ["disabled"]
const _hoisted_512 = ["innerHTML"]
const _hoisted_513 = { class: "body" }
const _hoisted_514 = { class: "fp-path" }
const _hoisted_515 = ["disabled"]
const _hoisted_516 = ["innerHTML"]
const _hoisted_517 = { class: "crumbs" }
const _hoisted_518 = { class: "font-list" }
const _hoisted_519 = {
  key: 0,
  class: "hint"
}
const _hoisted_520 = {
  key: 1,
  class: "hint"
}
const _hoisted_521 = ["onClick", "onDblclick"]
const _hoisted_522 = ["innerHTML"]
const _hoisted_523 = { class: "nm" }
const _hoisted_524 = {
  key: 0,
  class: "meta"
}
const _hoisted_525 = {
  key: 2,
  class: "hint"
}
const _hoisted_526 = { class: "eb-tip" }
const _hoisted_527 = { class: "foot" }
const _hoisted_528 = ["disabled"]
const _hoisted_529 = ["innerHTML"]
const _hoisted_530 = { class: "body" }
const _hoisted_531 = { class: "font-search" }
const _hoisted_532 = ["innerHTML"]
const _hoisted_533 = ["placeholder"]
const _hoisted_534 = { class: "chips" }
const _hoisted_535 = ["onClick"]
const _hoisted_536 = { class: "chips" }
const _hoisted_537 = { value: "auto" }
const _hoisted_538 = { value: "all" }
const _hoisted_539 = ["value"]
const _hoisted_540 = { class: "count" }
const _hoisted_541 = { class: "font-list" }
const _hoisted_542 = { class: "nm" }
const _hoisted_543 = { class: "meta" }
const _hoisted_544 = ["onClick"]
const _hoisted_545 = { class: "meta" }
const _hoisted_546 = {
  key: 0,
  class: "hint"
}
const _hoisted_547 = {
  key: 1,
  class: "hint"
}
const _hoisted_548 = { class: "eb-field" }
const _hoisted_549 = { class: "foot" }
const _hoisted_550 = { class: "body" }
const _hoisted_551 = { class: "eb-field" }
const _hoisted_552 = { class: "eb-tip" }
const _hoisted_553 = { class: "eb-row" }
const _hoisted_554 = { class: "eb-field" }
const _hoisted_555 = { value: "auto" }
const _hoisted_556 = { value: "light" }
const _hoisted_557 = { value: "dark" }
const _hoisted_558 = { class: "eb-field" }
const _hoisted_559 = { value: "auto" }
const _hoisted_560 = ["value"]
const _hoisted_561 = { class: "eb-field" }
const _hoisted_562 = { class: "opt" }
const _hoisted_563 = ["checked"]
const _hoisted_564 = { class: "opt" }
const _hoisted_565 = ["checked"]
const _hoisted_566 = { class: "opt" }
const _hoisted_567 = { class: "eb-tip" }
const _hoisted_568 = { class: "eb-tip" }
const _hoisted_569 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_570 = { class: "foot" }
const _hoisted_571 = { class: "body" }
const _hoisted_572 = { class: "eb-tip" }
const _hoisted_573 = ["value"]
const _hoisted_574 = { class: "foot" }
const _hoisted_575 = { class: "body" }
const _hoisted_576 = { class: "eb-field" }
const _hoisted_577 = ["value"]
const _hoisted_578 = { class: "eb-row" }
const _hoisted_579 = { class: "eb-field" }
const _hoisted_580 = ["value"]
const _hoisted_581 = { value: "" }
const _hoisted_582 = ["value"]
const _hoisted_583 = { class: "eb-field" }
const _hoisted_584 = { class: "eb-field" }
const _hoisted_585 = { class: "colour-pair" }
const _hoisted_586 = ["value"]
const _hoisted_587 = { class: "eb-row" }
const _hoisted_588 = { class: "eb-field" }
const _hoisted_589 = { value: "" }
const _hoisted_590 = { value: "left" }
const _hoisted_591 = { value: "center" }
const _hoisted_592 = { value: "right" }
const _hoisted_593 = { value: "justify" }
const _hoisted_594 = { class: "eb-field" }
const _hoisted_595 = { class: "eb-field" }
const _hoisted_596 = { class: "eb-field" }
const _hoisted_597 = { class: "opt" }
const _hoisted_598 = { class: "opt" }
const _hoisted_599 = { class: "eb-tip" }
const _hoisted_600 = { class: "foot" }
const _hoisted_601 = { class: "body" }
const _hoisted_602 = { class: "eb-field" }
const _hoisted_603 = { value: "" }
const _hoisted_604 = { value: "1 / 1" }
const _hoisted_605 = /*#__PURE__*/_createStaticVNode("<option value=\"4 / 3\">4 : 3</option><option value=\"3 / 2\">3 : 2</option><option value=\"16 / 9\">16 : 9</option><option value=\"3 / 4\">3 : 4</option><option value=\"2 / 3\">2 : 3</option>", 5)
const _hoisted_610 = ["src"]
const _hoisted_611 = { class: "hint" }
const _hoisted_612 = { class: "eb-tip" }
const _hoisted_613 = { class: "foot" }
const _hoisted_614 = { class: "body" }
const _hoisted_615 = { class: "eb-row eb-frow" }
const _hoisted_616 = { class: "eb-field b-style" }
const _hoisted_617 = { value: "" }
const _hoisted_618 = { value: "none" }
const _hoisted_619 = { value: "solid" }
const _hoisted_620 = { value: "dashed" }
const _hoisted_621 = { value: "dotted" }
const _hoisted_622 = { value: "double" }
const _hoisted_623 = { class: "eb-field b-style" }
const _hoisted_624 = { value: "all" }
const _hoisted_625 = { value: "top" }
const _hoisted_626 = { value: "bottom" }
const _hoisted_627 = { value: "topbottom" }
const _hoisted_628 = { value: "left" }
const _hoisted_629 = { class: "eb-field" }
const _hoisted_630 = { class: "eb-field" }
const _hoisted_631 = { class: "eb-tip" }
const _hoisted_632 = { class: "foot" }
const _hoisted_633 = { class: "body" }
const _hoisted_634 = { class: "eb-field" }
const _hoisted_635 = ["value"]
const _hoisted_636 = { class: "eb-field" }
const _hoisted_637 = { class: "eb-tip" }
const _hoisted_638 = { class: "foot" }
const _hoisted_639 = { class: "body" }
const _hoisted_640 = { class: "eb-field" }
const _hoisted_641 = { class: "eb-tip" }
const _hoisted_642 = { class: "foot" }
const _hoisted_643 = { class: "body" }
const _hoisted_644 = { class: "eb-row" }
const _hoisted_645 = { class: "eb-field" }
const _hoisted_646 = { value: 1 }
const _hoisted_647 = { value: 2 }
const _hoisted_648 = { value: 3 }
const _hoisted_649 = { value: 4 }
const _hoisted_650 = { class: "eb-field" }
const _hoisted_651 = { class: "eb-tip" }
const _hoisted_652 = { class: "foot" }
const _hoisted_653 = { class: "body" }
const _hoisted_654 = { class: "eb-row" }
const _hoisted_655 = { class: "eb-field" }
const _hoisted_656 = { class: "eb-field" }
const _hoisted_657 = { class: "eb-field" }
const _hoisted_658 = { class: "eb-row" }
const _hoisted_659 = { class: "eb-field" }
const _hoisted_660 = { class: "eb-field" }
const _hoisted_661 = { class: "eb-field" }
const _hoisted_662 = { class: "eb-tip" }
const _hoisted_663 = { class: "foot" }
const _hoisted_664 = { class: "body" }
const _hoisted_665 = { class: "eb-sect" }
const _hoisted_666 = { class: "eb-row" }
const _hoisted_667 = { class: "eb-field" }
const _hoisted_668 = { value: "" }
const _hoisted_669 = { value: "left" }
const _hoisted_670 = { value: "center" }
const _hoisted_671 = { value: "right" }
const _hoisted_672 = { value: "free" }
const _hoisted_673 = { class: "eb-field wide" }
const _hoisted_674 = { class: "eb-pick" }
const _hoisted_675 = ["onClick", "title"]
const _hoisted_676 = ["innerHTML"]
const _hoisted_677 = { class: "nm" }
const _hoisted_678 = { class: "eb-field" }
const _hoisted_679 = {
  key: 0,
  class: "eb-field"
}
const _hoisted_680 = { value: "" }
const _hoisted_681 = { value: "eb-yoko" }
const _hoisted_682 = { value: "eb-tate" }
const _hoisted_683 = {
  key: 1,
  class: "eb-field"
}
const _hoisted_684 = { value: "" }
const _hoisted_685 = { value: "eb-v-mid" }
const _hoisted_686 = { value: "eb-v-bot" }
const _hoisted_687 = {
  key: 0,
  class: "eb-sect"
}
const _hoisted_688 = {
  key: 1,
  class: "eb-row eb-frow"
}
const _hoisted_689 = { class: "eb-field" }
const _hoisted_690 = { class: "btn-pair" }
const _hoisted_691 = ["disabled"]
const _hoisted_692 = { class: "eb-field" }
const _hoisted_693 = ["disabled"]
const _hoisted_694 = { value: "cover" }
const _hoisted_695 = { value: "contain" }
const _hoisted_696 = { value: "tile" }
const _hoisted_697 = { class: "eb-field" }
const _hoisted_698 = { class: "eb-field" }
const _hoisted_699 = {
  key: 2,
  class: "eb-row eb-frow"
}
const _hoisted_700 = { class: "eb-field" }
const _hoisted_701 = { class: "opt" }
const _hoisted_702 = { class: "eb-field" }
const _hoisted_703 = ["disabled"]
const _hoisted_704 = { class: "eb-field" }
const _hoisted_705 = ["disabled"]
const _hoisted_706 = { class: "eb-field" }
const _hoisted_707 = ["disabled"]
const _hoisted_708 = { class: "eb-field" }
const _hoisted_709 = ["disabled"]
const _hoisted_710 = { class: "eb-field" }
const _hoisted_711 = { value: "" }
const _hoisted_712 = { value: "eb-al-l" }
const _hoisted_713 = { value: "eb-al-c" }
const _hoisted_714 = { value: "eb-al-r" }
const _hoisted_715 = { value: "eb-al-j" }
const _hoisted_716 = { class: "eb-field" }
const _hoisted_717 = { value: "" }
const _hoisted_718 = { value: "left" }
const _hoisted_719 = { value: "right" }
const _hoisted_720 = {
  key: 3,
  class: "eb-row"
}
const _hoisted_721 = { class: "eb-field" }
const _hoisted_722 = { class: "eb-field" }
const _hoisted_723 = { class: "eb-field" }
const _hoisted_724 = { class: "btn-pair" }
const _hoisted_725 = {
  key: 4,
  class: "eb-tip"
}
const _hoisted_726 = {
  key: 5,
  class: "eb-tip"
}
const _hoisted_727 = { class: "eb-sect" }
const _hoisted_728 = { class: "eb-row" }
const _hoisted_729 = { class: "eb-field" }
const _hoisted_730 = ["placeholder"]
const _hoisted_731 = { class: "eb-field" }
const _hoisted_732 = ["placeholder"]
const _hoisted_733 = { class: "eb-field" }
const _hoisted_734 = ["placeholder"]
const _hoisted_735 = { class: "eb-sect" }
const _hoisted_736 = { class: "eb-row" }
const _hoisted_737 = { class: "eb-field" }
const _hoisted_738 = { class: "eb-field" }
const _hoisted_739 = { class: "eb-field" }
const _hoisted_740 = { class: "eb-field" }
const _hoisted_741 = { class: "eb-sect" }
const _hoisted_742 = { class: "eb-row eb-frow" }
const _hoisted_743 = { class: "eb-field b-style" }
const _hoisted_744 = { value: "" }
const _hoisted_745 = { value: "none" }
const _hoisted_746 = { value: "solid" }
const _hoisted_747 = { value: "dashed" }
const _hoisted_748 = { value: "dotted" }
const _hoisted_749 = { value: "double" }
const _hoisted_750 = { class: "eb-field" }
const _hoisted_751 = { class: "eb-field" }
const _hoisted_752 = { class: "eb-field" }
const _hoisted_753 = { class: "eb-row" }
const _hoisted_754 = { class: "eb-field" }
const _hoisted_755 = { class: "colour-pair" }
const _hoisted_756 = ["value"]
const _hoisted_757 = { class: "eb-field" }
const _hoisted_758 = { class: "eb-field" }
const _hoisted_759 = { class: "eb-field" }
const _hoisted_760 = { class: "opt" }
const _hoisted_761 = { class: "opt" }
const _hoisted_762 = { class: "eb-tip" }
const _hoisted_763 = { class: "foot" }
const _hoisted_764 = ["disabled"]
const _hoisted_765 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+X", -1 /* HOISTED */)
const _hoisted_766 = ["disabled"]
const _hoisted_767 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+C", -1 /* HOISTED */)
const _hoisted_768 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+V", -1 /* HOISTED */)
const _hoisted_769 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+Shift+V", -1 /* HOISTED */)
const _hoisted_770 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_771 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+K", -1 /* HOISTED */)
const _hoisted_772 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_773 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_774 = { class: "fly" }
const _hoisted_775 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_776 = { class: "fly" }
const _hoisted_777 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+B", -1 /* HOISTED */)
const _hoisted_778 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+I", -1 /* HOISTED */)
const _hoisted_779 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Ctrl+U", -1 /* HOISTED */)
const _hoisted_780 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_781 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_782 = { class: "fly" }
const _hoisted_783 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_784 = { class: "fly" }
const _hoisted_785 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Tab", -1 /* HOISTED */)
const _hoisted_786 = /*#__PURE__*/_createElementVNode("span", { class: "s k" }, "Shift+Tab", -1 /* HOISTED */)
const _hoisted_787 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_788 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_789 = { class: "fly" }
const _hoisted_790 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_791 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_792 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_793 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_794 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_795 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_796 = { class: "fly" }
const _hoisted_797 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_798 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_799 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_800 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_801 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_802 = { class: "fly" }
const _hoisted_803 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_804 = { class: "fly" }
const _hoisted_805 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_806 = { class: "fly" }
const _hoisted_807 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_808 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_809 = { class: "fly" }
const _hoisted_810 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_811 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_812 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_813 = { class: "body" }
const _hoisted_814 = { class: "eb-tip" }
const _hoisted_815 = { class: "eb-row eb-frow" }
const _hoisted_816 = { class: "eb-field" }
const _hoisted_817 = { value: "" }
const _hoisted_818 = ["value"]
const _hoisted_819 = { class: "eb-field" }
const _hoisted_820 = { class: "eb-field" }
const _hoisted_821 = { class: "eb-field" }
const _hoisted_822 = { class: "colour-pair" }
const _hoisted_823 = { class: "eb-row eb-frow" }
const _hoisted_824 = { class: "eb-field" }
const _hoisted_825 = { class: "opt" }
const _hoisted_826 = { class: "opt" }
const _hoisted_827 = { class: "eb-field" }
const _hoisted_828 = { class: "opt" }
const _hoisted_829 = { class: "opt" }
const _hoisted_830 = { class: "eb-field" }
const _hoisted_831 = { value: "" }
const _hoisted_832 = { value: "super" }
const _hoisted_833 = { value: "sub" }
const _hoisted_834 = { class: "eb-field" }
const _hoisted_835 = { class: "eb-row eb-frow" }
const _hoisted_836 = { class: "eb-field" }
const _hoisted_837 = { class: "eb-field" }
const _hoisted_838 = { class: "eb-field" }
const _hoisted_839 = { class: "opt" }
const _hoisted_840 = { class: "eb-field" }
const _hoisted_841 = ["disabled"]
const _hoisted_842 = { class: "eb-field" }
const _hoisted_843 = ["disabled"]
const _hoisted_844 = { class: "eb-field" }
const _hoisted_845 = ["disabled"]
const _hoisted_846 = { class: "eb-field" }
const _hoisted_847 = ["disabled"]
const _hoisted_848 = { class: "foot" }
const _hoisted_849 = { class: "body" }
const _hoisted_850 = { class: "eb-row" }
const _hoisted_851 = { class: "eb-field" }
const _hoisted_852 = { value: "" }
const _hoisted_853 = { value: "left" }
const _hoisted_854 = { value: "center" }
const _hoisted_855 = { value: "right" }
const _hoisted_856 = { value: "justify" }
const _hoisted_857 = { class: "eb-field" }
const _hoisted_858 = ["placeholder"]
const _hoisted_859 = { class: "eb-row" }
const _hoisted_860 = { class: "eb-field" }
const _hoisted_861 = { class: "eb-field" }
const _hoisted_862 = { class: "eb-row" }
const _hoisted_863 = { class: "eb-field" }
const _hoisted_864 = { class: "eb-field" }
const _hoisted_865 = { class: "eb-field" }
const _hoisted_866 = { class: "eb-row eb-frow" }
const _hoisted_867 = { class: "eb-field b-style" }
const _hoisted_868 = { value: "" }
const _hoisted_869 = { value: "solid" }
const _hoisted_870 = { value: "dashed" }
const _hoisted_871 = { value: "dotted" }
const _hoisted_872 = { value: "double" }
const _hoisted_873 = { class: "eb-field b-style" }
const _hoisted_874 = ["disabled"]
const _hoisted_875 = { value: "all" }
const _hoisted_876 = { value: "top" }
const _hoisted_877 = { value: "bottom" }
const _hoisted_878 = { value: "topbottom" }
const _hoisted_879 = { value: "left" }
const _hoisted_880 = { class: "eb-field" }
const _hoisted_881 = ["disabled"]
const _hoisted_882 = { class: "eb-field" }
const _hoisted_883 = ["disabled"]
const _hoisted_884 = { class: "eb-row" }
const _hoisted_885 = { class: "eb-field" }
const _hoisted_886 = { class: "colour-pair" }
const _hoisted_887 = ["value"]
const _hoisted_888 = { class: "eb-field" }
const _hoisted_889 = { class: "opt" }
const _hoisted_890 = { class: "opt" }
const _hoisted_891 = { class: "opt" }
const _hoisted_892 = { class: "opt" }
const _hoisted_893 = { class: "eb-tip" }
const _hoisted_894 = { class: "foot" }
const _hoisted_895 = { class: "body" }
const _hoisted_896 = { class: "eb-field" }
const _hoisted_897 = { class: "eb-tip" }
const _hoisted_898 = { class: "foot" }
const _hoisted_899 = { class: "body" }
const _hoisted_900 = { class: "chips" }
const _hoisted_901 = ["onClick"]
const _hoisted_902 = { class: "eb-chargrid" }
const _hoisted_903 = ["onClick"]
const _hoisted_904 = { class: "eb-tip" }
const _hoisted_905 = { class: "foot" }
const _hoisted_906 = { class: "body" }
const _hoisted_907 = { class: "eb-field" }
const _hoisted_908 = { class: "eb-tip" }
const _hoisted_909 = {
  key: 0,
  class: "eb-tip"
}
const _hoisted_910 = { class: "foot" }
const _hoisted_911 = ["disabled"]
const _hoisted_912 = { class: "body" }
const _hoisted_913 = { class: "eb-field" }
const _hoisted_914 = ["placeholder"]
const _hoisted_915 = { class: "eb-field" }
const _hoisted_916 = { class: "eb-tip" }
const _hoisted_917 = { class: "foot" }
const _hoisted_918 = { class: "body" }
const _hoisted_919 = { class: "eb-field" }
const _hoisted_920 = { class: "eb-tip" }
const _hoisted_921 = { class: "foot" }
const _hoisted_922 = {
  key: 28,
  class: "eb-toast"
}

return function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", {
    class: _normalizeClass(["eb-shell", { narrow: _ctx.narrow }])
  }, [
    (_ctx.narrow && _ctx.sideOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 0,
          class: "eb-backdrop",
          onClick: _cache[0] || (_cache[0] = $event => (_ctx.sideOpen = false))
        }))
      : _createCommentVNode("v-if", true),
    _createElementVNode("aside", {
      class: _normalizeClass(["eb-side", { hidden: !_ctx.sideOpen }])
    }, [
      _createElementVNode("div", _hoisted_1, [
        _createElementVNode("span", {
          class: "logo",
          innerHTML: _ctx.logo
        }, null, 8 /* PROPS */, _hoisted_2),
        _hoisted_3,
        (!_ctx.narrow)
          ? (_openBlock(), _createElementBlock("span", _hoisted_4, _toDisplayString(_ctx.version), 1 /* TEXT */))
          : _createCommentVNode("v-if", true),
        (_ctx.narrow)
          ? (_openBlock(), _createElementBlock("button", {
              key: 1,
              class: "eb-tb side-close",
              onClick: _cache[1] || (_cache[1] = $event => (_ctx.sideOpen = false)),
              title: _ctx.t('Close')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.close
              }, null, 8 /* PROPS */, _hoisted_6)
            ], 8 /* PROPS */, _hoisted_5))
          : _createCommentVNode("v-if", true)
      ]),
      _createElementVNode("div", _hoisted_7, [
        _createElementVNode("button", {
          class: "eb-btn primary wide",
          onClick: _cache[2] || (_cache[2] = (...args) => (_ctx.newDoc && _ctx.newDoc(...args)))
        }, "＋ " + _toDisplayString(_ctx.t('New document')), 1 /* TEXT */)
      ]),
      _createElementVNode("div", _hoisted_8, [
        (!_ctx.docs.length)
          ? (_openBlock(), _createElementBlock("p", _hoisted_9, _toDisplayString(_ctx.t('No documents yet. Everything you write here is saved to {folder} in your Files as a plain .html file.', { folder: _ctx.settings.folder })), 1 /* TEXT */))
          : _createCommentVNode("v-if", true),
        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.docs, (d) => {
          return (_openBlock(), _createElementBlock("button", {
            key: d.id,
            class: _normalizeClass(["eb-docitem", { active: d.id === _ctx.doc.id }]),
            onClick: $event => (_ctx.openDoc(d.id))
          }, [
            _createElementVNode("span", _hoisted_11, _toDisplayString(d.title), 1 /* TEXT */),
            _createElementVNode("span", _hoisted_12, _toDisplayString(_ctx.when(d.mtime)) + " · " + _toDisplayString(_ctx.size(d.size)), 1 /* TEXT */)
          ], 10 /* CLASS, PROPS */, _hoisted_10))
        }), 128 /* KEYED_FRAGMENT */))
      ]),
      _createElementVNode("div", _hoisted_13, [
        _createElementVNode("button", {
          class: "eb-btn ghost wide",
          onClick: _cache[3] || (_cache[3] = $event => (_ctx.settingsOpen = true))
        }, "⚙ " + _toDisplayString(_ctx.t('Settings')), 1 /* TEXT */)
      ])
    ], 2 /* CLASS */),
    _createElementVNode("section", _hoisted_14, [
      _createElementVNode("div", _hoisted_15, [
        _createElementVNode("button", {
          class: "eb-tb menu-btn",
          onTouchend: _cache[4] || (_cache[4] = _withModifiers($event => (_ctx.sideOpen = !_ctx.sideOpen), ["prevent"])),
          onClick: _cache[5] || (_cache[5] = $event => (_ctx.sideOpen = !_ctx.sideOpen)),
          title: _ctx.t('Documents')
        }, [
          _createElementVNode("span", {
            innerHTML: _ctx.icons.menu
          }, null, 8 /* PROPS */, _hoisted_17)
        ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_16),
        _withDirectives(_createElementVNode("input", {
          class: "title-input",
          "onUpdate:modelValue": _cache[6] || (_cache[6] = $event => ((_ctx.doc.title) = $event)),
          placeholder: _ctx.t('Untitled document'),
          onChange: _cache[7] || (_cache[7] = (...args) => (_ctx.applyTitle && _ctx.applyTitle(...args))),
          disabled: !_ctx.doc.id
        }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_18), [
          [_vModelText, _ctx.doc.title]
        ]),
        _createElementVNode("span", {
          class: _normalizeClass(["state", { dirty: _ctx.dirty }])
        }, _toDisplayString(_ctx.stateText), 3 /* TEXT, CLASS */),
        _createElementVNode("button", {
          class: "eb-btn",
          onClick: _cache[8] || (_cache[8] = (...args) => (_ctx.save && _ctx.save(...args))),
          disabled: !_ctx.doc.id || _ctx.saving
        }, [
          _createTextVNode("💾 "),
          _createElementVNode("span", _hoisted_20, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
        ], 8 /* PROPS */, _hoisted_19),
        _createElementVNode("button", {
          class: "eb-btn",
          onClick: _cache[9] || (_cache[9] = (...args) => (_ctx.printDoc && _ctx.printDoc(...args))),
          disabled: !_ctx.doc.id
        }, [
          _createTextVNode("🖨 "),
          _createElementVNode("span", _hoisted_22, _toDisplayString(_ctx.t('Print / PDF')), 1 /* TEXT */)
        ], 8 /* PROPS */, _hoisted_21),
        _createElementVNode("button", {
          class: "eb-btn ghost",
          onClick: _cache[10] || (_cache[10] = $event => (_ctx.paperOpen = true)),
          disabled: !_ctx.doc.id,
          title: _ctx.t('Paper setup')
        }, [
          _createElementVNode("span", {
            innerHTML: _ctx.icons.paper
          }, null, 8 /* PROPS */, _hoisted_24)
        ], 8 /* PROPS */, _hoisted_23),
        _createElementVNode("button", {
          class: "eb-btn ghost",
          onClick: _cache[11] || (_cache[11] = (...args) => (_ctx.showSource && _ctx.showSource(...args))),
          disabled: !_ctx.doc.id,
          title: _ctx.t('View the HTML')
        }, "</>", 8 /* PROPS */, _hoisted_25),
        _createElementVNode("button", {
          class: "eb-btn ghost",
          onClick: _cache[12] || (_cache[12] = $event => (_ctx.menuOpen = !_ctx.menuOpen)),
          title: _ctx.t('More')
        }, "⋯", 8 /* PROPS */, _hoisted_26),
        (_ctx.doc.id)
          ? (_openBlock(), _createElementBlock("span", _hoisted_27, [
              _createElementVNode("select", {
                class: "tb-style",
                value: _ctx.fmt.block || 'P',
                onChange: _cache[13] || (_cache[13] = $event => (_ctx.setBlock($event.target.value))),
                title: _ctx.t('Paragraph style')
              }, [
                _createElementVNode("option", _hoisted_29, _toDisplayString(_ctx.t('Body text')), 1 /* TEXT */),
                _createElementVNode("option", _hoisted_30, _toDisplayString(_ctx.t('Heading 1')), 1 /* TEXT */),
                _createElementVNode("option", _hoisted_31, _toDisplayString(_ctx.t('Heading 2')), 1 /* TEXT */),
                _createElementVNode("option", _hoisted_32, _toDisplayString(_ctx.t('Heading 3')), 1 /* TEXT */),
                _createElementVNode("option", _hoisted_33, _toDisplayString(_ctx.t('Heading 4')), 1 /* TEXT */),
                _createElementVNode("option", _hoisted_34, _toDisplayString(_ctx.t('Quotation')), 1 /* TEXT */),
                _createElementVNode("option", _hoisted_35, _toDisplayString(_ctx.t('Preformatted')), 1 /* TEXT */)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_28),
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[14] || (_cache[14] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[15] || (_cache[15] = $event => (_ctx.openStyles())),
                title: _ctx.t('Change this style everywhere…')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.props
                }, null, 8 /* PROPS */, _hoisted_37)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_36),
              _createElementVNode("span", _hoisted_38, [
                _createElementVNode("button", {
                  class: _normalizeClass(["eb-tb text font-btn", { on: _ctx.menu === 'font' }]),
                  onMousedown: _cache[16] || (_cache[16] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[17] || (_cache[17] = $event => (_ctx.toggleMenu('font'))),
                  title: _ctx.t('Typeface of the text')
                }, [
                  _createElementVNode("span", {
                    class: "fname",
                    style: _normalizeStyle({ fontFamily: _ctx.fontPreviewStack(_ctx.fmt.family) })
                  }, _toDisplayString(_ctx.fmt.family || _ctx.fontsInUse.body), 5 /* TEXT, STYLE */),
                  _createElementVNode("span", {
                    class: "caret",
                    innerHTML: _ctx.icons.down
                  }, null, 8 /* PROPS */, _hoisted_40)
                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_39),
                (_ctx.menu === 'font')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "eb-menu wide",
                      onMousedown: _cache[21] || (_cache[21] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[18] || (_cache[18] = $event => {_ctx.setFamily(''); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('As the paragraph style says')), 1 /* TEXT */),
                      _hoisted_41,
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontRoles, (r) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: r.key,
                          class: "eb-menu-item",
                          onClick: $event => {_ctx.setFamily(_ctx.fontsInUse[r.key]); _ctx.menu = ''}
                        }, [
                          _createElementVNode("span", {
                            style: _normalizeStyle({ fontFamily: _ctx.fontPreviewStack(_ctx.fontsInUse[r.key]) })
                          }, _toDisplayString(_ctx.fontsInUse[r.key]), 5 /* TEXT, STYLE */),
                          _createElementVNode("span", _hoisted_43, _toDisplayString(r.label), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_42))
                      }), 128 /* KEYED_FRAGMENT */)),
                      _hoisted_44,
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[19] || (_cache[19] = $event => (_ctx.openFonts('selection')))
                      }, _toDisplayString(_ctx.t('Another typeface…')), 1 /* TEXT */),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[20] || (_cache[20] = $event => {_ctx.paperOpen = true; _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('The typefaces of the document…')), 1 /* TEXT */)
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              _createElementVNode("span", _hoisted_45, [
                _createElementVNode("span", {
                  class: "eb-num",
                  title: _ctx.t('Size of the text (pt)')
                }, [
                  _createElementVNode("button", {
                    class: "eb-tb",
                    onMousedown: _cache[22] || (_cache[22] = _withModifiers(() => {}, ["prevent"])),
                    onClick: _cache[23] || (_cache[23] = $event => (_ctx.stepSize(-0.5))),
                    innerHTML: _ctx.icons.minus
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_47),
                  _createElementVNode("input", {
                    type: "number",
                    min: "4",
                    max: "200",
                    step: "0.5",
                    value: _ctx.fmt.size,
                    onChange: _cache[24] || (_cache[24] = $event => (_ctx.setSize($event.target.value))),
                    onKeydown: _cache[25] || (_cache[25] = _withKeys(_withModifiers($event => (_ctx.setSize($event.target.value)), ["prevent"]), ["enter"]))
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_48),
                  _createElementVNode("button", {
                    class: "eb-tb",
                    onMousedown: _cache[26] || (_cache[26] = _withModifiers(() => {}, ["prevent"])),
                    onClick: _cache[27] || (_cache[27] = $event => (_ctx.stepSize(0.5))),
                    innerHTML: _ctx.icons.plus
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_49),
                  _createElementVNode("button", {
                    class: _normalizeClass(["eb-tb caret", { on: _ctx.menu === 'size' }]),
                    onMousedown: _cache[28] || (_cache[28] = _withModifiers(() => {}, ["prevent"])),
                    onClick: _cache[29] || (_cache[29] = $event => (_ctx.toggleMenu('size'))),
                    innerHTML: _ctx.icons.down
                  }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_50)
                ], 8 /* PROPS */, _hoisted_46),
                (_ctx.menu === 'size')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "eb-menu sizes",
                      onMousedown: _cache[31] || (_cache[31] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontSizes, (n) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: n,
                          class: _normalizeClass(["eb-menu-item", { on: _ctx.fmt.size === n }]),
                          onClick: $event => {_ctx.setSize(n); _ctx.menu = ''}
                        }, _toDisplayString(n), 11 /* TEXT, CLASS, PROPS */, _hoisted_51))
                      }), 128 /* KEYED_FRAGMENT */)),
                      _hoisted_52,
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[30] || (_cache[30] = $event => {_ctx.setSize(''); _ctx.menu = ''})
                      }, _toDisplayString(_ctx.t('As the paragraph style says')), 1 /* TEXT */)
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              _hoisted_53,
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[32] || (_cache[32] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[33] || (_cache[33] = (...args) => (_ctx.undo && _ctx.undo(...args))),
                title: _ctx.t('Undo') + ' (Ctrl+Z)'
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.undo
                }, null, 8 /* PROPS */, _hoisted_55)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_54),
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[34] || (_cache[34] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[35] || (_cache[35] = (...args) => (_ctx.redo && _ctx.redo(...args))),
                title: _ctx.t('Redo') + ' (Ctrl+Shift+Z)'
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.redo
                }, null, 8 /* PROPS */, _hoisted_57)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_56),
              (!_ctx.flow)
                ? (_openBlock(), _createElementBlock("span", {
                    key: 0,
                    class: "eb-num",
                    title: _ctx.t('Zoom')
                  }, [
                    _createElementVNode("span", _hoisted_59, _toDisplayString(_ctx.t('Zoom')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "eb-tb",
                      onMousedown: _cache[36] || (_cache[36] = _withModifiers(() => {}, ["prevent"])),
                      onClick: _cache[37] || (_cache[37] = $event => (_ctx.stepZoom(-10))),
                      innerHTML: _ctx.icons.minus
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_60),
                    _createElementVNode("button", {
                      class: "eb-tb text zoomv",
                      onMousedown: _cache[38] || (_cache[38] = _withModifiers(() => {}, ["prevent"])),
                      onClick: _cache[39] || (_cache[39] = $event => {_ctx.zoomSetByHand = true; _ctx.zoom = 100})
                    }, _toDisplayString(_ctx.zoom) + "%", 33 /* TEXT, NEED_HYDRATION */),
                    _createElementVNode("button", {
                      class: "eb-tb",
                      onMousedown: _cache[40] || (_cache[40] = _withModifiers(() => {}, ["prevent"])),
                      onClick: _cache[41] || (_cache[41] = $event => (_ctx.stepZoom(10))),
                      innerHTML: _ctx.icons.plus
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_61)
                  ], 8 /* PROPS */, _hoisted_58))
                : _createCommentVNode("v-if", true)
            ]))
          : _createCommentVNode("v-if", true),
        (_ctx.menuOpen)
          ? (_openBlock(), _createElementBlock("div", {
              key: 1,
              class: "eb-modal-back",
              onClick: _cache[50] || (_cache[50] = $event => (_ctx.menuOpen = false))
            }, [
              _createElementVNode("div", {
                class: "eb-modal",
                style: {"width":"min(360px,100%)"},
                onClick: _cache[49] || (_cache[49] = _withModifiers(() => {}, ["stop"]))
              }, [
                _createElementVNode("h3", null, _toDisplayString(_ctx.doc.title || _ctx.t('Untitled document')), 1 /* TEXT */),
                _createElementVNode("div", _hoisted_62, [
                  (_ctx.narrow)
                    ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                        _createElementVNode("button", {
                          class: "eb-btn wide primary",
                          onClick: _cache[42] || (_cache[42] = $event => {_ctx.newDoc(); _ctx.menuOpen = false})
                        }, "＋ " + _toDisplayString(_ctx.t('New document')), 1 /* TEXT */),
                        (_ctx.docs.length)
                          ? (_openBlock(), _createElementBlock("div", _hoisted_63, [
                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.docs, (d) => {
                                return (_openBlock(), _createElementBlock("button", {
                                  key: d.id,
                                  class: _normalizeClass(["eb-btn wide ghost", { on: d.id === _ctx.doc.id }]),
                                  onClick: $event => {_ctx.openDoc(d.id); _ctx.menuOpen = false}
                                }, _toDisplayString(d.title), 11 /* TEXT, CLASS, PROPS */, _hoisted_64))
                              }), 128 /* KEYED_FRAGMENT */))
                            ]))
                          : _createCommentVNode("v-if", true),
                        _hoisted_65
                      ], 64 /* STABLE_FRAGMENT */))
                    : _createCommentVNode("v-if", true),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[43] || (_cache[43] = (...args) => (_ctx.download && _ctx.download(...args)))
                  }, "⬇ " + _toDisplayString(_ctx.t('Download a copy')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[44] || (_cache[44] = (...args) => (_ctx.duplicate && _ctx.duplicate(...args)))
                  }, "⧉ " + _toDisplayString(_ctx.t('Duplicate')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[45] || (_cache[45] = $event => {_ctx.paperOpen = true; _ctx.menuOpen = false})
                  }, "🖹 " + _toDisplayString(_ctx.t('Paper setup')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: _normalizeClass(["eb-btn wide", { on: _ctx.review }]),
                    onClick: _cache[46] || (_cache[46] = $event => {_ctx.review = !_ctx.review; _ctx.menuOpen = false})
                  }, "✎ " + _toDisplayString(_ctx.review ? _ctx.t('Stop recording changes') : _ctx.t('Record changes')), 3 /* TEXT, CLASS */),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[47] || (_cache[47] = (...args) => (_ctx.showSource && _ctx.showSource(...args)))
                  }, "</> " + _toDisplayString(_ctx.t('View the HTML')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide danger",
                    onClick: _cache[48] || (_cache[48] = (...args) => (_ctx.removeDoc && _ctx.removeDoc(...args)))
                  }, "🗑 " + _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */)
                ])
              ])
            ]))
          : _createCommentVNode("v-if", true)
      ]),
      _createCommentVNode(" The page is running code the server has since replaced. Saying so is the\n         difference between \"it is not fixed\" and \"reload and it is\". "),
      (_ctx.newBuild)
        ? (_openBlock(), _createElementBlock("div", _hoisted_66, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('A newer EditBase is on the server. This page is still running the old one.')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "eb-btn primary",
              onClick: _cache[51] || (_cache[51] = (...args) => (_ctx.reloadForNewBuild && _ctx.reloadForNewBuild(...args)))
            }, _toDisplayString(_ctx.t('Save and reload')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "eb-btn ghost",
              onClick: _cache[52] || (_cache[52] = $event => (_ctx.newBuild = false))
            }, _toDisplayString(_ctx.t('Later')), 1 /* TEXT */)
          ]))
        : _createCommentVNode("v-if", true),
      _createCommentVNode(" What is done to the object that is chosen. It is a row of its own, under\n         the top row, and it is there only while something is chosen: in the rail\n         it stood thirteen buttons tall and pushed the tools off the screen. "),
      (_ctx.doc.id && _ctx.frame.on)
        ? (_openBlock(), _createElementBlock("div", _hoisted_67, [
            (_ctx.frame.on)
              ? (_openBlock(), _createElementBlock("span", {
                  key: 0,
                  class: "eb-objgrp",
                  onContextmenu: _cache[68] || (_cache[68] = _withModifiers($event => (_ctx.objectCtx($event)), ["prevent","stop"]))
                }, [
                  _createElementVNode("span", _hoisted_68, _toDisplayString(_ctx.frameLabel), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: _normalizeClass(["eb-tb", { on: _ctx.frame.free }]),
                    onClick: _cache[53] || (_cache[53] = $event => (_ctx.frameCmd('free'))),
                    title: _ctx.t('Place it freely')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.free
                    }, null, 8 /* PROPS */, _hoisted_70)
                  ], 10 /* CLASS, PROPS */, _hoisted_69),
                  _createElementVNode("button", {
                    class: _normalizeClass(["eb-tb", { on: _ctx.frame.wrap === 'none' }]),
                    onClick: _cache[54] || (_cache[54] = $event => (_ctx.frameCmd('wrapMode', 'none'))),
                    title: _ctx.t('Above and below')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.wrapNone
                    }, null, 8 /* PROPS */, _hoisted_72)
                  ], 10 /* CLASS, PROPS */, _hoisted_71),
                  _createElementVNode("button", {
                    class: _normalizeClass(["eb-tb", { on: _ctx.frame.wrap === 'left' }]),
                    onClick: _cache[55] || (_cache[55] = $event => (_ctx.frameCmd('wrapMode', 'left'))),
                    title: _ctx.t('Words to its left')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.wrapRight
                    }, null, 8 /* PROPS */, _hoisted_74)
                  ], 10 /* CLASS, PROPS */, _hoisted_73),
                  _createElementVNode("button", {
                    class: _normalizeClass(["eb-tb", { on: _ctx.frame.wrap === 'right' }]),
                    onClick: _cache[56] || (_cache[56] = $event => (_ctx.frameCmd('wrapMode', 'right'))),
                    title: _ctx.t('Words to its right')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.wrapLeft
                    }, null, 8 /* PROPS */, _hoisted_76)
                  ], 10 /* CLASS, PROPS */, _hoisted_75),
                  _createElementVNode("button", {
                    class: _normalizeClass(["eb-tb", { on: _ctx.frame.wrap === 'through' }]),
                    onClick: _cache[57] || (_cache[57] = $event => (_ctx.frameCmd('wrapMode', 'through'))),
                    title: _ctx.t('Words underneath it')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.wrapThrough
                    }, null, 8 /* PROPS */, _hoisted_78)
                  ], 10 /* CLASS, PROPS */, _hoisted_77),
                  _hoisted_79,
                  _createElementVNode("button", {
                    class: "eb-tb",
                    onClick: _cache[58] || (_cache[58] = $event => (_ctx.frameCmd('stack', 'front'))),
                    title: _ctx.t('Bring to front')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.toFront
                    }, null, 8 /* PROPS */, _hoisted_81)
                  ], 8 /* PROPS */, _hoisted_80),
                  _createElementVNode("button", {
                    class: "eb-tb",
                    onClick: _cache[59] || (_cache[59] = $event => (_ctx.frameCmd('stack', 'back'))),
                    title: _ctx.t('Send to back')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.toBack
                    }, null, 8 /* PROPS */, _hoisted_83)
                  ], 8 /* PROPS */, _hoisted_82),
                  _hoisted_84,
                  _createElementVNode("button", {
                    class: "eb-tb",
                    onClick: _cache[60] || (_cache[60] = $event => (_ctx.frameCmd('align', 'eb-al-l'))),
                    title: _ctx.t('Put the frame at the left margin')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.boxL
                    }, null, 8 /* PROPS */, _hoisted_86)
                  ], 8 /* PROPS */, _hoisted_85),
                  _createElementVNode("button", {
                    class: "eb-tb",
                    onClick: _cache[61] || (_cache[61] = $event => (_ctx.frameCmd('align', 'eb-al-c'))),
                    title: _ctx.t('Centre the frame in the column')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.boxC
                    }, null, 8 /* PROPS */, _hoisted_88)
                  ], 8 /* PROPS */, _hoisted_87),
                  _createElementVNode("button", {
                    class: "eb-tb",
                    onClick: _cache[62] || (_cache[62] = $event => (_ctx.frameCmd('align', 'eb-al-r'))),
                    title: _ctx.t('Put the frame at the right margin')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.boxR
                    }, null, 8 /* PROPS */, _hoisted_90)
                  ], 8 /* PROPS */, _hoisted_89),
                  _createElementVNode("button", {
                    class: "eb-tb",
                    onClick: _cache[63] || (_cache[63] = $event => (_ctx.frameCmd('fit'))),
                    title: _ctx.t('Make the frame the width of the column')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.boxW
                    }, null, 8 /* PROPS */, _hoisted_92)
                  ], 8 /* PROPS */, _hoisted_91),
                  (_ctx.frame.extras.length)
                    ? (_openBlock(), _createElementBlock("span", _hoisted_93))
                    : _createCommentVNode("v-if", true),
                  (_ctx.frame.extras.length)
                    ? (_openBlock(), _createElementBlock("button", {
                        key: 1,
                        class: "eb-tb",
                        onClick: _cache[64] || (_cache[64] = $event => (_ctx.frameCmd('spread'))),
                        title: _ctx.t('Space them evenly')
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.spread
                        }, null, 8 /* PROPS */, _hoisted_95)
                      ], 8 /* PROPS */, _hoisted_94))
                    : _createCommentVNode("v-if", true),
                  (_ctx.frame.extras.length)
                    ? (_openBlock(), _createElementBlock("button", {
                        key: 2,
                        class: "eb-tb",
                        onClick: _cache[65] || (_cache[65] = $event => (_ctx.frameCmd('sameSize'))),
                        title: _ctx.t('Make them the same size')
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.sameSize
                        }, null, 8 /* PROPS */, _hoisted_97)
                      ], 8 /* PROPS */, _hoisted_96))
                    : _createCommentVNode("v-if", true),
                  _hoisted_98,
                  _createElementVNode("button", {
                    class: "eb-tb",
                    onClick: _cache[66] || (_cache[66] = (...args) => (_ctx.openFrameProps && _ctx.openFrameProps(...args))),
                    title: _ctx.t('Frame properties…')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.props
                    }, null, 8 /* PROPS */, _hoisted_100)
                  ], 8 /* PROPS */, _hoisted_99),
                  _createElementVNode("button", {
                    class: "eb-tb danger",
                    onClick: _cache[67] || (_cache[67] = $event => (_ctx.frameCmd('delete'))),
                    title: _ctx.t('Delete')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.clear
                    }, null, 8 /* PROPS */, _hoisted_102)
                  ], 8 /* PROPS */, _hoisted_101)
                ], 32 /* NEED_HYDRATION */))
              : _createCommentVNode("v-if", true)
          ]))
        : _createCommentVNode("v-if", true),
      (_ctx.doc.id && _ctx.find.open)
        ? (_openBlock(), _createElementBlock("div", _hoisted_103, [
            _createElementVNode("span", {
              class: "ic",
              innerHTML: _ctx.icons.search
            }, null, 8 /* PROPS */, _hoisted_104),
            _withDirectives(_createElementVNode("input", {
              ref: "findInput",
              type: "text",
              "onUpdate:modelValue": _cache[69] || (_cache[69] = $event => ((_ctx.find.query) = $event)),
              placeholder: _ctx.t('Find'),
              onInput: _cache[70] || (_cache[70] = $event => (_ctx.runFind())),
              onKeydown: [
                _cache[71] || (_cache[71] = _withKeys(_withModifiers($event => (_ctx.findNext(1)), ["prevent"]), ["enter"])),
                _cache[72] || (_cache[72] = _withKeys(_withModifiers((...args) => (_ctx.closeFind && _ctx.closeFind(...args)), ["prevent"]), ["esc"]))
              ]
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_105), [
              [_vModelText, _ctx.find.query]
            ]),
            _createElementVNode("span", _hoisted_106, _toDisplayString(_ctx.find.hits.length ? (_ctx.find.index + 1) + ' / ' + _ctx.find.hits.length : _ctx.t('none')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "eb-tb",
              onClick: _cache[73] || (_cache[73] = $event => (_ctx.findNext(-1))),
              title: _ctx.t('Previous')
            }, "↑", 8 /* PROPS */, _hoisted_107),
            _createElementVNode("button", {
              class: "eb-tb",
              onClick: _cache[74] || (_cache[74] = $event => (_ctx.findNext(1))),
              title: _ctx.t('Next')
            }, "↓", 8 /* PROPS */, _hoisted_108),
            _createElementVNode("label", _hoisted_109, [
              _withDirectives(_createElementVNode("input", {
                type: "checkbox",
                "onUpdate:modelValue": _cache[75] || (_cache[75] = $event => ((_ctx.find.caseSensitive) = $event)),
                onChange: _cache[76] || (_cache[76] = $event => (_ctx.runFind()))
              }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                [_vModelCheckbox, _ctx.find.caseSensitive]
              ]),
              _createTextVNode(" " + _toDisplayString(_ctx.t('Match case')), 1 /* TEXT */)
            ]),
            _hoisted_110,
            _withDirectives(_createElementVNode("input", {
              type: "text",
              "onUpdate:modelValue": _cache[77] || (_cache[77] = $event => ((_ctx.find.replace) = $event)),
              placeholder: _ctx.t('Replace with'),
              onKeydown: _cache[78] || (_cache[78] = _withKeys(_withModifiers((...args) => (_ctx.replaceOne && _ctx.replaceOne(...args)), ["prevent"]), ["enter"]))
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_111), [
              [_vModelText, _ctx.find.replace]
            ]),
            _createElementVNode("button", {
              class: "eb-btn",
              onClick: _cache[79] || (_cache[79] = (...args) => (_ctx.replaceOne && _ctx.replaceOne(...args))),
              disabled: !_ctx.find.hits.length
            }, _toDisplayString(_ctx.t('Replace')), 9 /* TEXT, PROPS */, _hoisted_112),
            _createElementVNode("button", {
              class: "eb-btn",
              onClick: _cache[80] || (_cache[80] = (...args) => (_ctx.replaceAll && _ctx.replaceAll(...args))),
              disabled: !_ctx.find.hits.length
            }, _toDisplayString(_ctx.t('Replace all')), 9 /* TEXT, PROPS */, _hoisted_113),
            _createElementVNode("button", {
              class: "eb-tb",
              onClick: _cache[81] || (_cache[81] = (...args) => (_ctx.closeFind && _ctx.closeFind(...args))),
              title: _ctx.t('Close')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.close
              }, null, 8 /* PROPS */, _hoisted_115)
            ], 8 /* PROPS */, _hoisted_114)
          ]))
        : _createCommentVNode("v-if", true),
      (_ctx.doc.id && (_ctx.review || _ctx.changes))
        ? (_openBlock(), _createElementBlock("div", _hoisted_116, [
            _createElementVNode("span", _hoisted_117, _toDisplayString(_ctx.t('Review')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb text", { on: _ctx.review }]),
              onMousedown: _cache[82] || (_cache[82] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[83] || (_cache[83] = $event => (_ctx.review = !_ctx.review)),
              title: _ctx.t('Record what is changed from now on')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.review
              }, null, 8 /* PROPS */, _hoisted_119),
              _createElementVNode("span", _hoisted_120, _toDisplayString(_ctx.review ? _ctx.t('Recording') : _ctx.t('Not recording')), 1 /* TEXT */)
            ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_118),
            _hoisted_121,
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb text", { on: !_ctx.showChanges }]),
              onMousedown: _cache[84] || (_cache[84] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[85] || (_cache[85] = $event => (_ctx.showChanges = !_ctx.showChanges))
            }, [
              _createElementVNode("span", _hoisted_122, _toDisplayString(_ctx.showChanges ? _ctx.t('Showing the marks') : _ctx.t('As it would read')), 1 /* TEXT */)
            ], 34 /* CLASS, NEED_HYDRATION */),
            _hoisted_123,
            _createElementVNode("button", {
              class: "eb-tb text",
              onMousedown: _cache[86] || (_cache[86] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[87] || (_cache[87] = $event => (_ctx.reviewCmd('acceptOne'))),
              disabled: !_ctx.fmt.change
            }, _toDisplayString(_ctx.t('Keep this one')), 41 /* TEXT, PROPS, NEED_HYDRATION */, _hoisted_124),
            _createElementVNode("button", {
              class: "eb-tb text",
              onMousedown: _cache[88] || (_cache[88] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[89] || (_cache[89] = $event => (_ctx.reviewCmd('rejectOne'))),
              disabled: !_ctx.fmt.change
            }, _toDisplayString(_ctx.t('Undo this one')), 41 /* TEXT, PROPS, NEED_HYDRATION */, _hoisted_125),
            _hoisted_126,
            _createElementVNode("button", {
              class: "eb-tb text",
              onMousedown: _cache[90] || (_cache[90] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[91] || (_cache[91] = $event => (_ctx.reviewCmd('acceptAll'))),
              disabled: !_ctx.changes
            }, _toDisplayString(_ctx.t('Keep them all')), 41 /* TEXT, PROPS, NEED_HYDRATION */, _hoisted_127),
            _createElementVNode("button", {
              class: "eb-tb text",
              onMousedown: _cache[92] || (_cache[92] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[93] || (_cache[93] = $event => (_ctx.reviewCmd('rejectAll'))),
              disabled: !_ctx.changes
            }, _toDisplayString(_ctx.t('Undo them all')), 41 /* TEXT, PROPS, NEED_HYDRATION */, _hoisted_128),
            _createElementVNode("span", _hoisted_129, _toDisplayString(_ctx.t('{n} changes marked', { n: _ctx.changes })), 1 /* TEXT */)
          ]))
        : _createCommentVNode("v-if", true),
      (_ctx.doc.id && _ctx.fmt.image)
        ? (_openBlock(), _createElementBlock("div", _hoisted_130, [
            _createElementVNode("span", _hoisted_131, _toDisplayString(_ctx.t('Picture')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb text", { on: _ctx.fmt.imageSize === 'eb-img-s' }]),
              onMousedown: _cache[94] || (_cache[94] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[95] || (_cache[95] = $event => (_ctx.imageCmd('size', 'eb-img-s')))
            }, _toDisplayString(_ctx.t('Small')), 35 /* TEXT, CLASS, NEED_HYDRATION */),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb text", { on: _ctx.fmt.imageSize === 'eb-img-m' }]),
              onMousedown: _cache[96] || (_cache[96] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[97] || (_cache[97] = $event => (_ctx.imageCmd('size', 'eb-img-m')))
            }, _toDisplayString(_ctx.t('Medium')), 35 /* TEXT, CLASS, NEED_HYDRATION */),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb text", { on: _ctx.fmt.imageSize === 'eb-img-l' }]),
              onMousedown: _cache[98] || (_cache[98] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[99] || (_cache[99] = $event => (_ctx.imageCmd('size', 'eb-img-l')))
            }, _toDisplayString(_ctx.t('Full width')), 35 /* TEXT, CLASS, NEED_HYDRATION */),
            _hoisted_132,
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[100] || (_cache[100] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[101] || (_cache[101] = (...args) => (_ctx.openCrop && _ctx.openCrop(...args))),
              title: _ctx.t('Crop…')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.crop
              }, null, 8 /* PROPS */, _hoisted_134)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_133),
            _createElementVNode("button", {
              class: "eb-tb danger",
              onMousedown: _cache[102] || (_cache[102] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[103] || (_cache[103] = $event => (_ctx.imageCmd('delete'))),
              title: _ctx.t('Delete picture')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.clear
              }, null, 8 /* PROPS */, _hoisted_136)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_135),
            _createElementVNode("span", _hoisted_137, _toDisplayString(_ctx.t('The caption sits under the picture; leave it empty and it does not print.')), 1 /* TEXT */)
          ]))
        : _createCommentVNode("v-if", true),
      (_ctx.doc.id && _ctx.fmt.table)
        ? (_openBlock(), _createElementBlock("div", _hoisted_138, [
            _createElementVNode("span", _hoisted_139, _toDisplayString(_ctx.t('Table')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[104] || (_cache[104] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[105] || (_cache[105] = $event => (_ctx.tableCmd('rowAbove'))),
              title: _ctx.t('Insert row above')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.rowAbove
              }, null, 8 /* PROPS */, _hoisted_141)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_140),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[106] || (_cache[106] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[107] || (_cache[107] = $event => (_ctx.tableCmd('rowBelow'))),
              title: _ctx.t('Insert row below')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.rowBelow
              }, null, 8 /* PROPS */, _hoisted_143)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_142),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[108] || (_cache[108] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[109] || (_cache[109] = $event => (_ctx.tableCmd('colLeft'))),
              title: _ctx.t('Insert column left')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.colLeft
              }, null, 8 /* PROPS */, _hoisted_145)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_144),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[110] || (_cache[110] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[111] || (_cache[111] = $event => (_ctx.tableCmd('colRight'))),
              title: _ctx.t('Insert column right')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.colRight
              }, null, 8 /* PROPS */, _hoisted_147)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_146),
            _hoisted_148,
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[112] || (_cache[112] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[113] || (_cache[113] = $event => (_ctx.tableCmd('rowDel'))),
              title: _ctx.t('Delete row')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.rowDel
              }, null, 8 /* PROPS */, _hoisted_150)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_149),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[114] || (_cache[114] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[115] || (_cache[115] = $event => (_ctx.tableCmd('colDel'))),
              title: _ctx.t('Delete column')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.colDel
              }, null, 8 /* PROPS */, _hoisted_152)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_151),
            _hoisted_153,
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.tableHeader }]),
              onMousedown: _cache[116] || (_cache[116] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[117] || (_cache[117] = $event => (_ctx.tableCmd('header'))),
              title: _ctx.t('First row is a header')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.header
              }, null, 8 /* PROPS */, _hoisted_155)
            ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_154),
            _createElementVNode("select", {
              value: _ctx.fmt.tableVariant,
              onChange: _cache[118] || (_cache[118] = $event => (_ctx.tableCmd('variant', $event.target.value))),
              title: _ctx.t('Style')
            }, [
              _createElementVNode("option", _hoisted_157, _toDisplayString(_ctx.t('All borders')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_158, _toDisplayString(_ctx.t('Horizontal lines only')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_159, _toDisplayString(_ctx.t('No borders')), 1 /* TEXT */)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_156),
            _hoisted_160,
            _createElementVNode("label", {
              class: "eb-tb",
              title: _ctx.t('Cell colour')
            }, [
              _createElementVNode("span", {
                class: "colour-bar",
                style: _normalizeStyle({ background: _ctx.cellFill || 'transparent' })
              }, null, 4 /* STYLE */),
              _createElementVNode("span", {
                innerHTML: _ctx.icons.highlight
              }, null, 8 /* PROPS */, _hoisted_162),
              _createElementVNode("input", {
                type: "color",
                value: _ctx.cellFill || '#eef1f6',
                onInput: _cache[119] || (_cache[119] = $event => (_ctx.tableCmd('fill', $event.target.value)))
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_163)
            ], 8 /* PROPS */, _hoisted_161),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[120] || (_cache[120] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[121] || (_cache[121] = $event => (_ctx.tableCmd('fill', ''))),
              title: _ctx.t('No cell colour')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.nocolour
              }, null, 8 /* PROPS */, _hoisted_165)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_164),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[122] || (_cache[122] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[123] || (_cache[123] = $event => (_ctx.tableCmd('valign', 'top'))),
              title: _ctx.t('Cell text at the top')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.vTop
              }, null, 8 /* PROPS */, _hoisted_167)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_166),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[124] || (_cache[124] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[125] || (_cache[125] = $event => (_ctx.tableCmd('valign', 'middle'))),
              title: _ctx.t('Cell text in the middle')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.vMid
              }, null, 8 /* PROPS */, _hoisted_169)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_168),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[126] || (_cache[126] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[127] || (_cache[127] = $event => (_ctx.tableCmd('valign', 'bottom'))),
              title: _ctx.t('Cell text at the bottom')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.vBot
              }, null, 8 /* PROPS */, _hoisted_171)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_170),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[128] || (_cache[128] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[129] || (_cache[129] = (...args) => (_ctx.openCellBorder && _ctx.openCellBorder(...args))),
              title: _ctx.t('Rule round the cells…')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.cellBorder
              }, null, 8 /* PROPS */, _hoisted_173)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_172),
            _hoisted_174,
            _createElementVNode("button", {
              class: "eb-tb danger",
              onMousedown: _cache[130] || (_cache[130] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[131] || (_cache[131] = $event => (_ctx.tableCmd('delete'))),
              title: _ctx.t('Delete table')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.tableDel
              }, null, 8 /* PROPS */, _hoisted_176)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_175),
            _createElementVNode("span", _hoisted_177, _toDisplayString(_ctx.t('Tab moves to the next cell; a new row is added at the end.')), 1 /* TEXT */)
          ]))
        : _createCommentVNode("v-if", true),
      _createCommentVNode(" Down the left, in two columns, and outside the part that scrolls: on a\n         wide screen the room is at the sides, and the page wants the height.\n         The shelf of things to put on the page is at the foot of it. "),
      _createElementVNode("div", _hoisted_178, [
        (_ctx.doc.id)
          ? (_openBlock(), _createElementBlock("div", _hoisted_179, [
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.bold }]),
                onMousedown: _cache[132] || (_cache[132] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[133] || (_cache[133] = $event => (_ctx.inline('bold'))),
                title: _ctx.t('Bold') + ' (Ctrl+B)'
              }, _hoisted_182, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_180),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.italic }]),
                onMousedown: _cache[134] || (_cache[134] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[135] || (_cache[135] = $event => (_ctx.inline('italic'))),
                title: _ctx.t('Italic') + ' (Ctrl+I)'
              }, _hoisted_185, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_183),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.underline }]),
                onMousedown: _cache[136] || (_cache[136] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[137] || (_cache[137] = $event => (_ctx.inline('underline'))),
                title: _ctx.t('Underline') + ' (Ctrl+U)'
              }, _hoisted_188, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_186),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.strike }]),
                onMousedown: _cache[138] || (_cache[138] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[139] || (_cache[139] = $event => (_ctx.inline('strike'))),
                title: _ctx.t('Strikethrough')
              }, _hoisted_191, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_189),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.kenten }]),
                onMousedown: _cache[140] || (_cache[140] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[141] || (_cache[141] = $event => (_ctx.inline('kenten'))),
                title: _ctx.t('Emphasis dots')
              }, _hoisted_194, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_192),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.sup }]),
                onMousedown: _cache[142] || (_cache[142] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[143] || (_cache[143] = $event => (_ctx.inline('sup'))),
                title: _ctx.t('Superscript')
              }, _hoisted_197, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_195),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.sub }]),
                onMousedown: _cache[144] || (_cache[144] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[145] || (_cache[145] = $event => (_ctx.inline('sub'))),
                title: _ctx.t('Subscript')
              }, _hoisted_200, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_198),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.code }]),
                onMousedown: _cache[146] || (_cache[146] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[147] || (_cache[147] = $event => (_ctx.inline('code'))),
                title: _ctx.t('Inline code')
              }, _hoisted_203, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_201),
              _hoisted_204,
              _createElementVNode("span", _hoisted_205, [
                _createElementVNode("button", {
                  class: _normalizeClass(["eb-tb", { on: _ctx.menu === 'hl' }]),
                  onMousedown: _cache[148] || (_cache[148] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[149] || (_cache[149] = $event => (_ctx.toggleMenu('hl'))),
                  title: _ctx.t('Highlight')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.highlight
                  }, null, 8 /* PROPS */, _hoisted_207)
                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_206),
                (_ctx.menu === 'hl')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "eb-menu",
                      onMousedown: _cache[151] || (_cache[151] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.highlights, (h) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: h.key,
                          class: "eb-menu-item",
                          onClick: $event => {_ctx.inline(h.key); _ctx.menu = ''}
                        }, [
                          _createElementVNode("span", {
                            class: "eb-swatch",
                            style: _normalizeStyle({ background: h.color })
                          }, null, 4 /* STYLE */),
                          _createTextVNode(_toDisplayString(h.label), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_208))
                      }), 128 /* KEYED_FRAGMENT */)),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[150] || (_cache[150] = $event => {_ctx.clearHighlight(); _ctx.menu = ''})
                      }, [
                        _hoisted_209,
                        _createTextVNode(_toDisplayString(_ctx.t('Remove highlight')), 1 /* TEXT */)
                      ])
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              _createElementVNode("label", {
                class: "eb-tb",
                title: _ctx.t('Text colour')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.colour
                }, null, 8 /* PROPS */, _hoisted_211),
                _createElementVNode("span", {
                  class: "colour-bar",
                  style: _normalizeStyle({ background: _ctx.colour })
                }, null, 4 /* STYLE */),
                _createElementVNode("input", {
                  type: "color",
                  value: _ctx.colour,
                  onInput: _cache[152] || (_cache[152] = $event => (_ctx.setColour($event.target.value)))
                }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_212)
              ], 8 /* PROPS */, _hoisted_210),
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[153] || (_cache[153] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[154] || (_cache[154] = (...args) => (_ctx.clearColour && _ctx.clearColour(...args))),
                title: _ctx.t('Remove text colour')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.nocolour
                }, null, 8 /* PROPS */, _hoisted_214)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_213),
              _hoisted_215,
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.list === 'UL' }]),
                onMousedown: _cache[155] || (_cache[155] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[156] || (_cache[156] = $event => (_ctx.list('UL'))),
                title: _ctx.t('Bulleted list')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.ul
                }, null, 8 /* PROPS */, _hoisted_217)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_216),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.list === 'OL' }]),
                onMousedown: _cache[157] || (_cache[157] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[158] || (_cache[158] = $event => (_ctx.list('OL'))),
                title: _ctx.t('Numbered list')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.ol
                }, null, 8 /* PROPS */, _hoisted_219)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_218),
              _createElementVNode("span", _hoisted_220, [
                _createElementVNode("button", {
                  class: _normalizeClass(["eb-tb caret", { on: _ctx.menu === 'marker' }]),
                  onMousedown: _cache[159] || (_cache[159] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[160] || (_cache[160] = $event => (_ctx.toggleMenu('marker'))),
                  title: _ctx.t('Kind of marker'),
                  innerHTML: _ctx.icons.down
                }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_221),
                (_ctx.menu === 'marker')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "eb-menu markers",
                      onMousedown: _cache[161] || (_cache[161] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.listMarkers, (m) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: m.type,
                          class: _normalizeClass(["eb-menu-item", { on: _ctx.fmt.marker === m.type }]),
                          onClick: $event => {_ctx.setMarker(m.type); _ctx.menu = ''}
                        }, [
                          _createElementVNode("span", _hoisted_223, _toDisplayString(m.sample), 1 /* TEXT */),
                          _createElementVNode("span", null, _toDisplayString(m.label), 1 /* TEXT */)
                        ], 10 /* CLASS, PROPS */, _hoisted_222))
                      }), 128 /* KEYED_FRAGMENT */))
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.aligns, (a) => {
                return (_openBlock(), _createElementBlock("button", {
                  class: _normalizeClass(["eb-tb", { on: _ctx.fmt.align === a.cls }]),
                  key: a.cls,
                  onMousedown: _cache[162] || (_cache[162] = _withModifiers(() => {}, ["prevent"])),
                  onClick: $event => (_ctx.align(a.cls)),
                  title: a.label,
                  innerHTML: a.icon
                }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_224))
              }), 128 /* KEYED_FRAGMENT */)),
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[163] || (_cache[163] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[164] || (_cache[164] = $event => (_ctx.indent(1))),
                title: _ctx.t('Increase indent')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.indent
                }, null, 8 /* PROPS */, _hoisted_226)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_225),
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[165] || (_cache[165] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[166] || (_cache[166] = $event => (_ctx.indent(-1))),
                title: _ctx.t('Decrease indent')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.outdent
                }, null, 8 /* PROPS */, _hoisted_228)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_227),
              _hoisted_229,
              _createElementVNode("span", _hoisted_230, [
                _createElementVNode("button", {
                  class: _normalizeClass(["eb-tb text", { on: _ctx.menu === 'insert' }]),
                  onMousedown: _cache[167] || (_cache[167] = _withModifiers(() => {}, ["prevent"])),
                  onClick: _cache[168] || (_cache[168] = $event => (_ctx.toggleMenu('insert'))),
                  title: _ctx.t('Insert')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.plus
                  }, null, 8 /* PROPS */, _hoisted_232),
                  _createElementVNode("span", _hoisted_233, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */),
                  _createElementVNode("span", {
                    class: "caret",
                    innerHTML: _ctx.icons.down
                  }, null, 8 /* PROPS */, _hoisted_234)
                ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_231),
                (_ctx.menu === 'insert')
                  ? (_openBlock(), _createElementBlock("div", {
                      key: 0,
                      class: "eb-menu wide",
                      onMousedown: _cache[182] || (_cache[182] = _withModifiers(() => {}, ["prevent"]))
                    }, [
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[169] || (_cache[169] = $event => {_ctx.tableOpen = true; _ctx.menu = ''})
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.table
                        }, null, 8 /* PROPS */, _hoisted_235),
                        _createTextVNode(_toDisplayString(_ctx.t('Insert table')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[170] || (_cache[170] = $event => {_ctx.openPicker(); _ctx.menu = ''})
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.image
                        }, null, 8 /* PROPS */, _hoisted_236),
                        _createTextVNode(_toDisplayString(_ctx.t('Insert picture')), 1 /* TEXT */)
                      ]),
                      _hoisted_237,
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onPointerdown: _cache[171] || (_cache[171] = _withModifiers($event => (_ctx.shapeGrab($event, 'textbox')), ["prevent"]))
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.frame
                        }, null, 8 /* PROPS */, _hoisted_238),
                        _createTextVNode(_toDisplayString(_ctx.t('Text frame')), 1 /* TEXT */)
                      ], 32 /* NEED_HYDRATION */),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onPointerdown: _cache[172] || (_cache[172] = _withModifiers($event => (_ctx.shapeGrab($event, 'frame')), ["prevent"]))
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.box
                        }, null, 8 /* PROPS */, _hoisted_239),
                        _createTextVNode(_toDisplayString(_ctx.t('Block frame')), 1 /* TEXT */)
                      ], 32 /* NEED_HYDRATION */),
                      _hoisted_240,
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.shapes, (sh) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: sh.kind,
                          class: "eb-menu-item",
                          onPointerdown: _withModifiers($event => (_ctx.shapeGrab($event, sh.kind)), ["prevent"])
                        }, [
                          _createElementVNode("span", {
                            class: "eb-shape-icon",
                            innerHTML: sh.icon
                          }, null, 8 /* PROPS */, _hoisted_242),
                          _createTextVNode(_toDisplayString(sh.label), 1 /* TEXT */)
                        ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_241))
                      }), 128 /* KEYED_FRAGMENT */)),
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.boxes, (b) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: b.variant,
                          class: "eb-menu-item",
                          onClick: $event => {_ctx.addBox(b.variant); _ctx.menu = ''}
                        }, [
                          _createElementVNode("span", {
                            innerHTML: _ctx.icons.box
                          }, null, 8 /* PROPS */, _hoisted_244),
                          _createTextVNode(_toDisplayString(b.label), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_243))
                      }), 128 /* KEYED_FRAGMENT */)),
                      _hoisted_245,
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.rules, (r) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: r.cls,
                          class: "eb-menu-item",
                          onClick: $event => {_ctx.addRule(r.cls); _ctx.menu = ''}
                        }, [
                          _createElementVNode("span", {
                            innerHTML: _ctx.icons.rule
                          }, null, 8 /* PROPS */, _hoisted_247),
                          _createTextVNode(_toDisplayString(r.label), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_246))
                      }), 128 /* KEYED_FRAGMENT */)),
                      _hoisted_248,
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[173] || (_cache[173] = $event => {_ctx.addPageBreak(); _ctx.menu = ''})
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.pagebreak
                        }, null, 8 /* PROPS */, _hoisted_249),
                        _createTextVNode(_toDisplayString(_ctx.t('Page break')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[174] || (_cache[174] = $event => {_ctx.openMath(); _ctx.menu = ''})
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.formula
                        }, null, 8 /* PROPS */, _hoisted_250),
                        _createTextVNode(_toDisplayString(_ctx.t('Insert formula (MathML)')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[175] || (_cache[175] = $event => {_ctx.webOpen = true; _ctx.menu = ''})
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.link
                        }, null, 8 /* PROPS */, _hoisted_251),
                        _createTextVNode(_toDisplayString(_ctx.t('Bring in a web page…')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[176] || (_cache[176] = $event => {_ctx.openToc(); _ctx.menu = ''})
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.doc
                        }, null, 8 /* PROPS */, _hoisted_252),
                        _createTextVNode(_toDisplayString(_ctx.t('Table of contents…')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[177] || (_cache[177] = $event => {_ctx.openChars(); _ctx.menu = ''})
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.text
                        }, null, 8 /* PROPS */, _hoisted_253),
                        _createTextVNode(_toDisplayString(_ctx.t('Special character…')), 1 /* TEXT */)
                      ]),
                      _hoisted_254,
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[178] || (_cache[178] = $event => (_ctx.openRuby()))
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.ruby
                        }, null, 8 /* PROPS */, _hoisted_255),
                        _createTextVNode(_toDisplayString(_ctx.t('Reading over the word…')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[179] || (_cache[179] = $event => (_ctx.openNote()))
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.note
                        }, null, 8 /* PROPS */, _hoisted_256),
                        _createTextVNode(_toDisplayString(_ctx.t('Note…')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[180] || (_cache[180] = $event => (_ctx.openCols()))
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.columns
                        }, null, 8 /* PROPS */, _hoisted_257),
                        _createTextVNode(_toDisplayString(_ctx.t('Columns…')), 1 /* TEXT */)
                      ]),
                      _createElementVNode("button", {
                        class: "eb-menu-item",
                        onClick: _cache[181] || (_cache[181] = $event => (_ctx.openRunning()))
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.header
                        }, null, 8 /* PROPS */, _hoisted_258),
                        _createTextVNode(_toDisplayString(_ctx.t('Header and footer…')), 1 /* TEXT */)
                      ]),
                      (_ctx.anySource)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_259))
                        : _createCommentVNode("v-if", true),
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.sourceKeys, (key) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: key,
                          class: "eb-menu-item",
                          onClick: $event => (_ctx.openSource(key))
                        }, [
                          _createElementVNode("span", {
                            innerHTML: _ctx.icons.link
                          }, null, 8 /* PROPS */, _hoisted_261),
                          _createTextVNode(_toDisplayString(_ctx.sourceLabel(key)), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_260))
                      }), 128 /* KEYED_FRAGMENT */))
                    ], 32 /* NEED_HYDRATION */))
                  : _createCommentVNode("v-if", true)
              ]),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: !!_ctx.brush }]),
                onMousedown: _cache[183] || (_cache[183] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[184] || (_cache[184] = (...args) => (_ctx.useBrush && _ctx.useBrush(...args))),
                title: _ctx.brush ? _ctx.t('Put this format on the selection') : _ctx.t('Copy the format at the cursor')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.brush
                }, null, 8 /* PROPS */, _hoisted_263)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_262),
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[185] || (_cache[185] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[186] || (_cache[186] = (...args) => (_ctx.clearFmt && _ctx.clearFmt(...args))),
                title: _ctx.t('Clear formatting')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.clear
                }, null, 8 /* PROPS */, _hoisted_265)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_264),
              _hoisted_266,
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[187] || (_cache[187] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[188] || (_cache[188] = (...args) => (_ctx.undo && _ctx.undo(...args))),
                title: _ctx.t('Undo') + ' (Ctrl+Z)'
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.undo
                }, null, 8 /* PROPS */, _hoisted_268)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_267),
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[189] || (_cache[189] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[190] || (_cache[190] = (...args) => (_ctx.redo && _ctx.redo(...args))),
                title: _ctx.t('Redo') + ' (Ctrl+Shift+Z)'
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.redo
                }, null, 8 /* PROPS */, _hoisted_270)
              ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_269),
              _hoisted_271,
              (!_ctx.flow && !_ctx.tategaki)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 0,
                    class: _normalizeClass(["eb-tb", { on: _ctx.ruler }]),
                    onMousedown: _cache[191] || (_cache[191] = _withModifiers(() => {}, ["prevent"])),
                    onClick: _cache[192] || (_cache[192] = $event => (_ctx.ruler = !_ctx.ruler)),
                    title: _ctx.t('Ruler')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.ruler
                    }, null, 8 /* PROPS */, _hoisted_273)
                  ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_272))
                : _createCommentVNode("v-if", true),
              (!_ctx.flow)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 1,
                    class: _normalizeClass(["eb-tb", { on: _ctx.guides }]),
                    onMousedown: _cache[193] || (_cache[193] = _withModifiers(() => {}, ["prevent"])),
                    onClick: _cache[194] || (_cache[194] = $event => (_ctx.guides = !_ctx.guides)),
                    title: _ctx.guides ? _ctx.t('Hide the margin boundaries') : _ctx.t('Show the margin boundaries')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.guides
                    }, null, 8 /* PROPS */, _hoisted_275)
                  ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_274))
                : _createCommentVNode("v-if", true),
              (!_ctx.flow)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 2,
                    class: _normalizeClass(["eb-tb", { on: _ctx.palette }]),
                    onMousedown: _cache[195] || (_cache[195] = _withModifiers(() => {}, ["prevent"])),
                    onClick: _cache[196] || (_cache[196] = $event => (_ctx.palette = !_ctx.palette)),
                    title: _ctx.palette ? _ctx.t('Hide the shelf of things to put on the page') : _ctx.t('Show the shelf of things to put on the page')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.palette
                    }, null, 8 /* PROPS */, _hoisted_277)
                  ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_276))
                : _createCommentVNode("v-if", true),
              (!_ctx.flow)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 3,
                    class: _normalizeClass(["eb-tb", { on: _ctx.grid }]),
                    onMousedown: _cache[197] || (_cache[197] = _withModifiers(() => {}, ["prevent"])),
                    onClick: _cache[198] || (_cache[198] = $event => (_ctx.grid = !_ctx.grid)),
                    title: _ctx.grid ? _ctx.t('Hide the grid') : _ctx.t('Show a five millimetre grid')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.grid
                    }, null, 8 /* PROPS */, _hoisted_279)
                  ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_278))
                : _createCommentVNode("v-if", true),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.previewOpen }]),
                onMousedown: _cache[199] || (_cache[199] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[200] || (_cache[200] = $event => (_ctx.previewOpen = !_ctx.previewOpen)),
                title: _ctx.t('Pages')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.pages
                }, null, 8 /* PROPS */, _hoisted_281)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_280),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.layersOpen }]),
                onMousedown: _cache[201] || (_cache[201] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[202] || (_cache[202] = $event => (_ctx.layersOpen = !_ctx.layersOpen)),
                title: _ctx.t('Layers')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.layers
                }, null, 8 /* PROPS */, _hoisted_283)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_282),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.doc.paper.headerOn }]),
                onMousedown: _cache[203] || (_cache[203] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[204] || (_cache[204] = $event => (_ctx.toggleRegion('header'))),
                title: _ctx.t('Header')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.header
                }, null, 8 /* PROPS */, _hoisted_285)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_284),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.doc.paper.footerOn }]),
                onMousedown: _cache[205] || (_cache[205] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[206] || (_cache[206] = $event => (_ctx.toggleRegion('footer'))),
                title: _ctx.t('Footer')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.footer
                }, null, 8 /* PROPS */, _hoisted_287)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_286),
              (!_ctx.flow)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 4,
                    class: _normalizeClass(["eb-tb", { on: _ctx.boxes }]),
                    onMousedown: _cache[207] || (_cache[207] = _withModifiers(() => {}, ["prevent"])),
                    onClick: _cache[208] || (_cache[208] = $event => (_ctx.boxes = !_ctx.boxes)),
                    title: _ctx.boxes ? _ctx.t('Hide the box round every object') : _ctx.t('Show the box round every object')
                  }, [
                    _createElementVNode("span", {
                      innerHTML: _ctx.icons.boxes
                    }, null, 8 /* PROPS */, _hoisted_289)
                  ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_288))
                : _createCommentVNode("v-if", true),
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: !_ctx.flow }]),
                onMousedown: _cache[209] || (_cache[209] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[210] || (_cache[210] = (...args) => (_ctx.toggleFlow && _ctx.toggleFlow(...args))),
                title: _ctx.flow ? _ctx.t('Show the page as it prints') : _ctx.t('Fit the text to the screen')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.flow ? _ctx.icons.screenView : _ctx.icons.pageView
                }, null, 8 /* PROPS */, _hoisted_291)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_290),
              _createCommentVNode(" What is done to the object itself. It goes in the row that is already\n           here rather than in one of its own: a new row appearing pushed the\n           paper down 43 pixels every time an object was picked up, and the\n           thing just clicked jumped out from under the pointer. "),
              (_ctx.palette)
                ? (_openBlock(), _createElementBlock("div", _hoisted_292, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.paletteItems, (it) => {
                      return (_openBlock(), _createElementBlock("button", {
                        key: it.kind,
                        class: "eb-tb",
                        onPointerdown: _withModifiers($event => (_ctx.shapeGrab($event, it.kind)), ["prevent"]),
                        title: it.label
                      }, [
                        _createElementVNode("span", {
                          innerHTML: it.icon
                        }, null, 8 /* PROPS */, _hoisted_294)
                      ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_293))
                    }), 128 /* KEYED_FRAGMENT */))
                  ]))
                : _createCommentVNode("v-if", true)
            ]))
          : _createCommentVNode("v-if", true),
        _createElementVNode("div", {
          class: _normalizeClass(["eb-desk", { empty: !_ctx.doc.id }])
        }, [
          _createCommentVNode(" The palette. A page is laid out by taking things off a shelf and putting\n           them on the paper, so the shelf stands beside the paper rather than\n           hiding in a menu. Press one to put it in the flow of the text; drag one\n           on to the page to put it down where it lands. "),
          _withDirectives(_createElementVNode("div", {
            class: _normalizeClass(["eb-paperwrap", { noguides: !_ctx.guides, flow: _ctx.flow, grid: _ctx.grid && !_ctx.flow, ruled: _ctx.ruler && !_ctx.flow && !_ctx.tategaki, tate: _ctx.tategaki && !_ctx.flow }]),
            style: _normalizeStyle([_ctx.paperStyle, { zoom: _ctx.flow ? 1 : _ctx.zoom / 100 }])
          }, [
            (_ctx.ruler && !_ctx.flow && !_ctx.tategaki)
              ? (_openBlock(), _createElementBlock("div", {
                  key: 0,
                  class: "eb-ruler",
                  onPointerdown: _cache[216] || (_cache[216] = _withModifiers(() => {}, ["prevent"]))
                }, [
                  _createElementVNode("div", {
                    class: "band",
                    style: _normalizeStyle({ left: _ctx.rulerMm.ml + 'mm', right: _ctx.rulerMm.mr + 'mm' })
                  }, null, 4 /* STYLE */),
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.rulerMm.ticks, (n) => {
                    return (_openBlock(), _createElementBlock("span", {
                      class: "tick",
                      key: n,
                      style: _normalizeStyle({ left: ((n - 1) * 10) + 'mm' })
                    }, _toDisplayString((n - 1) * 10), 5 /* TEXT, STYLE */))
                  }), 128 /* KEYED_FRAGMENT */)),
                  _createElementVNode("span", {
                    class: "hm left",
                    style: _normalizeStyle({ left: _ctx.rulerMm.ml + 'mm' }),
                    onPointerdown: _cache[211] || (_cache[211] = _withModifiers($event => (_ctx.rulerGrab($event, 'ml')), ["prevent","stop"])),
                    title: _ctx.t('Left margin')
                  }, null, 44 /* STYLE, PROPS, NEED_HYDRATION */, _hoisted_295),
                  _createElementVNode("span", {
                    class: "hm right",
                    style: _normalizeStyle({ left: (_ctx.rulerMm.w - _ctx.rulerMm.mr) + 'mm' }),
                    onPointerdown: _cache[212] || (_cache[212] = _withModifiers($event => (_ctx.rulerGrab($event, 'mr')), ["prevent","stop"])),
                    title: _ctx.t('Right margin')
                  }, null, 44 /* STYLE, PROPS, NEED_HYDRATION */, _hoisted_296),
                  _createElementVNode("span", {
                    class: "ind first",
                    style: _normalizeStyle({ left: (_ctx.rulerMm.ml + _ctx.ind.left + _ctx.ind.first) + 'mm' }),
                    onPointerdown: _cache[213] || (_cache[213] = _withModifiers($event => (_ctx.rulerGrab($event, 'first')), ["prevent","stop"])),
                    title: _ctx.t('First line')
                  }, null, 44 /* STYLE, PROPS, NEED_HYDRATION */, _hoisted_297),
                  _createElementVNode("span", {
                    class: "ind il",
                    style: _normalizeStyle({ left: (_ctx.rulerMm.ml + _ctx.ind.left) + 'mm' }),
                    onPointerdown: _cache[214] || (_cache[214] = _withModifiers($event => (_ctx.rulerGrab($event, 'left')), ["prevent","stop"])),
                    title: _ctx.t('Indent left')
                  }, null, 44 /* STYLE, PROPS, NEED_HYDRATION */, _hoisted_298),
                  _createElementVNode("span", {
                    class: "ind ir",
                    style: _normalizeStyle({ left: (_ctx.rulerMm.w - _ctx.rulerMm.mr - _ctx.ind.right) + 'mm' }),
                    onPointerdown: _cache[215] || (_cache[215] = _withModifiers($event => (_ctx.rulerGrab($event, 'right')), ["prevent","stop"])),
                    title: _ctx.t('Indent right')
                  }, null, 44 /* STYLE, PROPS, NEED_HYDRATION */, _hoisted_299)
                ], 32 /* NEED_HYDRATION */))
              : _createCommentVNode("v-if", true),
            (!_ctx.flow)
              ? (_openBlock(), _createElementBlock("div", _hoisted_300, [
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.pageCount, (n) => {
                    return (_openBlock(), _createElementBlock("div", {
                      class: "eb-sheet",
                      key: n
                    }, [
                      (_ctx.hasRunning)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_301, [
                            _createElementVNode("span", _hoisted_302, _toDisplayString(_ctx.doc.paper.header.l), 1 /* TEXT */),
                            _createElementVNode("span", _hoisted_303, _toDisplayString(_ctx.doc.paper.header.c), 1 /* TEXT */),
                            _createElementVNode("span", _hoisted_304, _toDisplayString(_ctx.doc.paper.header.r), 1 /* TEXT */)
                          ]))
                        : _createCommentVNode("v-if", true),
                      (_ctx.hasRunning)
                        ? (_openBlock(), _createElementBlock("div", _hoisted_305, [
                            _createElementVNode("span", _hoisted_306, _toDisplayString(_ctx.doc.paper.footer.l), 1 /* TEXT */),
                            _createElementVNode("span", _hoisted_307, _toDisplayString(_ctx.doc.paper.footer.c), 1 /* TEXT */),
                            _createElementVNode("span", _hoisted_308, _toDisplayString(_ctx.doc.paper.footer.r), 1 /* TEXT */)
                          ]))
                        : _createCommentVNode("v-if", true)
                    ]))
                  }), 128 /* KEYED_FRAGMENT */))
                ]))
              : _createCommentVNode("v-if", true),
            _createElementVNode("div", {
              id: "eb-canvas",
              class: _normalizeClass(["eb-paper eb-doc", [_ctx.numberClass, { boxed: _ctx.boxes && !_ctx.flow }]]),
              style: _normalizeStyle(_ctx.paperStyle),
              contenteditable: "true",
              spellcheck: _ctx.spellcheck,
              role: "textbox",
              "aria-multiline": "true"
            }, null, 14 /* CLASS, STYLE, PROPS */, _hoisted_309),
            (_ctx.frame.drop >= 0)
              ? (_openBlock(), _createElementBlock("div", {
                  key: 2,
                  class: "eb-fdrop",
                  style: _normalizeStyle({ top: _ctx.frame.drop + 'px' })
                }, null, 4 /* STYLE */))
              : _createCommentVNode("v-if", true),
            _createCommentVNode(" The line a frame has just snapped to, drawn while it is being dragged\n             so the writer can see what it caught on. "),
            (_ctx.frame.gx !== null)
              ? (_openBlock(), _createElementBlock("div", {
                  key: 3,
                  class: "eb-snap v",
                  style: _normalizeStyle({ left: _ctx.frame.gx + 'px' })
                }, null, 4 /* STYLE */))
              : _createCommentVNode("v-if", true),
            (_ctx.frame.gy !== null)
              ? (_openBlock(), _createElementBlock("div", {
                  key: 4,
                  class: "eb-snap h",
                  style: _normalizeStyle({ top: _ctx.frame.gy + 'px' })
                }, null, 4 /* STYLE */))
              : _createCommentVNode("v-if", true),
            _createCommentVNode(" Text is an object too, and this is the box round the 文節 the caret is\n             standing in, or round whatever is selected. It is a marker and nothing\n             more: it takes no pointer and carries no bar, because anything floating\n             over the line above would cover the words there and slide across the\n             page every time the paragraph is aligned. What can be done to a phrase\n             is on the right button, under its own heading. "),
            (_ctx.tsel.on)
              ? (_openBlock(), _createElementBlock("div", _hoisted_310, [
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.tsel.boxes, (b, i) => {
                    return (_openBlock(), _createElementBlock("div", {
                      key: i,
                      class: "tbox",
                      style: _normalizeStyle({ left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' })
                    }, null, 4 /* STYLE */))
                  }), 128 /* KEYED_FRAGMENT */))
                ]))
              : _createCommentVNode("v-if", true),
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.frame.extras, (b, i) => {
              return (_openBlock(), _createElementBlock("div", {
                class: "eb-fmore",
                key: 'm' + i,
                style: _normalizeStyle({ left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' })
              }, null, 4 /* STYLE */))
            }), 128 /* KEYED_FRAGMENT */)),
            (_ctx.frame.on)
              ? (_openBlock(), _createElementBlock("div", {
                  key: 6,
                  class: _normalizeClass(["eb-fsel", { dragging: _ctx.frame.dragging }]),
                  style: _normalizeStyle({ left: (_ctx.frame.x - _ctx.frame.padX / 2) + 'px', top: (_ctx.frame.y - _ctx.frame.padY / 2) + 'px',
                    width: (_ctx.frame.w + _ctx.frame.padX) + 'px', height: (_ctx.frame.h + _ctx.frame.padY) + 'px' })
                }, [
                  _hoisted_311,
                  _createCommentVNode(" What a draughtsman needs while moving something: where it is and how\n               big it is, in the units the paper is measured in. "),
                  (_ctx.frame.dragging)
                    ? (_openBlock(), _createElementBlock("div", _hoisted_312, _toDisplayString(_ctx.frame.mm), 1 /* TEXT */))
                    : _createCommentVNode("v-if", true),
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.frameEdges, (e) => {
                    return (_openBlock(), _createElementBlock("div", {
                      key: 'e' + e,
                      class: _normalizeClass(["ed", e]),
                      onPointerdown: _cache[217] || (_cache[217] = _withModifiers($event => (_ctx.frameGrab($event, 'move')), ["prevent"])),
                      onContextmenu: _cache[218] || (_cache[218] = _withModifiers($event => (_ctx.objectCtx($event)), ["prevent","stop"]))
                    }, null, 34 /* CLASS, NEED_HYDRATION */))
                  }), 128 /* KEYED_FRAGMENT */)),
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.frameHandles, (h) => {
                    return (_openBlock(), _createElementBlock("span", {
                      key: h,
                      class: _normalizeClass(["hd", h]),
                      onPointerdown: _withModifiers($event => (_ctx.frameGrab($event, h)), ["prevent","stop"])
                    }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_313))
                  }), 128 /* KEYED_FRAGMENT */)),
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.frame.grips, (g) => {
                    return (_openBlock(), _createElementBlock("span", {
                      key: 'cg' + g.index,
                      class: "cg",
                      style: _normalizeStyle({ left: g.x + 'px' }),
                      onPointerdown: _withModifiers($event => (_ctx.colGrab($event, g.index)), ["prevent","stop"]),
                      title: _ctx.t('Drag to set the column width')
                    }, null, 44 /* STYLE, PROPS, NEED_HYDRATION */, _hoisted_314))
                  }), 128 /* KEYED_FRAGMENT */))
                ], 6 /* CLASS, STYLE */))
              : _createCommentVNode("v-if", true)
          ], 6 /* CLASS, STYLE */), [
            [_vShow, _ctx.doc.id]
          ]),
          (!_ctx.doc.id)
            ? (_openBlock(), _createElementBlock("div", _hoisted_315, [
                _createElementVNode("span", {
                  class: "mark",
                  innerHTML: _ctx.logo
                }, null, 8 /* PROPS */, _hoisted_316),
                _createElementVNode("p", null, _toDisplayString(_ctx.t('No document is open.')), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "eb-btn primary",
                  onClick: _cache[219] || (_cache[219] = (...args) => (_ctx.newDoc && _ctx.newDoc(...args)))
                }, _toDisplayString(_ctx.t('New document')), 1 /* TEXT */)
              ]))
            : _createCommentVNode("v-if", true)
        ], 2 /* CLASS */),
        _createCommentVNode(" The handles for the two panels, at the height of the eye: pointing left\n         to pull a panel out, pointing right to push it away again. "),
        (_ctx.doc.id)
          ? (_openBlock(), _createElementBlock("div", _hoisted_317, [
              _createElementVNode("div", _hoisted_318, [
                _createElementVNode("span", _hoisted_319, _toDisplayString(_ctx.t('Preview bar')), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "hnd",
                  onClick: _cache[220] || (_cache[220] = $event => (_ctx.previewOpen = !_ctx.previewOpen)),
                  title: (_ctx.previewOpen ? _ctx.t('Hide') : _ctx.t('Show')) + ' — ' + _ctx.t('Preview bar')
                }, _toDisplayString(_ctx.previewOpen ? '▶' : '◀'), 9 /* TEXT, PROPS */, _hoisted_320)
              ]),
              _createElementVNode("div", _hoisted_321, [
                _createElementVNode("span", _hoisted_322, _toDisplayString(_ctx.t('Layer bar')), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "hnd",
                  onClick: _cache[221] || (_cache[221] = $event => (_ctx.layersOpen = !_ctx.layersOpen)),
                  title: (_ctx.layersOpen ? _ctx.t('Hide') : _ctx.t('Show')) + ' — ' + _ctx.t('Layer bar')
                }, _toDisplayString(_ctx.layersOpen ? '▶' : '◀'), 9 /* TEXT, PROPS */, _hoisted_323)
              ])
            ]))
          : _createCommentVNode("v-if", true),
        _createCommentVNode(" The pages, down the right, beside the pile. Not a picture of the page --\n         a plan of it: where the writing sits and where each object stands, drawn\n         from their own measurements. It costs nothing to redraw and tells the\n         writer at a glance what is on which page and what overlaps what. "),
        (_ctx.doc.id && _ctx.previewOpen)
          ? (_openBlock(), _createElementBlock("aside", _hoisted_324, [
              _createElementVNode("div", _hoisted_325, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Pages')), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "eb-tb",
                  onClick: _cache[222] || (_cache[222] = $event => (_ctx.previewOpen = false)),
                  title: _ctx.t('Close')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.close
                  }, null, 8 /* PROPS */, _hoisted_327)
                ], 8 /* PROPS */, _hoisted_326)
              ]),
              _createElementVNode("div", _hoisted_328, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.preview, (pg) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: pg.n,
                    class: _normalizeClass(["pg", { on: pg.n === _ctx.pageNow }]),
                    onClick: $event => (_ctx.goToPage(pg.n)),
                    title: _ctx.t('Page {n}', { n: pg.n })
                  }, [
                    _createElementVNode("span", {
                      class: "sheet",
                      style: _normalizeStyle({ paddingTop: pg.ratio + '%' })
                    }, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(pg.blocks, (b, i) => {
                        return (_openBlock(), _createElementBlock("span", {
                          key: 'b' + i,
                          class: _normalizeClass(["blk", b.kind]),
                          style: _normalizeStyle({ left: b.x + '%', top: b.y + '%', width: b.w + '%', height: b.h + '%' })
                        }, null, 6 /* CLASS, STYLE */))
                      }), 128 /* KEYED_FRAGMENT */))
                    ], 4 /* STYLE */),
                    _createElementVNode("span", _hoisted_330, _toDisplayString(pg.n), 1 /* TEXT */)
                  ], 10 /* CLASS, PROPS */, _hoisted_329))
                }), 128 /* KEYED_FRAGMENT */))
              ])
            ]))
          : _createCommentVNode("v-if", true),
        _createCommentVNode(" The pile, down the right. What is on top of what decides which words move\n         out of whose way, so it has to be something a writer can see and change. "),
        (_ctx.doc.id && _ctx.layersOpen)
          ? (_openBlock(), _createElementBlock("aside", _hoisted_331, [
              _createElementVNode("div", _hoisted_332, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Layers')), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "eb-tb",
                  onClick: _cache[223] || (_cache[223] = $event => (_ctx.layersOpen = false)),
                  title: _ctx.t('Close')
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.close
                  }, null, 8 /* PROPS */, _hoisted_334)
                ], 8 /* PROPS */, _hoisted_333)
              ]),
              (!_ctx.layers.length)
                ? (_openBlock(), _createElementBlock("p", _hoisted_335, _toDisplayString(_ctx.t('Nothing is standing on the page yet.')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.layers, (g, gi) => {
                return (_openBlock(), _createElementBlock("div", {
                  class: "group",
                  key: g.level
                }, [
                  _createElementVNode("div", _hoisted_336, _toDisplayString(_ctx.t('Layer {n}', { n: g.level })), 1 /* TEXT */),
                  _createElementVNode("ol", _hoisted_337, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(g.items, (it) => {
                      return (_openBlock(), _createElementBlock("li", {
                        key: it.id,
                        class: _normalizeClass({ on: it.chosen })
                      }, [
                        _createElementVNode("button", {
                          class: "pick",
                          onClick: $event => (_ctx.chooseLayer(it.id)),
                          title: it.text
                        }, [
                          _createElementVNode("span", {
                            class: "ic",
                            innerHTML: it.icon
                          }, null, 8 /* PROPS */, _hoisted_339),
                          _createElementVNode("span", _hoisted_340, _toDisplayString(it.name), 1 /* TEXT */),
                          _createElementVNode("span", _hoisted_341, _toDisplayString(it.text), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_338),
                        _createElementVNode("span", _hoisted_342, [
                          _createElementVNode("button", {
                            class: "eb-tb",
                            disabled: gi === 0,
                            onClick: $event => (_ctx.raiseLayer(it.id, 1)),
                            title: _ctx.t('Bring forward')
                          }, "↑", 8 /* PROPS */, _hoisted_343),
                          _createElementVNode("button", {
                            class: "eb-tb",
                            disabled: gi === _ctx.layers.length - 1,
                            onClick: $event => (_ctx.raiseLayer(it.id, -1)),
                            title: _ctx.t('Send backward')
                          }, "↓", 8 /* PROPS */, _hoisted_344)
                        ])
                      ], 2 /* CLASS */))
                    }), 128 /* KEYED_FRAGMENT */))
                  ])
                ]))
              }), 128 /* KEYED_FRAGMENT */))
            ]))
          : _createCommentVNode("v-if", true)
      ]),
      (_ctx.doc.id)
        ? (_openBlock(), _createElementBlock("div", _hoisted_345, [
            _createElementVNode("span", _hoisted_346, _toDisplayString(_ctx.doc.name), 1 /* TEXT */),
            _createElementVNode("span", null, _toDisplayString(_ctx.t('{n} pages', { n: _ctx.pageCount })), 1 /* TEXT */),
            _createElementVNode("span", null, _toDisplayString(_ctx.t('{n} characters', { n: _ctx.counts })), 1 /* TEXT */),
            _createElementVNode("span", null, _toDisplayString(_ctx.paperLabel), 1 /* TEXT */)
          ]))
        : _createCommentVNode("v-if", true)
    ]),
    _createCommentVNode(" paper setup "),
    (_ctx.paperOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 1,
          class: "eb-modal-back",
          onClick: _cache[263] || (_cache[263] = $event => (_ctx.paperOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[262] || (_cache[262] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "🖹 " + _toDisplayString(_ctx.t('Paper setup')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_347, [
              _createElementVNode("div", _hoisted_348, [
                _createElementVNode("div", _hoisted_349, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Paper size')), 1 /* TEXT */),
                  _createElementVNode("select", {
                    value: _ctx.doc.paper.size,
                    onChange: _cache[224] || (_cache[224] = $event => (_ctx.setPaperSize($event.target.value)))
                  }, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.paperSizes, (p) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: p,
                        value: p
                      }, _toDisplayString(_ctx.paperName(p)), 9 /* TEXT, PROPS */, _hoisted_351))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_350)
                ]),
                _createElementVNode("div", _hoisted_352, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Orientation')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[225] || (_cache[225] = $event => ((_ctx.doc.paper.orientation) = $event)),
                    onChange: _cache[226] || (_cache[226] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                  }, [
                    _createElementVNode("option", _hoisted_353, _toDisplayString(_ctx.t('Portrait')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_354, _toDisplayString(_ctx.t('Landscape')), 1 /* TEXT */)
                  ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelSelect, _ctx.doc.paper.orientation]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_355, [
                _createElementVNode("div", _hoisted_356, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Top margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[227] || (_cache[227] = $event => ((_ctx.doc.paper.margin.top) = $event)),
                    onChange: _cache[228] || (_cache[228] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.top,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_357, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Bottom margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[229] || (_cache[229] = $event => ((_ctx.doc.paper.margin.bottom) = $event)),
                    onChange: _cache[230] || (_cache[230] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.bottom,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_358, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Left margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[231] || (_cache[231] = $event => ((_ctx.doc.paper.margin.left) = $event)),
                    onChange: _cache[232] || (_cache[232] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.left,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_359, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Right margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[233] || (_cache[233] = $event => ((_ctx.doc.paper.margin.right) = $event)),
                    onChange: _cache[234] || (_cache[234] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.right,
                      void 0,
                      { number: true }
                    ]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_360, [
                _createElementVNode("div", _hoisted_361, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Default body size (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "6",
                    max: "36",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[235] || (_cache[235] = $event => ((_ctx.doc.paper.fontSize) = $event)),
                    onChange: _cache[236] || (_cache[236] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.fontSize,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_362, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Default line height')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "3",
                    step: "0.05",
                    "onUpdate:modelValue": _cache[237] || (_cache[237] = $event => ((_ctx.doc.paper.lineHeight) = $event)),
                    onChange: _cache[238] || (_cache[238] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.lineHeight,
                      void 0,
                      { number: true }
                    ]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_363, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Direction of the text')), 1 /* TEXT */),
                _createElementVNode("select", {
                  value: _ctx.doc.paper.vertical ? 'v' : 'h',
                  onChange: _cache[239] || (_cache[239] = $event => (_ctx.setVertical($event.target.value === 'v')))
                }, [
                  _createElementVNode("option", _hoisted_365, _toDisplayString(_ctx.t('Across the page (horizontal)')), 1 /* TEXT */),
                  _createElementVNode("option", _hoisted_366, _toDisplayString(_ctx.t('Down the page (vertical, 縦書き)')), 1 /* TEXT */)
                ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_364)
              ]),
              _createElementVNode("div", _hoisted_367, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Number the headings')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("select", {
                  "onUpdate:modelValue": _cache[240] || (_cache[240] = $event => ((_ctx.doc.paper.headingNumbers) = $event)),
                  onChange: _cache[241] || (_cache[241] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                }, [
                  _createElementVNode("option", _hoisted_368, _toDisplayString(_ctx.t('Not numbered')), 1 /* TEXT */),
                  _createElementVNode("option", _hoisted_369, _toDisplayString(_ctx.t('1. / 1.1 / 1.1.1')), 1 /* TEXT */),
                  _createElementVNode("option", _hoisted_370, _toDisplayString(_ctx.t('Chapter 1 / Section 1 / (1), in Japanese')), 1 /* TEXT */)
                ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelSelect, _ctx.doc.paper.headingNumbers]
                ]),
                _createElementVNode("p", _hoisted_371, _toDisplayString(_ctx.t('The numbers are counted by the file itself, so adding a section renumbers everything after it. They are not part of the text and do not appear in a contents list.')), 1 /* TEXT */)
              ]),
              _createCommentVNode(" The page as an object in its own right: what it is painted with and\n             what is drawn round it. "),
              _createElementVNode("div", _hoisted_372, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('The page itself')), 1 /* TEXT */),
                _createElementVNode("div", _hoisted_373, [
                  _createElementVNode("div", _hoisted_374, [
                    _createElementVNode("label", null, _toDisplayString(_ctx.t('Page colour')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_375, [
                      _createElementVNode("input", {
                        type: "color",
                        value: _ctx.doc.paper.bg.colour || '#ffffff',
                        onInput: _cache[242] || (_cache[242] = $event => {_ctx.doc.paper.bg.colour = $event.target.value; _ctx.touchSettings()})
                      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_376),
                      _createElementVNode("button", {
                        class: _normalizeClass(["eb-btn ghost", { on: !_ctx.doc.paper.bg.colour }]),
                        onClick: _cache[243] || (_cache[243] = $event => {_ctx.doc.paper.bg.colour = ''; _ctx.touchSettings()})
                      }, _toDisplayString(_ctx.t('Plain paper')), 3 /* TEXT, CLASS */)
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_377, [
                    _createElementVNode("label", null, _toDisplayString(_ctx.t('Picture behind the page')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_378, [
                      _createElementVNode("button", {
                        class: "eb-btn ghost",
                        onClick: _cache[244] || (_cache[244] = (...args) => (_ctx.openPageBg && _ctx.openPageBg(...args)))
                      }, _toDisplayString(_ctx.doc.paper.bg.image ? _ctx.t('Change…') : _ctx.t('Choose…')), 1 /* TEXT */),
                      (_ctx.doc.paper.bg.image)
                        ? (_openBlock(), _createElementBlock("button", {
                            key: 0,
                            class: "eb-btn ghost",
                            onClick: _cache[245] || (_cache[245] = $event => {_ctx.doc.paper.bg.image = ''; _ctx.touchSettings()})
                          }, _toDisplayString(_ctx.t('Remove')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true)
                    ])
                  ])
                ]),
                (_ctx.doc.paper.bg.image)
                  ? (_openBlock(), _createElementBlock("div", _hoisted_379, [
                      _createElementVNode("div", _hoisted_380, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('How it sits on the page')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("select", {
                          "onUpdate:modelValue": _cache[246] || (_cache[246] = $event => ((_ctx.doc.paper.bg.fit) = $event)),
                          onChange: _cache[247] || (_cache[247] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                        }, [
                          _createElementVNode("option", _hoisted_381, _toDisplayString(_ctx.t('Fill the page')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_382, _toDisplayString(_ctx.t('Fit inside the page')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_383, _toDisplayString(_ctx.t('Stretch to the page')), 1 /* TEXT */),
                          _createElementVNode("option", _hoisted_384, _toDisplayString(_ctx.t('Repeat as a tile')), 1 /* TEXT */)
                        ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [_vModelSelect, _ctx.doc.paper.bg.fit]
                        ])
                      ]),
                      _createElementVNode("div", _hoisted_385, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('Fade it (%)')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "number",
                          min: "0",
                          max: "90",
                          step: "5",
                          "onUpdate:modelValue": _cache[248] || (_cache[248] = $event => ((_ctx.doc.paper.bg.fade) = $event)),
                          onChange: _cache[249] || (_cache[249] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [
                            _vModelText,
                            _ctx.doc.paper.bg.fade,
                            void 0,
                            { number: true }
                          ]
                        ])
                      ])
                    ]))
                  : _createCommentVNode("v-if", true),
                _createElementVNode("div", _hoisted_386, [
                  _createElementVNode("div", _hoisted_387, [
                    _createElementVNode("label", null, _toDisplayString(_ctx.t('Frame round the page')), 1 /* TEXT */),
                    _withDirectives(_createElementVNode("select", {
                      "onUpdate:modelValue": _cache[250] || (_cache[250] = $event => ((_ctx.doc.paper.border.style) = $event)),
                      onChange: _cache[251] || (_cache[251] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                    }, [
                      _createElementVNode("option", _hoisted_388, _toDisplayString(_ctx.t('None')), 1 /* TEXT */),
                      _createElementVNode("option", _hoisted_389, _toDisplayString(_ctx.t('Solid')), 1 /* TEXT */),
                      _createElementVNode("option", _hoisted_390, _toDisplayString(_ctx.t('Dashed')), 1 /* TEXT */),
                      _createElementVNode("option", _hoisted_391, _toDisplayString(_ctx.t('Dotted')), 1 /* TEXT */),
                      _createElementVNode("option", _hoisted_392, _toDisplayString(_ctx.t('Double')), 1 /* TEXT */)
                    ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                      [_vModelSelect, _ctx.doc.paper.border.style]
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_393, [
                    _createElementVNode("label", null, _toDisplayString(_ctx.t('Thickness (mm)')), 1 /* TEXT */),
                    _withDirectives(_createElementVNode("input", {
                      type: "number",
                      min: "0.1",
                      max: "20",
                      step: "0.1",
                      "onUpdate:modelValue": _cache[252] || (_cache[252] = $event => ((_ctx.doc.paper.border.width) = $event)),
                      onChange: _cache[253] || (_cache[253] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args))),
                      disabled: _ctx.doc.paper.border.style === 'none'
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_394), [
                      [
                        _vModelText,
                        _ctx.doc.paper.border.width,
                        void 0,
                        { number: true }
                      ]
                    ])
                  ]),
                  _createElementVNode("div", _hoisted_395, [
                    _createElementVNode("label", null, _toDisplayString(_ctx.t('Frame colour')), 1 /* TEXT */),
                    _withDirectives(_createElementVNode("input", {
                      type: "color",
                      "onUpdate:modelValue": _cache[254] || (_cache[254] = $event => ((_ctx.doc.paper.border.colour) = $event)),
                      onChange: _cache[255] || (_cache[255] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args))),
                      disabled: _ctx.doc.paper.border.style === 'none'
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_396), [
                      [_vModelText, _ctx.doc.paper.border.colour]
                    ])
                  ])
                ]),
                (_ctx.doc.paper.border.style !== 'none')
                  ? (_openBlock(), _createElementBlock("div", _hoisted_397, [
                      _createElementVNode("div", _hoisted_398, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('In from the edge (mm)')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "number",
                          min: "0",
                          max: "40",
                          step: "1",
                          "onUpdate:modelValue": _cache[256] || (_cache[256] = $event => ((_ctx.doc.paper.border.gap) = $event)),
                          onChange: _cache[257] || (_cache[257] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [
                            _vModelText,
                            _ctx.doc.paper.border.gap,
                            void 0,
                            { number: true }
                          ]
                        ])
                      ]),
                      _createElementVNode("div", _hoisted_399, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('Rounded corners (mm)')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "number",
                          min: "0",
                          max: "40",
                          step: "1",
                          "onUpdate:modelValue": _cache[258] || (_cache[258] = $event => ((_ctx.doc.paper.border.radius) = $event)),
                          onChange: _cache[259] || (_cache[259] = (...args) => (_ctx.touchSettings && _ctx.touchSettings(...args)))
                        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [
                            _vModelText,
                            _ctx.doc.paper.border.radius,
                            void 0,
                            { number: true }
                          ]
                        ])
                      ])
                    ]))
                  : _createCommentVNode("v-if", true),
                _createElementVNode("p", _hoisted_400, _toDisplayString(_ctx.t('The page colour, the picture and the frame are written into the file, and the file asks the browser to print them: in the print dialogue, background graphics must be left on. The frame is drawn on every page.')), 1 /* TEXT */)
              ]),
              _createElementVNode("p", _hoisted_401, _toDisplayString(_ctx.t('These are the document’s own defaults — what text is set in when nothing else has been said about it. To change one passage, use the size and typeface boxes in the toolbar; they act on what is selected, or on the paragraph the cursor is in.')), 1 /* TEXT */),
              _createElementVNode("div", _hoisted_402, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Default typefaces')), 1 /* TEXT */),
                _createElementVNode("div", _hoisted_403, [
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontRoles, (r) => {
                    return (_openBlock(), _createElementBlock("button", {
                      key: r.key,
                      class: "font-row",
                      onClick: $event => (_ctx.openFonts(r.key))
                    }, [
                      _createElementVNode("span", _hoisted_405, _toDisplayString(r.label), 1 /* TEXT */),
                      _createElementVNode("span", {
                        class: "fam",
                        style: _normalizeStyle({ fontFamily: _ctx.fontPreviewStack(_ctx.fontsInUse[r.key]) })
                      }, _toDisplayString(_ctx.fontsInUse[r.key]), 5 /* TEXT, STYLE */),
                      (!_ctx.doc.paper.fonts[r.key])
                        ? (_openBlock(), _createElementBlock("span", _hoisted_406, _toDisplayString(_ctx.t('default')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true),
                      _createElementVNode("span", {
                        class: "caret",
                        innerHTML: _ctx.icons.down
                      }, null, 8 /* PROPS */, _hoisted_407)
                    ], 8 /* PROPS */, _hoisted_404))
                  }), 128 /* KEYED_FRAGMENT */))
                ]),
                _createElementVNode("p", _hoisted_408, _toDisplayString(_ctx.t('Any family on Google Fonts can be used. The document carries its typefaces with it, so the file looks the same on a machine where they are not installed.')), 1 /* TEXT */)
              ]),
              _createElementVNode("p", _hoisted_409, _toDisplayString(_ctx.t('Page numbers and running headers come from your browser print dialogue: browsers do not yet support headers inside the page rule. Everything else here is written into the file.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_410, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[260] || (_cache[260] = (...args) => (_ctx.saveDefaultPaper && _ctx.saveDefaultPaper(...args)))
              }, _toDisplayString(_ctx.t('Use as default for new documents')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[261] || (_cache[261] = $event => (_ctx.paperOpen = false))
              }, _toDisplayString(_ctx.t('Done')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" something that arrived which a document cannot be made of "),
    (_ctx.embedAsk.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 2,
          class: "eb-modal-back",
          onClick: _cache[267] || (_cache[267] = $event => (_ctx.embedAsk = { open: false, items: [] }))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(520px,100%)"},
            onClick: _cache[266] || (_cache[266] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('This could not be turned into a document')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_411, [
              _createElementVNode("p", _hoisted_412, _toDisplayString(_ctx.t('These arrived with what you pasted. A document is made of writing and of objects that can be printed, and none of these is either: a browser draws them by fetching or running something else.')), 1 /* TEXT */),
              _createElementVNode("ul", _hoisted_413, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.embedAsk.items, (f, i) => {
                  return (_openBlock(), _createElementBlock("li", { key: i }, [
                    _createElementVNode("span", _hoisted_414, _toDisplayString(_ctx.embedLabel(f)), 1 /* TEXT */),
                    _createElementVNode("span", _hoisted_415, _toDisplayString(f.url), 1 /* TEXT */)
                  ]))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("p", _hoisted_416, _toDisplayString(_ctx.t('They can be put in as inline frames. Read this first:')), 1 /* TEXT */),
              _createElementVNode("ul", _hoisted_417, [
                _createElementVNode("li", null, _toDisplayString(_ctx.t('It is fetched from that address every time the document is opened, so the file is no longer one file that stands on its own, and it shows nothing without a network.')), 1 /* TEXT */),
                _createElementVNode("li", null, _toDisplayString(_ctx.t('It may not print. A printer is given the page as it stands, and a frame that has not finished loading — or that refuses to be printed — comes out blank. The address is printed underneath it so the paper still says what was there.')), 1 /* TEXT */),
                _createElementVNode("li", null, _toDisplayString(_ctx.t('The site may refuse to be framed at all, and then the frame stays empty.')), 1 /* TEXT */)
              ])
            ]),
            _createElementVNode("div", _hoisted_418, [
              _createElementVNode("button", {
                class: "eb-btn",
                onClick: _cache[264] || (_cache[264] = $event => (_ctx.embedAsk = { open: false, items: [] }))
              }, _toDisplayString(_ctx.t('Leave them out')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[265] || (_cache[265] = (...args) => (_ctx.insertEmbeds && _ctx.insertEmbeds(...args)))
              }, _toDisplayString(_ctx.t('Put them in as frames')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" insert table "),
    (_ctx.tableOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 3,
          class: "eb-modal-back",
          onClick: _cache[275] || (_cache[275] = $event => (_ctx.tableOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[274] || (_cache[274] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "▦ " + _toDisplayString(_ctx.t('Insert table')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_419, [
              _createElementVNode("div", _hoisted_420, [
                _createElementVNode("div", _hoisted_421, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Rows')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "60",
                    "onUpdate:modelValue": _cache[268] || (_cache[268] = $event => ((_ctx.table.rows) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.table.rows,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_422, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Columns')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "16",
                    "onUpdate:modelValue": _cache[269] || (_cache[269] = $event => ((_ctx.table.cols) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.table.cols,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_423, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Style')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[270] || (_cache[270] = $event => ((_ctx.table.variant) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_424, _toDisplayString(_ctx.t('All borders')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_425, _toDisplayString(_ctx.t('Horizontal lines only')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_426, _toDisplayString(_ctx.t('No borders')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.table.variant]
                  ])
                ])
              ]),
              _createElementVNode("label", _hoisted_427, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[271] || (_cache[271] = $event => ((_ctx.table.header) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.table.header]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('First row is a header')), 1 /* TEXT */)
              ])
            ]),
            _createElementVNode("div", _hoisted_428, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[272] || (_cache[272] = $event => (_ctx.tableOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[273] || (_cache[273] = (...args) => (_ctx.addTable && _ctx.addTable(...args)))
              }, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" formula "),
    (_ctx.mathOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 4,
          class: "eb-modal-back",
          onClick: _cache[281] || (_cache[281] = $event => (_ctx.mathOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[280] || (_cache[280] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "∑ " + _toDisplayString(_ctx.t('Insert formula (MathML)')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_429, [
              _createElementVNode("div", _hoisted_430, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.mathSnippets, (s) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: s.label,
                    class: "eb-btn",
                    onClick: $event => (_ctx.math.source = s.code)
                  }, _toDisplayString(s.label), 9 /* TEXT, PROPS */, _hoisted_431))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("div", _hoisted_432, [
                _hoisted_433,
                _withDirectives(_createElementVNode("textarea", {
                  "onUpdate:modelValue": _cache[276] || (_cache[276] = $event => ((_ctx.math.source) = $event)),
                  rows: "7",
                  spellcheck: "false"
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelText, _ctx.math.source]
                ])
              ]),
              _createElementVNode("label", _hoisted_434, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[277] || (_cache[277] = $event => ((_ctx.math.block) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.math.block]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Own line, centred')), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_435, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Preview')), 1 /* TEXT */),
                _createElementVNode("div", {
                  class: "eb-doc",
                  style: {"background":"#fff","color":"#111","border-radius":"9px","padding":"10px 12px","overflow-x":"auto"},
                  innerHTML: _ctx.mathPreview
                }, null, 8 /* PROPS */, _hoisted_436)
              ]),
              _createElementVNode("p", _hoisted_437, _toDisplayString(_ctx.t('MathML is drawn by the browser itself, so the formula stays text in the file — searchable, selectable and never a picture.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_438, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[278] || (_cache[278] = $event => (_ctx.mathOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[279] || (_cache[279] = (...args) => (_ctx.addMath && _ctx.addMath(...args)))
              }, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the other apps on this server "),
    (_ctx.sourceOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 5,
          class: "eb-modal-back",
          onClick: _cache[299] || (_cache[299] = $event => (_ctx.sourceOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal tall",
            onClick: _cache[298] || (_cache[298] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.link
              }, null, 8 /* PROPS */, _hoisted_439),
              _createTextVNode(" " + _toDisplayString(_ctx.sourceLabel(_ctx.source)), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_440, [
              (_ctx.src.loading)
                ? (_openBlock(), _createElementBlock("p", _hoisted_441, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.src.error)
                ? (_openBlock(), _createElementBlock("p", _hoisted_442, _toDisplayString(_ctx.src.error), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" Tables "),
              (_ctx.source === 'tables')
                ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                    (!_ctx.src.detail)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_443, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (x) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: x.id,
                              class: "fp-item",
                              onClick: $event => (_ctx.openCollection(x))
                            }, [
                              _createElementVNode("span", _hoisted_445, _toDisplayString(x.emoji || '▦'), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_446, _toDisplayString(x.title), 1 /* TEXT */)
                            ], 8 /* PROPS */, _hoisted_444))
                          }), 128 /* KEYED_FRAGMENT */)),
                          (!_ctx.src.items.length && !_ctx.src.loading)
                            ? (_openBlock(), _createElementBlock("p", _hoisted_447, _toDisplayString(_ctx.t('There is nothing here yet.')), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.src.detail)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("p", _hoisted_448, _toDisplayString(_ctx.t('{name}: {c} columns, {r} rows', { name: _ctx.src.detail.title, c: _ctx.src.detail.columns.length, r: _ctx.src.detail.rows.length })), 1 /* TEXT */),
                          _createElementVNode("label", _hoisted_449, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": _cache[282] || (_cache[282] = $event => ((_ctx.src.withHeader) = $event))
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelCheckbox, _ctx.src.withHeader]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('First row is a header')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_450, [
                            _createElementVNode("table", _hoisted_451, [
                              (_ctx.src.withHeader)
                                ? (_openBlock(), _createElementBlock("tr", _hoisted_452, [
                                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.detail.columns, (c, i) => {
                                      return (_openBlock(), _createElementBlock("th", { key: i }, _toDisplayString(c), 1 /* TEXT */))
                                    }), 128 /* KEYED_FRAGMENT */))
                                  ]))
                                : _createCommentVNode("v-if", true),
                              (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.detail.rows.slice(0, 8), (row, i) => {
                                return (_openBlock(), _createElementBlock("tr", { key: i }, [
                                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(row, (cell, j) => {
                                    return (_openBlock(), _createElementBlock("td", { key: j }, _toDisplayString(cell), 1 /* TEXT */))
                                  }), 128 /* KEYED_FRAGMENT */))
                                ]))
                              }), 128 /* KEYED_FRAGMENT */))
                            ])
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : _createCommentVNode("v-if", true)
                  ], 64 /* STABLE_FRAGMENT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" Contacts "),
              (_ctx.source === 'contacts')
                ? (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                    _createElementVNode("div", _hoisted_453, [
                      _createElementVNode("span", {
                        innerHTML: _ctx.icons.search
                      }, null, 8 /* PROPS */, _hoisted_454),
                      _withDirectives(_createElementVNode("input", {
                        type: "text",
                        "onUpdate:modelValue": _cache[283] || (_cache[283] = $event => ((_ctx.src.query) = $event)),
                        onKeydown: _cache[284] || (_cache[284] = _withKeys(_withModifiers((...args) => (_ctx.searchContacts && _ctx.searchContacts(...args)), ["prevent"]), ["enter"])),
                        placeholder: _ctx.t('Search contacts…')
                      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_455), [
                        [_vModelText, _ctx.src.query]
                      ]),
                      _createElementVNode("button", {
                        class: "eb-btn",
                        onClick: _cache[285] || (_cache[285] = (...args) => (_ctx.searchContacts && _ctx.searchContacts(...args)))
                      }, _toDisplayString(_ctx.t('Search')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_456, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (p) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: p.id,
                          class: "fp-item",
                          onClick: $event => (_ctx.insertContact(p))
                        }, [
                          _createElementVNode("span", _hoisted_458, _toDisplayString(p.name), 1 /* TEXT */),
                          _createElementVNode("span", _hoisted_459, _toDisplayString(p.org) + _toDisplayString(p.system ? ' · ' + _ctx.t('User directory') : ''), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_457))
                      }), 128 /* KEYED_FRAGMENT */)),
                      (!_ctx.src.items.length && !_ctx.src.loading)
                        ? (_openBlock(), _createElementBlock("p", _hoisted_460, _toDisplayString(_ctx.t('No contact matches that.')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true)
                    ]),
                    _createElementVNode("p", _hoisted_461, _toDisplayString(_ctx.t('Choosing a contact writes the address block at the cursor. For one letter per contact, use the merge fields below.')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_462, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.contactFields, (k) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: k,
                          class: "chip",
                          onClick: $event => (_ctx.insertField(k))
                        }, _toDisplayString(_ctx.fieldTag(k)), 9 /* TEXT, PROPS */, _hoisted_463))
                      }), 128 /* KEYED_FRAGMENT */))
                    ])
                  ], 64 /* STABLE_FRAGMENT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" Calendar "),
              (_ctx.source === 'calendar')
                ? (_openBlock(), _createElementBlock(_Fragment, { key: 4 }, [
                    _createElementVNode("div", _hoisted_464, [
                      _createElementVNode("div", _hoisted_465, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('From')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "date",
                          "onUpdate:modelValue": _cache[286] || (_cache[286] = $event => ((_ctx.src.from) = $event)),
                          onChange: _cache[287] || (_cache[287] = (...args) => (_ctx.loadEvents && _ctx.loadEvents(...args)))
                        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [_vModelText, _ctx.src.from]
                        ])
                      ]),
                      _createElementVNode("div", _hoisted_466, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('To')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "date",
                          "onUpdate:modelValue": _cache[288] || (_cache[288] = $event => ((_ctx.src.to) = $event)),
                          onChange: _cache[289] || (_cache[289] = (...args) => (_ctx.loadEvents && _ctx.loadEvents(...args)))
                        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [_vModelText, _ctx.src.to]
                        ])
                      ]),
                      _createElementVNode("div", _hoisted_467, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('Calendar')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("select", {
                          "onUpdate:modelValue": _cache[290] || (_cache[290] = $event => ((_ctx.src.calendar) = $event)),
                          onChange: _cache[291] || (_cache[291] = (...args) => (_ctx.loadEvents && _ctx.loadEvents(...args)))
                        }, [
                          _createElementVNode("option", _hoisted_468, _toDisplayString(_ctx.t('All calendars')), 1 /* TEXT */),
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (c) => {
                            return (_openBlock(), _createElementBlock("option", {
                              key: c.key,
                              value: c.key
                            }, _toDisplayString(c.name), 9 /* TEXT, PROPS */, _hoisted_469))
                          }), 128 /* KEYED_FRAGMENT */))
                        ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [_vModelSelect, _ctx.src.calendar]
                        ])
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_470, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.records, (e, i) => {
                        return (_openBlock(), _createElementBlock("div", {
                          key: i,
                          class: "fp-item"
                        }, [
                          _createElementVNode("span", _hoisted_471, _toDisplayString(e.summary), 1 /* TEXT */),
                          _createElementVNode("span", _hoisted_472, _toDisplayString(e.start.slice(0, 16).replace('T', ' ')) + _toDisplayString(e.allDay ? ' · ' + _ctx.t('All day') : '') + _toDisplayString(e.location ? ' · ' + e.location : ''), 1 /* TEXT */)
                        ]))
                      }), 128 /* KEYED_FRAGMENT */)),
                      (!_ctx.src.records.length && !_ctx.src.loading)
                        ? (_openBlock(), _createElementBlock("p", _hoisted_473, _toDisplayString(_ctx.t('No events in that range.')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true)
                    ])
                  ], 64 /* STABLE_FRAGMENT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" RegiBase "),
              (_ctx.source === 'regibase')
                ? (_openBlock(), _createElementBlock(_Fragment, { key: 5 }, [
                    (!_ctx.src.collection)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_474, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (x) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: x.id,
                              class: "fp-item",
                              onClick: $event => (_ctx.openCollection(x))
                            }, [
                              _createElementVNode("span", _hoisted_476, _toDisplayString(x.icon || '🗄'), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_477, _toDisplayString(x.name), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_478, _toDisplayString(x.count), 1 /* TEXT */)
                            ], 8 /* PROPS */, _hoisted_475))
                          }), 128 /* KEYED_FRAGMENT */)),
                          (!_ctx.src.items.length && !_ctx.src.loading)
                            ? (_openBlock(), _createElementBlock("p", _hoisted_479, _toDisplayString(_ctx.t('There is nothing here yet.')), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.src.collection)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("p", _hoisted_480, _toDisplayString(_ctx.t('{name}: {c} fields, {r} records', { name: _ctx.src.collection.name, c: _ctx.src.fields.length, r: _ctx.src.records.length })), 1 /* TEXT */),
                          _createElementVNode("div", _hoisted_481, [
                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.records, (r) => {
                              return (_openBlock(), _createElementBlock("button", {
                                key: r.id,
                                class: "fp-item",
                                onClick: $event => (_ctx.insertRecord(r))
                              }, [
                                _createElementVNode("span", _hoisted_483, _toDisplayString(_ctx.recordName(r)), 1 /* TEXT */),
                                _createElementVNode("span", _hoisted_484, _toDisplayString(_ctx.recordMeta(r)), 1 /* TEXT */)
                              ], 8 /* PROPS */, _hoisted_482))
                            }), 128 /* KEYED_FRAGMENT */)),
                            (!_ctx.src.records.length && !_ctx.src.loading)
                              ? (_openBlock(), _createElementBlock("p", _hoisted_485, _toDisplayString(_ctx.t('There is nothing here yet.')), 1 /* TEXT */))
                              : _createCommentVNode("v-if", true)
                          ]),
                          _createElementVNode("p", _hoisted_486, _toDisplayString(_ctx.t('Choosing a record writes it at the cursor as a two-column table, leaving out the fields it has nothing in. For one letter per record, use the merge fields below.')), 1 /* TEXT */),
                          _createElementVNode("div", _hoisted_487, [
                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.fields, (f) => {
                              return (_openBlock(), _createElementBlock("button", {
                                key: f.key,
                                class: "chip",
                                onClick: $event => (_ctx.insertField(f.key))
                              }, _toDisplayString(_ctx.fieldTag(f.key)) + " " + _toDisplayString(f.label), 9 /* TEXT, PROPS */, _hoisted_488))
                            }), 128 /* KEYED_FRAGMENT */))
                          ])
                        ], 64 /* STABLE_FRAGMENT */))
                      : _createCommentVNode("v-if", true)
                  ], 64 /* STABLE_FRAGMENT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" FormulaBase "),
              (_ctx.source === 'formulabase')
                ? (_openBlock(), _createElementBlock(_Fragment, { key: 6 }, [
                    (!_ctx.src.collection)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_489, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (x) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: x.id,
                              class: "fp-item",
                              onClick: $event => (_ctx.openCollection(x))
                            }, [
                              _createElementVNode("span", _hoisted_491, _toDisplayString(x.icon || '∑'), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_492, _toDisplayString(x.name), 1 /* TEXT */)
                            ], 8 /* PROPS */, _hoisted_490))
                          }), 128 /* KEYED_FRAGMENT */)),
                          (!_ctx.src.items.length && !_ctx.src.loading)
                            ? (_openBlock(), _createElementBlock("p", _hoisted_493, _toDisplayString(_ctx.t('There is nothing here yet.')), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.src.collection)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_494, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.records, (f) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: f.id,
                              class: "fp-item",
                              onClick: $event => (_ctx.insertFormula(f))
                            }, [
                              _createElementVNode("span", _hoisted_496, _toDisplayString(f.name), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_497, _toDisplayString(f.expression), 1 /* TEXT */)
                            ], 8 /* PROPS */, _hoisted_495))
                          }), 128 /* KEYED_FRAGMENT */))
                        ]))
                      : _createCommentVNode("v-if", true)
                  ], 64 /* STABLE_FRAGMENT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" Notes "),
              (_ctx.source === 'notes')
                ? (_openBlock(), _createElementBlock("div", _hoisted_498, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (n) => {
                      return (_openBlock(), _createElementBlock("button", {
                        key: n.id,
                        class: "fp-item",
                        onClick: $event => (_ctx.insertNote(n))
                      }, [
                        _createElementVNode("span", _hoisted_500, _toDisplayString(n.title), 1 /* TEXT */),
                        _createElementVNode("span", _hoisted_501, _toDisplayString(n.category), 1 /* TEXT */)
                      ], 8 /* PROPS */, _hoisted_499))
                    }), 128 /* KEYED_FRAGMENT */)),
                    (!_ctx.src.items.length && !_ctx.src.loading)
                      ? (_openBlock(), _createElementBlock("p", _hoisted_502, _toDisplayString(_ctx.t('There is nothing here yet.')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("div", _hoisted_503, [
              (_ctx.src.detail || _ctx.src.collection)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 0,
                    class: "eb-btn ghost",
                    onClick: _cache[292] || (_cache[292] = $event => {_ctx.src.detail = null; _ctx.src.collection = null})
                  }, _toDisplayString(_ctx.t('Back')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.source === 'contacts' || (_ctx.source === 'regibase' && _ctx.src.collection))
                ? (_openBlock(), _createElementBlock("button", {
                    key: 1,
                    class: "eb-btn ghost",
                    onClick: _cache[293] || (_cache[293] = $event => (_ctx.openMerge(_ctx.source === 'contacts' ? 'contacts' : 'regibase')))
                  }, _toDisplayString(_ctx.t('Mail merge…')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.source === 'calendar' && _ctx.src.records.length)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 2,
                    class: "eb-btn",
                    onClick: _cache[294] || (_cache[294] = $event => (_ctx.insertEvents(true)))
                  }, _toDisplayString(_ctx.t('Insert as a table')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.source === 'calendar' && _ctx.src.records.length)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 3,
                    class: "eb-btn primary",
                    onClick: _cache[295] || (_cache[295] = $event => (_ctx.insertEvents(false)))
                  }, _toDisplayString(_ctx.t('Insert as a list')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.source === 'tables' && _ctx.src.detail)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 4,
                    class: "eb-btn primary",
                    onClick: _cache[296] || (_cache[296] = (...args) => (_ctx.insertTableData && _ctx.insertTableData(...args)))
                  }, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[297] || (_cache[297] = $event => (_ctx.sourceOpen = false))
              }, _toDisplayString(_ctx.t('Close')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" mail merge "),
    (_ctx.mergeOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 6,
          class: "eb-modal-back",
          onClick: _cache[305] || (_cache[305] = $event => (_ctx.mergeOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[304] || (_cache[304] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Mail merge')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_504, [
              (!_ctx.merge.keys.length)
                ? (_openBlock(), _createElementBlock("p", _hoisted_505, _toDisplayString(_ctx.mergeHint), 1 /* TEXT */))
                : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                    _createElementVNode("p", _hoisted_506, _toDisplayString(_ctx.t('{n} records will be filled into {k} fields:', { n: _ctx.merge.count, k: _ctx.merge.keys.length })), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_507, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.merge.keys, (k) => {
                        return (_openBlock(), _createElementBlock("span", {
                          key: k,
                          class: "chip"
                        }, _toDisplayString(_ctx.fieldTag(k)), 1 /* TEXT */))
                      }), 128 /* KEYED_FRAGMENT */))
                    ]),
                    _createElementVNode("label", _hoisted_508, [
                      _withDirectives(_createElementVNode("input", {
                        type: "radio",
                        value: false,
                        "onUpdate:modelValue": _cache[300] || (_cache[300] = $event => ((_ctx.merge.separate) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelRadio, _ctx.merge.separate]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('One document, one page per record')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("label", _hoisted_509, [
                      _withDirectives(_createElementVNode("input", {
                        type: "radio",
                        value: true,
                        "onUpdate:modelValue": _cache[301] || (_cache[301] = $event => ((_ctx.merge.separate) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelRadio, _ctx.merge.separate]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('A separate document per record')), 1 /* TEXT */)
                    ])
                  ], 64 /* STABLE_FRAGMENT */))
            ]),
            _createElementVNode("div", _hoisted_510, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[302] || (_cache[302] = $event => (_ctx.mergeOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                disabled: !_ctx.merge.keys.length || _ctx.merge.busy,
                onClick: _cache[303] || (_cache[303] = (...args) => (_ctx.runMerge && _ctx.runMerge(...args)))
              }, _toDisplayString(_ctx.merge.busy ? _ctx.t('Working…') : _ctx.t('Merge')), 9 /* TEXT, PROPS */, _hoisted_511)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" pictures from Files "),
    (_ctx.pickerOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 7,
          class: "eb-modal-back",
          onClick: _cache[310] || (_cache[310] = $event => (_ctx.pickerOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal tall",
            onClick: _cache[309] || (_cache[309] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.image
              }, null, 8 /* PROPS */, _hoisted_512),
              _createTextVNode(" " + _toDisplayString(_ctx.picker.mode === 'pagebg' ? _ctx.t('Picture behind the page') : (_ctx.picker.mode === 'objectbg' ? _ctx.t('Picture behind the words') : _ctx.t('Insert picture'))), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_513, [
              _createElementVNode("div", _hoisted_514, [
                _createElementVNode("button", {
                  class: "eb-btn ghost",
                  disabled: _ctx.picker.parent === null || _ctx.picker.loading,
                  onClick: _cache[306] || (_cache[306] = $event => (_ctx.pickerLoad(_ctx.picker.parent)))
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.up
                  }, null, 8 /* PROPS */, _hoisted_516)
                ], 8 /* PROPS */, _hoisted_515),
                _createElementVNode("span", _hoisted_517, "/" + _toDisplayString(_ctx.picker.path), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_518, [
                (_ctx.picker.loading)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_519, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                (_ctx.picker.error)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_520, _toDisplayString(_ctx.picker.error), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.picker.entries, (x) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: x.path,
                    class: _normalizeClass(["fp-item", { on: _ctx.picker.selected && _ctx.picker.selected.path === x.path, dim: !x.is_dir && !x.is_image }]),
                    onClick: $event => (_ctx.pickerClick(x)),
                    onDblclick: $event => (_ctx.pickerConfirm(x))
                  }, [
                    _createElementVNode("span", {
                      class: "ic",
                      innerHTML: x.is_dir ? _ctx.icons.folder : _ctx.icons.image
                    }, null, 8 /* PROPS */, _hoisted_522),
                    _createElementVNode("span", _hoisted_523, _toDisplayString(x.name), 1 /* TEXT */),
                    (!x.is_dir)
                      ? (_openBlock(), _createElementBlock("span", _hoisted_524, _toDisplayString(_ctx.size(x.size)), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_521))
                }), 128 /* KEYED_FRAGMENT */)),
                (!_ctx.picker.loading && !_ctx.picker.entries.length)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_525, _toDisplayString(_ctx.t('This folder is empty.')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true)
              ]),
              _createElementVNode("p", _hoisted_526, _toDisplayString(_ctx.t('The picture is embedded in the document itself, so it travels with the file. Large photographs are scaled down on the way in.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_527, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[307] || (_cache[307] = $event => (_ctx.pickerOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                disabled: !_ctx.picker.selected || _ctx.picker.busy,
                onClick: _cache[308] || (_cache[308] = $event => (_ctx.pickerConfirm()))
              }, _toDisplayString(_ctx.picker.busy ? _ctx.t('Loading…') : (_ctx.picker.mode === 'pagebg' ? _ctx.t('Use for the page') : (_ctx.picker.mode === 'objectbg' ? _ctx.t('Use behind the words') : _ctx.t('Insert')))), 9 /* TEXT, PROPS */, _hoisted_528)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" typeface picker "),
    (_ctx.fontsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 8,
          class: "eb-modal-back",
          onClick: _cache[319] || (_cache[319] = (...args) => (_ctx.closeFonts && _ctx.closeFonts(...args)))
        }, [
          _createElementVNode("div", {
            class: "eb-modal tall",
            onClick: _cache[318] || (_cache[318] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.text
              }, null, 8 /* PROPS */, _hoisted_529),
              _createTextVNode(" " + _toDisplayString(_ctx.t('Typeface')) + " — " + _toDisplayString(_ctx.fontRoleLabel), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_530, [
              _createElementVNode("div", _hoisted_531, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.search
                }, null, 8 /* PROPS */, _hoisted_532),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[311] || (_cache[311] = $event => ((_ctx.fontQuery) = $event)),
                  onInput: _cache[312] || (_cache[312] = $event => (_ctx.fontPage = 1)),
                  placeholder: _ctx.t('Search Google Fonts…')
                }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_533), [
                  [_vModelText, _ctx.fontQuery]
                ])
              ]),
              _createElementVNode("div", _hoisted_534, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontCats, (c) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: c.key,
                    class: _normalizeClass(["chip", { on: _ctx.fontCat === c.key }]),
                    onClick: $event => {_ctx.fontCat = c.key; _ctx.fontPage = 1}
                  }, _toDisplayString(c.label), 11 /* TEXT, CLASS, PROPS */, _hoisted_535))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("div", _hoisted_536, [
                _withDirectives(_createElementVNode("select", {
                  "onUpdate:modelValue": _cache[313] || (_cache[313] = $event => ((_ctx.fontScript) = $event)),
                  onChange: _cache[314] || (_cache[314] = $event => (_ctx.fontPage = 1))
                }, [
                  _createElementVNode("option", _hoisted_537, _toDisplayString(_ctx.t('Script of this document')) + " — " + _toDisplayString(_ctx.scriptLabel(_ctx.docScript)), 1 /* TEXT */),
                  _createElementVNode("option", _hoisted_538, _toDisplayString(_ctx.t('Every script')), 1 /* TEXT */),
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontScripts, (sc) => {
                    return (_openBlock(), _createElementBlock("option", {
                      key: sc,
                      value: sc
                    }, _toDisplayString(_ctx.scriptLabel(sc)), 9 /* TEXT, PROPS */, _hoisted_539))
                  }), 128 /* KEYED_FRAGMENT */))
                ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelSelect, _ctx.fontScript]
                ]),
                _createElementVNode("span", _hoisted_540, _toDisplayString(_ctx.t('{n} families', { n: _ctx.fontResults.length })), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_541, [
                _createElementVNode("button", {
                  class: _normalizeClass(["font-item", { on: _ctx.fontRole === 'selection' ? !_ctx.fmt.family : !_ctx.doc.paper.fonts[_ctx.fontRole] }]),
                  onClick: _cache[315] || (_cache[315] = $event => (_ctx.chooseFont('')))
                }, [
                  _createElementVNode("span", _hoisted_542, _toDisplayString(_ctx.fontRole === 'selection' ? _ctx.t('As the paragraph style says') : _ctx.t('Default for this language')), 1 /* TEXT */),
                  _createElementVNode("span", _hoisted_543, _toDisplayString(_ctx.fontRole === 'selection' ? _ctx.fontsInUse.body : _ctx.defaultFontName), 1 /* TEXT */)
                ], 2 /* CLASS */),
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontPageItems, (f) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: f.f,
                    class: _normalizeClass(["font-item", { on: _ctx.fontRole === 'selection' ? _ctx.fmt.family === f.f : _ctx.doc.paper.fonts[_ctx.fontRole] === f.f }]),
                    onClick: $event => (_ctx.chooseFont(f.f))
                  }, [
                    _createElementVNode("span", {
                      class: "nm",
                      style: _normalizeStyle({ fontFamily: _ctx.fontPreviewStack(f.f) })
                    }, _toDisplayString(f.f), 5 /* TEXT, STYLE */),
                    _createElementVNode("span", _hoisted_545, _toDisplayString(_ctx.catLabel(f.c)) + " · " + _toDisplayString(_ctx.t('{n} weights', { n: f.w.length })), 1 /* TEXT */)
                  ], 10 /* CLASS, PROPS */, _hoisted_544))
                }), 128 /* KEYED_FRAGMENT */)),
                (!_ctx.fontResults.length && _ctx.fontsLoading)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_546, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                (!_ctx.fontResults.length && !_ctx.fontsLoading)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_547, _toDisplayString(_ctx.t('No family matches that.')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true)
              ]),
              (_ctx.fontPageItems.length < _ctx.fontResults.length)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 0,
                    class: "eb-btn wide",
                    onClick: _cache[316] || (_cache[316] = $event => (_ctx.fontPage++))
                  }, _toDisplayString(_ctx.t('Show more')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createElementVNode("div", _hoisted_548, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Preview')), 1 /* TEXT */),
                _createElementVNode("div", {
                  class: "font-sample",
                  style: _normalizeStyle({ fontFamily: _ctx.fontPreviewStack(_ctx.previewFamily) })
                }, _toDisplayString(_ctx.sampleText), 5 /* TEXT, STYLE */)
              ])
            ]),
            _createElementVNode("div", _hoisted_549, [
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[317] || (_cache[317] = (...args) => (_ctx.closeFonts && _ctx.closeFonts(...args)))
              }, _toDisplayString(_ctx.t('Done')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" settings "),
    (_ctx.settingsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 9,
          class: "eb-modal-back",
          onClick: _cache[330] || (_cache[330] = $event => (_ctx.settingsOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[329] || (_cache[329] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "⚙ " + _toDisplayString(_ctx.t('Settings')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_550, [
              _createElementVNode("div", _hoisted_551, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Save documents in')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[320] || (_cache[320] = $event => ((_ctx.settings.folder) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelText, _ctx.settings.folder]
                ]),
                _createElementVNode("p", _hoisted_552, _toDisplayString(_ctx.t('A folder in your own Files. Documents already saved elsewhere stay where they are.')), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_553, [
                _createElementVNode("div", _hoisted_554, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Theme')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[321] || (_cache[321] = $event => ((_ctx.settings.theme) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_555, _toDisplayString(_ctx.t('Follow Nextcloud')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_556, _toDisplayString(_ctx.t('Light')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_557, _toDisplayString(_ctx.t('Dark')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.settings.theme]
                  ])
                ]),
                _createElementVNode("div", _hoisted_558, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Language')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[322] || (_cache[322] = $event => ((_ctx.settings.language) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_559, _toDisplayString(_ctx.t('Follow Nextcloud')), 1 /* TEXT */),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.settings.languages, (l) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: l.code,
                        value: l.code
                      }, _toDisplayString(l.name), 9 /* TEXT, PROPS */, _hoisted_560))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.settings.language]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_561, [
                _createElementVNode("label", _hoisted_562, [
                  _createElementVNode("input", {
                    type: "checkbox",
                    checked: _ctx.spellcheck,
                    onChange: _cache[323] || (_cache[323] = (...args) => (_ctx.toggleSpellcheck && _ctx.toggleSpellcheck(...args)))
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_563),
                  _createTextVNode(" " + _toDisplayString(_ctx.t('Check spelling while typing')), 1 /* TEXT */)
                ]),
                _createElementVNode("label", _hoisted_564, [
                  _createElementVNode("input", {
                    type: "checkbox",
                    checked: _ctx.autolink,
                    onChange: _cache[324] || (_cache[324] = (...args) => (_ctx.toggleAutolink && _ctx.toggleAutolink(...args)))
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_565),
                  _createTextVNode(" " + _toDisplayString(_ctx.t('Turn an address into a link as it is typed')), 1 /* TEXT */)
                ]),
                _createElementVNode("label", _hoisted_566, [
                  _withDirectives(_createElementVNode("input", {
                    type: "checkbox",
                    "onUpdate:modelValue": _cache[325] || (_cache[325] = $event => ((_ctx.pasteObject) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelCheckbox, _ctx.pasteObject]
                  ]),
                  _createTextVNode(" " + _toDisplayString(_ctx.t('Paste into a box of its own')), 1 /* TEXT */)
                ]),
                _createElementVNode("p", _hoisted_567, _toDisplayString(_ctx.t('What is pasted arrives as an object with a box round it, ready to be put where it belongs. Hold Shift while pasting to put it straight into the writing as plain text.')), 1 /* TEXT */),
                _createElementVNode("p", _hoisted_568, _toDisplayString(_ctx.t('Spelling is checked by the browser itself, in the language it is set to. Shift+right-click reaches its suggestions.')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_569, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[326] || (_cache[326] = $event => ((_ctx.autosave) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.autosave]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Save automatically while typing')), 1 /* TEXT */)
              ])
            ]),
            _createElementVNode("div", _hoisted_570, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[327] || (_cache[327] = $event => (_ctx.settingsOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[328] || (_cache[328] = (...args) => (_ctx.saveSettings && _ctx.saveSettings(...args)))
              }, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the file itself "),
    (_ctx.htmlOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 10,
          class: "eb-modal-back",
          onClick: _cache[333] || (_cache[333] = $event => (_ctx.htmlOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(860px,100%)"},
            onClick: _cache[332] || (_cache[332] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "</> " + _toDisplayString(_ctx.t('View the HTML')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_571, [
              _createElementVNode("p", _hoisted_572, _toDisplayString(_ctx.t('This is exactly what is stored in Files — one file, styles included, nothing else needed to open it.')), 1 /* TEXT */),
              _createElementVNode("textarea", {
                rows: "18",
                spellcheck: "false",
                readonly: "",
                value: _ctx.htmlText,
                style: {"width":"100%","font-family":"monospace","font-size":"12px"}
              }, null, 8 /* PROPS */, _hoisted_573)
            ]),
            _createElementVNode("div", _hoisted_574, [
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[331] || (_cache[331] = $event => (_ctx.htmlOpen = false))
              }, _toDisplayString(_ctx.t('Close')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the right button, as a word processor uses it "),
    _createCommentVNode(" the styles of the document: one rule per kind of paragraph "),
    (_ctx.stylesOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 11,
          class: "eb-modal-back",
          onClick: _cache[355] || (_cache[355] = (...args) => (_ctx.closeStyles && _ctx.closeStyles(...args)))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[354] || (_cache[354] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Styles of this document')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_575, [
              _createElementVNode("div", _hoisted_576, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Which style')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("select", {
                  "onUpdate:modelValue": _cache[334] || (_cache[334] = $event => ((_ctx.styleKey) = $event))
                }, [
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.styleTargets, (t2) => {
                    return (_openBlock(), _createElementBlock("option", {
                      key: t2.key,
                      value: t2.key
                    }, _toDisplayString(t2.label), 9 /* TEXT, PROPS */, _hoisted_577))
                  }), 128 /* KEYED_FRAGMENT */))
                ], 512 /* NEED_PATCH */), [
                  [_vModelSelect, _ctx.styleKey]
                ])
              ]),
              _createElementVNode("div", _hoisted_578, [
                _createElementVNode("div", _hoisted_579, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Typeface')), 1 /* TEXT */),
                  _createElementVNode("select", {
                    value: _ctx.styleNow.family,
                    onChange: _cache[335] || (_cache[335] = $event => {_ctx.styleNow.family = $event.target.value; _ctx.touchStyles()})
                  }, [
                    _createElementVNode("option", _hoisted_581, _toDisplayString(_ctx.t('As the document says')), 1 /* TEXT */),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.styleFamilies, (f) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: f,
                        value: f
                      }, _toDisplayString(f), 9 /* TEXT, PROPS */, _hoisted_582))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_580)
                ]),
                _createElementVNode("div", _hoisted_583, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Size (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "4",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[336] || (_cache[336] = $event => ((_ctx.styleNow.size) = $event)),
                    onInput: _cache[337] || (_cache[337] = (...args) => (_ctx.touchStyles && _ctx.touchStyles(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.styleNow.size]
                  ])
                ]),
                _createElementVNode("div", _hoisted_584, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Colour')), 1 /* TEXT */),
                  _createElementVNode("div", _hoisted_585, [
                    _createElementVNode("input", {
                      type: "color",
                      value: _ctx.styleNow.colour || '#111111',
                      onInput: _cache[338] || (_cache[338] = $event => {_ctx.styleNow.colour = $event.target.value; _ctx.touchStyles()})
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_586),
                    _createElementVNode("button", {
                      class: "eb-btn ghost",
                      onClick: _cache[339] || (_cache[339] = $event => {_ctx.styleNow.colour = ''; _ctx.touchStyles()})
                    }, _toDisplayString(_ctx.t('None')), 1 /* TEXT */)
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_587, [
                _createElementVNode("div", _hoisted_588, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Alignment')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[340] || (_cache[340] = $event => ((_ctx.styleNow.align) = $event)),
                    onChange: _cache[341] || (_cache[341] = (...args) => (_ctx.touchStyles && _ctx.touchStyles(...args)))
                  }, [
                    _createElementVNode("option", _hoisted_589, _toDisplayString(_ctx.t('Unchanged')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_590, _toDisplayString(_ctx.t('Left')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_591, _toDisplayString(_ctx.t('Centre')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_592, _toDisplayString(_ctx.t('Right')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_593, _toDisplayString(_ctx.t('Justified')), 1 /* TEXT */)
                  ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelSelect, _ctx.styleNow.align]
                  ])
                ]),
                _createElementVNode("div", _hoisted_594, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Line height')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "4",
                    step: "0.05",
                    "onUpdate:modelValue": _cache[342] || (_cache[342] = $event => ((_ctx.styleNow.lineHeight) = $event)),
                    onInput: _cache[343] || (_cache[343] = (...args) => (_ctx.touchStyles && _ctx.touchStyles(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.styleNow.lineHeight]
                  ])
                ]),
                _createElementVNode("div", _hoisted_595, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space above (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[344] || (_cache[344] = $event => ((_ctx.styleNow.before) = $event)),
                    onInput: _cache[345] || (_cache[345] = (...args) => (_ctx.touchStyles && _ctx.touchStyles(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.styleNow.before]
                  ])
                ]),
                _createElementVNode("div", _hoisted_596, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space below (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[346] || (_cache[346] = $event => ((_ctx.styleNow.after) = $event)),
                    onInput: _cache[347] || (_cache[347] = (...args) => (_ctx.touchStyles && _ctx.touchStyles(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.styleNow.after]
                  ])
                ])
              ]),
              _createElementVNode("label", _hoisted_597, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[348] || (_cache[348] = $event => ((_ctx.styleNow.bold) = $event)),
                  onChange: _cache[349] || (_cache[349] = (...args) => (_ctx.touchStyles && _ctx.touchStyles(...args)))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.styleNow.bold]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Bold')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_598, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[350] || (_cache[350] = $event => ((_ctx.styleNow.italic) = $event)),
                  onChange: _cache[351] || (_cache[351] = (...args) => (_ctx.touchStyles && _ctx.touchStyles(...args)))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.styleNow.italic]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Italic')), 1 /* TEXT */)
              ]),
              _createElementVNode("p", _hoisted_599, _toDisplayString(_ctx.t('This changes every paragraph of that kind at once, now and later, because it is written as a rule in the file rather than on each paragraph. Anything you have set on one paragraph by hand still wins over it.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_600, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[352] || (_cache[352] = (...args) => (_ctx.clearStyle && _ctx.clearStyle(...args)))
              }, _toDisplayString(_ctx.t('Reset this style')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[353] || (_cache[353] = (...args) => (_ctx.closeStyles && _ctx.closeStyles(...args)))
              }, _toDisplayString(_ctx.t('Done')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" cropping a picture: a shape for the frame and a place to look at "),
    (_ctx.cropOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 12,
          class: "eb-modal-back",
          onClick: _cache[362] || (_cache[362] = $event => (_ctx.cropOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(520px,100%)"},
            onClick: _cache[361] || (_cache[361] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Crop')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_601, [
              _createElementVNode("div", _hoisted_602, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Shape')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("select", {
                  "onUpdate:modelValue": _cache[356] || (_cache[356] = $event => ((_ctx.crop.ratio) = $event))
                }, [
                  _createElementVNode("option", _hoisted_603, _toDisplayString(_ctx.t('The whole picture')), 1 /* TEXT */),
                  _createElementVNode("option", _hoisted_604, _toDisplayString(_ctx.t('Square (1:1)')), 1 /* TEXT */),
                  _hoisted_605
                ], 512 /* NEED_PATCH */), [
                  [_vModelSelect, _ctx.crop.ratio]
                ])
              ]),
              (_ctx.crop.ratio)
                ? (_openBlock(), _createElementBlock("div", {
                    key: 0,
                    class: "eb-cropbox",
                    style: _normalizeStyle({ aspectRatio: _ctx.crop.ratio }),
                    onPointerdown: _cache[357] || (_cache[357] = _withModifiers((...args) => (_ctx.cropGrab && _ctx.cropGrab(...args)), ["prevent"]))
                  }, [
                    _createElementVNode("img", {
                      src: _ctx.cropSrc,
                      style: _normalizeStyle({ objectPosition: _ctx.crop.x + '% ' + _ctx.crop.y + '%' })
                    }, null, 12 /* STYLE, PROPS */, _hoisted_610),
                    _createElementVNode("span", _hoisted_611, _toDisplayString(_ctx.t('Drag the picture to choose what shows.')), 1 /* TEXT */)
                  ], 36 /* STYLE, NEED_HYDRATION */))
                : _createCommentVNode("v-if", true),
              _createElementVNode("p", _hoisted_612, _toDisplayString(_ctx.t('Nothing is cut away: the whole picture stays in the file and the frame simply shows part of it, so the crop can be changed or undone at any time.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_613, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[358] || (_cache[358] = $event => (_ctx.crop.ratio = ''))
              }, _toDisplayString(_ctx.t('The whole picture')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn",
                onClick: _cache[359] || (_cache[359] = $event => (_ctx.cropOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[360] || (_cache[360] = (...args) => (_ctx.applyCrop && _ctx.applyCrop(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" a rule round the chosen cells "),
    (_ctx.cellBorderOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 13,
          class: "eb-modal-back",
          onClick: _cache[370] || (_cache[370] = $event => (_ctx.cellBorderOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(560px,100%)"},
            onClick: _cache[369] || (_cache[369] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Rule round the cells')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_614, [
              _createElementVNode("div", _hoisted_615, [
                _createElementVNode("div", _hoisted_616, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Rule')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[363] || (_cache[363] = $event => ((_ctx.cellBorder.style) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_617, _toDisplayString(_ctx.t('As the style says')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_618, _toDisplayString(_ctx.t('None')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_619, _toDisplayString(_ctx.t('Solid')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_620, _toDisplayString(_ctx.t('Dashed')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_621, _toDisplayString(_ctx.t('Dotted')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_622, _toDisplayString(_ctx.t('Double')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.cellBorder.style]
                  ])
                ]),
                _createElementVNode("div", _hoisted_623, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('On which edges')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[364] || (_cache[364] = $event => ((_ctx.cellBorder.sides) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_624, _toDisplayString(_ctx.t('All four')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_625, _toDisplayString(_ctx.t('Above')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_626, _toDisplayString(_ctx.t('Below')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_627, _toDisplayString(_ctx.t('Above and below')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_628, _toDisplayString(_ctx.t('At the left')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.cellBorder.sides]
                  ])
                ]),
                _createElementVNode("div", _hoisted_629, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Thickness (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0.25",
                    step: "0.25",
                    "onUpdate:modelValue": _cache[365] || (_cache[365] = $event => ((_ctx.cellBorder.width) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.cellBorder.width]
                  ])
                ]),
                _createElementVNode("div", _hoisted_630, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Line colour')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "color",
                    "onUpdate:modelValue": _cache[366] || (_cache[366] = $event => ((_ctx.cellBorder.colour) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.cellBorder.colour]
                  ])
                ])
              ]),
              _createElementVNode("p", _hoisted_631, _toDisplayString(_ctx.t('This is put on every cell the selection touches. Select across several cells first to do a block of them at once.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_632, [
              _createElementVNode("button", {
                class: "eb-btn",
                onClick: _cache[367] || (_cache[367] = $event => (_ctx.cellBorderOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[368] || (_cache[368] = (...args) => (_ctx.applyCellBorder && _ctx.applyCellBorder(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" a reading over a word "),
    (_ctx.rubyOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 14,
          class: "eb-modal-back",
          onClick: _cache[377] || (_cache[377] = $event => (_ctx.rubyOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(420px,100%)"},
            onClick: _cache[376] || (_cache[376] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Reading')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_633, [
              _createElementVNode("div", _hoisted_634, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Word')), 1 /* TEXT */),
                _createElementVNode("input", {
                  type: "text",
                  value: _ctx.rubyWord,
                  readonly: ""
                }, null, 8 /* PROPS */, _hoisted_635)
              ]),
              _createElementVNode("div", _hoisted_636, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Reading')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  ref: "rubyInput",
                  type: "text",
                  "onUpdate:modelValue": _cache[371] || (_cache[371] = $event => ((_ctx.rubyText) = $event)),
                  onKeydown: _cache[372] || (_cache[372] = _withKeys(_withModifiers((...args) => (_ctx.applyRubyText && _ctx.applyRubyText(...args)), ["prevent"]), ["enter"]))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelText, _ctx.rubyText]
                ])
              ]),
              _createElementVNode("p", _hoisted_637, _toDisplayString(_ctx.t('The reading is written above the word, at half its size, using the element HTML has for exactly this.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_638, [
              (_ctx.fmt.ruby)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 0,
                    class: "eb-btn ghost",
                    onClick: _cache[373] || (_cache[373] = (...args) => (_ctx.dropRuby && _ctx.dropRuby(...args)))
                  }, _toDisplayString(_ctx.t('Remove the reading')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createElementVNode("button", {
                class: "eb-btn",
                onClick: _cache[374] || (_cache[374] = $event => (_ctx.rubyOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[375] || (_cache[375] = (...args) => (_ctx.applyRubyText && _ctx.applyRubyText(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" a note "),
    (_ctx.noteOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 15,
          class: "eb-modal-back",
          onClick: _cache[382] || (_cache[382] = $event => (_ctx.noteOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(520px,100%)"},
            onClick: _cache[381] || (_cache[381] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Note')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_639, [
              _createElementVNode("div", _hoisted_640, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('The note')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("textarea", {
                  ref: "noteInput",
                  rows: "4",
                  "onUpdate:modelValue": _cache[378] || (_cache[378] = $event => ((_ctx.noteText) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelText, _ctx.noteText]
                ])
              ]),
              _createElementVNode("p", _hoisted_641, _toDisplayString(_ctx.t('A number goes in at the cursor and the note is added to the list at the end of the document. The numbers follow the order the notes are cited in and look after themselves. A browser cannot put a note at the foot of the page that cites it: nothing in CSS moves text from one page to another.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_642, [
              _createElementVNode("button", {
                class: "eb-btn",
                onClick: _cache[379] || (_cache[379] = $event => (_ctx.noteOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[380] || (_cache[380] = (...args) => (_ctx.applyNote && _ctx.applyNote(...args)))
              }, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" columns "),
    (_ctx.colsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 16,
          class: "eb-modal-back",
          onClick: _cache[388] || (_cache[388] = $event => (_ctx.colsOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(460px,100%)"},
            onClick: _cache[387] || (_cache[387] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Columns')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_643, [
              _createElementVNode("div", _hoisted_644, [
                _createElementVNode("div", _hoisted_645, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Columns')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[383] || (_cache[383] = $event => ((_ctx.cols.count) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_646, _toDisplayString(_ctx.t('One (no columns)')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_647, _toDisplayString(_ctx.t('Two')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_648, _toDisplayString(_ctx.t('Three')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_649, _toDisplayString(_ctx.t('Four')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [
                      _vModelSelect,
                      _ctx.cols.count,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_650, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Gap (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "40",
                    step: "1",
                    "onUpdate:modelValue": _cache[384] || (_cache[384] = $event => ((_ctx.cols.gap) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.cols.gap,
                      void 0,
                      { number: true }
                    ]
                  ])
                ])
              ]),
              _createElementVNode("p", _hoisted_651, _toDisplayString(_ctx.t('The paragraphs you have selected are laid out in columns. Select a paragraph inside them and choose one column to take the columns off again.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_652, [
              _createElementVNode("button", {
                class: "eb-btn",
                onClick: _cache[385] || (_cache[385] = $event => (_ctx.colsOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[386] || (_cache[386] = (...args) => (_ctx.applyCols && _ctx.applyCols(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the running header and footer "),
    (_ctx.runOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 17,
          class: "eb-modal-back",
          onClick: _cache[404] || (_cache[404] = $event => (_ctx.runOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[403] || (_cache[403] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Header and footer')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_653, [
              _createElementVNode("label", null, _toDisplayString(_ctx.t('Header')), 1 /* TEXT */),
              _createElementVNode("div", _hoisted_654, [
                _createElementVNode("div", _hoisted_655, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Left')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "text",
                    maxlength: "120",
                    "onUpdate:modelValue": _cache[389] || (_cache[389] = $event => ((_ctx.doc.paper.header.l) = $event)),
                    onInput: _cache[390] || (_cache[390] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.doc.paper.header.l]
                  ])
                ]),
                _createElementVNode("div", _hoisted_656, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Centre')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "text",
                    maxlength: "120",
                    "onUpdate:modelValue": _cache[391] || (_cache[391] = $event => ((_ctx.doc.paper.header.c) = $event)),
                    onInput: _cache[392] || (_cache[392] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.doc.paper.header.c]
                  ])
                ]),
                _createElementVNode("div", _hoisted_657, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Right')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "text",
                    maxlength: "120",
                    "onUpdate:modelValue": _cache[393] || (_cache[393] = $event => ((_ctx.doc.paper.header.r) = $event)),
                    onInput: _cache[394] || (_cache[394] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.doc.paper.header.r]
                  ])
                ])
              ]),
              _createElementVNode("label", null, _toDisplayString(_ctx.t('Footer')), 1 /* TEXT */),
              _createElementVNode("div", _hoisted_658, [
                _createElementVNode("div", _hoisted_659, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Left')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "text",
                    maxlength: "120",
                    "onUpdate:modelValue": _cache[395] || (_cache[395] = $event => ((_ctx.doc.paper.footer.l) = $event)),
                    onInput: _cache[396] || (_cache[396] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.doc.paper.footer.l]
                  ])
                ]),
                _createElementVNode("div", _hoisted_660, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Centre')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "text",
                    maxlength: "120",
                    "onUpdate:modelValue": _cache[397] || (_cache[397] = $event => ((_ctx.doc.paper.footer.c) = $event)),
                    onInput: _cache[398] || (_cache[398] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.doc.paper.footer.c]
                  ])
                ]),
                _createElementVNode("div", _hoisted_661, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Right')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "text",
                    maxlength: "120",
                    "onUpdate:modelValue": _cache[399] || (_cache[399] = $event => ((_ctx.doc.paper.footer.r) = $event)),
                    onInput: _cache[400] || (_cache[400] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelText, _ctx.doc.paper.footer.r]
                  ])
                ])
              ]),
              _createElementVNode("p", _hoisted_662, _toDisplayString(_ctx.t('These repeat in the margin of every printed page. They are plain text: page numbers cannot be counted by a browser, and come from its own print dialogue instead.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_663, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[401] || (_cache[401] = (...args) => (_ctx.clearRunning && _ctx.clearRunning(...args)))
              }, _toDisplayString(_ctx.t('Clear')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[402] || (_cache[402] = $event => (_ctx.runOpen = false))
              }, _toDisplayString(_ctx.t('Done')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" frame properties: everything here is written on the object as inline CSS,\n       so the saved file carries its own layout and needs nothing to read it "),
    (_ctx.fpropsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 18,
          class: "eb-modal-back",
          onClick: _cache[446] || (_cache[446] = $event => (_ctx.fpropsOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[445] || (_cache[445] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('{name} properties', { name: _ctx.frameLabel })), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_664, [
              _createElementVNode("h4", _hoisted_665, _toDisplayString(_ctx.t('Where it stands')), 1 /* TEXT */),
              _createElementVNode("div", _hoisted_666, [
                _createElementVNode("div", _hoisted_667, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Placement')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[405] || (_cache[405] = $event => ((_ctx.fprops.place) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_668, _toDisplayString(_ctx.t('In the flow of the text')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_669, _toDisplayString(_ctx.t('In the flow, at the left')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_670, _toDisplayString(_ctx.t('In the flow, centred')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_671, _toDisplayString(_ctx.t('In the flow, at the right')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_672, _toDisplayString(_ctx.t('Placed freely')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.fprops.place]
                  ])
                ]),
                _createElementVNode("div", _hoisted_673, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Where the words go')), 1 /* TEXT */),
                  _createElementVNode("div", _hoisted_674, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.wrapChoices, (w) => {
                      return (_openBlock(), _createElementBlock("button", {
                        key: w.kind,
                        class: _normalizeClass(["eb-pickitem", { on: _ctx.fprops.wrapMode === w.kind }]),
                        onClick: $event => (_ctx.fprops.wrapMode = w.kind),
                        title: w.label
                      }, [
                        _createElementVNode("span", {
                          innerHTML: w.icon
                        }, null, 8 /* PROPS */, _hoisted_676),
                        _createElementVNode("span", _hoisted_677, _toDisplayString(w.label), 1 /* TEXT */)
                      ], 10 /* CLASS, PROPS */, _hoisted_675))
                    }), 128 /* KEYED_FRAGMENT */))
                  ])
                ]),
                _createElementVNode("div", _hoisted_678, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Gap to the text (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "60",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[406] || (_cache[406] = $event => ((_ctx.fprops.wrapGap) = $event)),
                    placeholder: '3'
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.wrapGap]
                  ])
                ]),
                (_ctx.frameHoldsWords)
                  ? (_openBlock(), _createElementBlock("div", _hoisted_679, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Which way the words run')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("select", {
                        "onUpdate:modelValue": _cache[407] || (_cache[407] = $event => ((_ctx.fprops.flow) = $event))
                      }, [
                        _createElementVNode("option", _hoisted_680, _toDisplayString(_ctx.t('As the page runs')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_681, _toDisplayString(_ctx.t('Across (horizontal)')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_682, _toDisplayString(_ctx.t('Down (vertical)')), 1 /* TEXT */)
                      ], 512 /* NEED_PATCH */), [
                        [_vModelSelect, _ctx.fprops.flow]
                      ])
                    ]))
                  : _createCommentVNode("v-if", true),
                (_ctx.frameHoldsWords)
                  ? (_openBlock(), _createElementBlock("div", _hoisted_683, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Text down the box')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("select", {
                        "onUpdate:modelValue": _cache[408] || (_cache[408] = $event => ((_ctx.fprops.vpos) = $event))
                      }, [
                        _createElementVNode("option", _hoisted_684, _toDisplayString(_ctx.t('At the top')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_685, _toDisplayString(_ctx.t('In the middle')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_686, _toDisplayString(_ctx.t('At the bottom')), 1 /* TEXT */)
                      ], 512 /* NEED_PATCH */), [
                        [_vModelSelect, _ctx.fprops.vpos]
                      ])
                    ]))
                  : _createCommentVNode("v-if", true)
              ]),
              _createCommentVNode(" How the writing itself is dressed: a picture behind it, an outline\n             round each letter, a shadow under them. Written as CSS on the object,\n             so the saved file carries the look with it. "),
              (_ctx.frameHoldsWords)
                ? (_openBlock(), _createElementBlock("h4", _hoisted_687, _toDisplayString(_ctx.t('How the words are dressed')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.frameHoldsWords)
                ? (_openBlock(), _createElementBlock("div", _hoisted_688, [
                    _createElementVNode("div", _hoisted_689, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Picture behind the words')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_690, [
                        _createElementVNode("button", {
                          class: "eb-btn",
                          onClick: _cache[409] || (_cache[409] = $event => (_ctx.openObjectBg()))
                        }, _toDisplayString(_ctx.fprops.bgImage ? _ctx.t('Change…') : _ctx.t('Choose…')), 1 /* TEXT */),
                        _createElementVNode("button", {
                          class: "eb-btn",
                          disabled: !_ctx.fprops.bgImage,
                          onClick: _cache[410] || (_cache[410] = $event => (_ctx.clearObjectBg()))
                        }, _toDisplayString(_ctx.t('None')), 9 /* TEXT, PROPS */, _hoisted_691)
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_692, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('How it fills')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("select", {
                        "onUpdate:modelValue": _cache[411] || (_cache[411] = $event => ((_ctx.fprops.bgFit) = $event)),
                        disabled: !_ctx.fprops.bgImage
                      }, [
                        _createElementVNode("option", _hoisted_694, _toDisplayString(_ctx.t('Fill the box')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_695, _toDisplayString(_ctx.t('Fit inside')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_696, _toDisplayString(_ctx.t('Tiled')), 1 /* TEXT */)
                      ], 8 /* PROPS */, _hoisted_693), [
                        [_vModelSelect, _ctx.fprops.bgFit]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_697, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Outline (mm)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "number",
                        min: "0",
                        max: "3",
                        step: "0.05",
                        "onUpdate:modelValue": _cache[412] || (_cache[412] = $event => ((_ctx.fprops.strokeWidth) = $event)),
                        placeholder: "0"
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.fprops.strokeWidth]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_698, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Outline colour')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "color",
                        "onUpdate:modelValue": _cache[413] || (_cache[413] = $event => ((_ctx.fprops.strokeColour) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.fprops.strokeColour]
                      ])
                    ])
                  ]))
                : _createCommentVNode("v-if", true),
              (_ctx.frameHoldsWords)
                ? (_openBlock(), _createElementBlock("div", _hoisted_699, [
                    _createElementVNode("div", _hoisted_700, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Shadow under the letters')), 1 /* TEXT */),
                      _createElementVNode("label", _hoisted_701, [
                        _withDirectives(_createElementVNode("input", {
                          type: "checkbox",
                          "onUpdate:modelValue": _cache[414] || (_cache[414] = $event => ((_ctx.fprops.textShadow) = $event))
                        }, null, 512 /* NEED_PATCH */), [
                          [_vModelCheckbox, _ctx.fprops.textShadow]
                        ]),
                        _createTextVNode(" " + _toDisplayString(_ctx.t('On')), 1 /* TEXT */)
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_702, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Across (pt)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "number",
                        min: "-20",
                        max: "20",
                        step: "0.5",
                        "onUpdate:modelValue": _cache[415] || (_cache[415] = $event => ((_ctx.fprops.shadowX) = $event)),
                        disabled: !_ctx.fprops.textShadow
                      }, null, 8 /* PROPS */, _hoisted_703), [
                        [_vModelText, _ctx.fprops.shadowX]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_704, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Down (pt)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "number",
                        min: "-20",
                        max: "20",
                        step: "0.5",
                        "onUpdate:modelValue": _cache[416] || (_cache[416] = $event => ((_ctx.fprops.shadowY) = $event)),
                        disabled: !_ctx.fprops.textShadow
                      }, null, 8 /* PROPS */, _hoisted_705), [
                        [_vModelText, _ctx.fprops.shadowY]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_706, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Softness (pt)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "number",
                        min: "0",
                        max: "30",
                        step: "0.5",
                        "onUpdate:modelValue": _cache[417] || (_cache[417] = $event => ((_ctx.fprops.shadowBlur) = $event)),
                        disabled: !_ctx.fprops.textShadow
                      }, null, 8 /* PROPS */, _hoisted_707), [
                        [_vModelText, _ctx.fprops.shadowBlur]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_708, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Shadow colour')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "color",
                        "onUpdate:modelValue": _cache[418] || (_cache[418] = $event => ((_ctx.fprops.shadowColour) = $event)),
                        disabled: !_ctx.fprops.textShadow
                      }, null, 8 /* PROPS */, _hoisted_709), [
                        [_vModelText, _ctx.fprops.shadowColour]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_710, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Text inside it')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("select", {
                        "onUpdate:modelValue": _cache[419] || (_cache[419] = $event => ((_ctx.fprops.inner) = $event))
                      }, [
                        _createElementVNode("option", _hoisted_711, _toDisplayString(_ctx.t('As the document is set')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_712, _toDisplayString(_ctx.t('Ranged left')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_713, _toDisplayString(_ctx.t('Centred')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_714, _toDisplayString(_ctx.t('Ranged right')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_715, _toDisplayString(_ctx.t('Justified')), 1 /* TEXT */)
                      ], 512 /* NEED_PATCH */), [
                        [_vModelSelect, _ctx.fprops.inner]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_716, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Text wrap')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("select", {
                        "onUpdate:modelValue": _cache[420] || (_cache[420] = $event => ((_ctx.fprops.wrap) = $event))
                      }, [
                        _createElementVNode("option", _hoisted_717, _toDisplayString(_ctx.t('None')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_718, _toDisplayString(_ctx.t('Text wraps on the right')), 1 /* TEXT */),
                        _createElementVNode("option", _hoisted_719, _toDisplayString(_ctx.t('Text wraps on the left')), 1 /* TEXT */)
                      ], 512 /* NEED_PATCH */), [
                        [_vModelSelect, _ctx.fprops.wrap]
                      ])
                    ])
                  ]))
                : _createCommentVNode("v-if", true),
              (_ctx.freePlacement)
                ? (_openBlock(), _createElementBlock("div", _hoisted_720, [
                    _createElementVNode("div", _hoisted_721, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('From the left (mm)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "number",
                        step: "1",
                        "onUpdate:modelValue": _cache[421] || (_cache[421] = $event => ((_ctx.fprops.x) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.fprops.x]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_722, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('From the top (mm)')), 1 /* TEXT */),
                      _withDirectives(_createElementVNode("input", {
                        type: "number",
                        step: "1",
                        "onUpdate:modelValue": _cache[422] || (_cache[422] = $event => ((_ctx.fprops.y) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelText, _ctx.fprops.y]
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_723, [
                      _createElementVNode("label", null, _toDisplayString(_ctx.t('Overlapping')), 1 /* TEXT */),
                      _createElementVNode("div", _hoisted_724, [
                        _createElementVNode("button", {
                          class: "eb-btn ghost",
                          onClick: _cache[423] || (_cache[423] = $event => (_ctx.stackFromProps('front')))
                        }, _toDisplayString(_ctx.t('Bring to front')), 1 /* TEXT */),
                        _createElementVNode("button", {
                          class: "eb-btn ghost",
                          onClick: _cache[424] || (_cache[424] = $event => (_ctx.stackFromProps('back')))
                        }, _toDisplayString(_ctx.t('Send to back')), 1 /* TEXT */)
                      ])
                    ])
                  ]))
                : _createCommentVNode("v-if", true),
              (_ctx.freePlacement)
                ? (_openBlock(), _createElementBlock("p", _hoisted_725, _toDisplayString(_ctx.t('A frame placed freely is measured from the line of text it was put on, so it keeps to that page when the document is printed. The text runs underneath it rather than round it.')), 1 /* TEXT */))
                : (_ctx.fprops.wrap)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_726, _toDisplayString(_ctx.t('The text runs round a wrapped frame. Move it with the four spacings below: they are what holds it away from the words.')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
              _createElementVNode("h4", _hoisted_727, _toDisplayString(_ctx.t('How big it is')), 1 /* TEXT */),
              _createElementVNode("div", _hoisted_728, [
                _createElementVNode("div", _hoisted_729, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Width (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "5",
                    step: "1",
                    "onUpdate:modelValue": _cache[425] || (_cache[425] = $event => ((_ctx.fprops.width) = $event)),
                    placeholder: _ctx.t('auto')
                  }, null, 8 /* PROPS */, _hoisted_730), [
                    [_vModelText, _ctx.fprops.width]
                  ])
                ]),
                _createElementVNode("div", _hoisted_731, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Height (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "3",
                    step: "1",
                    "onUpdate:modelValue": _cache[426] || (_cache[426] = $event => ((_ctx.fprops.height) = $event)),
                    placeholder: _ctx.t('auto')
                  }, null, 8 /* PROPS */, _hoisted_732), [
                    [_vModelText, _ctx.fprops.height]
                  ])
                ]),
                _createElementVNode("div", _hoisted_733, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Inner margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    step: "1",
                    "onUpdate:modelValue": _cache[427] || (_cache[427] = $event => ((_ctx.fprops.pad) = $event)),
                    placeholder: _ctx.t('auto')
                  }, null, 8 /* PROPS */, _hoisted_734), [
                    [_vModelText, _ctx.fprops.pad]
                  ])
                ])
              ]),
              _createElementVNode("h4", _hoisted_735, _toDisplayString(_ctx.t('The room round it')), 1 /* TEXT */),
              _createElementVNode("div", _hoisted_736, [
                _createElementVNode("div", _hoisted_737, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space above (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    step: "1",
                    "onUpdate:modelValue": _cache[428] || (_cache[428] = $event => ((_ctx.fprops.mt) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.mt]
                  ])
                ]),
                _createElementVNode("div", _hoisted_738, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space below (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    step: "1",
                    "onUpdate:modelValue": _cache[429] || (_cache[429] = $event => ((_ctx.fprops.mb) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.mb]
                  ])
                ]),
                _createElementVNode("div", _hoisted_739, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space left (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    step: "1",
                    "onUpdate:modelValue": _cache[430] || (_cache[430] = $event => ((_ctx.fprops.ml) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.ml]
                  ])
                ]),
                _createElementVNode("div", _hoisted_740, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space right (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    step: "1",
                    "onUpdate:modelValue": _cache[431] || (_cache[431] = $event => ((_ctx.fprops.mr) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.mr]
                  ])
                ])
              ]),
              _createElementVNode("h4", _hoisted_741, _toDisplayString(_ctx.t('Its own look')), 1 /* TEXT */),
              _createElementVNode("div", _hoisted_742, [
                _createElementVNode("div", _hoisted_743, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Border')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[432] || (_cache[432] = $event => ((_ctx.fprops.border) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_744, _toDisplayString(_ctx.t('As the style says')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_745, _toDisplayString(_ctx.t('None')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_746, _toDisplayString(_ctx.t('Solid')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_747, _toDisplayString(_ctx.t('Dashed')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_748, _toDisplayString(_ctx.t('Dotted')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_749, _toDisplayString(_ctx.t('Double')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.fprops.border]
                  ])
                ]),
                _createElementVNode("div", _hoisted_750, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Thickness (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0.25",
                    step: "0.25",
                    "onUpdate:modelValue": _cache[433] || (_cache[433] = $event => ((_ctx.fprops.borderWidth) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.borderWidth]
                  ])
                ]),
                _createElementVNode("div", _hoisted_751, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Line colour')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "color",
                    "onUpdate:modelValue": _cache[434] || (_cache[434] = $event => ((_ctx.fprops.borderColour) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.borderColour]
                  ])
                ]),
                _createElementVNode("div", _hoisted_752, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Corners (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    step: "1",
                    "onUpdate:modelValue": _cache[435] || (_cache[435] = $event => ((_ctx.fprops.radius) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.radius]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_753, [
                _createElementVNode("div", _hoisted_754, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Fill colour')), 1 /* TEXT */),
                  _createElementVNode("div", _hoisted_755, [
                    _createElementVNode("input", {
                      type: "color",
                      value: _ctx.fprops.fill || '#ffffff',
                      onInput: _cache[436] || (_cache[436] = $event => (_ctx.fprops.fill = $event.target.value))
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_756),
                    _createElementVNode("button", {
                      class: _normalizeClass(["eb-btn ghost", { on: !_ctx.fprops.fill }]),
                      onClick: _cache[437] || (_cache[437] = $event => (_ctx.fprops.fill = ''))
                    }, _toDisplayString(_ctx.t('Transparent')), 3 /* TEXT, CLASS */)
                  ])
                ]),
                _createElementVNode("div", _hoisted_757, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Opacity (%)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "10",
                    max: "100",
                    step: "5",
                    "onUpdate:modelValue": _cache[438] || (_cache[438] = $event => ((_ctx.fprops.opacity) = $event)),
                    placeholder: "100"
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.opacity]
                  ])
                ]),
                _createElementVNode("div", _hoisted_758, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Turn (degrees)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-180",
                    max: "180",
                    step: "5",
                    "onUpdate:modelValue": _cache[439] || (_cache[439] = $event => ((_ctx.fprops.rotate) = $event)),
                    placeholder: "0"
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.fprops.rotate]
                  ])
                ]),
                _createElementVNode("div", _hoisted_759, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Effects')), 1 /* TEXT */),
                  _createElementVNode("label", _hoisted_760, [
                    _withDirectives(_createElementVNode("input", {
                      type: "checkbox",
                      "onUpdate:modelValue": _cache[440] || (_cache[440] = $event => ((_ctx.fprops.shadow) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [_vModelCheckbox, _ctx.fprops.shadow]
                    ]),
                    _createTextVNode(" " + _toDisplayString(_ctx.t('Drop shadow')), 1 /* TEXT */)
                  ]),
                  _createElementVNode("label", _hoisted_761, [
                    _withDirectives(_createElementVNode("input", {
                      type: "checkbox",
                      "onUpdate:modelValue": _cache[441] || (_cache[441] = $event => ((_ctx.fprops.keep) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [_vModelCheckbox, _ctx.fprops.keep]
                    ]),
                    _createTextVNode(" " + _toDisplayString(_ctx.t('Do not split across pages')), 1 /* TEXT */)
                  ])
                ])
              ]),
              _createElementVNode("p", _hoisted_762, _toDisplayString(_ctx.t('Fill colours are printed: the file tells the browser to print them even when it would normally leave backgrounds out.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_763, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[442] || (_cache[442] = (...args) => (_ctx.clearFrameProps && _ctx.clearFrameProps(...args)))
              }, _toDisplayString(_ctx.t('Clear')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn",
                onClick: _cache[443] || (_cache[443] = $event => (_ctx.fpropsOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[444] || (_cache[444] = (...args) => (_ctx.applyFrameProps && _ctx.applyFrameProps(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    (_ctx.ctx.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 19,
          class: "eb-ctx-back",
          onMousedown: _cache[447] || (_cache[447] = _withModifiers(() => {}, ["prevent"])),
          onClick: _cache[448] || (_cache[448] = (...args) => (_ctx.closeCtxIfSettled && _ctx.closeCtxIfSettled(...args))),
          onTouchend: _cache[449] || (_cache[449] = _withModifiers((...args) => (_ctx.closeCtxIfSettled && _ctx.closeCtxIfSettled(...args)), ["prevent"])),
          onContextmenu: _cache[450] || (_cache[450] = _withModifiers((...args) => (_ctx.closeCtx && _ctx.closeCtx(...args)), ["prevent"]))
        }, null, 32 /* NEED_HYDRATION */))
      : _createCommentVNode("v-if", true),
    (_ctx.ctx.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 20,
          class: _normalizeClass(["eb-ctxmenu", { flip: _ctx.ctx.flip }]),
          style: _normalizeStyle({ left: _ctx.ctx.x + 'px', top: _ctx.ctx.y + 'px' }),
          onMousedown: _cache[555] || (_cache[555] = _withModifiers(() => {}, ["prevent"])),
          onContextmenu: _cache[556] || (_cache[556] = _withModifiers(() => {}, ["prevent"]))
        }, [
          _createElementVNode("button", {
            class: "ci",
            disabled: !_ctx.ctx.selection,
            onClick: _cache[451] || (_cache[451] = $event => (_ctx.ctxDo('cut')))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Cut')), 1 /* TEXT */),
            _hoisted_765
          ], 8 /* PROPS */, _hoisted_764),
          _createElementVNode("button", {
            class: "ci",
            disabled: !_ctx.ctx.selection,
            onClick: _cache[452] || (_cache[452] = $event => (_ctx.ctxDo('copy')))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Copy')), 1 /* TEXT */),
            _hoisted_767
          ], 8 /* PROPS */, _hoisted_766),
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[453] || (_cache[453] = $event => (_ctx.ctxDo('paste')))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Paste')), 1 /* TEXT */),
            _hoisted_768
          ]),
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[454] || (_cache[454] = $event => (_ctx.ctxDo('pasteText')))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Paste as plain text')), 1 /* TEXT */),
            _hoisted_769
          ]),
          _hoisted_770,
          (_ctx.ctx.link)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                _createElementVNode("button", {
                  class: "ci",
                  onClick: _cache[455] || (_cache[455] = $event => (_ctx.ctxDo('linkOpen')))
                }, _toDisplayString(_ctx.t('Open the link')), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "ci",
                  onClick: _cache[456] || (_cache[456] = $event => (_ctx.ctxDo('link')))
                }, _toDisplayString(_ctx.t('Edit the link…')), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "ci",
                  onClick: _cache[457] || (_cache[457] = $event => (_ctx.ctxDo('linkDel')))
                }, _toDisplayString(_ctx.t('Remove the link')), 1 /* TEXT */)
              ], 64 /* STABLE_FRAGMENT */))
            : (_openBlock(), _createElementBlock("button", {
                key: 1,
                class: "ci",
                onClick: _cache[458] || (_cache[458] = $event => (_ctx.ctxDo('link')))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Hyperlink…')), 1 /* TEXT */),
                _hoisted_771
              ])),
          _hoisted_772,
          _createElementVNode("div", {
            class: "ci has-sub",
            onMouseenter: _cache[466] || (_cache[466] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
            onClick: _cache[467] || (_cache[467] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Paragraph style')), 1 /* TEXT */),
            _hoisted_773,
            _createElementVNode("div", _hoisted_774, [
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[459] || (_cache[459] = $event => (_ctx.ctxDo('block','P')))
              }, _toDisplayString(_ctx.t('Body text')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[460] || (_cache[460] = $event => (_ctx.ctxDo('block','H1')))
              }, _toDisplayString(_ctx.t('Heading 1')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[461] || (_cache[461] = $event => (_ctx.ctxDo('block','H2')))
              }, _toDisplayString(_ctx.t('Heading 2')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[462] || (_cache[462] = $event => (_ctx.ctxDo('block','H3')))
              }, _toDisplayString(_ctx.t('Heading 3')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[463] || (_cache[463] = $event => (_ctx.ctxDo('block','H4')))
              }, _toDisplayString(_ctx.t('Heading 4')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[464] || (_cache[464] = $event => (_ctx.ctxDo('block','BLOCKQUOTE')))
              }, _toDisplayString(_ctx.t('Quotation')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[465] || (_cache[465] = $event => (_ctx.ctxDo('block','PRE')))
              }, _toDisplayString(_ctx.t('Preformatted')), 1 /* TEXT */)
            ])
          ], 32 /* NEED_HYDRATION */),
          _createElementVNode("div", {
            class: "ci has-sub",
            onMouseenter: _cache[481] || (_cache[481] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
            onClick: _cache[482] || (_cache[482] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Character')), 1 /* TEXT */),
            _hoisted_775,
            _createElementVNode("div", _hoisted_776, [
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[468] || (_cache[468] = $event => (_ctx.ctxDo('inline','bold')))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Bold')), 1 /* TEXT */),
                _hoisted_777
              ]),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[469] || (_cache[469] = $event => (_ctx.ctxDo('inline','italic')))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Italic')), 1 /* TEXT */),
                _hoisted_778
              ]),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[470] || (_cache[470] = $event => (_ctx.ctxDo('inline','underline')))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Underline')), 1 /* TEXT */),
                _hoisted_779
              ]),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[471] || (_cache[471] = $event => (_ctx.ctxDo('inline','strike')))
              }, _toDisplayString(_ctx.t('Strikethrough')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[472] || (_cache[472] = $event => (_ctx.ctxDo('inline','kenten')))
              }, _toDisplayString(_ctx.t('Emphasis dots')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[473] || (_cache[473] = $event => (_ctx.ctxDo('inline','sup')))
              }, _toDisplayString(_ctx.t('Superscript')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[474] || (_cache[474] = $event => (_ctx.ctxDo('inline','sub')))
              }, _toDisplayString(_ctx.t('Subscript')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[475] || (_cache[475] = $event => (_ctx.ctxDo('inline','code')))
              }, _toDisplayString(_ctx.t('Monospaced')), 1 /* TEXT */),
              _hoisted_780,
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[476] || (_cache[476] = $event => (_ctx.ctxDo('case','wide')))
              }, _toDisplayString(_ctx.t('To full width')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[477] || (_cache[477] = $event => (_ctx.ctxDo('case','narrow')))
              }, _toDisplayString(_ctx.t('To half width')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[478] || (_cache[478] = $event => (_ctx.ctxDo('case','upper')))
              }, _toDisplayString(_ctx.t('UPPER CASE')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[479] || (_cache[479] = $event => (_ctx.ctxDo('case','lower')))
              }, _toDisplayString(_ctx.t('lower case')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[480] || (_cache[480] = $event => (_ctx.ctxDo('case','title')))
              }, _toDisplayString(_ctx.t('Capitalise Each Word')), 1 /* TEXT */)
            ])
          ], 32 /* NEED_HYDRATION */),
          _createElementVNode("div", {
            class: "ci has-sub",
            onMouseenter: _cache[487] || (_cache[487] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
            onClick: _cache[488] || (_cache[488] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Alignment')), 1 /* TEXT */),
            _hoisted_781,
            _createElementVNode("div", _hoisted_782, [
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[483] || (_cache[483] = $event => (_ctx.ctxDo('align','left')))
              }, _toDisplayString(_ctx.t('Left')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[484] || (_cache[484] = $event => (_ctx.ctxDo('align','center')))
              }, _toDisplayString(_ctx.t('Centre')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[485] || (_cache[485] = $event => (_ctx.ctxDo('align','right')))
              }, _toDisplayString(_ctx.t('Right')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[486] || (_cache[486] = $event => (_ctx.ctxDo('align','justify')))
              }, _toDisplayString(_ctx.t('Justified')), 1 /* TEXT */)
            ])
          ], 32 /* NEED_HYDRATION */),
          _createElementVNode("div", {
            class: "ci has-sub",
            onMouseenter: _cache[493] || (_cache[493] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
            onClick: _cache[494] || (_cache[494] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('List')), 1 /* TEXT */),
            _hoisted_783,
            _createElementVNode("div", _hoisted_784, [
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[489] || (_cache[489] = $event => (_ctx.ctxDo('list','UL')))
              }, _toDisplayString(_ctx.t('Bulleted list')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[490] || (_cache[490] = $event => (_ctx.ctxDo('list','OL')))
              }, _toDisplayString(_ctx.t('Numbered list')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[491] || (_cache[491] = $event => (_ctx.ctxDo('indent',1)))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Increase indent')), 1 /* TEXT */),
                _hoisted_785
              ]),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[492] || (_cache[492] = $event => (_ctx.ctxDo('indent',-1)))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Decrease indent')), 1 /* TEXT */),
                _hoisted_786
              ])
            ])
          ], 32 /* NEED_HYDRATION */),
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[495] || (_cache[495] = $event => (_ctx.ctxDo('para')))
          }, _toDisplayString(_ctx.t('Paragraph settings…')), 1 /* TEXT */),
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[496] || (_cache[496] = $event => (_ctx.ctxDo('chars')))
          }, _toDisplayString(_ctx.t('Special character…')), 1 /* TEXT */),
          (_ctx.ctx.table)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                _hoisted_787,
                _createElementVNode("div", {
                  class: "ci has-sub",
                  onMouseenter: _cache[510] || (_cache[510] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                  onClick: _cache[511] || (_cache[511] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                }, [
                  _createElementVNode("span", null, _toDisplayString(_ctx.t('Table')), 1 /* TEXT */),
                  _hoisted_788,
                  _createElementVNode("div", _hoisted_789, [
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[497] || (_cache[497] = $event => (_ctx.ctxDo('table','rowAbove')))
                    }, _toDisplayString(_ctx.t('Insert a row above')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[498] || (_cache[498] = $event => (_ctx.ctxDo('table','rowBelow')))
                    }, _toDisplayString(_ctx.t('Insert a row below')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[499] || (_cache[499] = $event => (_ctx.ctxDo('table','colLeft')))
                    }, _toDisplayString(_ctx.t('Insert a column to the left')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[500] || (_cache[500] = $event => (_ctx.ctxDo('table','colRight')))
                    }, _toDisplayString(_ctx.t('Insert a column to the right')), 1 /* TEXT */),
                    _hoisted_790,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[501] || (_cache[501] = $event => (_ctx.ctxDo('table','rowDel')))
                    }, _toDisplayString(_ctx.t('Delete the row')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[502] || (_cache[502] = $event => (_ctx.ctxDo('table','colDel')))
                    }, _toDisplayString(_ctx.t('Delete the column')), 1 /* TEXT */),
                    _hoisted_791,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[503] || (_cache[503] = $event => (_ctx.ctxDo('merge')))
                    }, _toDisplayString(_ctx.t('Merge the cells')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[504] || (_cache[504] = $event => (_ctx.ctxDo('split')))
                    }, _toDisplayString(_ctx.t('Split the cell')), 1 /* TEXT */),
                    _hoisted_792,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[505] || (_cache[505] = $event => (_ctx.ctxDo('cellAlign','left')))
                    }, _toDisplayString(_ctx.t('Cell text left')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[506] || (_cache[506] = $event => (_ctx.ctxDo('cellAlign','center')))
                    }, _toDisplayString(_ctx.t('Cell text centred')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[507] || (_cache[507] = $event => (_ctx.ctxDo('cellAlign','right')))
                    }, _toDisplayString(_ctx.t('Cell text right')), 1 /* TEXT */),
                    _hoisted_793,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[508] || (_cache[508] = $event => (_ctx.ctxDo('table','header')))
                    }, _toDisplayString(_ctx.t('Header row')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[509] || (_cache[509] = $event => (_ctx.ctxDo('table','delete')))
                    }, _toDisplayString(_ctx.t('Delete the table')), 1 /* TEXT */)
                  ])
                ], 32 /* NEED_HYDRATION */)
              ], 64 /* STABLE_FRAGMENT */))
            : _createCommentVNode("v-if", true),
          (_ctx.ctx.image)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                _hoisted_794,
                _createElementVNode("div", {
                  class: "ci has-sub",
                  onMouseenter: _cache[524] || (_cache[524] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                  onClick: _cache[525] || (_cache[525] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                }, [
                  _createElementVNode("span", null, _toDisplayString(_ctx.t('Picture')), 1 /* TEXT */),
                  _hoisted_795,
                  _createElementVNode("div", _hoisted_796, [
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[512] || (_cache[512] = $event => (_ctx.ctxDo('image','eb-img-s')))
                    }, _toDisplayString(_ctx.t('Small')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[513] || (_cache[513] = $event => (_ctx.ctxDo('image','eb-img-m')))
                    }, _toDisplayString(_ctx.t('Medium')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[514] || (_cache[514] = $event => (_ctx.ctxDo('image','eb-img-l')))
                    }, _toDisplayString(_ctx.t('Large')), 1 /* TEXT */),
                    _hoisted_797,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[515] || (_cache[515] = $event => (_ctx.ctxDo('float','')))
                    }, _toDisplayString(_ctx.t('No text wrap')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[516] || (_cache[516] = $event => (_ctx.ctxDo('float','left')))
                    }, _toDisplayString(_ctx.t('Wrap text on the right')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[517] || (_cache[517] = $event => (_ctx.ctxDo('float','right')))
                    }, _toDisplayString(_ctx.t('Wrap text on the left')), 1 /* TEXT */),
                    _hoisted_798,
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: _ctx.ctxCaption === 'below' }]),
                      onClick: _cache[518] || (_cache[518] = $event => (_ctx.ctxDo('caption','below')))
                    }, _toDisplayString(_ctx.t('Caption under the picture')), 3 /* TEXT, CLASS */),
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: _ctx.ctxCaption === 'above' }]),
                      onClick: _cache[519] || (_cache[519] = $event => (_ctx.ctxDo('caption','above')))
                    }, _toDisplayString(_ctx.t('Caption over the picture')), 3 /* TEXT, CLASS */),
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: _ctx.ctxCaption === 'inside' }]),
                      onClick: _cache[520] || (_cache[520] = $event => (_ctx.ctxDo('caption','inside')))
                    }, _toDisplayString(_ctx.t('Caption inside the picture')), 3 /* TEXT, CLASS */),
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: _ctx.ctxCaption === 'none' }]),
                      onClick: _cache[521] || (_cache[521] = $event => (_ctx.ctxDo('caption','none')))
                    }, _toDisplayString(_ctx.t('No caption')), 3 /* TEXT, CLASS */),
                    _hoisted_799,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[522] || (_cache[522] = $event => (_ctx.ctxDo('alt')))
                    }, _toDisplayString(_ctx.t('Alternative text…')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[523] || (_cache[523] = $event => (_ctx.ctxDo('imageDel')))
                    }, _toDisplayString(_ctx.t('Delete the picture')), 1 /* TEXT */)
                  ])
                ], 32 /* NEED_HYDRATION */)
              ], 64 /* STABLE_FRAGMENT */))
            : _createCommentVNode("v-if", true),
          _createCommentVNode(" What a writer who knows LibreOffice reaches for when they right-click a\n         thing on the page: the wrap, the arrangement, the anchor, the size. "),
          (_ctx.ctx.frame || _ctx.ctx.text)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 4 }, [
                _hoisted_800,
                _createElementVNode("div", {
                  class: "ci has-sub",
                  onMouseenter: _cache[530] || (_cache[530] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                  onClick: _cache[531] || (_cache[531] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                }, [
                  _createElementVNode("span", null, _toDisplayString(_ctx.t('Wrap')), 1 /* TEXT */),
                  _hoisted_801,
                  _createElementVNode("div", _hoisted_802, [
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: _ctx.frame.wrap === 'none' }]),
                      onClick: _cache[526] || (_cache[526] = $event => (_ctx.ctxDo('wrapMode','none')))
                    }, _toDisplayString(_ctx.t('Above and below')), 3 /* TEXT, CLASS */),
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: _ctx.frame.wrap === 'left' }]),
                      onClick: _cache[527] || (_cache[527] = $event => (_ctx.ctxDo('wrapMode','left')))
                    }, _toDisplayString(_ctx.t('Words to its left')), 3 /* TEXT, CLASS */),
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: _ctx.frame.wrap === 'right' }]),
                      onClick: _cache[528] || (_cache[528] = $event => (_ctx.ctxDo('wrapMode','right')))
                    }, _toDisplayString(_ctx.t('Words to its right')), 3 /* TEXT, CLASS */),
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: _ctx.frame.wrap === 'through' }]),
                      onClick: _cache[529] || (_cache[529] = $event => (_ctx.ctxDo('wrapMode','through')))
                    }, _toDisplayString(_ctx.t('Words underneath it')), 3 /* TEXT, CLASS */)
                  ])
                ], 32 /* NEED_HYDRATION */),
                _createElementVNode("div", {
                  class: "ci has-sub",
                  onMouseenter: _cache[536] || (_cache[536] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                  onClick: _cache[537] || (_cache[537] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                }, [
                  _createElementVNode("span", null, _toDisplayString(_ctx.t('Arrange')), 1 /* TEXT */),
                  _hoisted_803,
                  _createElementVNode("div", _hoisted_804, [
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[532] || (_cache[532] = $event => (_ctx.ctxDo('frameFront')))
                    }, _toDisplayString(_ctx.t('Bring to front')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[533] || (_cache[533] = $event => (_ctx.ctxDo('stackStep',1)))
                    }, _toDisplayString(_ctx.t('Forward one')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[534] || (_cache[534] = $event => (_ctx.ctxDo('stackStep',-1)))
                    }, _toDisplayString(_ctx.t('Back one')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[535] || (_cache[535] = $event => (_ctx.ctxDo('frameBack')))
                    }, _toDisplayString(_ctx.t('Send to back')), 1 /* TEXT */)
                  ])
                ], 32 /* NEED_HYDRATION */),
                _createElementVNode("div", {
                  class: "ci has-sub",
                  onMouseenter: _cache[542] || (_cache[542] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                  onClick: _cache[543] || (_cache[543] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                }, [
                  _createElementVNode("span", null, _toDisplayString(_ctx.t('Align')), 1 /* TEXT */),
                  _hoisted_805,
                  _createElementVNode("div", _hoisted_806, [
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[538] || (_cache[538] = $event => (_ctx.ctxDo('frameAlign','eb-al-l')))
                    }, _toDisplayString(_ctx.t('Put the frame at the left margin')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[539] || (_cache[539] = $event => (_ctx.ctxDo('frameAlign','eb-al-c')))
                    }, _toDisplayString(_ctx.t('Centre the frame in the column')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[540] || (_cache[540] = $event => (_ctx.ctxDo('frameAlign','eb-al-r')))
                    }, _toDisplayString(_ctx.t('Put the frame at the right margin')), 1 /* TEXT */),
                    _hoisted_807,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[541] || (_cache[541] = $event => (_ctx.ctxDo('frameFit')))
                    }, _toDisplayString(_ctx.t('Make the frame the width of the column')), 1 /* TEXT */)
                  ])
                ], 32 /* NEED_HYDRATION */),
                _createElementVNode("div", {
                  class: "ci has-sub",
                  onMouseenter: _cache[546] || (_cache[546] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                  onClick: _cache[547] || (_cache[547] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                }, [
                  _createElementVNode("span", null, _toDisplayString(_ctx.t('Anchor')), 1 /* TEXT */),
                  _hoisted_808,
                  _createElementVNode("div", _hoisted_809, [
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: !_ctx.frame.free }]),
                      onClick: _cache[544] || (_cache[544] = $event => (_ctx.ctxDo('frameInFlow')))
                    }, _toDisplayString(_ctx.t('As character')), 3 /* TEXT, CLASS */),
                    _createElementVNode("button", {
                      class: _normalizeClass(["ci", { on: _ctx.frame.free }]),
                      onClick: _cache[545] || (_cache[545] = $event => (_ctx.ctxDo('frameToPage')))
                    }, _toDisplayString(_ctx.t('To paragraph')), 3 /* TEXT, CLASS */)
                  ])
                ], 32 /* NEED_HYDRATION */),
                _hoisted_810,
                _createElementVNode("button", {
                  class: "ci strong",
                  onClick: _cache[548] || (_cache[548] = $event => (_ctx.ctxDo('frameProps')))
                }, _toDisplayString(_ctx.t('Object properties…')), 1 /* TEXT */),
                (_ctx.ctx.frame)
                  ? (_openBlock(), _createElementBlock("button", {
                      key: 0,
                      class: "ci",
                      onClick: _cache[549] || (_cache[549] = $event => (_ctx.ctxDo('framePlain')))
                    }, _toDisplayString(_ctx.t('Clear the formatting inside')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                (_ctx.ctx.frame)
                  ? (_openBlock(), _createElementBlock("button", {
                      key: 1,
                      class: "ci",
                      onClick: _cache[550] || (_cache[550] = $event => (_ctx.ctxDo('frameDel')))
                    }, _toDisplayString(_ctx.t('Delete the frame')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true)
              ], 64 /* STABLE_FRAGMENT */))
            : _createCommentVNode("v-if", true),
          (_ctx.ctx.selection)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 5 }, [
                _hoisted_811,
                _createElementVNode("button", {
                  class: "ci strong",
                  onClick: _cache[551] || (_cache[551] = $event => (_ctx.ctxDo('runProps')))
                }, _toDisplayString(_ctx.t('Properties of the chosen words…')), 1 /* TEXT */)
              ], 64 /* STABLE_FRAGMENT */))
            : _createCommentVNode("v-if", true),
          _hoisted_812,
          (!_ctx.flow)
            ? (_openBlock(), _createElementBlock("button", {
                key: 6,
                class: "ci",
                onClick: _cache[552] || (_cache[552] = $event => (_ctx.ctxDo('guides')))
              }, _toDisplayString(_ctx.guides ? _ctx.t('Hide the margin boundaries') : _ctx.t('Show the margin boundaries')), 1 /* TEXT */))
            : _createCommentVNode("v-if", true),
          (!_ctx.flow)
            ? (_openBlock(), _createElementBlock("button", {
                key: 7,
                class: "ci",
                onClick: _cache[553] || (_cache[553] = $event => (_ctx.ctxDo('boxes')))
              }, _toDisplayString(_ctx.boxes ? _ctx.t('Hide the box round every object') : _ctx.t('Show the box round every object')), 1 /* TEXT */))
            : _createCommentVNode("v-if", true),
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[554] || (_cache[554] = $event => (_ctx.ctxDo('clear')))
          }, _toDisplayString(_ctx.t('Clear formatting')), 1 /* TEXT */)
        ], 38 /* CLASS, STYLE, NEED_HYDRATION */))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" The properties of a chosen run of words. Everything here is written on the\n       words themselves, so one letter can be dressed differently from the next. "),
    (_ctx.wordsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 21,
          class: "eb-modal-back",
          onClick: _cache[578] || (_cache[578] = $event => (_ctx.wordsOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(720px,100%)"},
            onClick: _cache[577] || (_cache[577] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Properties of the chosen words…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_813, [
              _createElementVNode("p", _hoisted_814, _toDisplayString(_ctx.t('“{words}” — what is set here is written on these words alone.', { words: _ctx.wordsSample })), 1 /* TEXT */),
              _createElementVNode("div", _hoisted_815, [
                _createElementVNode("div", _hoisted_816, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Typeface')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[557] || (_cache[557] = $event => ((_ctx.wordsFmt.family) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_817, _toDisplayString(_ctx.t('Unchanged')), 1 /* TEXT */),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontChoices, (f) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: f,
                        value: f
                      }, _toDisplayString(f), 9 /* TEXT, PROPS */, _hoisted_818))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.wordsFmt.family]
                  ])
                ]),
                _createElementVNode("div", _hoisted_819, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Size (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "4",
                    max: "300",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[558] || (_cache[558] = $event => ((_ctx.wordsFmt.size) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.wordsFmt.size]
                  ])
                ]),
                _createElementVNode("div", _hoisted_820, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Colour')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "color",
                    "onUpdate:modelValue": _cache[559] || (_cache[559] = $event => ((_ctx.wordsFmt.colour) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.wordsFmt.colour]
                  ])
                ]),
                _createElementVNode("div", _hoisted_821, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Highlight')), 1 /* TEXT */),
                  _createElementVNode("div", _hoisted_822, [
                    _withDirectives(_createElementVNode("input", {
                      type: "color",
                      "onUpdate:modelValue": _cache[560] || (_cache[560] = $event => ((_ctx.wordsFmt.fill) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [_vModelText, _ctx.wordsFmt.fill]
                    ]),
                    _createElementVNode("button", {
                      class: "eb-btn",
                      onClick: _cache[561] || (_cache[561] = $event => (_ctx.wordsFmt.fill = ''))
                    }, _toDisplayString(_ctx.t('None')), 1 /* TEXT */)
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_823, [
                _createElementVNode("div", _hoisted_824, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Weight and slope')), 1 /* TEXT */),
                  _createElementVNode("label", _hoisted_825, [
                    _withDirectives(_createElementVNode("input", {
                      type: "checkbox",
                      "onUpdate:modelValue": _cache[562] || (_cache[562] = $event => ((_ctx.wordsFmt.bold) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [_vModelCheckbox, _ctx.wordsFmt.bold]
                    ]),
                    _createTextVNode(" " + _toDisplayString(_ctx.t('Bold')), 1 /* TEXT */)
                  ]),
                  _createElementVNode("label", _hoisted_826, [
                    _withDirectives(_createElementVNode("input", {
                      type: "checkbox",
                      "onUpdate:modelValue": _cache[563] || (_cache[563] = $event => ((_ctx.wordsFmt.italic) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [_vModelCheckbox, _ctx.wordsFmt.italic]
                    ]),
                    _createTextVNode(" " + _toDisplayString(_ctx.t('Italic')), 1 /* TEXT */)
                  ])
                ]),
                _createElementVNode("div", _hoisted_827, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Lines')), 1 /* TEXT */),
                  _createElementVNode("label", _hoisted_828, [
                    _withDirectives(_createElementVNode("input", {
                      type: "checkbox",
                      "onUpdate:modelValue": _cache[564] || (_cache[564] = $event => ((_ctx.wordsFmt.underline) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [_vModelCheckbox, _ctx.wordsFmt.underline]
                    ]),
                    _createTextVNode(" " + _toDisplayString(_ctx.t('Underline')), 1 /* TEXT */)
                  ]),
                  _createElementVNode("label", _hoisted_829, [
                    _withDirectives(_createElementVNode("input", {
                      type: "checkbox",
                      "onUpdate:modelValue": _cache[565] || (_cache[565] = $event => ((_ctx.wordsFmt.strike) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [_vModelCheckbox, _ctx.wordsFmt.strike]
                    ]),
                    _createTextVNode(" " + _toDisplayString(_ctx.t('Strikethrough')), 1 /* TEXT */)
                  ])
                ]),
                _createElementVNode("div", _hoisted_830, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Raised or lowered')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[566] || (_cache[566] = $event => ((_ctx.wordsFmt.raise) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_831, _toDisplayString(_ctx.t('On the line')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_832, _toDisplayString(_ctx.t('Raised')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_833, _toDisplayString(_ctx.t('Lowered')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.wordsFmt.raise]
                  ])
                ]),
                _createElementVNode("div", _hoisted_834, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Letter spacing (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-5",
                    max: "30",
                    step: "0.1",
                    "onUpdate:modelValue": _cache[567] || (_cache[567] = $event => ((_ctx.wordsFmt.spacing) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.wordsFmt.spacing]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_835, [
                _createElementVNode("div", _hoisted_836, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Outline (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "3",
                    step: "0.05",
                    "onUpdate:modelValue": _cache[568] || (_cache[568] = $event => ((_ctx.wordsFmt.strokeWidth) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.wordsFmt.strokeWidth]
                  ])
                ]),
                _createElementVNode("div", _hoisted_837, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Outline colour')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "color",
                    "onUpdate:modelValue": _cache[569] || (_cache[569] = $event => ((_ctx.wordsFmt.strokeColour) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.wordsFmt.strokeColour]
                  ])
                ]),
                _createElementVNode("div", _hoisted_838, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Shadow under the letters')), 1 /* TEXT */),
                  _createElementVNode("label", _hoisted_839, [
                    _withDirectives(_createElementVNode("input", {
                      type: "checkbox",
                      "onUpdate:modelValue": _cache[570] || (_cache[570] = $event => ((_ctx.wordsFmt.shadow) = $event))
                    }, null, 512 /* NEED_PATCH */), [
                      [_vModelCheckbox, _ctx.wordsFmt.shadow]
                    ]),
                    _createTextVNode(" " + _toDisplayString(_ctx.t('On')), 1 /* TEXT */)
                  ])
                ]),
                _createElementVNode("div", _hoisted_840, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Across (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-20",
                    max: "20",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[571] || (_cache[571] = $event => ((_ctx.wordsFmt.shadowX) = $event)),
                    disabled: !_ctx.wordsFmt.shadow
                  }, null, 8 /* PROPS */, _hoisted_841), [
                    [_vModelText, _ctx.wordsFmt.shadowX]
                  ])
                ]),
                _createElementVNode("div", _hoisted_842, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Down (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-20",
                    max: "20",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[572] || (_cache[572] = $event => ((_ctx.wordsFmt.shadowY) = $event)),
                    disabled: !_ctx.wordsFmt.shadow
                  }, null, 8 /* PROPS */, _hoisted_843), [
                    [_vModelText, _ctx.wordsFmt.shadowY]
                  ])
                ]),
                _createElementVNode("div", _hoisted_844, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Softness (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "30",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[573] || (_cache[573] = $event => ((_ctx.wordsFmt.shadowBlur) = $event)),
                    disabled: !_ctx.wordsFmt.shadow
                  }, null, 8 /* PROPS */, _hoisted_845), [
                    [_vModelText, _ctx.wordsFmt.shadowBlur]
                  ])
                ]),
                _createElementVNode("div", _hoisted_846, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Shadow colour')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "color",
                    "onUpdate:modelValue": _cache[574] || (_cache[574] = $event => ((_ctx.wordsFmt.shadowColour) = $event)),
                    disabled: !_ctx.wordsFmt.shadow
                  }, null, 8 /* PROPS */, _hoisted_847), [
                    [_vModelText, _ctx.wordsFmt.shadowColour]
                  ])
                ])
              ])
            ]),
            _createElementVNode("div", _hoisted_848, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[575] || (_cache[575] = $event => (_ctx.wordsOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[576] || (_cache[576] = (...args) => (_ctx.applyRunProps && _ctx.applyRunProps(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" paragraph properties, written as inline styles so the file carries them "),
    (_ctx.paraOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 22,
          class: "eb-modal-back",
          onClick: _cache[601] || (_cache[601] = $event => (_ctx.paraOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(580px,100%)"},
            onClick: _cache[600] || (_cache[600] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Paragraph settings…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_849, [
              _createElementVNode("div", _hoisted_850, [
                _createElementVNode("div", _hoisted_851, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Alignment')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[579] || (_cache[579] = $event => ((_ctx.para.align) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_852, _toDisplayString(_ctx.t('Unchanged')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_853, _toDisplayString(_ctx.t('Left')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_854, _toDisplayString(_ctx.t('Centre')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_855, _toDisplayString(_ctx.t('Right')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_856, _toDisplayString(_ctx.t('Justified')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.para.align]
                  ])
                ]),
                _createElementVNode("div", _hoisted_857, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Line height')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "4",
                    step: "0.05",
                    "onUpdate:modelValue": _cache[580] || (_cache[580] = $event => ((_ctx.para.lineHeight) = $event)),
                    placeholder: _ctx.t('From the paper setup')
                  }, null, 8 /* PROPS */, _hoisted_858), [
                    [_vModelText, _ctx.para.lineHeight]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_859, [
                _createElementVNode("div", _hoisted_860, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space above (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[581] || (_cache[581] = $event => ((_ctx.para.before) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.before]
                  ])
                ]),
                _createElementVNode("div", _hoisted_861, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space below (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[582] || (_cache[582] = $event => ((_ctx.para.after) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.after]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_862, [
                _createElementVNode("div", _hoisted_863, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Indent left (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-100",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[583] || (_cache[583] = $event => ((_ctx.para.left) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.left]
                  ])
                ]),
                _createElementVNode("div", _hoisted_864, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Indent right (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-100",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[584] || (_cache[584] = $event => ((_ctx.para.right) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.right]
                  ])
                ]),
                _createElementVNode("div", _hoisted_865, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('First line (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-100",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[585] || (_cache[585] = $event => ((_ctx.para.firstLine) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.firstLine]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_866, [
                _createElementVNode("div", _hoisted_867, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Rule round the paragraph')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[586] || (_cache[586] = $event => ((_ctx.para.border) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_868, _toDisplayString(_ctx.t('None')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_869, _toDisplayString(_ctx.t('Solid')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_870, _toDisplayString(_ctx.t('Dashed')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_871, _toDisplayString(_ctx.t('Dotted')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_872, _toDisplayString(_ctx.t('Double')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.para.border]
                  ])
                ]),
                _createElementVNode("div", _hoisted_873, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('On which edges')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[587] || (_cache[587] = $event => ((_ctx.para.borderSides) = $event)),
                    disabled: !_ctx.para.border
                  }, [
                    _createElementVNode("option", _hoisted_875, _toDisplayString(_ctx.t('All four')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_876, _toDisplayString(_ctx.t('Above')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_877, _toDisplayString(_ctx.t('Below')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_878, _toDisplayString(_ctx.t('Above and below')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_879, _toDisplayString(_ctx.t('At the left')), 1 /* TEXT */)
                  ], 8 /* PROPS */, _hoisted_874), [
                    [_vModelSelect, _ctx.para.borderSides]
                  ])
                ]),
                _createElementVNode("div", _hoisted_880, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Thickness (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0.25",
                    step: "0.25",
                    "onUpdate:modelValue": _cache[588] || (_cache[588] = $event => ((_ctx.para.borderWidth) = $event)),
                    disabled: !_ctx.para.border
                  }, null, 8 /* PROPS */, _hoisted_881), [
                    [_vModelText, _ctx.para.borderWidth]
                  ])
                ]),
                _createElementVNode("div", _hoisted_882, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Line colour')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "color",
                    "onUpdate:modelValue": _cache[589] || (_cache[589] = $event => ((_ctx.para.borderColour) = $event)),
                    disabled: !_ctx.para.border
                  }, null, 8 /* PROPS */, _hoisted_883), [
                    [_vModelText, _ctx.para.borderColour]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_884, [
                _createElementVNode("div", _hoisted_885, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Shading')), 1 /* TEXT */),
                  _createElementVNode("div", _hoisted_886, [
                    _createElementVNode("input", {
                      type: "color",
                      value: _ctx.para.fill || '#ffffff',
                      onInput: _cache[590] || (_cache[590] = $event => (_ctx.para.fill = $event.target.value))
                    }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_887),
                    _createElementVNode("button", {
                      class: "eb-btn ghost",
                      onClick: _cache[591] || (_cache[591] = $event => (_ctx.para.fill = ''))
                    }, _toDisplayString(_ctx.t('None')), 1 /* TEXT */)
                  ])
                ]),
                _createElementVNode("div", _hoisted_888, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Inner margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "40",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[592] || (_cache[592] = $event => ((_ctx.para.pad) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.pad]
                  ])
                ])
              ]),
              _createElementVNode("label", _hoisted_889, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[593] || (_cache[593] = $event => ((_ctx.para.pageBefore) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.para.pageBefore]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Start a new page before this paragraph')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_890, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[594] || (_cache[594] = $event => ((_ctx.para.keepWithNext) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.para.keepWithNext]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Keep with the next paragraph')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_891, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[595] || (_cache[595] = $event => ((_ctx.para.keepTogether) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.para.keepTogether]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Do not split this paragraph across pages')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_892, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[596] || (_cache[596] = $event => ((_ctx.para.noLoneLines) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.para.noLoneLines]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Never leave one line of it alone on a page')), 1 /* TEXT */)
              ]),
              _createElementVNode("p", _hoisted_893, _toDisplayString(_ctx.t('Empty means the paragraph inherits from the paper setup. These are written into the file as ordinary CSS, so a browser prints them the same way.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_894, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[597] || (_cache[597] = (...args) => (_ctx.clearPara && _ctx.clearPara(...args)))
              }, _toDisplayString(_ctx.t('Reset')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[598] || (_cache[598] = $event => (_ctx.paraOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[599] || (_cache[599] = (...args) => (_ctx.applyPara && _ctx.applyPara(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" a table of contents, as links rather than page numbers "),
    (_ctx.tocOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 23,
          class: "eb-modal-back",
          onClick: _cache[607] || (_cache[607] = $event => (_ctx.tocOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(520px,100%)"},
            onClick: _cache[606] || (_cache[606] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Table of contents…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_895, [
              _createElementVNode("div", _hoisted_896, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Title')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[602] || (_cache[602] = $event => ((_ctx.tocTitle) = $event)),
                  onKeydown: _cache[603] || (_cache[603] = _withKeys(_withModifiers((...args) => (_ctx.applyToc && _ctx.applyToc(...args)), ["prevent"]), ["enter"]))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelText, _ctx.tocTitle]
                ])
              ]),
              _createElementVNode("p", _hoisted_897, _toDisplayString(_ctx.t('Built from the headings in the document, as links to them. Running it again brings an existing contents list up to date.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_898, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[604] || (_cache[604] = $event => (_ctx.tocOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[605] || (_cache[605] = (...args) => (_ctx.applyToc && _ctx.applyToc(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" characters that are awkward to type "),
    (_ctx.charsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 24,
          class: "eb-modal-back",
          onClick: _cache[610] || (_cache[610] = $event => (_ctx.charsOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(620px,100%)"},
            onClick: _cache[609] || (_cache[609] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Special character…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_899, [
              _createElementVNode("div", _hoisted_900, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.charSets, (c) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: c.key,
                    class: _normalizeClass(["chip", { on: _ctx.charSet === c.key }]),
                    onClick: $event => (_ctx.charSet = c.key)
                  }, _toDisplayString(_ctx.t(c.key)), 11 /* TEXT, CLASS, PROPS */, _hoisted_901))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("div", _hoisted_902, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.charsOf(_ctx.charSet), (ch, i) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: i,
                    class: "eb-charcell",
                    onClick: $event => (_ctx.pickChar(ch))
                  }, _toDisplayString(ch), 9 /* TEXT, PROPS */, _hoisted_903))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("p", _hoisted_904, _toDisplayString(_ctx.t('The character goes in at the caret. The dialog stays open so several can be picked.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_905, [
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[608] || (_cache[608] = $event => (_ctx.charsOpen = false))
              }, _toDisplayString(_ctx.t('Close')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" a hyperlink "),
    (_ctx.webOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 25,
          class: "eb-modal-back",
          onClick: _cache[616] || (_cache[616] = $event => (_ctx.webOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(560px,100%)"},
            onClick: _cache[615] || (_cache[615] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Bring in a web page…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_906, [
              _createElementVNode("div", _hoisted_907, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Address')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[611] || (_cache[611] = $event => ((_ctx.webUrl) = $event)),
                  placeholder: "https://example.org/page",
                  onKeydown: _cache[612] || (_cache[612] = _withKeys(_withModifiers((...args) => (_ctx.fetchWebPage && _ctx.fetchWebPage(...args)), ["prevent"]), ["enter"]))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelText, _ctx.webUrl]
                ])
              ]),
              _createElementVNode("p", _hoisted_908, _toDisplayString(_ctx.t('The writing on the page is brought in: headings, paragraphs, lists, tables and pictures. Navigation, sidebars and advertising are left behind. Copying a page and pasting it here does the same thing.')), 1 /* TEXT */),
              (_ctx.webBusy)
                ? (_openBlock(), _createElementBlock("p", _hoisted_909, _toDisplayString(_ctx.t('Fetching…')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("div", _hoisted_910, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[613] || (_cache[613] = $event => (_ctx.webOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                disabled: _ctx.webBusy || !_ctx.webUrl,
                onClick: _cache[614] || (_cache[614] = (...args) => (_ctx.fetchWebPage && _ctx.fetchWebPage(...args)))
              }, _toDisplayString(_ctx.t('Bring it in')), 9 /* TEXT, PROPS */, _hoisted_911)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    (_ctx.linkOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 26,
          class: "eb-modal-back",
          onClick: _cache[624] || (_cache[624] = $event => (_ctx.linkOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(520px,100%)"},
            onClick: _cache[623] || (_cache[623] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.link.editing ? _ctx.t('Edit the link…') : _ctx.t('Hyperlink…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_912, [
              _createElementVNode("div", _hoisted_913, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Text')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[617] || (_cache[617] = $event => ((_ctx.link.text) = $event)),
                  placeholder: _ctx.t('The words that carry the link')
                }, null, 8 /* PROPS */, _hoisted_914), [
                  [_vModelText, _ctx.link.text]
                ])
              ]),
              _createElementVNode("div", _hoisted_915, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Address')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[618] || (_cache[618] = $event => ((_ctx.link.url) = $event)),
                  placeholder: "example.org/page",
                  onKeydown: _cache[619] || (_cache[619] = _withKeys(_withModifiers((...args) => (_ctx.applyLinkDialog && _ctx.applyLinkDialog(...args)), ["prevent"]), ["enter"]))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelText, _ctx.link.url]
                ])
              ]),
              _createElementVNode("p", _hoisted_916, _toDisplayString(_ctx.t('A bare address becomes https://, and an e-mail address becomes a mailto: link.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_917, [
              (_ctx.link.editing)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 0,
                    class: "eb-btn ghost",
                    onClick: _cache[620] || (_cache[620] = $event => {_ctx.linkOpen = false; _ctx.ctxDo('linkDel')})
                  }, _toDisplayString(_ctx.t('Remove the link')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[621] || (_cache[621] = $event => (_ctx.linkOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[622] || (_cache[622] = (...args) => (_ctx.applyLinkDialog && _ctx.applyLinkDialog(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" what a reader hears in place of the picture "),
    (_ctx.altOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 27,
          class: "eb-modal-back",
          onClick: _cache[630] || (_cache[630] = $event => (_ctx.altOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(520px,100%)"},
            onClick: _cache[629] || (_cache[629] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Alternative text…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_918, [
              _createElementVNode("div", _hoisted_919, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Alternative text')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[625] || (_cache[625] = $event => ((_ctx.altText) = $event)),
                  onKeydown: _cache[626] || (_cache[626] = _withKeys(_withModifiers((...args) => (_ctx.applyAlt && _ctx.applyAlt(...args)), ["prevent"]), ["enter"]))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelText, _ctx.altText]
                ])
              ]),
              _createElementVNode("p", _hoisted_920, _toDisplayString(_ctx.t('This is what a screen reader says, and what shows if the picture cannot be loaded. It is written into the file as the alt attribute.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_921, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[627] || (_cache[627] = $event => (_ctx.altOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[628] || (_cache[628] = (...args) => (_ctx.applyAlt && _ctx.applyAlt(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    (_ctx.toast)
      ? (_openBlock(), _createElementBlock("div", _hoisted_922, _toDisplayString(_ctx.toast), 1 /* TEXT */))
      : _createCommentVNode("v-if", true)
  ], 2 /* CLASS */))
}
})();

  const app = createApp({
    render,
    data() {
      return {
        version: '',
        logo: LOGO,
        icons: ICONS,
        sideOpen: true,
        narrow: false,
        zoomSetByHand: false,
        flow: false,
        flowPref: {},
        zoom: 100,
        menu: '',
        pageCount: 1,
        fontsOpen: false,
        fontRole: 'body',
        fontQuery: '',
        fontCat: 'all',
        fontScript: 'auto',
        fontPage: 1,
        fontsLoading: false,
        fontList: [],
        fontScripts: [],
        docs: [],
        doc: { id: 0, name: '', title: '', paper: normalisePaper(null), styles: normaliseStyles(null), lang: 'ja', foreign: false },
        stylesOpen: false, styleKey: 'h2',
        dirty: false,
        saving: false,
        savedAt: 0,
        settings: { folder: 'EditBase', theme: 'auto', language: 'auto', languages: [] },
        autosave: true,
        guides: true,
        colour: '#111111',
        counts: 0,
        fmt: { block: 'P', align: '', list: '', size: null, family: '', marker: '', ruby: false },
        rubyOpen: false, rubyWord: '', rubyText: '',
        noteOpen: false, noteText: '',
        colsOpen: false, cols: { count: 2, gap: 8 },
        runOpen: false,
        brush: null,
        toast: '',
        build: '', newBuild: false,
        layersOpen: false, layers: [],
        previewOpen: false, preview: [], pageNow: 1,
        wordsOpen: false, wordsSample: '',
        wordsFmt: { family: '', size: '', colour: '#000000', fill: '', bold: false, italic: false,
          underline: false, strike: false, spacing: '', raise: '',
          strokeWidth: '', strokeColour: '#000000',
          shadow: false, shadowX: 1, shadowY: 1, shadowBlur: 1.5, shadowColour: '#808080' },
        menuOpen: false, paperOpen: false, tableOpen: false, mathOpen: false,
        settingsOpen: false, hlOpen: false, boxOpen: false, ruleOpen: false,
        // The file as text, and the panel that reads another app on this server:
        // two dialogues, two names. They shared one for a while, and opening either
        // put both on the screen.
        htmlOpen: false,
        htmlText: '',
        defaultPaper: normalisePaper(null),
        ctx: { open: false, x: 0, y: 0, flip: false, table: false, image: false, captionPlace: '', link: false, list: false, selection: false, frame: false, text: false },
        frame: { on: false, x: 0, y: 0, w: 0, h: 0, padX: 0, padY: 0, free: false, wrap: '', drop: -1, kind: '', bar: false, dragging: false, mm: '', grips: [], gx: null, gy: null, extras: [] },
        coarse: false,
        ruler: true,
        ind: { left: 0, right: 0, first: 0 },
        review: false, showChanges: true, changes: 0,
        prevSettings: '',
        cropOpen: false, cropSrc: '',
        crop: { ratio: '', x: 50, y: 50 },
        cellBorderOpen: false,
        cellBorder: { style: 'solid', sides: 'all', width: 0.75, colour: '#666666' },
        tsel: { on: false, x: 0, y: 0, w: 0, h: 0, boxes: [] },
        fpropsOpen: false,
        fpropsRange: null,
        fprops: {
          place: '', x: '', y: '', width: '', height: '', mt: '', mb: '', ml: '', mr: '', pad: '',
          border: '', borderWidth: '', borderColour: '#666666', radius: '', fill: '', opacity: '', rotate: '', vpos: '', shadow: false, keep: false,
        },
        paraOpen: false,
        para: { align: '', lineHeight: '', before: '', after: '', left: '', right: '', firstLine: '', pageBefore: false, keepWithNext: false, keepTogether: false, noLoneLines: false,
          border: '', borderSides: 'all', borderWidth: '', borderColour: '#666666', fill: '', pad: '' },
        charsOpen: false,
        charSets: CHAR_SETS,
        charSet: 'Punctuation',
        tocOpen: false,
        tocTitle: '',
        spellcheck: false,
        autolink: true,
        palette: true, grid: false, boxes: true, pendingDrop: null,
        webOpen: false, webUrl: '', webBusy: false,
        linkOpen: false,
        link: { url: '', text: '', editing: false },
        altOpen: false,
        altText: '',
        find: { open: false, query: '', replace: '', hits: [], index: 0, caseSensitive: false },
        sources: {},
        sourceOpen: false,
        source: '',
        src: {
          loading: false, error: '', items: [], detail: null, query: '',
          collection: null, fields: [], records: [], selected: [],
          from: '', to: '', calendar: '', asTable: false, withHeader: true,
        },
        mergeOpen: false,
        merge: { source: '', keys: [], count: 0, busy: false, separate: false },
        pickerOpen: false,
        pasteObject: true,
        embedAsk: { open: false, items: [] },
        picker: { path: '', parent: null, entries: [], selected: null, loading: false, busy: false, error: '', mode: 'insert' },
        table: { rows: 3, cols: 3, header: true, variant: '' },
        math: { source: '', block: true },
        paperSizes: Object.keys(PAPERS),
      };
    },
    computed: {
      stateText() {
        if (this.saving) { return this.t('Saving…'); }
        if (!this.doc.id) { return ''; }
        if (this.dirty) { return this.t('Unsaved changes'); }
        return this.savedAt ? this.t('Saved {time}', { time: this.when(this.savedAt / 1000) }) : this.t('Saved');
      },
      paperStyle() {
        const p = normalisePaper(this.doc.paper);
        const s = sheet(p);
        const f = resolveFonts(p, this.doc.lang);
        const art = pageArt(p);
        return {
          '--eb-paper-w': s.w + 'mm',
          '--eb-paper-h': s.h + 'mm',
          '--eb-mt': p.margin.top + 'mm',
          '--eb-mr': p.margin.right + 'mm',
          '--eb-mb': p.margin.bottom + 'mm',
          '--eb-ml': p.margin.left + 'mm',
          '--eb-pageh': (s.h - p.margin.top - p.margin.bottom) + 'mm',
          '--eb-pageart': art.any ? 'url("' + art.url + '")' : 'none',
          '--eb-font-body': fontStack(f.body, 'serif'),
          '--eb-font-head': fontStack(f.head, 'sans'),
          '--eb-font-mono': fontStack(f.mono, 'mono'),
          // Reading size on screen only; the file keeps the paper's own size.
          fontSize: this.flow ? Math.max(16, Math.round(p.fontSize * 4 / 3)) + 'px' : p.fontSize + 'pt',
          lineHeight: String(p.lineHeight),
        };
      },
      mathPreview() { return sanitiseHtml(this.math.source); },
      fontsInUse() {
        const f = resolveFonts(normalisePaper(this.doc.paper), this.doc.lang);
        return { body: f.body, heading: f.head, mono: f.mono };
      },
      fontRoles() {
        return [
          { key: 'body', label: this.t('Body text') },
          { key: 'heading', label: this.t('Headings') },
          { key: 'mono', label: this.t('Preformatted') },
        ];
      },
      fontRoleLabel() {
        if (this.fontRole === 'selection') { return this.t('The text you have chosen'); }
        const r = this.fontRoles.find((x) => x.key === this.fontRole);
        return r ? r.label : '';
      },
      fontCats() {
        return [
          { key: 'all', label: this.t('All') },
          { key: 'serif', label: this.t('Serif') },
          { key: 'sans', label: this.t('Sans serif') },
          { key: 'display', label: this.t('Display') },
          { key: 'handwriting', label: this.t('Handwriting') },
          { key: 'mono', label: this.t('Monospace') },
        ];
      },
      docScript() { return scriptFor(this.doc.lang); },
      sourceKeys() { return Object.keys(this.sources).filter((k) => this.sources[k]); },
      anySource() { return this.sourceKeys.length > 0; },
      contactFields() { return ['name', 'family', 'given', 'org', 'title', 'email', 'tel', 'postcode', 'region', 'locality', 'street']; },
      mergeHint() {
        return this.t('This document has no merge fields yet. Put a field such as {example} into the text first.', { example: this.fieldTag('name') });
      },
      defaultFontName() {
        const def = defaultFonts(this.doc.lang);
        if (this.fontRole === 'mono') { return def.mono; }
        if (this.fontRole === 'heading') { return def.sans; }
        return def[this.doc.paper.font === 'sans' ? 'sans' : 'serif'];
      },
      fontResults() {
        const q = this.fontQuery.trim().toLowerCase();
        const script = this.fontScript === 'auto' ? this.docScript : this.fontScript;
        return this.fontList.filter((f) => {
          if (q && f.f.toLowerCase().indexOf(q) < 0) { return false; }
          if (this.fontCat !== 'all' && f.c !== this.fontCat) { return false; }
          if (this.fontScript !== 'all' && script && f.s.indexOf(script) < 0) { return false; }
          return true;
        });
      },
      fontPageItems() { return this.fontResults.slice(0, this.fontPage * 24); },
      /** Typefaces for the run dialogue: the ones the document already uses first. */
      /** The four ways the words can meet an object, with the picture of each. */
      wrapChoices() {
        return [
          { kind: 'none', label: this.t('Above and below'), icon: this.icons.wrapNone },
          { kind: 'left', label: this.t('Words to its left'), icon: this.icons.wrapRight },
          { kind: 'right', label: this.t('Words to its right'), icon: this.icons.wrapLeft },
          { kind: 'through', label: this.t('Words underneath it'), icon: this.icons.wrapThrough },
        ];
      },
      fontChoices() {
        const used = [];
        const c = canvas();
        if (c) {
          c.querySelectorAll('[style*="font-family"]').forEach((el) => {
            const f = (el.style.fontFamily || '').replace(/["']/g, '').split(',')[0].trim();
            if (f && used.indexOf(f) < 0) { used.push(f); }
          });
        }
        const rest = this.fontList.map((f) => f.f).filter((f) => used.indexOf(f) < 0);
        return used.concat(rest).slice(0, 200);
      },
      previewFamily() { return (this.fontRole === 'selection' ? this.fmt.family : this.doc.paper.fonts[this.fontRole]) || this.defaultFontName; },
      sampleText() {
        const samples = {
          japanese: 'あの日見た花の名前を僕達はまだ知らない。永字八法 1234567890',
          'chinese-simplified': '天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。1234567890',
          'chinese-traditional': '天地玄黃，宇宙洪荒。日月盈昃，辰宿列張。1234567890',
          korean: '다람쥐 헌 쳇바퀴에 타고파. 1234567890',
          arabic: 'نص حكيم له سر قاطع وذو شأن عظيم ١٢٣٤٥٦٧٨٩٠',
          hebrew: 'דג סקרן שט בים מאוכזב ולפתע מצא חברה 1234567890',
          devanagari: 'ऋषियों को सताने वाले दुष्ट राक्षसों के राजा रावण का 1234567890',
          thai: 'เป็นมนุษย์สุดประเสริฐเลิศคุณค่า ๑๒๓๔๕๖๗๘๙๐',
          cyrillic: 'Съешь же ещё этих мягких французских булок 1234567890',
          vietnamese: 'Do bạch kim rất quý nên sẽ dùng để lắp vô xe. 1234567890',
        };
        return samples[this.docScript] || 'The quick brown fox jumps over the lazy dog. 1234567890';
      },
      paperLabel() {
        const p = normalisePaper(this.doc.paper);
        const o = p.orientation === 'landscape' ? this.t('Landscape') : this.t('Portrait');
        return p.size + ' ' + o + ' · ' + p.margin.top + '/' + p.margin.right + '/' + p.margin.bottom + '/' + p.margin.left + ' mm';
      },
      highlights() {
        return [
          { key: 'mark', color: '#fff3a3', label: this.t('Yellow') },
          { key: 'mark-g', color: '#c9f2c7', label: this.t('Green') },
          { key: 'mark-b', color: '#cfe4ff', label: this.t('Blue') },
          { key: 'mark-p', color: '#f0d3fb', label: this.t('Purple') },
          { key: 'mark-r', color: '#ffd0d0', label: this.t('Red') },
        ];
      },
      aligns() {
        // Drawn rather than lettered: no font ships a dependable alignment glyph.
        const bars = (widths) => '<svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">'
          + widths.map((w, i) => '<rect x="' + w[0] + '" y="' + (1 + i * 3) + '" width="' + w[1] + '" height="1.6" rx=".8" fill="currentColor"/>').join('')
          + '</svg>';
        return [
          { cls: 'eb-al-l', icon: bars([[0, 16], [0, 10], [0, 14], [0, 8]]), label: this.t('Align left') },
          { cls: 'eb-al-c', icon: bars([[0, 16], [3, 10], [1, 14], [4, 8]]), label: this.t('Centre') },
          { cls: 'eb-al-r', icon: bars([[0, 16], [6, 10], [2, 14], [8, 8]]), label: this.t('Align right') },
          { cls: 'eb-al-j', icon: bars([[0, 16], [0, 16], [0, 16], [0, 16]]), label: this.t('Justify') },
        ];
      },
      fontSizes() { return FONT_SIZES; },
      rulerMm() {
        const p = normalisePaper(this.doc.paper);
        const s2 = sheet(p);
        return { w: s2.w, ml: p.margin.left, mr: p.margin.right, ticks: Math.floor(s2.w / 10) + 1 };
      },
      numberClass() {
        const out = [];
        const n = this.doc.paper.headingNumbers;
        if (n === 'decimal') { out.push('eb-hn'); }
        if (n === 'japanese') { out.push('eb-hn', 'eb-hn-ja'); }
        if (this.doc.paper.vertical) { out.push('eb-tategaki'); }
        if (!this.showChanges) { out.push('eb-clean'); }
        return out.join(' ');
      },
      tategaki() { return !!this.doc.paper.vertical; },
      cellFill() { return this.fmt.cellFill || ''; },
      styleTargets() {
        const names = {
          p: this.t('Body text'), h1: this.t('Heading 1'), h2: this.t('Heading 2'),
          h3: this.t('Heading 3'), h4: this.t('Heading 4'), li: this.t('List item'),
          blockquote: this.t('Quotation'), pre: this.t('Preformatted'),
          cell: this.t('Table text'), caption: this.t('Caption'),
        };
        return STYLE_TARGETS.map((t2) => ({ key: t2.key, label: names[t2.key] || t2.key }));
      },
      styleNow() {
        if (!this.doc.styles) { this.doc.styles = normaliseStyles(null); }
        if (!this.doc.styles[this.styleKey]) { this.doc.styles[this.styleKey] = Object.assign({}, EMPTY_STYLE); }
        return this.doc.styles[this.styleKey];
      },
      /** The three the document already uses, so the common choice is one click. */
      styleFamilies() {
        const f = this.fontsInUse;
        const out = [];
        [f.body, f.heading, f.mono].forEach((n) => { if (n && out.indexOf(n) < 0) { out.push(n); } });
        STYLE_TARGETS.forEach((t2) => {
          const n = this.doc.styles && this.doc.styles[t2.key] && this.doc.styles[t2.key].family;
          if (n && out.indexOf(n) < 0) { out.push(n); }
        });
        return out;
      },
      hasRunning() {
        const h = this.doc.paper.header || {};
        const f = this.doc.paper.footer || {};
        return !!(h.l || h.c || h.r || f.l || f.c || f.r);
      },
      listMarkers() {
        return [
          { type: 'disc', sample: '•', label: this.t('Disc') },
          { type: 'circle', sample: '◦', label: this.t('Circle') },
          { type: 'square', sample: '▪', label: this.t('Square') },
          { type: 'none', sample: '　', label: this.t('No marker') },
          { type: 'decimal', sample: '1.', label: this.t('1, 2, 3') },
          { type: 'decimal-leading-zero', sample: '01.', label: this.t('01, 02, 03') },
          { type: 'lower-alpha', sample: 'a.', label: this.t('a, b, c') },
          { type: 'upper-alpha', sample: 'A.', label: this.t('A, B, C') },
          { type: 'lower-roman', sample: 'i.', label: this.t('i, ii, iii') },
          { type: 'upper-roman', sample: 'I.', label: this.t('I, II, III') },
          { type: 'cjk-decimal', sample: '一、', label: this.t('One, two, three in kanji') },
          { type: 'cjk-ideographic', sample: '一、', label: this.t('Formal kanji numerals') },
          { type: 'katakana-iroha', sample: 'イ、', label: this.t('I, ro, ha in katakana') },
          { type: 'hiragana-iroha', sample: 'い、', label: this.t('I, ro, ha in hiragana') },
        ];
      },
      frameHandles() {
        if (this.frameIsWriting && !this.frame.free) { return ['e', 'w']; }
        return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      },
      /**
       * The bands along the edges are what an object is dragged by. Round writing
       * that is still in the flow they would lie over the line above and the line
       * below, and a click meant for the text would start a drag instead. Writing
       * is moved by writing; once it is placed freely it is moved like anything else.
       */
      frameEdges() {
        return this.frameIsWriting && !this.frame.free ? [] : ['t', 'r', 'b', 'l'];
      },
      /** Wrapping and free placement cannot both be true: CSS has only one answer. */
      freePlacement() { return this.fprops.place === 'free' && !this.fprops.wrap; },
      /** What the frame is, in the writer's words, for the bar and the dialogue. */
      /** Whether this object is a box with words in it, as against a table or a rule. */
      frameHoldsWords() {
        return ['SHAPE', 'FRAME', 'ASIDE', 'NOTE', 'TEXT', 'TEXTBOX',
          'PARA', 'HEADING', 'LIST', 'QUOTE', 'PRE', 'COLUMNS'].indexOf(this.frame.kind) >= 0;
      },
      /** Writing: a block that stands in the text rather than an object put on the page. */
      /** Where the caption of the picture under the pointer stands. */
      ctxCaption() { return this.ctx.open && this.ctx.image ? this.ctx.captionPlace : ''; },
      frameIsWriting() {
        return ['PARA', 'HEADING', 'LIST', 'QUOTE', 'PRE', 'COLUMNS'].indexOf(this.frame.kind) >= 0;
      },
      frameLabel() {
        const kind = this.frame.kind;
        const names = {
          FIGURE: this.t('Picture'), TABLE: this.t('Table'), ASIDE: this.t('Box'),
          NAV: this.t('Contents'), HR: this.t('Rule'), MATH: this.t('Formula'),
          NOTE: this.t('Note'), FRAME: this.t('Block frame'), TEXT: this.t('Phrase'),
          TEXTBOX: this.t('Text frame'),
          SHAPE: this.t('Shape'), EMBED: this.t('An embedded page'),
          PARA: this.t('Paragraph'), HEADING: this.t('Heading'), LIST: this.t('List'),
          QUOTE: this.t('Quotation'), PRE: this.t('Preformatted text'), COLUMNS: this.t('Column layout'),
        };
        return names[kind] || this.t('Frame');
      },
      /** What stands on the shelf beside the paper. */
      paletteItems() {
        return [{ kind: 'textbox', label: this.t('Text frame'), icon: this.icons.frame },
          { kind: 'frame', label: this.t('Block frame'), icon: this.icons.box },
          { kind: 'table', label: this.t('Insert table'), icon: this.icons.table },
          { kind: 'image', label: this.t('Insert picture'), icon: this.icons.image }]
          .concat(this.shapes.map((sh) => ({ kind: sh.kind, label: sh.label, icon: '<span class="eb-shape-icon">' + sh.icon + '</span>' })));
      },
      /** The shapes that can be put on a page, drawn in CSS rather than in a font. */
      shapes() {
        const box = (extra) => '<span class="sh" style="' + extra + '"></span>';
        return [
          { kind: 'rect', label: this.t('Rectangle'), icon: box('border:1.5px solid currentColor') },
          { kind: 'round', label: this.t('Rounded rectangle'), icon: box('border:1.5px solid currentColor;border-radius:4px') },
          { kind: 'ellipse', label: this.t('Ellipse'), icon: box('border:1.5px solid currentColor;border-radius:50%') },
          { kind: 'line', label: this.t('Line'), icon: box('border-top:1.5px solid currentColor;height:0;align-self:center') },
          { kind: 'arrow', label: this.t('Arrow'), icon: box('border-top:1.5px solid currentColor;height:0;align-self:center;position:relative') },
        ];
      },
      boxes() {
        return [
          { variant: '', icon: '▢', label: this.t('Rounded box') },
          { variant: 'sq', icon: '▭', label: this.t('Square box') },
          { variant: 'dashed', icon: '⬚', label: this.t('Dashed box') },
          { variant: 'tint', icon: '▩', label: this.t('Tinted box') },
          { variant: 'note', icon: '▎', label: this.t('Side bar note') },
        ];
      },
      rules() {
        return [
          { cls: '', icon: '―', label: this.t('Thin rule') },
          { cls: 'eb-rule-thick', icon: '━', label: this.t('Thick rule') },
          { cls: 'eb-rule-dashed', icon: '┅', label: this.t('Dashed rule') },
        ];
      },
      mathSnippets() {
        const m = (inner) => '<math xmlns="http://www.w3.org/1998/Math/MathML">' + inner + '</math>';
        return [
          { label: this.t('Fraction'), code: m('<mfrac><mi>a</mi><mi>b</mi></mfrac>') },
          { label: this.t('Power'), code: m('<msup><mi>x</mi><mn>2</mn></msup>') },
          { label: this.t('Square root'), code: m('<msqrt><mrow><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup></mrow></msqrt>') },
          { label: this.t('Sum'), code: m('<mrow><munderover><mo>&#x2211;</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><msub><mi>a</mi><mi>i</mi></msub></mrow>') },
          { label: this.t('Integral'), code: m('<mrow><msubsup><mo>&#x222B;</mo><mn>0</mn><mn>1</mn></msubsup><mi>f</mi><mo>(</mo><mi>x</mi><mo>)</mo><mi>d</mi><mi>x</mi></mrow>') },
          { label: this.t('Quadratic formula'), code: m('<mrow><mi>x</mi><mo>=</mo><mfrac><mrow><mo>&#x2212;</mo><mi>b</mi><mo>&#xB1;</mo><msqrt><mrow><msup><mi>b</mi><mn>2</mn></msup><mo>&#x2212;</mo><mn>4</mn><mi>a</mi><mi>c</mi></mrow></msqrt></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac></mrow>') },
        ];
      },
    },
    methods: {
      t: T,
      notify(msg) {
        this.toast = msg;
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { this.toast = ''; }, 2600);
      },
      when(ts) {
        if (!ts) { return ''; }
        const d = new Date(ts * 1000);
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        return sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
      },
      size(bytes) {
        const kb = (bytes || 0) / 1024;
        return kb < 1024 ? Math.max(1, Math.round(kb)) + ' KB' : (kb / 1024).toFixed(1) + ' MB';
      },

      // ---- documents ----
      async loadDocs() {
        try {
          const r = await api('documents');
          this.docs = r.documents || [];
        } catch (e) { this.notify(this.t('Could not read the document list: {msg}', { msg: e.message })); }
      },
      async newDoc() {
        const title = this.t('Untitled document');
        const paper = normalisePaper(this.defaultPaper);
        const body = '<p><br></p>';
        try {
          const created = await api('documents', { method: 'POST', body: { name: title, content: buildHtml({ title, paper, body, lang: this.docLang() }) } });
          await this.loadDocs();
          await this.openDoc(created.id);
          this.notify(this.t('Created {name}', { name: created.name }));
        } catch (e) { this.notify(this.t('Could not create the document: {msg}', { msg: e.message })); }
      },
      async openDoc(id) {
        if (this.narrow) { this.sideOpen = false; }
        if (this.dirty && this.doc.id && this.doc.id !== id) { await this.save(); }
        try {
          const d = await api('documents/' + id);
          const parsed = parseHtml(d.content);
          this.doc = {
            id: d.id, name: d.name, title: parsed.title || d.title,
            paper: parsed.paper, styles: parsed.styles, lang: parsed.lang, foreign: parsed.foreign, writable: d.writable,
          };
          // What the file itself carries decides whether the two switches are on:
          // the page's own header and footer are part of the document, not a
          // setting that could disagree with it.
          this.doc.paper.headerOn = parsed.hasHeader;
          this.doc.paper.footerOn = parsed.hasFooter;
          canvas().innerHTML = parsed.body || '<p><br></p>';
          normaliseCanvas(this.t('Page break'), this.t('Caption'));
          // A family the built-in list does not know needs the catalogue, or the
          // saved file would lose its stylesheet link on the next save.
          const chosen = Object.values(parsed.paper.fonts || {}).filter(Boolean);
          if (chosen.some((f) => !knownFont(f)) && !this.fontList.length) {
            loadFonts().then((cat) => {
              this.fontList = cat.families || [];
              this.fontScripts = cat.scripts || [];
              this.applyDocFonts();
            }).catch(() => { /* the fallback stack still renders */ });
          }
          this.applyDocStyles();
          history.reset();
          this.prevSettings = history.state();
          this.dirty = false;
          this.savedAt = (d.mtime || 0) * 1000;
          this.refreshState();
          this.recount();
          this.$nextTick(() => this.reflowWrap());
          if (window.innerWidth < 860) { this.sideOpen = false; }
          if (parsed.foreign) {
            this.notify(this.t('This file was not written by EditBase. Its own styles are replaced by the EditBase stylesheet when you save.'));
          }
        } catch (e) { this.notify(this.t('Could not open the document: {msg}', { msg: e.message })); }
      },
      /** The body as it goes into the file: editor-only marks taken back out. */
      exportBody() {
        const clone = canvas().cloneNode(true);
        clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
        clone.querySelectorAll('.eb-pagebreak').forEach((el) => el.removeAttribute('data-label'));
        clone.querySelectorAll('figcaption').forEach((el) => el.removeAttribute('data-ph'));
        clone.querySelectorAll('.eb-pagespacer').forEach((el) => el.remove());
        fillEmbeds(clone);
        // An empty paragraph holds its line in the editor, where contenteditable
        // gives it one; on a plain page it collapses to nothing and everything
        // below moves up. Give it the line break the editor was drawing for free.
        clone.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th')
          .forEach((el) => { if (!el.firstChild) { el.appendChild(document.createElement('br')); } });
        return stripEditorArtefacts(clone.innerHTML);
      },
      currentHtml(clean) {
        return buildHtml({
          clean: !!clean,
          title: this.doc.title || this.t('Untitled document'),
          paper: this.doc.paper,
          styles: this.doc.styles,
          lang: this.doc.lang,
          body: this.exportBody(),
        });
      },
      async save() {
        if (!this.doc.id || this.saving) { return; }
        this.saving = true;
        try {
          const saved = await api('documents/' + this.doc.id, { method: 'PUT', body: { content: this.currentHtml() } });
          this.dirty = false;
          this.doc.foreign = false;
          this.savedAt = Date.now();
          const row = this.docs.find((d) => d.id === saved.id);
          if (row) { row.mtime = saved.mtime; row.size = saved.size; }
        } catch (e) {
          this.notify(this.t('Could not save: {msg}', { msg: e.message }));
        } finally { this.saving = false; }
      },
      async applyTitle() {
        if (!this.doc.id) { return; }
        const title = (this.doc.title || '').trim() || this.t('Untitled document');
        this.doc.title = title;
        try {
          const r = await api('documents/' + this.doc.id + '/rename', { method: 'POST', body: { name: title } });
          this.doc.name = r.name;
          await this.save();
          await this.loadDocs();
        } catch (e) { this.notify(this.t('Could not rename: {msg}', { msg: e.message })); }
      },
      async duplicate() {
        this.menuOpen = false;
        if (!this.doc.id) { return; }
        await this.save();
        try {
          const copy = await api('documents/' + this.doc.id + '/duplicate', { method: 'POST' });
          await this.loadDocs();
          await this.openDoc(copy.id);
        } catch (e) { this.notify(this.t('Could not duplicate: {msg}', { msg: e.message })); }
      },
      async removeDoc() {
        this.menuOpen = false;
        if (!this.doc.id) { return; }
        if (!window.confirm(this.t('Move "{name}" to the trash?', { name: this.doc.name }))) { return; }
        try {
          await api('documents/' + this.doc.id, { method: 'DELETE' });
          const id = this.doc.id;
          this.doc = { id: 0, name: '', title: '', paper: normalisePaper(this.defaultPaper), lang: this.docLang(), foreign: false };
          canvas().innerHTML = '';
          this.dirty = false;
          await this.loadDocs();
          const next = this.docs[0];
          if (next && next.id !== id) { await this.openDoc(next.id); }
        } catch (e) { this.notify(this.t('Could not delete: {msg}', { msg: e.message })); }
      },
      download() {
        this.menuOpen = false;
        downloadHtml(this.doc.name || (this.doc.title + '.html'), this.currentHtml());
      },
      printDoc() {
        const paper = normalisePaper(this.doc.paper);
        // A browser leaves the paper's own colour out of a printout unless the
        // writer says otherwise, and the box that says so is in its own dialogue
        // where we cannot reach it. Say so at the moment of printing, or a page
        // that was decorated comes out of the printer plain white.
        if (pageArt(paper).any) {
          this.notify(this.t('Turn on “Background graphics” in the print dialogue, or the page’s colour and frame will not be printed.'));
        }
        printHtml(this.currentHtml(!this.showChanges), pageRule(paper));
      },
      showSource() {
        this.menuOpen = false;
        this.htmlText = this.currentHtml();
        this.htmlOpen = true;
      },

      // ---- editing ----
      touch() {
        this.dirty = true;
        this.scheduleAutosave();
      },
      scheduleAutosave() {
        clearTimeout(this._saveTimer);
        if (!this.autosave || !this.doc.id) { return; }
        this._saveTimer = setTimeout(() => { if (this.dirty) { this.save(); } }, 2500);
      },
      recount() {
        const c = canvas();
        this.counts = c ? c.textContent.replace(/\s/g, '').length : 0;
        this.repaginate();
      },
      /**
       * Lay the text over the sheets and keep the right number of sheets under it.
       * Runs on the next frame so the measurements are of the layout as it now is,
       * and once more afterwards because adding a sheet can change what fits.
       */
      repaginate() {
        if (!canvas()) { return; }
        if (this.flow) {
          // Take out the spacers the page view left behind, and stop measuring.
          Array.from(canvas().querySelectorAll('.eb-pagespacer')).forEach((n) => n.remove());
          this.pageCount = 1;
          return;
        }
        clearTimeout(this._pageTimer);
        this._pageTimer = setTimeout(() => {
          const pages = paginate();
          if (pages !== this.pageCount) {
            this.pageCount = pages;
            this.$nextTick(() => { this.pageCount = paginate(); });
          }
          this.syncFrame();
        }, 60);
      },
      refreshState() {
        if (!canvas()) { return; }
        const s = activeFormats();
        s.size = sizeAt(normalisePaper(this.doc.paper).fontSize);
        s.family = familyAt();
        const at = getRange();
        const list = at ? listAt(at.startContainer) : null;
        s.marker = list ? (list.style.listStyleType || (list.nodeName === 'OL' ? 'decimal' : 'disc')) : '';
        const cell = at ? cellAt(at.startContainer) : null;
        s.cellFill = cell ? (rgbToHex(cell.style.backgroundColor) || '') : '';
        const block = selectedBlocks(true)[0];
        this.ind = block ? {
          left: Number(numberIn(block.style.getPropertyValue('margin-left'), 'mm')) || 0,
          right: Number(numberIn(block.style.getPropertyValue('margin-right'), 'mm')) || 0,
          first: Number(numberIn(block.style.getPropertyValue('text-indent'), 'mm')) || 0,
        } : { left: 0, right: 0, first: 0 };
        s.ruby = !!(at && rubyAt(at.startContainer));
        s.change = !!(at && (insAt(at.startContainer) || delAt(at.startContainer)));
        this.changes = countChanges();
        this.fmt = s;
        this.syncFrame();
        const range = getRange();
        if (range) {
          const owner = ancestorWithStyle(range.startContainer.nodeType === 3 ? range.startContainer : (range.startContainer.firstChild || range.startContainer), 'color');
          if (owner) { this.colour = rgbToHex(owner.style.color) || this.colour; }
        }
      },
      run(fn) {
        // Toolbar buttons suppress mousedown so the selection survives the click;
        // focus() would still collapse it if the canvas had lost focus, so put the
        // range back afterwards.
        const c = canvas();
        const saved = getRange();
        const clone = saved ? saved.cloneRange() : null;
        if (document.activeElement !== c) {
          c.focus();
          if (clone) { selectRange(clone); }
        }
        command(fn, this.t('Page break'), this.t('Caption'));
        this.touch();
        this.refreshState();
        this.recount();
      },
      inline(key) { this.run(() => toggleInline(key)); },
      /** These act on the paragraph, so the box goes round the paragraph. */
      blockRun(fn) { this.run(fn); },
      setBlock(tag) { this.blockRun(() => setBlockType(tag)); },
      list(tag) { this.blockRun(() => toggleList(tag)); },
      align(cls) {
        // An object with its box up is what is being aligned -- not whatever
        // paragraph the caret was left in, somewhere else on the page. But when
        // the caret is in the frame's own text, the words in it are what is being
        // aligned, and the frame stays where it is.
        if (frameTaken && frameEl && !caretInside(frameEl)
          && this.alignObject(frameEl, cls)) { return; }
        this.blockRun(() => setBlockClass('align', cls));
      },
      indent(dir) { this.blockRun(() => stepIndent(dir)); },
      clearFmt() { this.run(() => clearFormatting()); },
      setColour(value) { this.colour = value; this.run(() => applyInlineStyle('color', value)); },
      clearColour() { this.run(() => applyInlineStyle('color', '')); },
      /**
       * Changing to a smaller paper keeps the margins it had, and 25mm of margin
       * on a 100mm postcard leaves 50mm to write in. No margin is allowed to eat
       * more than a quarter of the paper it is on.
       */
      setPaperSize(size) {
        this.doc.paper.size = size;
        const s2 = sheet(normalisePaper(this.doc.paper));
        const m = this.doc.paper.margin;
        // A card is not a letter: 20mm of margin on a 100mm postcard leaves 60mm
        // to write in, which is not what anyone means by a postcard.
        const small = s2.w < 150 || s2.h < 150;
        const capW = small ? 10 : Math.floor(s2.w / 4);
        const capH = small ? 10 : Math.floor(s2.h / 4);
        m.left = Math.min(m.left, capW);
        m.right = Math.min(m.right, capW);
        m.top = Math.min(m.top, capH);
        m.bottom = Math.min(m.bottom, capH);
        this.touchSettings();
      },
      /** A postcard has no letter to name it, so it is named in words. */
      paperName(key) {
        if (key === 'Postcard') { return this.t('Postcard (100 x 148)'); }
        if (key === 'Postcard2') { return this.t('Reply postcard (148 x 200)'); }
        // Which B this is matters: the ISO one is 6mm narrower.
        if (key === 'B4') { return this.t('B4 (JIS 257 x 364)'); }
        if (key === 'B5') { return this.t('B5 (JIS 182 x 257)'); }
        return key;
      },
      addTable() {
        const rows = Math.min(60, Math.max(1, this.table.rows || 1));
        const cols = Math.min(16, Math.max(1, this.table.cols || 1));
        this.tableOpen = false;
        this.run(() => insertTable(rows, cols, this.table.header, this.table.variant));
      },
      addBox(variant) {
        this.run(() => (variant === 'note' ? insertNote() : insertBox(variant)));
      },
      addRule(cls) { this.run(() => insertRule(cls)); },
      addPageBreak() { this.run(() => insertPageBreak(this.t('Page break'))); },
      openMath() {
        if (!this.math.source) { this.math.source = this.mathSnippets[0].code; }
        this.mathOpen = true;
      },
      async fetchWebPage() {
        const url = (this.webUrl || '').trim();
        if (!url || this.webBusy) { return; }
        this.webBusy = true;
        try {
          const got = await api('fetch?url=' + encodeURIComponent(/^https?:/i.test(url) ? url : 'https://' + url));
          this.webOpen = false;
          this.webUrl = '';
          const c = canvas();
          if (c) { c.focus(); }
          // The same road as the clipboard: what a page is made of that a
          // document cannot be made of is asked about, not thrown away.
          let out = {};
          this.run(() => { out = pasteHtmlAt(got.html || '', got.url || '', this.pasteObject); });
          if (out.made) {
            frameEl = out.made;
            frameMore = [];
            framePinned = true;
            frameTaken = true;
            this.frame.bar = true;
            this.settleFrame();
          }
          this.askAboutForeign(out.foreign);
        } catch (e) {
          this.notify(this.t('Could not read that page: {msg}', { msg: e.message }));
        } finally { this.webBusy = false; }
      },
      addMath() {
        const src = this.math.source;
        const block = this.math.block;
        try {
          this.mathOpen = false;
          this.run(() => insertMath(src, block));
        } catch (e) { this.notify(this.t('That is not valid MathML.')); }
      },
      // ---- typefaces ----
      fontPreviewStack(family) { return fontStack(family, 'sans'); },
      catLabel(c) {
        const m = this.fontCats.find((x) => x.key === c);
        return m ? m.label : c;
      },
      scriptLabel(code) {
        const names = {
          latin: this.t('Latin'), 'latin-ext': this.t('Latin (extended)'), cyrillic: this.t('Cyrillic'),
          'cyrillic-ext': this.t('Cyrillic (extended)'), greek: this.t('Greek'), 'greek-ext': this.t('Greek (extended)'),
          vietnamese: this.t('Vietnamese'), japanese: this.t('Japanese'), korean: this.t('Korean'),
          'chinese-simplified': this.t('Chinese (simplified)'), 'chinese-traditional': this.t('Chinese (traditional)'),
          'chinese-hongkong': this.t('Chinese (Hong Kong)'), arabic: this.t('Arabic'), hebrew: this.t('Hebrew'),
          devanagari: this.t('Devanagari'), bengali: this.t('Bengali'), tamil: this.t('Tamil'), telugu: this.t('Telugu'),
          thai: this.t('Thai'), khmer: this.t('Khmer'), myanmar: this.t('Burmese'), sinhala: this.t('Sinhala'),
          gujarati: this.t('Gujarati'), kannada: this.t('Kannada'), malayalam: this.t('Malayalam'),
          oriya: this.t('Odia'), gurmukhi: this.t('Gurmukhi'), armenian: this.t('Armenian'),
          georgian: this.t('Georgian'), ethiopic: this.t('Ethiopic'), math: this.t('Mathematics'), symbols: this.t('Symbols'),
        };
        return names[code] || code;
      },
      async openFonts(role) {
        // Choosing from the list puts the canvas out of focus, so where the text was
        // has to be remembered before the dialogue takes over.
        if (role === 'selection') { ctxRange = getRange() ? getRange().cloneRange() : null; }
        this.fontRole = role;
        this.fontsOpen = true;
        this.menu = '';
        this.fontQuery = '';
        this.fontPage = 1;
        this.fontCat = 'all';
        if (!this.fontList.length) {
          this.fontsLoading = true;
          try {
            const cat = await loadFonts();
            this.fontList = cat.families || [];
            this.fontScripts = cat.scripts || [];
          } catch (e) {
            this.notify(this.t('Could not load the font list: {msg}', { msg: e.message }));
          } finally { this.fontsLoading = false; }
        }
      },
      closeFonts() {
        this.fontsOpen = false;
        linkStylesheet('eb-font-preview', '');
      },
      chooseFont(family) {
        if (this.fontRole === 'selection') {
          if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the text moved on */ } }
          this.setFamily(family);
          ctxRange = getRange() ? getRange().cloneRange() : ctxRange;
          return;
        }
        this.doc.paper.fonts[this.fontRole] = family;
        this.applyDocFonts();
        this.touch();
      },
      /** Load the families this document uses, for the editor's own canvas. */
      /** The document's own styles, in a sheet of their own after the built-in one. */
      applyDocStyles() {
        const css = stylesCss(normaliseStyles(this.doc.styles), '#editbase-root ');
        let el = document.getElementById('eb-doc-styles');
        if (!el) {
          el = document.createElement('style');
          el.id = 'eb-doc-styles';
          document.head.appendChild(el);
        }
        el.textContent = css;
        this.applyDocFonts();
        this.$nextTick(() => this.repaginate());
      },
      applyDocFonts() {
        const f = resolveFonts(normalisePaper(this.doc.paper), this.doc.lang);
        const c = canvas();
        const named = c ? familiesInBody(c.innerHTML) : [];
        linkStylesheet('eb-doc-fonts', fontsUrl([f.body, f.head, f.mono].concat(named).concat(stylesFamilies(normaliseStyles(this.doc.styles)))));
        // Text set in the real typeface is a different height, so the pages have to
        // be laid out again once the fonts have actually loaded.
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => this.repaginate()).catch(() => { /* nothing to redo */ });
        }
      },
      /** Load just enough of each listed family to draw its own name. */
      loadPreviewFonts() {
        const names = this.fontPageItems.map((f) => f.f).slice(0, 24);
        if (!names.length) { linkStylesheet('eb-font-preview', ''); return; }
        const text = names.join('') + this.sampleText;
        linkStylesheet('eb-font-preview', fontsUrl(names, text.slice(0, 1200)));
      },

      toggleMenu(key) { this.menu = this.menu === key ? '' : key; },
      /** The toolbar's size box: the selection, or the block the caret is in. */
      setSize(pt) {
        if (pt === '' || pt == null) { this.run(() => styleTextOrBlock('fontSize', '')); return; }
        const v = Number(pt);
        if (!(v >= 4 && v <= 200)) { this.refreshState(); return; }
        this.run(() => styleTextOrBlock('fontSize', (Math.round(v * 2) / 2) + 'pt'));
      },
      stepSize(d) {
        const now = this.fmt.size || normalisePaper(this.doc.paper).fontSize;
        this.setSize(Math.min(200, Math.max(4, Math.round((Number(now) + d) * 2) / 2)));
      },
      /** The toolbar's typeface box, on the same terms. */
      setFamily(family) {
        this.run(() => styleTextOrBlock('fontFamily', family ? fontStack(family, 'sans') : ''));
        this.applyDocFonts();
      },
      stepZoom(d) { this.zoomSetByHand = true; this.zoom = Math.min(200, Math.max(25, this.zoom + d)); },
      clearHighlight() { this.run(() => clearMarks()); },
      // ---- the other apps on this server ----
      async loadSources() {
        try {
          const r = await api('sources');
          this.sources = r.sources || {};
        } catch (e) { this.sources = {}; }
      },
      fieldTag(key) { return '{' + '{' + key + '}' + '}'; },
      sourceLabel(key) {
        return {
          tables: this.t('Nextcloud Tables'), contacts: this.t('Contacts'), calendar: this.t('Calendar'),
          notes: this.t('Notes'), regibase: 'RegiBase', formulabase: 'FormulaBase',
        }[key] || key;
      },
      async openSource(key) {
        this.menu = '';
        this.source = key;
        this.sourceOpen = true;
        const today = new Date();
        const month = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        this.src = {
          loading: true, error: '', items: [], detail: null, query: '',
          collection: null, fields: [], records: [], selected: [],
          from: today.toISOString().slice(0, 10), to: month.toISOString().slice(0, 10),
          calendar: '', asTable: false, withHeader: true,
        };
        try {
          if (key === 'tables') { this.src.items = (await api('tables')).tables || []; }
          if (key === 'contacts') { this.src.items = (await api('contacts')).contacts || []; }
          if (key === 'regibase') { this.src.items = (await api('regibase/collections')).collections || []; }
          if (key === 'formulabase') { this.src.items = (await api('formulabase/collections')).collections || []; }
          if (key === 'calendar') {
            this.src.items = (await api('calendars')).calendars || [];
            await this.loadEvents();
          }
          if (key === 'notes') { this.src.items = await this.loadNotes(); }
        } catch (e) {
          this.src.error = e.message;
        } finally { this.src.loading = false; }
      },
      /** Notes has its own API on this same session; no server-side bridge needed. */
      async loadNotes() {
        const url = (window.OC && OC.generateUrl) ? OC.generateUrl('/apps/notes/api/v1/notes') : '/apps/notes/api/v1/notes';
        const res = await fetch(url, { credentials: 'same-origin', headers: { requesttoken: TOKEN } });
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        const body = await res.json();
        const list = Array.isArray(body) ? body : (body && Array.isArray(body.notesData) ? body.notesData : []);
        return list.filter((n) => n && n.id && !n.error);
      },
      async loadEvents() {
        this.src.loading = true;
        this.src.error = '';
        try {
          const q = 'from=' + encodeURIComponent(this.src.from) + '&to=' + encodeURIComponent(this.src.to)
            + (this.src.calendar ? '&calendar=' + encodeURIComponent(this.src.calendar) : '');
          this.src.records = (await api('calendar/events?' + q)).events || [];
        } catch (e) {
          this.src.error = e.message;
          this.src.records = [];
        } finally { this.src.loading = false; }
      },
      async searchContacts() {
        this.src.loading = true;
        try {
          this.src.items = (await api('contacts?q=' + encodeURIComponent(this.src.query))).contacts || [];
        } catch (e) { this.src.error = e.message; } finally { this.src.loading = false; }
      },
      async openCollection(item) {
        this.src.loading = true;
        this.src.error = '';
        try {
          if (this.source === 'tables') {
            this.src.detail = await api('tables/' + item.id);
          }
          if (this.source === 'regibase') {
            const r = await api('regibase/collections/' + item.id);
            this.src.collection = item;
            this.src.fields = r.fields || [];
            this.src.records = r.records || [];
          }
          if (this.source === 'formulabase') {
            this.src.collection = item;
            this.src.records = (await api('formulabase/collections/' + item.id + '/formulas')).formulas || [];
          }
        } catch (e) { this.src.error = e.message; } finally { this.src.loading = false; }
      },

      insertTableData() {
        const d = this.src.detail;
        if (!d) { return; }
        this.sourceOpen = false;
        this.run(() => {
          const table = tableFromRows(d.columns || [], d.rows || [], this.src.withHeader);
          insertBlockNode(table);
          const tail = document.createElement('p');
          tail.appendChild(document.createElement('br'));
          table.parentNode.insertBefore(tail, table.nextSibling);
          placeCaretIn(tail);
        });
      },
      /** A name-and-address block, laid out the way a letter wants it. */
      insertContact(person) {
        this.sourceOpen = false;
        const lines = [];
        if (person.postcode) { lines.push('〒' + person.postcode); }
        const address = (person.region || '') + (person.locality || '') + (person.street ? ' ' + person.street : '');
        if (address.trim()) { lines.push(address.trim()); }
        if (person.org) { lines.push(person.org); }
        if (person.title) { lines.push(person.title); }
        if (person.name) {
          // An honorific is a property of the language, not a phrase to translate:
          // a Japanese letter needs 様 after the name, an English one needs nothing.
          const honorific = { ja: ' 様', ko: ' 귀하' }[langKey(this.doc.lang)] || '';
          lines.push(person.name + honorific);
        }
        const html = lines.map((l) => '<p>' + l.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>').join('');
        this.run(() => insertHtmlBlock(html));
      },
      insertEvents(asTable) {
        const events = this.src.records || [];
        if (!events.length) { return; }
        this.sourceOpen = false;
        const when = (e) => {
          const start = new Date(e.start);
          const date = start.toLocaleDateString();
          if (e.allDay) { return date; }
          return date + ' ' + start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        };
        if (asTable) {
          const rows = events.map((e) => [when(e), e.summary || '', e.location || '']);
          this.run(() => {
            const table = tableFromRows([this.t('When'), this.t('Event'), this.t('Where')], rows, true);
            insertBlockNode(table);
            const tail = document.createElement('p');
            tail.appendChild(document.createElement('br'));
            table.parentNode.insertBefore(tail, table.nextSibling);
            placeCaretIn(tail);
          });
          return;
        }
        const items = events.map((e) => {
          const bits = [when(e), e.summary || ''].filter(Boolean).join(' — ');
          const where = e.location ? '（' + e.location + '）' : '';
          return '<li>' + (bits + where).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>';
        });
        this.run(() => insertHtmlBlock('<ul>' + items.join('') + '</ul>'));
      },
      /** The first field with something in it is the record's name to a reader. */
      recordName(record) {
        const found = this.src.fields.find((f) => record.data[f.key]);
        return found ? String(record.data[found.key]) : '—';
      },
      /** The next two, so a list of contacts says who as well as what. */
      recordMeta(record) {
        const filled = this.src.fields.filter((f) => record.data[f.key]);
        return filled.slice(1, 3).map((f) => String(record.data[f.key])).join(' · ');
      },
      insertRecord(record) {
        this.sourceOpen = false;
        // An empty field is not worth a row of its own in a document.
        const rows = this.src.fields.filter((f) => record.data[f.key]).map((f) => [f.label, String(record.data[f.key])]);
        this.run(() => {
          const table = tableFromRows([], rows, false);
          insertBlockNode(table);
          const tail = document.createElement('p');
          tail.appendChild(document.createElement('br'));
          table.parentNode.insertBefore(tail, table.nextSibling);
          placeCaretIn(tail);
        });
      },
      insertFormula(formula) {
        this.sourceOpen = false;
        if (!formula.mathml) {
          this.notify(this.t('That formula could not be turned into MathML.'));
          return;
        }
        this.run(() => {
          const wrap = document.createElement('div');
          wrap.className = 'eb-math-block';
          const holder = document.createElement('div');
          holder.innerHTML = formula.mathml;
          sanitiseInto(holder);
          const math = holder.querySelector('math');
          if (math) { wrap.appendChild(math); }
          insertBlockNode(wrap);
          if (formula.description) {
            const p = document.createElement('p');
            p.textContent = formula.description;
            wrap.parentNode.insertBefore(p, wrap.nextSibling);
          }
        });
      },
      insertNote(note) {
        this.sourceOpen = false;
        const html = markdownToHtml(note.content || '');
        this.run(() => insertHtmlBlock('<h2>' + String(note.title || '').replace(/</g, '&lt;') + '</h2>' + html));
      },
      /** Put a merge field at the caret, e.g. {{name}}. */
      insertField(key) {
        this.run(() => {
          const range = getRange();
          const node = document.createTextNode('{{' + key + '}}');
          if (range) {
            range.deleteContents();
            range.insertNode(node);
            const after = document.createRange();
            after.setStartAfter(node);
            after.collapse(true);
            selectRange(after);
          }
        });
      },

      // ---- mail merge ----
      openMerge(source) {
        this.sourceOpen = false;
        this.merge.source = source;
        this.merge.keys = placeholdersIn(this.exportBody());
        this.merge.count = source === 'contacts' ? (this.src.items || []).length : (this.src.records || []).length;
        this.merge.separate = false;
        this.mergeOpen = true;
      },
      mergeValuesFor(row) {
        if (this.merge.source === 'contacts') { return row; }
        const values = {};
        this.src.fields.forEach((f) => { values[f.key] = row.data[f.key] || ''; values[f.label] = row.data[f.key] || ''; });
        return values;
      },
      async runMerge() {
        const rows = this.merge.source === 'contacts' ? (this.src.items || []) : (this.src.records || []);
        if (!rows.length) { return; }
        this.merge.busy = true;
        try {
          const body = this.exportBody();
          const title = this.doc.title || this.t('Untitled document');
          if (this.merge.separate) {
            for (const row of rows) {
              const values = this.mergeValuesFor(row);
              const name = (values.name || values.title || '').toString().slice(0, 60) || String(rows.indexOf(row) + 1);
              await api('documents', {
                method: 'POST',
                body: {
                  name: title + ' — ' + name,
                  content: buildHtml({ title: title + ' — ' + name, paper: this.doc.paper, lang: this.doc.lang, body: fillPlaceholders(body, values) }),
                },
              });
            }
          } else {
            const parts = rows.map((row, i) => (i ? '<div class="eb-pagebreak"></div>' : '') + fillPlaceholders(body, this.mergeValuesFor(row)));
            const name = title + ' — ' + this.t('merged');
            await api('documents', {
              method: 'POST',
              body: { name, content: buildHtml({ title: name, paper: this.doc.paper, lang: this.doc.lang, body: parts.join('\n') }) },
            });
          }
          this.mergeOpen = false;
          await this.loadDocs();
          this.notify(this.t('{n} documents made', { n: this.merge.separate ? rows.length : 1 }));
        } catch (e) {
          this.notify(this.t('The merge failed: {msg}', { msg: e.message }));
        } finally { this.merge.busy = false; }
      },

      // ---- find and replace ----
      openFind() {
        this.find.open = true;
        const sel = window.getSelection();
        const picked = sel && !sel.isCollapsed ? sel.toString() : '';
        if (picked && picked.length < 120) { this.find.query = picked; }
        this.$nextTick(() => {
          const el = this.$refs.findInput;
          if (el) { el.focus(); el.select(); }
          this.runFind();
        });
      },
      closeFind() {
        this.find.open = false;
        this.find.hits = [];
        canvas().focus();
      },
      runFind(keepIndex) {
        const r = findAll(this.find.query, this.find.caseSensitive);
        this.find.hits = r.hits;
        this._findChunks = r.chunks;
        if (!r.hits.length) { this.find.index = 0; return; }
        this.find.index = keepIndex ? Math.min(this.find.index, r.hits.length - 1) : 0;
        selectHit(r.chunks, r.hits[this.find.index]);
      },
      findNext(dir) {
        if (!this.find.hits.length) { return; }
        const n = this.find.hits.length;
        this.find.index = (this.find.index + dir + n) % n;
        selectHit(this._findChunks, this.find.hits[this.find.index]);
      },
      replaceOne() {
        if (!this.find.hits.length) { return; }
        const hit = this.find.hits[this.find.index];
        history.push(true);
        replaceRange(this._findChunks, hit, this.find.replace);
        normaliseCanvas(this.t('Page break'), this.t('Caption'));
        this.touch();
        this.recount();
        this.runFind(true);
      },
      replaceAll() {
        if (!this.find.hits.length) { return; }
        history.push(true);
        // Backwards, so the offsets of the occurrences still to come stay valid —
        // a replacement only ever shifts the text after it. The node map has to be
        // rebuilt each time even so, because the nodes themselves have changed.
        const hits = this.find.hits.slice().reverse();
        hits.forEach((hit) => {
          replaceRange(textMap().chunks, hit, this.find.replace);
        });
        normaliseCanvas(this.t('Page break'), this.t('Caption'));
        this.touch();
        this.recount();
        const done = hits.length;
        this.runFind();
        this.notify(this.t('{n} replaced', { n: done }));
      },

      // ---- pictures ----
      openPicker() {
        this.picker.mode = 'insert';
        this.pickerOpen = true;
        this.picker.selected = null;
        this.pickerLoad('');
      },
      /**
       * Something arrived that a document cannot be made of -- a frame, a film, a
       * canvas. It is not thrown away without asking: the writer decides whether
       * to keep it as an inline frame, knowing what that costs.
       */
      askAboutForeign(list) {
        const items = (list || []).filter((f) => /^https:\/\//i.test(f.url || ''));
        if (!items.length) { return; }
        this.embedAsk = { open: true, items: items };
      },
      embedLabel(f) {
        const kind = { iframe: this.t('An embedded page'), video: this.t('A film'), audio: this.t('Sound'),
          object: this.t('An embedded page'), embed: this.t('An embedded page'), canvas: this.t('A drawing made by a script') }[f.kind] || f.kind;
        let host = '';
        try { host = new URL(f.url).host; } catch (e) { host = ''; }
        return host ? kind + ' — ' + host : kind;
      },
      insertEmbeds() {
        const items = this.embedAsk.items.slice();
        this.embedAsk = { open: false, items: [] };
        if (!items.length) { return; }
        let last = null;
        this.run(() => {
          items.forEach((f) => {
            const box = makeEmbed(f.url);
            insertBlockNode(box);
            last = box;
          });
        });
        if (last) {
          frameEl = last;
          frameMore = [];
          framePinned = true;
          frameTaken = true;
          this.frame.bar = true;
          this.settleFrame();
        }
      },

      /** The same picker again, asked for the picture behind one object's words. */
      openObjectBg() {
        this.picker.mode = 'objectbg';
        this.fpropsOpen = false;
        this.pickerOpen = true;
        this.picker.selected = null;
        this.pickerLoad('');
      },
      clearObjectBg() { this.fprops.bgImage = ''; },
      /** The same picker, asked for the picture the page is printed on. */
      openPageBg() {
        this.picker.mode = 'pagebg';
        this.pickerOpen = true;
        this.picker.selected = null;
        this.pickerLoad('');
      },
      async pickerLoad(path) {
        this.picker.loading = true;
        this.picker.error = '';
        this.picker.selected = null;
        try {
          const r = await api('files/browse?path=' + encodeURIComponent(path || ''));
          this.picker.path = r.path || '';
          this.picker.parent = r.parent === undefined ? null : r.parent;
          this.picker.entries = r.entries || [];
        } catch (e) {
          this.picker.error = this.t('Could not open the folder: {msg}', { msg: e.message });
          this.picker.entries = [];
        } finally { this.picker.loading = false; }
      },
      pickerClick(x) {
        if (x.is_dir) { this.pickerLoad(x.path); return; }
        if (x.is_image) { this.picker.selected = x; }
      },
      async pickerConfirm(x) {
        const chosen = x && !x.is_dir ? x : this.picker.selected;
        if (!chosen || !chosen.is_image || this.picker.busy) { return; }
        this.picker.busy = true;
        try {
          const r = await api('files/' + chosen.id + '/image');
          const raw = 'data:' + r.mime + ';base64,' + r.data;
          // A page background is stretched over the paper and printed at 300dpi
          // at most; anything larger only makes the file heavier, and the file
          // carries this one twice -- once for the screen, once for the printer.
          const url = await shrinkImage(raw, r.mime, this.picker.mode === 'pagebg' ? 1600 : undefined);
          this.pickerOpen = false;
          if (this.picker.mode === 'objectbg') {
            // Straight back into the dialogue that asked for it: the writer
            // presses OK there and it is applied with the rest.
            this.fprops.bgImage = url;
            this.fpropsOpen = true;
            return;
          }
          if (this.picker.mode === 'pagebg') {
            const size = await imageSize(url);
            this.doc.paper.bg.image = url;
            this.doc.paper.bg.w = size.w;
            this.doc.paper.bg.h = size.h;
            this.touchSettings();
            return;
          }
          let made = null;
          this.run(() => { made = insertImage(url, r.name, 'eb-img-m'); });
          this.placeAtPendingDrop(made);
        } catch (e) {
          this.notify(this.t('Could not read the picture: {msg}', { msg: e.message }));
        } finally { this.picker.busy = false; }
      },
      imageCmd(kind, arg) {
        if (kind === 'size') { this.run(() => setImageSize(arg)); }
        if (kind === 'delete') { this.run(() => deleteImage()); }
        if (kind === 'caption') {
          this.run(() => setCaptionPlace(imageAt(), arg));
          this.$nextTick(() => this.syncFrame());
        }
      },
      /**
       * A picture dragged off the shelf cannot be put down until it has been
       * chosen, so where it was dropped is remembered while the picker is open and
       * used the moment there is something to place.
       */
      placeAtPendingDrop(el) {
        const at = this.pendingDrop;
        this.pendingDrop = null;
        if (!el || !at) { return; }
        const put = () => {
          if (!el.parentNode) { return; }
          setObjectFree(el, true);
          el.style.left = '0mm';
          el.style.top = '0mm';
          this.moveFreeTo(el, at.x, at.y);
          this.keepOnPaper(el);
          frameEl = el;
          framePinned = true;
          frameTaken = true;
          this.frame.bar = true;
          this.settleFrame();
          // Settling repaginates, and repagination can move the anchor the picture
          // hangs from. Put it where it was dropped once the page has stopped
          // moving, or it lands a line or two above the pointer.
          this.$nextTick(() => {
            if (!el.parentNode) { return; }
            this.moveFreeTo(el, at.x, at.y);
            this.keepOnPaper(el);
            this.syncFrame();
          });
        };
        // A picture has no size until it has loaded, and a box of no size cannot be
        // put anywhere: wait for it, or it lands short of where it was dropped.
        const img = el.querySelector ? el.querySelector('img') : null;
        if (img && !img.complete) {
          img.addEventListener('load', () => this.$nextTick(put), { once: true });
          img.addEventListener('error', () => this.$nextTick(put), { once: true });
          return;
        }
        this.$nextTick(put);
      },
      /** A picture on the clipboard goes straight in, same as one picked from Files. */
      async insertPastedFiles(files) {
        for (const file of files) {
          if (!/^image\//.test(file.type)) { continue; }
          try {
            const raw = await readFileAsDataUrl(file);
            const url = await shrinkImage(raw, file.type);
            this.run(() => insertImage(url, file.name || '', 'eb-img-m'));
          } catch (e) {
            this.notify(this.t('Could not read the picture: {msg}', { msg: e.message }));
          }
        }
      },
      tableCmd(kind, arg) {
        const ops = {
          fill: () => setCellFill(arg),
          valign: () => setCellVerticalAlign(arg),
          rowAbove: () => addRow(-1), rowBelow: () => addRow(1),
          colLeft: () => addColumn(-1), colRight: () => addColumn(1),
          rowDel: () => deleteRow(), colDel: () => deleteColumn(),
          header: () => toggleHeaderRow(), variant: () => setTableVariant(arg),
          delete: () => deleteTable(),
        };
        if (ops[kind]) { this.run(ops[kind]); }
      },

      // ---- the bounding box round an object -------------------------------------
      /** The page is drawn at a zoom; every measurement here is in unzoomed pixels. */
      frameZoom() { return this.flow ? 1 : ((this.zoom || 100) / 100); },
      /** Which object the box is round, and where to draw it. */
      syncFrame() {
        const c = canvas();
        if (!c || !this.doc.id) { this.frame.on = false; frameEl = null; return; }
        if (frameEl && !c.contains(frameEl)) { frameEl = null; framePinned = false; }
        // A click holds on to the object it landed on, so it stays selected while
        // the bar and the handles are used. It lets go when the caret is somewhere
        // else -- unless it is one of the objects a caret can never be inside.
        // An object taken by a click stays taken until the writer types or clicks
        // elsewhere. Reading the caret instead let go of an empty shape the moment
        // it was put down: a click on a box with nothing in it leaves the caret
        // where it was, and the box let itself go before it could be dragged.
        if (!frameTaken && framePinned && frameEl && !/^(HR|FIGURE|IMG)$/.test(frameEl.nodeName)) {
          const at = getRange();
          if (at && inCanvas(at.startContainer) && !frameEl.contains(at.startContainer)) { framePinned = false; }
        }
        if (!framePinned) {
          const range = getRange();
          const at = range && inCanvas(range.startContainer)
            ? (objectAt(range.startContainer) || textBlockAt(range.startContainer)) : null;
          if (at) { frameEl = at; } else if (range && inCanvas(range.startContainer)) { frameEl = null; }
        }
        const el = frameEl;
        if (!el) { this.frame.on = false; this.syncText(); return; }
        const wrap = this.$el && this.$el.querySelector ? this.$el.querySelector('.eb-paperwrap') : null;
        if (!wrap || !el.getBoundingClientRect) { this.frame.on = false; return; }
        const z = this.frameZoom() || 1;
        const a = el.getBoundingClientRect();
        const b = wrap.getBoundingClientRect();
        // No layout to measure (a document not yet shown, or the test harness).
        if (!a.width && !a.height) { this.frame.on = false; this.syncText(); return; }
        this.frame.x = (a.left - b.left) / z;
        this.frame.y = (a.top - b.top) / z;
        this.frame.w = a.width / z;
        this.frame.h = a.height / z;
        // A rule or a line is a fraction of a millimetre tall. Drawn true, its box
        // has no room for the bands that move it and the handles that size it, and
        // the thing cannot be picked up at all. The box is given a little height to
        // be caught by; what is dragged is still measured from the object itself.
        const box = this.columnBox();
        if (box) {
          const mm = (n) => (Math.round(n * MM / z * 10) / 10).toFixed(1);
          this.frame.mm = mm(a.left - box.left) + ', ' + mm(a.top - box.top)
            + '  ' + mm(a.width) + ' \u00d7 ' + mm(a.height) + ' mm';
        }
        // The boxes round the ones held with Shift. They carry no bar and no
        // handles: one of them is in charge and that is the one with the bar.
        frameMore = frameMore.filter((o) => o && o.parentNode && c.contains(o) && o !== el);
        this.frame.extras = frameMore.map((o) => {
          const q = o.getBoundingClientRect();
          return { x: (q.left - b.left) / z, y: (q.top - b.top) / z, w: q.width / z, h: q.height / z };
        });
        this.frame.padX = this.frame.w < 10 ? (10 - this.frame.w) : 0;
        this.frame.padY = this.frame.h < 10 ? (10 - this.frame.h) : 0;
        this.frame.free = objectFree(el);
        this.frame.wrap = wrapMode(el);
        this.frame.kind = objectKind(el);
        this.frame.on = true;
        frameBox = a;
        // A table is the one frame with something inside it worth taking hold of:
        // the line between two columns.
        // In 縦書き a table's columns run the other way, so a vertical grip drawn at
        // a horizontal offset lands outside the table and means nothing. Rather
        // than guess at the mapping, the grips stay away and the widths are set
        // from the properties instead.
        this.frame.grips = el.nodeName === 'TABLE' && !this.tategaki
          ? columnEdges(el).map((e) => ({ index: e.index, x: (e.right - b.left) / z }))
          : [];
        if (this.coarse) { this.frame.bar = true; }
        this.syncText();
      },
      /**
       * The little bar would sit over the line above the frame and hide it, so it
       * only comes out when the pointer is near the frame -- which is when it is
       * wanted. A finger has no hover, so on a touch screen it simply stays out.
       */
      frameHover(e) {
        if (this.coarse) { return; }
        const near = (r) => !!r && e.clientX > r.left - 40 && e.clientX < r.right + 40
          && e.clientY > r.top - 52 && e.clientY < r.bottom + 40;
        if (this.frame.on) {
          const on = frameDrag ? true : near(frameBox);
          if (on !== this.frame.bar) { this.frame.bar = on; }
          return;
        }
      },
      /**
       * Text is an object as well. The box goes round whatever is selected, or --
       * when nothing is -- round the 文節 the caret is standing in, which is the
       * unit a reader of Japanese sees and the unit worth moving about.
       */
      syncText() {
        textRange = null;
        const c = canvas();
        const wrap = this.$el && this.$el.querySelector ? this.$el.querySelector('.eb-paperwrap') : null;
        if (!c || !wrap || !this.doc.id) { this.tsel.on = false; return; }
        const sel = getRange();
        if (!sel || !inCanvas(sel.startContainer)) { this.tsel.on = false; return; }
        // The box belongs to the words it is drawn round, and it stays on them.
        // Aligning the paragraph moves those words, and the box goes with them --
        // it does not jump off onto the paragraph, which is somewhere else and
        // not what was boxed.
        let ranges = [];
        const range = sel.collapsed ? bunsetsuAt(sel.startContainer, sel.startOffset) : sel.cloneRange();
        if (range && !range.collapsed) { ranges = [range]; }
        if (!ranges.length) { this.tsel.on = false; return; }
        // No layout to measure (a document not yet shown, or the test harness).
        if (typeof ranges[0].getClientRects !== 'function') { this.tsel.on = false; return; }
        const rects = ranges.reduce((all, r2) => all.concat(Array.from(r2.getClientRects())), [])
          .filter((r2) => r2.width > 0.5 && r2.height > 0.5);
        if (!rects.length) { this.tsel.on = false; return; }
        const z = this.frameZoom() || 1;
        const b = wrap.getBoundingClientRect();
        const boxes = rects.map((r) => ({ x: (r.left - b.left) / z, y: (r.top - b.top) / z, w: r.width / z, h: r.height / z }));
        const left = Math.min.apply(null, boxes.map((r) => r.x));
        const top = Math.min.apply(null, boxes.map((r) => r.y));
        const right = Math.max.apply(null, boxes.map((r) => r.x + r.w));
        const bottom = Math.max.apply(null, boxes.map((r) => r.y + r.h));
        textRange = ranges[0];
        textBox = { left: Math.min.apply(null, rects.map((r) => r.left)), right: Math.max.apply(null, rects.map((r) => r.right)),
          top: Math.min.apply(null, rects.map((r) => r.top)), bottom: Math.max.apply(null, rects.map((r) => r.bottom)) };
        this.tsel.boxes = boxes;
        this.tsel.x = left;
        this.tsel.y = top;
        this.tsel.w = right - left;
        this.tsel.h = bottom - top;
        this.tsel.on = true;
      },
      /** Any of these turns the run of text into a frame, and then acts on it. */
      promoteText() {
        if (frameEl) { return frameEl; }
        if (!textRange) { return null; }
        history.push(true);
        const span = frameText(textRange);
        if (!span) { return null; }
        frameEl = span;
        framePinned = true;
        textRange = null;
        this.tsel.on = false;
        return span;
      },
      textCmd(kind, arg) {
        if (!this.promoteText()) { return; }
        this.frameCmd(kind, arg);
      },
      /** A click on an object picks it up, including the ones a caret cannot enter. */
      onCanvasDown(e) {
        if (frameDrag) { return; }
        const at = objectAt(e.target) || thinObjectNear(e.clientX, e.clientY);
        // Shift takes hold of another one without letting go of the first, which
        // is how several things are lined up with each other.
        if (e.shiftKey && at && frameEl && at !== frameEl) {
          const i = frameMore.indexOf(at);
          if (i >= 0) { frameMore.splice(i, 1); } else { frameMore.push(at); }
          frameTaken = true;
          this.$nextTick(() => this.syncFrame());
          return;
        }
        if (!e.shiftKey) { frameMore = []; }
        frameEl = at;
        // A rule or a picture never holds the caret, so the caret cannot keep it
        // selected either: remember that this one was chosen by hand.
        framePinned = !!at;
        if (at) { this.frame.bar = true; }
        // One click picks the object up; a second one goes inside it to write.
        frameTaken = takesClick(at, e.target, e.clientX, e.clientY) && e.detail <= 1;
        this.$nextTick(() => this.syncFrame());
      },
      clearFrame() {
        frameTaken = false;
        frameMore = [];
        frameEl = null;
        framePinned = false;
        frameBox = null;
        this.frame.on = false;
        this.frame.bar = false;
        this.frame.drop = -1;
        this.tsel.on = false;
        textRange = null;
      },
      /** Take hold of the border to move it, or of a handle to size it. */
      frameGrab(e, mode) {
        if (!frameEl) { return; }
        framePinned = true;
        // Taking hold of the box itself -- its edge or one of its handles -- is
        // taking hold of the object, whatever the object is. It is the only way
        // to get at a table, which has no margin of its own to click on.
        frameTaken = true;
        // While the pointer is down the box must not answer for what is under it,
        // or the drop lands on the editor's own overlay rather than on the page.
        this.frame.dragging = true;
        const props = objectProps(frameEl) || {};
        history.push(true);
        frameDrag = {
          mode,
          math: objectKind(frameEl) === 'MATH',
          size0: parseFloat(getComputedStyle(frameEl).fontSize) || 14,
          z: this.frameZoom() || 1,
          x0: e.clientX, y0: e.clientY,
          w0: this.frame.w, h0: this.frame.h,
          left: Number(props.x) || 0, top: Number(props.y) || 0,
          free: objectFree(frameEl),
          flt: frameEl.style.cssFloat || frameEl.style.float || '',
          mt: Number(props.mt) || 0, ml: Number(props.ml) || 0, mr: Number(props.mr) || 0,
          moved: false, ref: null, after: false,
        };
        const move = (ev) => this.frameDragMove(ev);
        const up = (ev) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          this.frameDragEnd(ev);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      },
      /** Widen one column at the expense of the one beside it. */
      colGrab(e, index) {
        if (!frameEl || frameEl.nodeName !== 'TABLE') { return; }
        framePinned = true;
        this.frame.dragging = true;
        history.push(true);
        const z = this.frameZoom() || 1;
        frameDrag = {
          mode: 'column', index, z, x0: e.clientX, y0: e.clientY,
          widths: columnWidths(frameEl, z), moved: false,
        };
        const move = (ev) => this.colDragMove(ev);
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          const d = frameDrag;
          frameDrag = null;
          this.frame.dragging = false;
          if (d && d.moved) { this.settleFrame(); } else { this.$nextTick(() => this.syncFrame()); }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      },
      colDragMove(e) {
        const d = frameDrag;
        if (!d || d.mode !== 'column' || !frameEl) { return; }
        if (Math.abs(e.clientX - d.x0) > 2) { d.moved = true; }
        if (!d.moved) { return; }
        const dx = (e.clientX - d.x0) / d.z * MM;
        const widths = d.widths.slice();
        const i = d.index;
        if (widths[i] == null || widths[i + 1] == null) { return; }
        const room = widths[i] + widths[i + 1];
        const w = Math.max(6, Math.min(room - 6, widths[i] + dx));
        widths[i] = w;
        widths[i + 1] = room - w;
        setColumnWidths(frameEl, widths);
        this.syncFrame();
      },
      frameDragEndGuides() { this.frame.gx = null; this.frame.gy = null; },
      frameDragMove(e) {
        const d = frameDrag;
        if (!d || !frameEl) { return; }
        if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 3) { d.moved = true; }
        const dx = (e.clientX - d.x0) / d.z * MM;
        const dy = (e.clientY - d.y0) / d.z * MM;
        const s = frameEl.style;
        if (d.mode === 'move') {
          if (d.free) {
            s.left = round1(d.left + dx) + 'mm';
            s.top = round1(d.top + dy) + 'mm';
            this.snapFree(frameEl, e.altKey);
            this.keepOnPaper(frameEl);
            this.syncFrame();
          } else if (d.flt) {
            // A floated frame is moved by the space it holds round itself: that is
            // what a browser lets you move without taking it out of the flow, and
            // the text still runs round it wherever it lands.
            s.marginTop = round1(d.mt + dy) + 'mm';
            if (d.flt === 'left') { s.marginLeft = round1(Math.max(0, d.ml + dx)) + 'mm'; } else { s.marginRight = round1(Math.max(0, d.mr - dx)) + 'mm'; }
            this.syncFrame();
          } else if (d.moved) {
            this.frameDropTarget(e);
          }
          return;
        }
        const w0 = d.w0 * MM;
        const h0 = d.h0 * MM;
        let w = w0; let h = h0; let left = d.left; let top = d.top;
        if (d.mode.indexOf('e') >= 0) { w = w0 + dx; }
        if (d.mode.indexOf('w') >= 0) { w = w0 - dx; if (d.free) { left = d.left + dx; } }
        if (d.mode.indexOf('s') >= 0) { h = h0 + dy; }
        if (d.mode.indexOf('n') >= 0) { h = h0 - dy; if (d.free) { top = d.top + dy; } }
        // A formula is resized by being set larger or smaller, the way a formula
        // in any word processor is: giving its box a width moves nothing, because
        // nothing inside it wraps.
        if (d.math) {
          const k = d.mode === 'n' || d.mode === 's' ? (h / h0) : (w / w0);
          const size = Math.min(200, Math.max(4, d.size0 * (k > 0 ? k : 1) * 0.75));
          s.fontSize = round1(size) + 'pt';
          s.removeProperty('width');
          s.removeProperty('max-width');
          s.removeProperty('min-height');
          if (d.free) { s.left = round1(left) + 'mm'; s.top = round1(top) + 'mm'; this.keepOnPaper(frameEl); }
          this.syncFrame();
          return;
        }
        w = Math.max(8, w);
        h = Math.max(5, h);
        // Nothing is made wider than the paper it is printed on.
        w = Math.min(w, sheet(normalisePaper(this.doc.paper)).w);
        if (d.mode !== 'n' && d.mode !== 's') { s.width = round1(w) + 'mm'; s.maxWidth = 'none'; }
        // A picture keeps its proportions: its height follows its width.
        if (d.mode !== 'e' && d.mode !== 'w' && frameEl.nodeName !== 'FIGURE') {
          if (frameEl.nodeName === 'HR') { s.height = round1(h) + 'mm'; } else { s.minHeight = round1(h) + 'mm'; }
        }
        if (d.free) { s.left = round1(left) + 'mm'; s.top = round1(top) + 'mm'; this.keepOnPaper(frameEl); }
        this.syncFrame();
      },
      /** Dragging a frame that is in the flow moves it to another place in the text. */
      frameDropTarget(e) {
        const c = canvas();
        const d = frameDrag;
        if (!c || !d || !frameEl) { return; }
        const host = objectFree(frameEl) ? frameEl.parentNode : frameEl;
        // The innermost block under the pointer wins, so a formula can be put back
        // inside the box it came out of rather than landing in front of it.
        let node = document.elementFromPoint(e.clientX, e.clientY);
        let block = null;
        while (node && node !== c && node.nodeType === 1) {
          const parent = node.parentNode;
          const hosts = parent === c || (parent && parent.nodeType === 1 && parent.matches && parent.matches(BLOCK_HOSTS));
          if (hosts && isBlock(node)) { block = node; break; }
          node = parent;
        }
        if (!block || block === host || host.contains(block) || block.classList.contains('eb-pagespacer')) {
          d.ref = null;
          this.frame.drop = -1;
          return;
        }
        const r = block.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        const wrap = this.$el.querySelector('.eb-paperwrap');
        const b = wrap.getBoundingClientRect();
        d.ref = block;
        d.after = after;
        this.frame.drop = ((after ? r.bottom : r.top) - b.top) / (this.frameZoom() || 1);
      },
      frameDragEnd() {
        const d = frameDrag;
        frameDrag = null;
        this.frame.dragging = false;
        this.frame.drop = -1;
        this.frameDragEndGuides();
        if (!d || !frameEl) { return; }
        if (!d.moved) { return; }
        if (d.mode === 'move' && !d.free && d.ref) {
          window.__eb_lastDrop = { refIndex: Array.prototype.indexOf.call(canvas().children, d.ref),
            ref: d.ref.nodeName, after: d.after, by: 'the box' };
          moveObjectTo(frameEl, d.ref, d.after);
        }
        this.settleFrame();
      },
      /** Everything a frame command changes ends the same way. */
      /**
       * Aligning an object is a matter of its margins, not of the text inside it:
       * a picture pushed to the right margin, a frame centred in the column. It
       * returns false for the ones this does not fit -- an object sitting in the
       * run of a sentence, or one already parked where the writer put it by hand
       * -- and the paragraph command runs instead.
       */
      /** The column the text is set in, in client pixels. */
      columnBox() {
        const c = canvas();
        if (!c || !c.getBoundingClientRect) { return null; }
        const z = this.frameZoom() || 1;
        const cs = window.getComputedStyle(c);
        const r = c.getBoundingClientRect();
        return { left: r.left + (parseFloat(cs.paddingLeft) || 0) * z,
          right: r.right - (parseFloat(cs.paddingRight) || 0) * z,
          top: r.top + (parseFloat(cs.paddingTop) || 0) * z,
          paperLeft: r.left, paperRight: r.right, z };
      },
      /** Shift a parked frame sideways by so many client pixels. */
      nudgeFree(el, dx) {
        if (!dx) { return; }
        const z = this.frameZoom() || 1;
        const now = parseFloat(el.style.left) || 0;
        el.style.left = round1(now + dx * MM / z) + 'mm';
      },
      /**
       * Several objects held at once are lined up with each other rather than with
       * the column: left edges together, centres together, right edges together.
       * It is the one thing a page of boxes always needs and the hardest to do by
       * eye.
       */
      alignGroup(cls) {
        const each = frameAll().filter((o) => objectFree(o) && o.getBoundingClientRect);
        if (each.length < 2) { return; }
        const rects = each.map((o) => o.getBoundingClientRect());
        const left = Math.min.apply(null, rects.map((r) => r.left));
        const right = Math.max.apply(null, rects.map((r) => r.right));
        const mid = (left + right) / 2;
        history.push(true);
        each.forEach((o, i) => {
          const r = rects[i];
          let want = r.left;
          if (cls === 'eb-al-l') { want = left; }
          else if (cls === 'eb-al-c') { want = mid - r.width / 2; }
          else if (cls === 'eb-al-r') { want = right - r.width; }
          this.nudgeFree(o, want - r.left);
          this.keepOnPaper(o);
        });
        this.settleFrame();
      },
      /** Even gaps between three or more, left to right or top to bottom. */
      spreadGroup() {
        const each = frameAll().filter((o) => objectFree(o) && o.getBoundingClientRect);
        if (each.length < 3) { return; }
        const rects = each.map((o) => o.getBoundingClientRect());
        const wide = Math.max.apply(null, rects.map((r) => r.right)) - Math.min.apply(null, rects.map((r) => r.left));
        const tall = Math.max.apply(null, rects.map((r) => r.bottom)) - Math.min.apply(null, rects.map((r) => r.top));
        const across = wide >= tall;
        const order = each.map((o, i) => ({ el: o, r: rects[i] }))
          .sort((a, b) => (across ? a.r.left - b.r.left : a.r.top - b.r.top));
        const first = order[0].r;
        const last = order[order.length - 1].r;
        const room = across
          ? (last.left - first.left)
          : (last.top - first.top);
        const step = room / (order.length - 1);
        history.push(true);
        order.forEach((o, i) => {
          if (i === 0 || i === order.length - 1) { return; }
          const want = (across ? first.left : first.top) + step * i;
          if (across) { this.nudgeFree(o.el, want - o.r.left); }
          else {
            const z = this.frameZoom() || 1;
            o.el.style.top = round1((parseFloat(o.el.style.top) || 0) + (want - o.r.top) * MM / z) + 'mm';
          }
          this.keepOnPaper(o.el);
        });
        this.settleFrame();
      },
      /** The rest take the size of the one with the bar on it. */
      sameSizeGroup() {
        const each = frameAll();
        if (each.length < 2 || !frameEl || !frameEl.getBoundingClientRect) { return; }
        const z = this.frameZoom() || 1;
        const r = frameEl.getBoundingClientRect();
        const w = round1(r.width * MM / z);
        const h = round1(r.height * MM / z);
        history.push(true);
        each.forEach((o) => {
          if (o === frameEl) { return; }
          o.style.width = w + 'mm';
          o.style.maxWidth = 'none';
          if (o.nodeName !== 'FIGURE' && !(o.classList && (o.classList.contains('eb-sh-line') || o.classList.contains('eb-sh-arrow')))) {
            o.style.minHeight = h + 'mm';
          }
          this.keepOnPaper(o);
        });
        this.settleFrame();
      },
      alignFree(el, cls) {
        const box = this.columnBox();
        if (!box || !el.getBoundingClientRect) { return false; }
        const r = el.getBoundingClientRect();
        let want;
        if (cls === 'eb-al-l') { want = box.left; }
        else if (cls === 'eb-al-c') { want = box.left + ((box.right - box.left) - r.width) / 2; }
        else if (cls === 'eb-al-r') { want = box.right - r.width; }
        else { return false; }
        history.push(true);
        this.nudgeFree(el, want - r.left);
        this.settleFrame();
        return true;
      },
      /**
       * A parked frame stays on the paper. Dragged far enough it used to leave it
       * entirely -- one in a document here sat 68.7mm off the left edge, where no
       * alignment could reach it and nothing showed but the half that overhung.
       */
      /**
       * Dragging a frame catches on the lines a writer actually wants: the two
       * margins, the middle of the column, and the top of the text. Without it a
       * frame can be put near the centre but never on it, which is the moment a
       * page stops feeling like a page. Hold Alt to place it freely.
       */
      snapFree(el, off) {
        this.frame.gx = null;
        this.frame.gy = null;
        const box = this.columnBox();
        const wrap = this.$el && this.$el.querySelector ? this.$el.querySelector('.eb-paperwrap') : null;
        const c = canvas();
        if (off || !box || !wrap || !c || !el || !el.getBoundingClientRect) { return; }
        const z = this.frameZoom() || 1;
        const near = 7 * z;
        const b = wrap.getBoundingClientRect();
        const cs = window.getComputedStyle(c);
        const cr = c.getBoundingClientRect();
        // The lines worth catching on: the margins and the middle of the column,
        // the top of the text, and the edges and middles of everything else
        // already on the page. Laying a page out is mostly lining things up.
        const xs = [box.left, (box.left + box.right) / 2, box.right];
        const ys = [cr.top + (parseFloat(cs.paddingTop) || 0) * z];
        Array.from(c.querySelectorAll('.eb-anchor > *')).forEach((o) => {
          if (o === el || !o.getBoundingClientRect) { return; }
          const q = o.getBoundingClientRect();
          if (!q.width && !q.height) { return; }
          xs.push(q.left, (q.left + q.right) / 2, q.right);
          ys.push(q.top, (q.top + q.bottom) / 2, q.bottom);
        });
        const pick = (lines, have) => {
          let best = null;
          lines.forEach((want) => {
            have.forEach((h) => {
              const gap = want - h;
              if (Math.abs(gap) <= near && (!best || Math.abs(gap) < Math.abs(best[0]))) { best = [gap, want]; }
            });
          });
          return best;
        };
        // With the grid on, everything lands on it. A grid that only catches when
        // you are nearly on it is not a grid, it is a hint.
        if (this.grid) {
          const now = el.getBoundingClientRect();
          const snap5 = (v) => Math.round(v / 5) * 5;
          const dx = snap5((now.left - cr.left) * MM / z) - (now.left - cr.left) * MM / z;
          const dy = snap5((now.top - cr.top) * MM / z) - (now.top - cr.top) * MM / z;
          el.style.left = round1((parseFloat(el.style.left) || 0) + dx) + 'mm';
          el.style.top = round1((parseFloat(el.style.top) || 0) + dy) + 'mm';
          return;
        }
        const r = el.getBoundingClientRect();
        const bx = pick(xs, [r.left, (r.left + r.right) / 2, r.right]);
        if (bx) {
          this.nudgeFree(el, bx[0]);
          this.frame.gx = (bx[1] - b.left) / z;
        }
        const r2 = el.getBoundingClientRect();
        const by = pick(ys, [r2.top, (r2.top + r2.bottom) / 2, r2.bottom]);
        if (by) {
          el.style.top = round1((parseFloat(el.style.top) || 0) + by[0] * MM / z) + 'mm';
          this.frame.gy = (by[1] - b.top) / z;
        }
      },
      /**
       * Ctrl+D leaves a copy four millimetres down and across, ready to be dragged
       * off. Several held at once are all copied, or the key would do something
       * different from everything else on the toolbar.
       */
      duplicateFrame() {
        const all = frameAll();
        if (!all.length) { return; }
        history.push(true);
        const copies = all.map((o) => {
          const host = objectFree(o) ? o.parentNode : o;
          if (!host || !host.parentNode) { return null; }
          const copy = host.cloneNode(true);
          host.parentNode.insertBefore(copy, host.nextSibling);
          const made = objectFree(o) ? copy.firstElementChild : copy;
          if (made && objectFree(made)) {
            made.style.left = round1((parseFloat(made.style.left) || 0) + 4) + 'mm';
            made.style.top = round1((parseFloat(made.style.top) || 0) + 4) + 'mm';
            this.keepOnPaper(made);
          }
          return made;
        }).filter(Boolean);
        if (!copies.length) { return; }
        frameEl = copies[0];
        frameMore = copies.slice(1);
        framePinned = true;
        frameTaken = true;
        this.frame.bar = true;
        this.settleFrame();
      },
      /** Arrow keys walk a frame about the page, the way they do in a drawing. */
      nudgeFrameBy(el, dxMm, dyMm) {
        if (!el || !objectFree(el)) { return false; }
        history.push(true);
        el.style.left = round1((parseFloat(el.style.left) || 0) + dxMm) + 'mm';
        el.style.top = round1((parseFloat(el.style.top) || 0) + dyMm) + 'mm';
        this.keepOnPaper(el);
        this.settleFrame();
        return true;
      },
      keepOnPaper(el) {
        const box = this.columnBox();
        if (!box || !el || !el.getBoundingClientRect || !objectFree(el)) { return; }
        const r = el.getBoundingClientRect();
        // Wider than the paper it sits on: bring it back to the width of the
        // column, or it can never be moved again -- every nudge is undone by the
        // edge it is already past.
        if (r.width > box.paperRight - box.paperLeft) {
          const paper = normalisePaper(this.doc.paper);
          el.style.width = round1(sheet(paper).w - paper.margin.left - paper.margin.right) + 'mm';
          el.style.maxWidth = 'none';
          const r2 = el.getBoundingClientRect();
          this.nudgeFree(el, box.left - r2.left);
          return;
        }
        if (r.left < box.paperLeft) { this.nudgeFree(el, box.paperLeft - r.left); }
        else if (r.right > box.paperRight) { this.nudgeFree(el, box.paperRight - r.right); }
        // And it stays on the paper the other way too: dragged up hard, a shape
        // used to sit above the top edge of the first sheet, where it is drawn on
        // the desk rather than on the page and prints nowhere at all.
        const c = canvas();
        if (!c || !c.getBoundingClientRect) { return; }
        const paper = c.getBoundingClientRect();
        const now = el.getBoundingClientRect();
        const z = this.frameZoom() || 1;
        let dy = 0;
        if (now.top < paper.top) { dy = paper.top - now.top; }
        else if (now.bottom > paper.bottom) { dy = Math.min(0, paper.bottom - now.bottom); }
        if (dy) { el.style.top = round1((parseFloat(el.style.top) || 0) + dy * MM / z) + 'mm'; }
      },
      alignObject(el, cls) {
        if (!el || cls === 'eb-al-j') { return false; }
        // A frame parked by hand is aligned by moving it: to the left margin, to
        // the middle of the column, or to the right margin. This is also the way
        // back for one that has been dragged off the paper altogether.
        if (objectFree(el)) { return this.alignFree(el, cls); }
        // A frame standing in the run of a sentence is inline: margins of its own
        // move it nowhere, and what decides where it sits is the alignment of the
        // line it is on. So that is what is set -- on the block the frame is
        // actually in, not on whatever paragraph the caret happens to be left in,
        // which is somewhere else on the page as often as not.
        if (el.nodeName === 'SPAN') {
          const block = innerBlockOf(el.parentNode);
          if (!block || !block.classList) { return false; }
          history.push(true);
          // Auto margins were written on to inline frames by an earlier reading of
          // this and never moved anything. Take them off while we are here.
          el.style.removeProperty('margin-left');
          el.style.removeProperty('margin-right');
          if (!el.getAttribute('style')) { el.removeAttribute('style'); }
          const already = alignOf(block) === cls;
          ['eb-al-l', 'eb-al-c', 'eb-al-r', 'eb-al-j'].forEach((c) => block.classList.remove(c));
          if (block.style) {
            block.style.removeProperty('text-align');
            if (!block.getAttribute('style')) { block.removeAttribute('style'); }
          }
          if (!already) { block.classList.add(cls); }
          if (block.getAttribute('class') === '') { block.removeAttribute('class'); }
          this.settleFrame();
          return true;
        }
        const want = { 'eb-al-l': ['0', 'auto'], 'eb-al-c': ['auto', 'auto'], 'eb-al-r': ['auto', '0'] }[cls];
        if (!want) { return false; }
        const now = [el.style.marginLeft || '', el.style.marginRight || ''];
        history.push(true);
        el.style.removeProperty('float');
        // Pressing the alignment it already has takes it off, as it does on a
        // paragraph.
        if (now[0] === want[0] && now[1] === want[1]) {
          el.style.removeProperty('margin-left');
          el.style.removeProperty('margin-right');
        } else {
          el.style.marginLeft = want[0];
          el.style.marginRight = want[1];
        }
        this.settleFrame();
        return true;
      },
      settleFrame(fit) {
        normaliseCanvas(this.t('Page break'), this.t('Caption'));
        this.touch();
        this.recount();
        this.refreshState();
        this.$nextTick(() => {
          if (fit) { this.fitFrameWidth(fit); }
          this.reflowWrap();
          this.syncFrame();
          this.refreshLayers();
          this.refreshPreview();
        });
      },
      /**
       * Redraw the room the objects take out of the writing. It is measured, so it
       * runs after the page is laid out -- and it runs often: as the writer types,
       * the lines move and the room has to move with them.
       */
      reflowWrap() {
        const c = canvas();
        if (!c) { return; }
        applyWrap(c, this.frameZoom());
      },
      queueWrap() {
        if (wrapTimer) { window.clearTimeout(wrapTimer); }
        wrapTimer = window.setTimeout(() => { wrapTimer = null; this.reflowWrap(); }, 160);
      },
      frameCmd(kind, arg) {
        if (!frameEl) { return; }
        // What holds a piece of writing selected is the caret being inside it.
        // Every command here moves the block in the markup -- into an anchor, out
        // of one, to another place in the text -- and a moved block loses the
        // caret, so the box let go the instant the writer touched the bar and the
        // next button pressed did nothing at all. The caret is put back where it
        // was: the words themselves have not moved, only their surroundings.
        const r0 = getRange();
        const caret = r0 && frameEl.contains(r0.startContainer) ? r0.cloneRange() : null;
        const keepCaret = () => {
          const c = canvas();
          if (caret && c && c.contains(caret.startContainer)) { selectRange(caret); }
        };
        // Where the frame itself sits in the column, as against what the words
        // inside it do. These two are the whole of the difference between the
        // frame's own bar and the alignment buttons above the page.
        if (kind === 'align') {
          framePinned = true;
          frameTaken = true;
          if (frameMore.length) { this.alignGroup(arg); return; }
          if (!this.alignObject(frameEl, arg)) { this.blockRun(() => setBlockClass('align', arg)); }
          keepCaret();
          return;
        }
        if (kind === 'spread' || kind === 'sameSize') {
          this[kind === 'spread' ? 'spreadGroup' : 'sameSizeGroup']();
          return;
        }
        if (kind === 'fit') {
          const paper = normalisePaper(this.doc.paper);
          const w = round1(sheet(paper).w - paper.margin.left - paper.margin.right);
          history.push(true);
          framePinned = true;
          frameAll().forEach((o) => {
            o.style.width = w + 'mm';
            o.style.maxWidth = 'none';
            if (objectFree(o)) {
              const box = this.columnBox();
              if (box) { this.nudgeFree(o, box.left - o.getBoundingClientRect().left); }
            }
          });
          keepCaret();
          this.settleFrame();
          return;
        }
        const el = frameEl;
        framePinned = true;
        // Using the bar is taking hold of the object, exactly as a click on it is.
        // Without this the box let go of a piece of writing the moment the markup
        // moved under it -- the caret was left behind on the page -- and the next
        // button pressed found nothing selected and did nothing at all.
        frameTaken = true;
        history.push(true);
        if (kind === 'free') {
          if (objectFree(el)) { setObjectFree(el, false); } else { this.freeInPlace(el); }
        } else if (kind === 'wrapMode') {
          // 折り返し, LibreOffice's word for it. It says what the words do when
          // they meet this object, and nothing else: where the object stands is
          // the placement's business, not the wrap's.
          const mode = WRAP_MODES.indexOf(arg) >= 0 ? arg : 'none';
          el.setAttribute('data-wrap', mode);
          if (objectFree(el)) {
            // Standing over the text: a float would not reach it, so the room is
            // taken out of the writing itself. See applyWrap.
            el.style.removeProperty('float');
          } else {
            // Still in the run of the text: a float is the wrap, and it is the
            // better one -- the words reflow round it as they are written.
            el.style.removeProperty('float');
            el.style.removeProperty('margin-left');
            el.style.removeProperty('margin-right');
            if (mode === 'right') {
              el.style.cssFloat = 'left';
              el.style.marginRight = wrapGap(el) + 'mm';
            } else if (mode === 'left') {
              el.style.cssFloat = 'right';
              el.style.marginLeft = wrapGap(el) + 'mm';
            }
          }
        } else if (kind === 'plain') {
          plainBlock(el);
        } else if (kind === 'wrap') {
          // Pressing the side it is already wrapped on takes the wrapping off.
          if (arg && (el.style.cssFloat || el.style.float) === arg) { arg = ''; }
          // Where it looks like it is now. Text can only run round something that
          // is in the flow -- a browser runs its words under anything parked with
          // position, and there is no way round that -- so asking for a wrap turns
          // a parked object into a floated one. The offsets it was parked with are
          // carried over as margins, so it stays as near to where it was as the
          // flow allows instead of jumping back to its anchor.
          const was = this.columnBox();
          const before = (objectFree(el) && was && el.getBoundingClientRect)
            ? el.getBoundingClientRect() : null;
          setObjectFree(el, false);
          el.style.removeProperty('float');
          el.style.removeProperty('margin-left');
          el.style.removeProperty('margin-right');
          el.style.removeProperty('margin-top');
          if (arg) {
            el.style.cssFloat = arg;
            el.style[arg === 'left' ? 'marginRight' : 'marginLeft'] = '6mm';
            if (before && was) {
              const z = this.frameZoom() || 1;
              const gap = arg === 'left'
                ? (before.left - was.left)
                : (was.right - before.right);
              if (gap > 1) {
                el.style[arg === 'left' ? 'marginLeft' : 'marginRight'] = round1(gap * MM / z) + 'mm';
              }
              // A float only pushes the words that come after it. Parked over a
              // paragraph it sat after that paragraph in the markup, so asking for
              // a wrap changed nothing at all on screen. It moves to just before
              // the paragraph it was lying on.
              const target = blockAtY(before.top + 1);
              if (target && target !== el && target !== el.parentNode) {
                moveObjectTo(el, target, false);
              }
            }
          }
          if (!el.getAttribute('style')) { el.removeAttribute('style'); }
        } else if (kind === 'stack') {
          if (!objectFree(el)) { this.freeInPlace(el); }
          restack(el, arg);
        } else if (kind === 'delete') {
          deleteObject(el);
          this.clearFrame();
          this.settleFrame();
          return;
        }
        keepCaret();
        this.settleFrame(el);
      },
      /**
       * A frame that still fills the whole column is not floating over anything and
       * nothing can wrap beside it -- which is what made a formula placed over the
       * text refuse to take a wrap. Only in that case is a width imposed, and it is
       * the paper's column that decides it, not whatever the screen happens to be.
       */
      fitFrameWidth(el) {
        const c = canvas();
        if (!el || !c || el.style.width || !el.getBoundingClientRect) { return; }
        const free = objectFree(el);
        const flt = el.style.cssFloat || el.style.float || '';
        if (!free && !flt) { return; }
        const z = this.frameZoom() || 1;
        const cs = window.getComputedStyle(c);
        const room = c.getBoundingClientRect().width / z
          - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        const w = el.getBoundingClientRect().width / z;
        if (!room || !w || w < room * 0.85) { return; }
        const paper = normalisePaper(this.doc.paper);
        const column = sheet(paper).w - paper.margin.left - paper.margin.right;
        el.style.width = round1(column / 2) + 'mm';
        el.style.maxWidth = 'none';
      },
      openFrameProps() {
        if (!frameEl && !textRange) { return; }
        this.closeCtx();
        if (frameEl) {
          const props = objectProps(frameEl);
          if (props) { this.fprops = Object.assign({}, this.fprops, props); }
          this.fprops.wrapMode = wrapMode(frameEl);
          this.fprops.wrapGap = frameEl.getAttribute('data-wrap-gap') || '';
        } else {
          // Nothing is written on the text yet, so the dialogue starts empty; the
          // run of words only becomes a frame if the settings are applied.
          this.clearFrameProps();
          this.fpropsRange = textRange.cloneRange();
        }
        this.fpropsOpen = true;
      },
      clearFrameProps() {
        this.fprops = {
          place: '', inner: '', x: '', y: '', width: '', height: '', mt: '', mb: '', ml: '', mr: '', pad: '',
          wrapMode: 'none', wrapGap: '', flow: '',
          bgImage: '', bgFit: 'cover',
          strokeWidth: '', strokeColour: '#000000',
          textShadow: false, shadowX: 1, shadowY: 1, shadowBlur: 1.5, shadowColour: '#808080',
          border: '', borderWidth: '', borderColour: '#666666', radius: '', fill: '', opacity: '', rotate: '', vpos: '', shadow: false, keep: false,
        };
      },
      applyFrameProps() {
        const v = Object.assign({}, this.fprops);
        this.fpropsOpen = false;
        if (!frameEl && this.fpropsRange) {
          textRange = this.fpropsRange;
          this.fpropsRange = null;
          try { selectRange(textRange); } catch (e) { /* the text moved on */ }
          if (!this.promoteText()) { return; }
        }
        if (!frameEl) { return; }
        framePinned = true;
        frameTaken = true;
        history.push(true);
        setObjectProps(frameEl, v);
        if (v.wrapGap === '' || v.wrapGap == null) { frameEl.removeAttribute('data-wrap-gap'); }
        else { frameEl.setAttribute('data-wrap-gap', String(v.wrapGap)); }
        // Only if the writer actually changed it: the wrap and the placement are
        // set in the same dialogue, and the wrap must not undo what the placement
        // just did.
        if ((v.wrapMode || 'none') !== wrapMode(frameEl)) { this.frameCmd('wrapMode', v.wrapMode || 'none'); }
        this.settleFrame(frameEl);
      },
      /** The two overlap buttons in the dialogue act at once, like a menu item. */
      stackFromProps(where) {
        const v = Object.assign({}, this.fprops, { place: 'free', wrap: '' });
        this.fprops.place = 'free';
        this.fprops.wrap = '';
        if (!frameEl && this.fpropsRange) {
          textRange = this.fpropsRange;
          this.fpropsRange = null;
          try { selectRange(textRange); } catch (e) { /* the text moved on */ }
          if (!this.promoteText()) { return; }
        }
        if (!frameEl) { return; }
        framePinned = true;
        history.push(true);
        setObjectProps(frameEl, v);
        restack(frameEl, where);
        this.fprops.z = Number(frameEl.style.zIndex) || '';
        this.settleFrame();
      },
      setVertical(on) {
        history.pushPrev(this.prevSettings);
        this.doc.paper.vertical = !!on;
        this.prevSettings = history.state();
        this.touch();
        this.$nextTick(() => { this.fitZoom(); this.repaginate(); });
      },
      reviewCmd(kind) {
        const at = getRange();
        const one = at ? (insAt(at.startContainer) || delAt(at.startContainer)) : null;
        if ((kind === 'acceptOne' || kind === 'rejectOne') && !one) { return; }
        this.run(() => {
          if (kind === 'acceptAll') { acceptChanges(); }
          if (kind === 'rejectAll') { rejectChanges(); }
          if (kind === 'acceptOne') { acceptOne(one); }
          if (kind === 'rejectOne') { rejectOne(one); }
        });
        this.changes = countChanges();
      },
      openCrop() {
        const fig = imageAt(getRange() ? getRange().startContainer : null);
        if (!fig) { this.notify(this.t('Put the cursor on a picture first.')); return; }
        const img = fig.querySelector('img');
        ctxRange = getRange() ? getRange().cloneRange() : null;
        this.cropSrc = img ? img.getAttribute('src') : '';
        this.crop = Object.assign({ ratio: '', x: 50, y: 50 }, cropOf(fig) || {});
        this.cropOpen = true;
      },
      /** Drag inside the preview to say which part of the picture shows. */
      cropGrab(e) {
        const box = e.currentTarget;
        const r = box.getBoundingClientRect();
        const start = { x: e.clientX, y: e.clientY, cx: this.crop.x, cy: this.crop.y };
        const move = (ev) => {
          this.crop.x = Math.max(0, Math.min(100, start.cx - (ev.clientX - start.x) / Math.max(1, r.width) * 100));
          this.crop.y = Math.max(0, Math.min(100, start.cy - (ev.clientY - start.y) / Math.max(1, r.height) * 100));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      },
      applyCrop() {
        const v = Object.assign({}, this.crop);
        this.cropOpen = false;
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the picture moved on */ } }
        this.run(() => {
          const fig = imageAt(getRange() ? getRange().startContainer : null);
          if (fig) { setCrop(fig, v); }
        });
      },
      openCellBorder() {
        ctxRange = getRange() ? getRange().cloneRange() : null;
        this.cellBorderOpen = true;
      },
      applyCellBorder() {
        const v = Object.assign({}, this.cellBorder);
        this.cellBorderOpen = false;
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the table moved on */ } }
        this.run(() => setCellBorder(v));
      },
      openStyles() {
        const block = String(this.fmt.block || 'P').toLowerCase();
        const known = STYLE_TARGETS.some((t2) => t2.key === block);
        this.styleKey = known ? block : 'p';
        this.stylesOpen = true;
      },
      closeStyles() { this.stylesOpen = false; },
      /** A change to the paper or the styles is an undoable step like any other. */
      touchSettings() {
        history.pushPrev(this.prevSettings);
        this.prevSettings = history.state();
        this.touch();
      },
      touchStyles() {
        history.pushPrev(this.prevSettings);
        this.doc.styles = normaliseStyles(this.doc.styles);
        this.prevSettings = history.state();
        this.applyDocStyles();
        this.touch();
      },
      clearStyle() {
        this.doc.styles[this.styleKey] = Object.assign({}, EMPTY_STYLE);
        this.touchStyles();
      },
      addFrame() { this.run(() => insertFrame()); this.$nextTick(() => this.syncFrame()); },
      addTextBox() { this.run(() => insertTextBox(false)); this.$nextTick(() => this.syncFrame()); },
      /**
       * The header and the footer of the page. Not objects: regions. Turning one
       * on puts it on the page ready to be written in; turning it off takes it
       * away, and what was in it goes with it.
       */
      toggleRegion(which) {
        const c = canvas();
        if (!c) { return; }
        const on = which === 'header' ? !this.doc.paper.headerOn : !this.doc.paper.footerOn;
        this.run(() => {
          const sel = which === 'header' ? ':scope > header.eb-header' : ':scope > footer.eb-footer';
          const had = c.querySelector(sel);
          if (!on) {
            if (had) { had.remove(); }
          } else if (!had) {
            const el = document.createElement(which === 'header' ? 'header' : 'footer');
            el.className = which === 'header' ? 'eb-header' : 'eb-footer';
            const p = document.createElement('p');
            p.appendChild(document.createElement('br'));
            el.appendChild(p);
            if (which === 'header') { c.insertBefore(el, c.firstChild); } else { c.appendChild(el); }
            placeCaretIn(p);
          }
        });
        if (which === 'header') { this.doc.paper.headerOn = on; } else { this.doc.paper.footerOn = on; }
        this.touch();
        this.$nextTick(() => { this.repaginate(); this.syncFrame(); });
      },
      addShape(kind) {
        let made = null;
        this.run(() => { made = insertShape(kind); });
        this.$nextTick(() => {
          frameEl = made;
          framePinned = true;
          frameTaken = true;
          this.frame.bar = true;
          this.syncFrame();
        });
      },
      /** Dragging one out of the menu drops it where the pointer lets go. */
      /**
       * Dragging a shape out of the menu and on to the page. It is done with the
       * pointer rather than with the browser's own drag and drop: that carries a
       * ghost image nobody asked for, behaves differently in every browser, and
       * does not exist on a touch screen at all. A press, a move and a release is
       * the same gesture everywhere.
       *
       * Released on the page, the shape is put down there. Released without
       * moving, it is put down where the caret is, so a click still works.
       */
      shapeGrab(e, kind) {
        const ghost = document.createElement('div');
        ghost.className = 'eb-dragghost';
        ghost.style.width = '45mm';
        ghost.style.height = '25mm';
        if (kind === 'ellipse') { ghost.style.borderRadius = '50%'; }
        if (kind === 'round') { ghost.style.borderRadius = '4mm'; }
        if (kind === 'line' || kind === 'arrow') { ghost.style.height = '0'; }
        document.body.appendChild(ghost);
        const at = (ev) => {
          ghost.style.left = ev.clientX + 'px';
          ghost.style.top = ev.clientY + 'px';
        };
        at(e);
        let moved = false;
        const start = { x: e.clientX, y: e.clientY };
        const move = (ev) => {
          if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) { moved = true; }
          at(ev);
        };
        const up = (ev) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          ghost.remove();
          this.menu = '';
          const c = canvas();
          const over = c && c.getBoundingClientRect ? c.getBoundingClientRect() : null;
          const inside = !!over && ev.clientX >= over.left && ev.clientX <= over.right
            && ev.clientY >= over.top && ev.clientY <= over.bottom;
          this.dropShape(kind, moved && inside ? ev : null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      },
      dropShape(kind, ev) {
        const c = canvas();
        if (!c) { return; }
        // Pressed rather than dragged, a frame of words goes into the flow where
        // the caret is, which is what someone writing a letter wants. Dragged, it
        // is put down where it lands, which is what someone laying out a page
        // wants. Both are one gesture apart.
        if (kind === 'textbox' && !ev) { this.addTextBox(); return; }
        if (kind === 'frame' && !ev) { this.addFrame(); return; }
        if (kind === 'table' && !ev) { this.tableOpen = true; return; }
        if (kind === 'image') {
          this.pendingDrop = ev ? { x: ev.clientX, y: ev.clientY } : null;
          this.openPicker();
          return;
        }
        if (ev) {
          const at2 = caretFromPoint(ev.clientX, ev.clientY);
          if (at2) { selectRange(at2); }
        }
        let made = null;
        this.run(() => {
          made = kind === 'textbox' ? insertTextBox(true)
            : (kind === 'frame' ? insertFreeFrame()
              : (kind === 'table' ? insertFreeTable() : insertShape(kind)));
        });
        this.$nextTick(() => {
          if (made && made.parentNode && ev) {
            this.moveFreeTo(made, ev.clientX, ev.clientY);
            this.keepOnPaper(made);
          }
          frameEl = made;
          framePinned = true;
          frameTaken = true;
          this.frame.bar = true;
          this.syncFrame();
        });
      },
      /** Put a parked object's top-left corner at a point on the page. */
      moveFreeTo(el, x, y) {
        if (!el || !el.getBoundingClientRect) { return; }
        const z = this.frameZoom() || 1;
        const r = el.getBoundingClientRect();
        el.style.left = round1((parseFloat(el.style.left) || 0) + (x - r.left) * MM / z) + 'mm';
        el.style.top = round1((parseFloat(el.style.top) || 0) + (y - r.top) * MM / z) + 'mm';
      },
      // ---- the context menu ----------------------------------------------------
      /**
       * LibreOffice puts its own menu on the right button, and so does this: the
       * items are the ones that apply where the pointer is.
       *
       * The browser's own menu never appears anywhere inside the app -- not over
       * the page, not over the toolbar, not over the shelf or the margins. A word
       * processor that shows "Back / Reload / View source" over its own page is
       * not a word processor. Suppressing it is done once, on the app's root, so
       * there is no corner of the app where it can still get through.
       */
      /**
       * The right button on the object's own bar or on one of the bands it is
       * dragged by. Those are the editor's own furniture, laid over the page, so
       * the menu has to be asked for on behalf of the object underneath them --
       * and it is the menu that comes up, not the properties dialogue, which is
       * one item within it.
       */
      /**
       * A page left open goes on running the code it was loaded with. Someone can
       * be shown a fault that was mended an hour ago, report it again, and be
       * told it is fixed -- and both of them are right. The app asks the server
       * what it is serving, whenever the window is looked at again, and says so.
       */
      watchForNewBuild() {
        const check = async () => {
          if (!this.build || this.newBuild) { return; }
          try {
            const s = await api('settings');
            if (s && s.build && s.build !== this.build) { this.newBuild = true; }
          } catch (e) { /* offline, or the server is busy: ask again later */ }
        };
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { check(); } });
        window.addEventListener('focus', check);
        window.setInterval(check, 5 * 60 * 1000);
      },
      async reloadForNewBuild() {
        if (this.dirty && this.doc.id) { try { await this.save(); } catch (e) { /* reload anyway */ } }
        window.location.reload();
      },
      /**
       * The pile, read off the page. Everything standing on the paper is in it,
       * grouped by the level it stands at -- things at the same level are one
       * group -- and the top of the list is the top of the pile.
       */
      refreshLayers() {
        const c = canvas();
        if (!c || !this.layersOpen) { this.layers = []; return; }
        const placed = Array.from(c.querySelectorAll('.eb-anchor > *'))
          .filter((el) => el.nodeType === 1);
        const groups = new Map();
        placed.forEach((el, i) => {
          const level = Number(el.style.zIndex) || 0;
          if (!groups.has(level)) { groups.set(level, []); }
          const kind = objectKind(el);
          groups.get(level).push({
            id: i,
            name: this.nameOfKind(kind),
            icon: this.iconOfKind(kind),
            text: (el.textContent || '').trim().slice(0, 24),
            chosen: el === frameEl,
          });
        });
        this.layers = Array.from(groups.keys()).sort((a, b) => b - a)
          .map((level) => ({ level: level, items: groups.get(level) }));
        layerEls = placed;
      },
      nameOfKind(kind) {
        const names = {
          FIGURE: this.t('Picture'), TABLE: this.t('Table'), ASIDE: this.t('Box'),
          NAV: this.t('Contents'), HR: this.t('Rule'), MATH: this.t('Formula'),
          NOTE: this.t('Note'), FRAME: this.t('Block frame'), TEXT: this.t('Phrase'),
          TEXTBOX: this.t('Text frame'), SHAPE: this.t('Shape'), EMBED: this.t('An embedded page'),
          PARA: this.t('Text frame'), HEADING: this.t('Heading'), LIST: this.t('List'),
        };
        return names[kind] || this.t('Block frame');
      },
      iconOfKind(kind) {
        return { FIGURE: this.icons.image, TABLE: this.icons.table, SHAPE: this.icons.box,
          EMBED: this.icons.link, HR: this.icons.rule }[kind] || this.icons.frame;
      },
      chooseLayer(id) {
        const el = layerEls[id];
        if (!el || !el.parentNode) { return; }
        frameEl = el;
        frameMore = [];
        framePinned = true;
        frameTaken = true;
        this.frame.bar = true;
        el.scrollIntoView({ block: 'center' });
        this.$nextTick(() => { this.syncFrame(); this.refreshLayers(); });
      },
      raiseLayer(id, dir) {
        const el = layerEls[id];
        if (!el || !el.parentNode) { return; }
        history.push(true);
        restack(el, dir);
        this.touch();
        this.$nextTick(() => { this.reflowWrap(); this.syncFrame(); this.refreshLayers(); });
      },
      /**
       * A plan of each page: the writing as grey bars, the objects as outlines,
       * placed from their own measurements. Redrawn whenever the page settles.
       */
      refreshPreview() {
        const c = canvas();
        if (!c || !this.previewOpen) { this.preview = []; return; }
        const sheet = this.$el.querySelector('.eb-sheet');
        if (!sheet) { this.preview = []; return; }
        const z = this.frameZoom() || 1;
        const pageH = sheet.getBoundingClientRect().height / z;
        const paper = sheet.getBoundingClientRect();
        const left = paper.left;
        const width = paper.width / z;
        if (!pageH || !width) { this.preview = []; return; }
        const top0 = paper.top;
        const pages = [];
        for (let n = 1; n <= Math.max(1, this.pageCount); n += 1) {
          pages.push({ n: n, ratio: Math.round((pageH / width) * 1000) / 10, blocks: [] });
        }
        const put = (el, kind) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) { return; }
          const y = (r.top - top0) / z;
          const n = Math.floor(y / pageH) + 1;
          const pg = pages[n - 1];
          if (!pg) { return; }
          pg.blocks.push({
            kind: kind,
            x: Math.max(0, Math.round(((r.left - left) / z / width) * 1000) / 10),
            y: Math.max(0, Math.round((((y % pageH)) / pageH) * 1000) / 10),
            w: Math.min(100, Math.round(((r.width / z) / width) * 1000) / 10),
            h: Math.min(100, Math.round(((r.height / z) / pageH) * 1000) / 10),
          });
        };
        Array.from(c.children).forEach((el) => {
          if (el.classList && el.classList.contains('eb-pagespacer')) { return; }
          if (el.classList && el.classList.contains('eb-anchor')) {
            Array.from(el.children).forEach((o) => put(o, 'obj'));
            return;
          }
          put(el, 'text');
        });
        this.preview = pages;
      },
      goToPage(n) {
        const sheet = this.$el.querySelectorAll('.eb-sheet')[n - 1];
        if (sheet) { sheet.scrollIntoView({ block: 'start', behavior: 'smooth' }); this.pageNow = n; }
      },
      /** The chosen words, and what is written on them. */
      openRunProps() {
        const range = getRange();
        if (!range || range.collapsed) { this.notify(this.t('Choose the words first.')); return; }
        const was = readRun();
        if (!was) { this.notify(this.t('Choose the words first.')); return; }
        wordsRange = range.cloneRange();
        wordsWas = was;
        this.wordsFmt = Object.assign({}, was);
        this.wordsSample = range.toString().slice(0, 30);
        this.wordsOpen = true;
      },
      applyRunProps() {
        const v = Object.assign({}, this.wordsFmt);
        this.wordsOpen = false;
        if (!wordsRange) { return; }
        try { selectRange(wordsRange); } catch (e) { return; }
        history.push(true);
        writeRun(v, wordsWas);
        wordsRange = null;
        this.touch();
        this.recount();
        this.refreshState();
        this.$nextTick(() => this.reflowWrap());
      },
      /**
       * Take an object out of the flow and leave it exactly where it was on the
       * page. Parking it at nought and nought put it against the left margin --
       * a centred picture jumped left the moment it was set free, which is not
       * what "place it freely" means to anybody.
       */
      /** Put a freely placed object down where the hand let go of it. */
      dropFreeAt(el, x, y) {
        if (!el || !el.getBoundingClientRect) { return; }
        const r = el.getBoundingClientRect();
        const z = this.frameZoom() || 1;
        const dx = (x - dragGrabX) - r.left;
        const dy = (y - dragGrabY) - r.top;
        el.style.left = round1((parseFloat(el.style.left) || 0) + dx * MM / z) + 'mm';
        el.style.top = round1((parseFloat(el.style.top) || 0) + dy * MM / z) + 'mm';
        this.keepOnPaper(el);
      },
      freeInPlace(el) {
        if (!el || objectFree(el)) { return; }
        const was = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        setObjectFree(el, true);
        el.style.left = '0mm';
        el.style.top = '0mm';
        if (!was || !was.width) { return; }
        const now = el.getBoundingClientRect();
        const z = this.frameZoom() || 1;
        el.style.left = round1((was.left - now.left) * MM / z) + 'mm';
        el.style.top = round1((was.top - now.top) * MM / z) + 'mm';
        this.keepOnPaper(el);
      },
      objectCtx(e) {
        const under = frameEl || document.elementFromPoint(e.clientX, e.clientY);
        this.openCtx({
          clientX: e.clientX, clientY: e.clientY, shiftKey: false, target: under,
          preventDefault() { /* already refused by the binding */ },
        });
      },
      openCtx(e) {
        if (!this.doc.id) { return; }
        const c = canvas();
        if (!c || !inCanvas(e.target)) { return; }
        e.preventDefault();
        const point = caretFromPoint(e.clientX, e.clientY);
        const sel = getRange();
        let inside = false;
        if (sel && !sel.collapsed && point) {
          try { inside = sel.comparePoint(point.startContainer, point.startOffset) === 0; } catch (err) { inside = false; }
        }
        if (point && !inside) { selectRange(point); }
        const at = point && !inside ? point.startContainer : e.target;
        const range = getRange();
        this.ctx.table = !!cellAt(at);
        this.ctx.image = !!imageAt(at);
        this.ctx.captionPlace = this.ctx.image ? captionPlace(imageAt(at)) : '';
        // The right button acts on what it is over, so it also picks the frame up.
        // Writing counts: a paragraph is an object like any other, and the menu is
        // where its wrap, its arrangement and its size are set.
        const obj = objectAt(e.target) || objectAt(at) || thinObjectNear(e.clientX, e.clientY)
          || textBlockAt(e.target) || textBlockAt(at);
        // The right button on an object shows that object's settings, whatever the
        // object is -- not only on the thin band of its border. Inside something
        // written in, a cell or a caption, the menu for text is what is wanted.
        // The right button on an object takes hold of it and shows its menu -- the
        // wrap, the arrangement, the size -- which is where a writer who knows a
        // word processor looks for them. The properties dialogue is one item in it,
        // not the whole answer to a right click.
        if (obj && takesClick(obj, e.target, e.clientX, e.clientY)) {
          frameEl = obj;
          framePinned = true;
          frameTaken = true;
          this.frame.bar = true;
        } else if (obj) { frameEl = obj; framePinned = true; } else { frameEl = null; framePinned = false; }
        this.ctx.frame = !!obj;
        this.syncFrame();
        this.ctx.text = !obj && !!textRange;
        this.ctx.link = !!linkAt(at);
        this.ctx.list = !!(topBlockOf(at) && closestMatching(at, { tag: 'LI' }));
        this.ctx.selection = !!(range && !range.collapsed);
        // Keep the whole menu on screen; its own height is capped in the stylesheet.
        this.ctx.flip = e.clientX > window.innerWidth - 500;
        this.ctx.x = Math.max(6, Math.min(e.clientX, window.innerWidth - 250));
        this.ctx.y = Math.max(6, Math.min(e.clientY, window.innerHeight - 430));
        ctxAt = window.performance ? window.performance.now() : 0;
        this.ctx.open = true;
        this.refreshState();
        // The estimate above keeps it roughly on screen; measuring it settles the rest.
        this.$nextTick(() => {
          const el = document.querySelector('.eb-ctxmenu');
          if (!el) { return; }
          const r = el.getBoundingClientRect();
          if (r.right > window.innerWidth - 6) { this.ctx.x = Math.max(6, window.innerWidth - r.width - 6); }
          if (r.bottom > window.innerHeight - 6) { this.ctx.y = Math.max(6, window.innerHeight - r.height - 6); }
        });
      },
      closeCtx() { this.ctx.open = false; },
      /**
       * Lifting the finger after a long press sends a click at the same spot, which
       * lands on the backdrop and would shut the menu the press just opened.
       */
      closeCtxIfSettled() {
        const now = window.performance ? window.performance.now() : 0;
        if (now - ctxAt < 400) { return; }
        this.closeCtx();
      },
      /** Touch has no hover, so the row itself opens and closes its submenu. */
      toggleFly(e) {
        if (e.target.closest && e.target.closest('.fly')) { return; }
        const row = e.currentTarget;
        const was = row.classList.contains('open');
        const menu = row.closest('.eb-ctxmenu');
        if (menu) { Array.from(menu.querySelectorAll('.has-sub.open')).forEach((n) => n.classList.remove('open')); }
        if (!was) { row.classList.add('open'); }
      },
      /**
       * A submenu opens beside its row, which near the foot of the window would
       * run off the bottom. Measure it once it is up and pull it back inside.
       */
      placeFly(e) {
        const fly = e.currentTarget.querySelector('.fly');
        if (!fly) { return; }
        // On a narrow screen the submenu is stacked under its row, not floated.
        if (window.innerWidth <= 620) { fly.style.top = ''; fly.style.bottom = ''; fly.style.maxHeight = ''; return; }
        fly.style.top = '-6px';
        fly.style.bottom = 'auto';
        fly.style.maxHeight = '';
        const measure = () => {
          const r = fly.getBoundingClientRect();
          if (!r.height) { return; }
          const room = window.innerHeight - 16;
          if (r.height > room) { fly.style.maxHeight = room + 'px'; }
          const after = fly.getBoundingClientRect();
          if (after.bottom > window.innerHeight - 8) {
            fly.style.top = 'auto';
            fly.style.bottom = '-6px';
            const up = fly.getBoundingClientRect();
            if (up.top < 8) { fly.style.bottom = (up.top - 8) + 'px'; }
          }
        };
        measure();
        window.requestAnimationFrame(measure);
      },
      ctxDo(kind, arg) {
        this.closeCtx();
        const acts = {
          block: () => this.setBlock(arg),
          inline: () => this.inline(arg),
          align: () => this.align(arg),
          list: () => this.list(arg),
          indent: () => this.indent(arg),
          clear: () => this.clearFmt(),
          case: () => this.run(() => transformText(arg)),
          para: () => this.openPara(),
          toc: () => this.openToc(),
          chars: () => this.openChars(),
          cut: () => this.clipboard('cut'),
          copy: () => this.clipboard('copy'),
          paste: () => this.pasteFromClipboard(false),
          pasteText: () => this.pasteFromClipboard(true),
          link: () => this.openLink(),
          linkOpen: () => this.openLinkTarget(),
          linkDel: () => this.run(() => removeLink()),
          table: () => this.tableCmd(arg),
          cellAlign: () => this.run(() => setCellAlign(arg)),
          merge: () => this.doMerge(),
          split: () => this.doSplit(),
          image: () => this.imageCmd('size', arg),
          caption: () => this.imageCmd('caption', arg),
          float: () => this.run(() => setImageFloat(arg)),
          alt: () => this.openAlt(),
          imageDel: () => this.imageCmd('delete'),
          frameProps: () => this.openFrameProps(),
          frameFree: () => (frameEl ? this.frameCmd('free') : this.textCmd('free')),
          frameWrap: () => (frameEl ? this.frameCmd('wrap', arg) : this.textCmd('wrap', arg)),
          wrapMode: () => (frameEl ? this.frameCmd('wrapMode', arg) : this.textCmd('wrapMode', arg)),
          framePlain: () => this.frameCmd('plain'),
          runProps: () => this.openRunProps(),
          frameAlign: () => (frameEl ? this.frameCmd('align', arg) : this.textCmd('align', arg)),
          frameFit: () => (frameEl ? this.frameCmd('fit') : this.textCmd('fit')),
          stackStep: () => (frameEl ? this.frameCmd('stack', arg) : this.textCmd('stack', arg)),
          frameInFlow: () => { if (frameEl && objectFree(frameEl)) { this.frameCmd('free'); } },
          frameToPage: () => { if (frameEl && !objectFree(frameEl)) { this.frameCmd('free'); } },
          frameFront: () => (frameEl ? this.frameCmd('stack', 'front') : this.textCmd('stack', 'front')),
          frameBack: () => (frameEl ? this.frameCmd('stack', 'back') : this.textCmd('stack', 'back')),
          frameDel: () => this.frameCmd('delete'),
          guides: () => { this.guides = !this.guides; },
          boxes: () => { this.boxes = !this.boxes; },
        };
        if (acts[kind]) { acts[kind](); }
      },

      // ---- readings, notes, columns, markers and the paintbrush -------------------
      openRuby() {
        this.menu = '';
        const r = getRange();
        const existing = r ? rubyAt(r.startContainer) : null;
        if (existing) {
          const rt = existing.querySelector('rt');
          this.rubyWord = String(existing.textContent || '').replace(String(rt ? rt.textContent : ''), '');
          this.rubyText = rt ? rt.textContent : '';
          ctxRange = r.cloneRange();
        } else {
          if (!r || r.collapsed) { this.notify(this.t('Choose the word first.')); return; }
          this.rubyWord = r.toString();
          this.rubyText = '';
          ctxRange = r.cloneRange();
        }
        this.rubyOpen = true;
        this.$nextTick(() => { if (this.$refs.rubyInput) { this.$refs.rubyInput.focus(); } });
      },
      applyRubyText() {
        const reading = this.rubyText;
        this.rubyOpen = false;
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the text moved on */ } }
        this.run(() => {
          if (rubyAt(getRange() ? getRange().startContainer : null)) { removeRuby(); }
          applyRuby(reading);
        });
      },
      dropRuby() {
        this.rubyOpen = false;
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the text moved on */ } }
        this.run(() => removeRuby());
      },
      openNote() {
        this.menu = '';
        ctxRange = getRange() ? getRange().cloneRange() : null;
        this.noteText = '';
        this.noteOpen = true;
        this.$nextTick(() => { if (this.$refs.noteInput) { this.$refs.noteInput.focus(); } });
      },
      applyNote() {
        const text = this.noteText;
        this.noteOpen = false;
        if (!String(text).trim()) { return; }
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the text moved on */ } }
        this.run(() => insertFootnote(text, this.t('Notes')));
      },
      openCols() {
        this.menu = '';
        ctxRange = getRange() ? getRange().cloneRange() : null;
        const now = columnsAt();
        this.cols.count = now || 2;
        this.colsOpen = true;
      },
      applyCols() {
        const v = { count: Number(this.cols.count) || 1, gap: Number(this.cols.gap) || 0 };
        this.colsOpen = false;
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the text moved on */ } }
        this.blockRun(() => setColumns(v.count, v.gap));
        this.repaginate();
      },
      openRunning() { this.menu = ''; this.runOpen = true; },
      clearRunning() {
        history.pushPrev(this.prevSettings);
        this.doc.paper.header = { l: '', c: '', r: '' };
        this.doc.paper.footer = { l: '', c: '', r: '' };
        this.prevSettings = history.state();
        this.touch();
      },
      setMarker(type) { this.blockRun(() => setListMarker(type)); },
      /**
       * The ruler. Its two outer marks are the paper's margins; the three inner ones
       * are this paragraph's indents, which is the division a word processor makes
       * and the one a writer expects.
       */
      rulerGrab(e, what) {
        const p = normalisePaper(this.doc.paper);
        const start = {
          ml: p.margin.left, mr: p.margin.right,
          left: this.ind.left, right: this.ind.right, first: this.ind.first,
        };
        const block = selectedBlocks(true)[0];
        if (what !== 'ml' && what !== 'mr' && !block) { return; }
        if (what === 'ml' || what === 'mr') { history.push(true); } else { history.push(true); }
        const z = this.frameZoom() || 1;
        const x0 = e.clientX;
        const move = (ev) => {
          const d = Math.round(((ev.clientX - x0) / z * MM) * 2) / 2;
          if (what === 'ml') {
            this.doc.paper.margin.left = Math.max(0, Math.min(100, start.ml + d));
          } else if (what === 'mr') {
            this.doc.paper.margin.right = Math.max(0, Math.min(100, start.mr - d));
          } else if (what === 'left') {
            this.ind.left = Math.max(-50, Math.min(150, start.left + d));
            styleOrClear(block, 'margin-left', this.ind.left ? this.ind.left + 'mm' : '');
          } else if (what === 'right') {
            this.ind.right = Math.max(-50, Math.min(150, start.right - d));
            styleOrClear(block, 'margin-right', this.ind.right ? this.ind.right + 'mm' : '');
          } else if (what === 'first') {
            this.ind.first = Math.max(-50, Math.min(150, start.first + d));
            styleOrClear(block, 'text-indent', this.ind.first ? this.ind.first + 'mm' : '');
          }
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          if (block && !block.getAttribute('style')) { block.removeAttribute('style'); }
          this.touch();
          this.repaginate();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      },
      /** The paintbrush: pick a format up with one press, put it down with the next. */
      useBrush() {
        if (!this.brush) {
          this.brush = pickFormat();
          this.notify(this.t('Format copied. Choose the text to put it on.'));
          return;
        }
        const fmt = this.brush;
        this.brush = null;
        const r = getRange();
        if (!r || r.collapsed) { this.notify(this.t('Choose the text first.')); return; }
        this.run(() => paintFormat(fmt));
      },

      // ---- paragraph, contents, characters --------------------------------------
      openPara() {
        const now = paragraphProps();
        ctxRange = getRange() ? getRange().cloneRange() : null;
        if (now) { this.para = Object.assign({}, now); }
        this.paraOpen = true;
      },
      applyPara() {
        const v = Object.assign({}, this.para);
        this.paraOpen = false;
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the text moved on */ } }
        this.blockRun(() => setParagraphProps(v));
        this.repaginate();
      },
      clearPara() {
        this.para = { align: '', lineHeight: '', before: '', after: '', left: '', right: '', firstLine: '', pageBefore: false, keepWithNext: false, keepTogether: false, noLoneLines: false,
          border: '', borderSides: 'all', borderWidth: '', borderColour: '#666666', fill: '', pad: '' };
      },
      openToc() {
        ctxRange = getRange() ? getRange().cloneRange() : null;
        if (!this.tocTitle) { this.tocTitle = this.t('Contents'); }
        this.tocOpen = true;
      },
      applyToc() {
        const title = this.tocTitle;
        this.tocOpen = false;
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the text moved on */ } }
        let ok = false;
        this.run(() => { ok = buildToc(title); });
        if (!ok) { this.notify(this.t('Give the document some headings first — the contents are built from them.')); }
        this.repaginate();
      },
      openChars() {
        ctxRange = getRange() ? getRange().cloneRange() : null;
        this.charsOpen = true;
      },
      pickChar(ch) {
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the text moved on */ } }
        this.run(() => insertText(ch));
        ctxRange = getRange() ? getRange().cloneRange() : null;
      },
      charsOf(key) {
        const set = CHAR_SETS.find((c) => c.key === key);
        return set ? Array.from(set.chars) : [];
      },
      toggleSpellcheck() {
        this.spellcheck = !this.spellcheck;
        window.localStorage.setItem('eb-spellcheck', this.spellcheck ? '1' : '0');
      },
      toggleAutolink() {
        this.autolink = !this.autolink;
        window.localStorage.setItem('eb-autolink', this.autolink ? '1' : '0');
      },

      /**
       * A software keyboard covers the bottom of the window without resizing the
       * page, so the line being typed can end up behind it. visualViewport is what
       * knows where the keyboard starts.
       */
      keepCaretVisible() {
        if (!this.narrow) { return; }
        const c = canvas();
        if (!c || document.activeElement !== c) { return; }
        const r = getRange();
        if (!r) { return; }
        let rect = r.getBoundingClientRect();
        if (!rect || (!rect.height && !rect.width)) {
          const block = topBlockOf(r.startContainer);
          rect = block ? block.getBoundingClientRect() : null;
        }
        if (!rect) { return; }
        const vv = window.visualViewport;
        const bottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
        const desk = document.querySelector('.eb-desk');
        if (!desk) { return; }
        if (rect.bottom > bottom - 16) { desk.scrollTop += rect.bottom - bottom + 72; }
        else if (rect.top < desk.getBoundingClientRect().top + 8) { desk.scrollTop -= (desk.getBoundingClientRect().top + 8 - rect.top); }
      },

      // ---- narrow screens ------------------------------------------------------
      /**
       * A phone has no room for a sidebar beside the page, so it becomes a drawer
       * that starts closed; and an A4 page is wider than the screen, so the zoom
       * starts at whatever makes it fit.
       */
      measureWidth() {
        // Width alone is not enough: a phone asked for "desktop site" reports about
        // 980px, and then none of this would apply on the very device that needs it.
        // A coarse pointer is a finger, whatever the browser claims about width.
        const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        this.coarse = coarse;
        const narrow = window.innerWidth <= 860 || (coarse && window.innerWidth <= 1100);
        const became = narrow && !this.narrow;
        this.narrow = narrow;
        if (became) { this.sideOpen = false; }
        if (!narrow && !this.sideOpen && window.innerWidth > 1100) { this.sideOpen = true; }
        // An A4 page shrunk to a phone renders 10.5pt text at about six pixels,
        // which can be looked at but not read or written. So on a narrow screen
        // the text flows to the screen instead, at a size a person can read; the
        // document itself is untouched and still prints as A4.
        // The choice is remembered per screen class: what suits a phone is not what
        // suits a desktop, and one browser profile may see both.
        const pref = this.flowPref[narrow ? 'narrow' : 'wide'];
        // A tablet still shows a whole A4 page at a readable size; a phone does not.
        this.setFlow(pref == null ? (window.innerWidth <= 700 || (coarse && window.innerWidth <= 820)) : pref);
        this.fitZoom();
      },
      setFlow(on) {
        if (this.flow === on) { return; }
        this.flow = on;
        this.$nextTick(() => {
          if (on) { this.repaginate(); } else { this.zoomSetByHand = false; this.fitZoom(); this.repaginate(); }
        });
      },
      toggleFlow() {
        this.setFlow(!this.flow);
        this.flowPref[this.narrow ? 'narrow' : 'wide'] = this.flow;
        try { window.localStorage.setItem('eb-flow', JSON.stringify(this.flowPref)); } catch (e) { /* private mode */ }
      },
      fitZoom() {
        if (this.flow) { this.zoom = 100; return; }
        if (!this.narrow || this.zoomSetByHand) { return; }
        const desk = document.querySelector('.eb-desk');
        if (!desk) { return; }
        const room = desk.clientWidth - 12;
        // sheet() speaks millimetres; the desk speaks CSS pixels.
        const paper = sheet(this.doc.paper).w * 96 / 25.4;
        if (!room || !paper) { return; }
        const fit = Math.floor((room / paper) * 100);
        this.zoom = Math.min(100, Math.max(25, fit));
      },

      // ---- dragging ------------------------------------------------------------
      /**
       * A browser drags a picture by itself, and hands the drop a copy of it. Left
       * alone, dropping it somewhere else in the same document put a second copy
       * in and left the first where it was. What is being dragged is remembered
       * here, so the drop can move that very element instead of copying it.
       */
      onDragStart(e) {
        const r = getRange();
        dragRange = r && !r.collapsed ? r.cloneRange() : null;
        const t = e && e.target && e.target.nodeType === 1 ? e.target : null;
        const el = t && t.closest ? (t.closest(OBJECT_SEL) || (t.nodeName === 'IMG' ? t.closest('figure') : null)) : null;
        dragObject = el && inCanvas(el) ? el : null;
        // Where inside it the hand took hold, so it can be put down under the
        // same spot rather than jumping its corner to the pointer.
        if (dragObject && e && e.clientX != null && dragObject.getBoundingClientRect) {
          const r = dragObject.getBoundingClientRect();
          dragGrabX = e.clientX - r.left;
          dragGrabY = e.clientY - r.top;
        } else { dragGrabX = 0; dragGrabY = 0; }
        // The object itself is what moves; a selection inside it would be moved
        // twice over.
        if (dragObject) { dragRange = null; }
      },
      onDragOver(e) {
        if (!this.doc.id) { return; }
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = (dragObject || dragRange) ? 'move' : 'copy';
        }
        // Show where it would land, the way a text cursor does.
        const point = caretFromPoint(e.clientX, e.clientY);
        if (point && !pointInsideRange(dragRange, point)) { selectRange(point); }
      },
      onDrop(e) {
        if (!this.doc.id) { return; }
        e.preventDefault();
        dropX = e.clientX;
        dropY = e.clientY;
        const point = caretFromPoint(e.clientX, e.clientY);
        // A picture dragged inside the document is handed back to us by the
        // browser as a FILE -- Chromium makes one out of the image being dragged.
        // Taken at face value that is a new picture arriving from outside, and it
        // was inserted as one: the original stayed where it was and a copy landed
        // where it was dropped. Drag and drop became copy and paste.
        //
        // If the drag started in this document, it is our own object coming back
        // and there is no file to speak of, whatever the browser says.
        const fromHere = !!(dragObject || dragRange);
        const files = (!fromHere && e.dataTransfer) ? Array.from(e.dataTransfer.files || []) : [];
        if (files.some((f) => /^image\//.test(f.type))) {
          if (point) { selectRange(point); }
          dragRange = null;
          this.insertPastedFiles(files);
          return;
        }
        // An object standing on the paper is moved by its coordinates: the writer
        // is pointing at a place on the page, not at a place in the text. Sending
        // it to the paragraph under the pointer instead is what sent it back to
        // the left margin -- its own left and top were measured from an anchor
        // that had moved somewhere else entirely.
        if (dragObject && objectFree(dragObject)) {
          const moving = dragObject;
          this.run(() => this.dropFreeAt(moving, e.clientX, e.clientY));
          dragRange = null;
          dragObject = null;
          this.settleFrame();
          return;
        }
        const data = e.dataTransfer;
        let ok = false;
        this.run(() => { ok = dropAt(point, data); });
        dragRange = null;
        dragObject = null;
        if (!ok) { this.notify(this.t('There is nowhere to drop that.')); }
        this.repaginate();
      },
      onDragEnd() { dragRange = null; dragObject = null; },

      // ---- clipboard -----------------------------------------------------------
      clipboard(kind) {
        let ok = false;
        try { ok = document.execCommand(kind); } catch (e) { ok = false; }
        if (!ok) {
          this.notify(this.t('The browser only allows this from the keyboard: {keys}', { keys: kind === 'cut' ? 'Ctrl+X' : 'Ctrl+C' }));
          return;
        }
        if (kind === 'cut') { this.touch(); this.recount(); this.repaginate(); }
      },
      /**
       * Reading the clipboard needs the browser's permission, which it only gives
       * to a page the reader is using. If it says no, say which keys do work
       * rather than failing silently.
       */
      async pasteFromClipboard(plainOnly) {
        let html = '';
        let text = '';
        try {
          if (!plainOnly && navigator.clipboard && navigator.clipboard.read) {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              const types = item.types || [];
              if (types.indexOf('text/html') >= 0) { html = await (await item.getType('text/html')).text(); break; }
              if (types.indexOf('text/plain') >= 0) { text = await (await item.getType('text/plain')).text(); }
            }
          } else if (navigator.clipboard && navigator.clipboard.readText) {
            text = await navigator.clipboard.readText();
          }
        } catch (e) {
          this.notify(this.t('The browser would not hand over the clipboard. Use {keys} instead.', { keys: plainOnly ? 'Ctrl+Shift+V' : 'Ctrl+V' }));
          return;
        }
        if (!html && !text) { return; }
        // The right button's Paste behaves as Ctrl+V does, and its "as plain text"
        // is the same escape hatch Shift gives on the keyboard.
        const asObject = this.pasteObject && !plainOnly && !pasteWouldNest();
        let out = {};
        this.run(() => { out = html ? pasteHtmlAt(html, '', asObject) : { made: pasteTextAt(text, asObject), foreign: [] }; });
        if (out.made) {
          frameEl = out.made;
          frameMore = [];
          framePinned = true;
          frameTaken = true;
          this.frame.bar = true;
          this.settleFrame();
        }
        this.repaginate();
        this.askAboutForeign(out.foreign);
      },

      // ---- links ---------------------------------------------------------------
      openLink() {
        const a = linkAt();
        const r = getRange();
        ctxRange = r ? r.cloneRange() : null;
        this.link.editing = !!a;
        this.link.url = a ? (a.getAttribute('href') || '') : '';
        this.link.text = a ? a.textContent : (r && !r.collapsed ? String(r) : '');
        this.linkOpen = true;
      },
      applyLinkDialog() {
        const url = this.link.url;
        const text = this.link.text;
        this.linkOpen = false;
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the text moved on */ } }
        let ok = false;
        this.run(() => { ok = applyLink(url, text); });
        if (!ok) { this.notify(this.t('That address cannot be linked to.')); }
      },
      openLinkTarget() {
        const a = linkAt();
        if (a) { window.open(a.getAttribute('href'), '_blank', 'noopener'); }
      },

      // ---- pictures and cells --------------------------------------------------
      openAlt() {
        ctxRange = getRange() ? getRange().cloneRange() : null;
        this.altText = imageAlt();
        this.altOpen = true;
      },
      applyAlt() {
        const text = this.altText;
        this.altOpen = false;
        if (ctxRange) { try { selectRange(ctxRange); } catch (e) { /* the picture moved on */ } }
        this.run(() => setImageAlt(text));
      },
      doMerge() {
        let ok = false;
        this.run(() => { ok = mergeCells(); });
        if (!ok) { this.notify(this.t('Select the cells to merge first. Cells that already span out of the selection cannot be merged.')); }
      },
      doSplit() {
        let ok = false;
        this.run(() => { ok = splitCell(); });
        if (!ok) { this.notify(this.t('This cell is not a merged one.')); }
      },

      undo() { canvas().focus(); if (history.undo()) { this.touch(); this.refreshState(); this.recount(); } },
      redo() { canvas().focus(); if (history.redo()) { this.touch(); this.refreshState(); this.recount(); } },

      // ---- settings ----
      docLang() { return (document.documentElement.lang || 'ja').slice(0, 5); },
      async saveSettings() {
        try {
          await api('settings', { method: 'POST', body: { folder: this.settings.folder, theme: this.settings.theme, language: this.settings.language } });
          this.applyTheme(this.settings.theme);
          await this.applyLanguage(this.settings.language);
          await this.loadDocs();
          this.settingsOpen = false;
          this.notify(this.t('Settings saved'));
        } catch (e) { this.notify(this.t('Could not save the settings: {msg}', { msg: e.message })); }
      },
      async saveDefaultPaper() {
        this.defaultPaper = normalisePaper(this.doc.paper);
        try {
          await api('settings', { method: 'POST', body: { paper: JSON.stringify(this.defaultPaper) } });
          this.notify(this.t('New documents will start with this paper setup.'));
        } catch (e) { this.notify(this.t('Could not save the settings: {msg}', { msg: e.message })); }
      },
      applyTheme(pref) {
        const root = document.getElementById('editbase-root');
        if (!root) { return; }
        root.dataset.theme = pref;
        if (pref === 'auto') {
          const resolved = ncIsDark();
          if (resolved === null) { delete root.dataset.ebtheme; } else { root.dataset.ebtheme = resolved ? 'dark' : 'light'; }
        } else {
          root.dataset.ebtheme = pref;
        }
      },
      async applyLanguage(lang) {
        if (!lang || lang === 'auto') { i18nOverride = null; } else {
          try {
            const r = await api('i18n/' + encodeURIComponent(lang));
            i18nOverride = (r && r.translations) ? r.translations : {};
          } catch (e) { i18nOverride = null; }
        }
        this.$forceUpdate();
      },

      /**
       * With changes being recorded, typing goes into a run marked as added and a
       * deletion strikes the text out instead of taking it away. The browser tells
       * us exactly what it is about to remove, which is what makes this workable:
       * getTargetRanges is the whole trick.
       */
      onBeforeInput(e) {
        frameTaken = false;
        history.push(false);
        if (!this.review || !this.doc.id) { return; }
        const type = String(e.inputType || '');
        if (/^delete/.test(type)) {
          const ranges = (e.getTargetRanges && e.getTargetRanges()) || [];
          const target = ranges.length ? ranges[0] : null;
          const range = target ? (function () {
            const r = document.createRange();
            r.setStart(target.startContainer, target.startOffset);
            r.setEnd(target.endContainer, target.endOffset);
            return r;
          }()) : null;
          if (!range || range.collapsed || !inCanvas(range.startContainer)) { return; }
          e.preventDefault();
          history.push(true);
          const back = /Backward|ByCut|SoftLineBackward|WordBackward/.test(type);
          const at = document.createRange();
          at.setStart(back ? range.startContainer : range.endContainer, back ? range.startOffset : range.endOffset);
          at.collapse(true);
          markDeleted(range);
          try { selectRange(at); } catch (err) { /* the text moved under us */ }
          this.settleReview();
          return;
        }
        if (/^insert/.test(type) && type !== 'insertCompositionText') {
          const sel = getRange();
          if (sel && !sel.collapsed) {
            e.preventDefault();
            history.push(true);
            const end = document.createRange();
            end.setStart(sel.endContainer, sel.endOffset);
            end.collapse(true);
            markDeleted(sel);
            try { selectRange(end); } catch (err) { /* the text moved under us */ }
            ensureIns();
            if (type === 'insertText' && e.data) { insertText(e.data); }
            this.settleReview();
            return;
          }
          ensureIns();
        }
      },
      settleReview() {
        this.touch();
        this.recount();
        this.$nextTick(() => this.refreshState());
      },
      onKey(e) {
        const meta = e.ctrlKey || e.metaKey;
        // A paste event carries no keys of its own -- it is not a keyboard event --
        // so the one that started it is remembered here. Shift is what says "into
        // the writing, as plain text", as it does everywhere else.
        if (meta && (e.key === 'v' || e.key === 'V')) { pastePlain = !!e.shiftKey; }
        if (e.key === 'Escape' && this.frame.on) { this.clearFrame(); return undefined; }
        // Arrow keys walk a parked frame about the page: a millimetre a press, five
        // with Shift, a fifth with Alt. Anywhere else they belong to the caret.
        if (frameTaken && frameEl && objectFree(frameEl) && !meta
          && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
          const step = e.shiftKey ? 5 : (e.altKey ? 0.2 : 1);
          const dx = (e.key === 'ArrowLeft' ? -step : (e.key === 'ArrowRight' ? step : 0));
          const dy = (e.key === 'ArrowUp' ? -step : (e.key === 'ArrowDown' ? step : 0));
          const each = frameAll().filter((o) => objectFree(o));
          if (each.length) {
            e.preventDefault();
            history.push(true);
            each.forEach((o) => {
              o.style.left = round1((parseFloat(o.style.left) || 0) + dx) + 'mm';
              o.style.top = round1((parseFloat(o.style.top) || 0) + dy) + 'mm';
              this.keepOnPaper(o);
            });
            this.settleFrame();
            return undefined;
          }
        }
        // A block still in the run of the text is not walked about with the arrows:
        // the caret is. Let go of it, so the box follows the caret to wherever it
        // goes rather than staying behind on the paragraph the bar was last used on.
        if (frameEl && !objectFree(frameEl) && !meta
          && /^(Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(e.key)) {
          frameTaken = false;
          framePinned = false;
        }
        // Ctrl+D leaves a copy a few millimetres down and across, ready to be
        // dragged off -- the quickest way to lay out a row of the same thing.
        if (meta && !e.altKey && e.key.toLowerCase() === 'd' && frameTaken && frameEl) {
          e.preventDefault();
          this.duplicateFrame();
          return undefined;
        }
        // A picture with its box up goes when Delete is pressed, the way it does
        // in every word processor. Text being written inside a frame does not:
        // there the key deletes a character, as it always has.
        if ((e.key === 'Delete' || e.key === 'Backspace') && frameTaken && frameEl) {
          e.preventDefault();
          if (frameMore.length) {
            history.push(true);
            frameAll().forEach((o) => deleteObject(o));
            this.clearFrame();
            this.settleFrame();
            return undefined;
          }
          this.frameCmd('delete');
          return undefined;
        }
        if (meta && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          this.run(() => moveBlock(e.key === 'ArrowUp' ? -1 : 1));
          return undefined;
        }
        if (meta && !e.altKey) {
          const k = e.key.toLowerCase();
          if (k === 'b') { e.preventDefault(); return this.inline('bold'); }
          if (k === 'i') { e.preventDefault(); return this.inline('italic'); }
          if (k === 'u') { e.preventDefault(); return this.inline('underline'); }
          if (k === 's') { e.preventDefault(); return this.save(); }
          if (k === 'p') { e.preventDefault(); return this.printDoc(); }
          if (k === 'f') { e.preventDefault(); return this.openFind(); }
          if (k === 'k') { e.preventDefault(); return this.openLink(); }
          if (k === 'h') { e.preventDefault(); return this.openFind(); }
          if (k === 'z' && !e.shiftKey) { e.preventDefault(); return this.undo(); }
          if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); return this.redo(); }
        }
        if (this.autolink && (e.key === ' ' || e.key === 'Enter') && !meta && urlBeforeCaret()) {
          this.run(() => autoLink());
        }
        // Tab indents the paragraph instead of leaving the document.
        if (e.key === 'Tab') {
          e.preventDefault();
          if (cellAt()) {
            // Only adding a row is a change worth recording; walking is not.
            if (!e.shiftKey && atLastCell()) { this.run(() => moveCell(1)); } else { moveCell(e.shiftKey ? -1 : 1); this.refreshState(); }
            return undefined;
          }
          return this.indent(e.shiftKey ? -1 : 1);
        }
        return undefined;
      },

      async boot() {
        const root = document.getElementById('editbase-root');
        this.version = (root && root.dataset.version) || '';
        try {
          const s = await api('settings');
          this.settings.folder = s.folder || 'EditBase';
          this.settings.theme = s.theme || 'auto';
          this.settings.language = s.language || 'auto';
          this.settings.languages = s.languages || [];
          if (s.paper) { try { this.defaultPaper = normalisePaper(JSON.parse(s.paper)); } catch (e) { /* keep the built-in default */ } }
          this.build = s.build || '';
        } catch (e) { /* the app still works with the defaults */ }
        this.watchForNewBuild();
        this.applyTheme(this.settings.theme);
        if (this.settings.language && this.settings.language !== 'auto') { await this.applyLanguage(this.settings.language); }
        await this.loadDocs();
        this.loadSources();
        const wanted = Number((root && root.dataset.fileid) || 0);
        const last = Number(window.localStorage.getItem('eb-last-doc') || 0);
        const target = wanted || (this.docs.some((d) => d.id === last) ? last : (this.docs[0] && this.docs[0].id));
        if (target) { await this.openDoc(target); }
      },
    },
    watch: {
      'doc.id'(id) { if (id) { window.localStorage.setItem('eb-last-doc', String(id)); } },
      'doc.paper.fonts': { deep: true, handler() { this.applyDocFonts(); } },
      'doc.paper.font'() { this.applyDocFonts(); },
      'doc.paper.fontSize'() { this.touch(); this.$nextTick(() => this.repaginate()); },
      'doc.paper.lineHeight'() { this.touch(); this.$nextTick(() => this.repaginate()); },
      'doc.paper.size'() { this.$nextTick(() => this.repaginate()); },
      'doc.paper.orientation'() { this.$nextTick(() => this.repaginate()); },
      'doc.paper.margin': { deep: true, handler() { this.$nextTick(() => this.repaginate()); } },
      fontPageItems() { this.loadPreviewFonts(); },
      zoom(v) { window.localStorage.setItem('eb-zoom', String(v)); this.$nextTick(() => this.syncFrame()); },
      flow() { this.$nextTick(() => this.syncFrame()); },
      'doc.paper': { deep: true, handler() { if (this.doc.id) { this.dirty = true; this.scheduleAutosave(); } } },
      autosave(v) { window.localStorage.setItem('eb-autosave', v ? '1' : '0'); },
      guides(v) { window.localStorage.setItem('eb-guides', v ? '1' : '0'); },
      boxes(v) { window.localStorage.setItem('eb-boxes', v ? '1' : '0'); },
      layersOpen(v) {
        window.localStorage.setItem('eb-layers', v ? '1' : '0');
        this.$nextTick(() => this.refreshLayers());
      },
      previewOpen(v) {
        window.localStorage.setItem('eb-preview', v ? '1' : '0');
        this.$nextTick(() => this.refreshPreview());
      },
      pasteObject(v) { window.localStorage.setItem('eb-paste-object', v ? '1' : '0'); },
      ruler(v) { window.localStorage.setItem('eb-ruler', v ? '1' : '0'); this.$nextTick(() => this.syncFrame()); },
      review(v) { window.localStorage.setItem('eb-review', v ? '1' : '0'); },
    },
    mounted() {
      canvasEl = document.getElementById('eb-canvas');
      history.readState = () => JSON.stringify({ paper: this.doc.paper, styles: this.doc.styles });
      history.applyState = (raw) => {
        let v = null;
        try { v = JSON.parse(raw); } catch (e) { return; }
        this.doc.paper = normalisePaper(v.paper);
        this.doc.styles = normaliseStyles(v.styles);
        this.applyDocStyles();
      };
      const style = document.createElement('style');
      style.id = 'eb-doc-style';
      style.textContent = DOC_CSS + EDITOR_CSS;
      document.head.appendChild(style);

      const stored = window.localStorage.getItem('eb-autosave');
      if (stored != null) { this.autosave = stored === '1'; }
      try {
        const fl = JSON.parse(window.localStorage.getItem('eb-flow') || '{}');
        if (fl && typeof fl === 'object') { this.flowPref = fl; }
      } catch (e) { /* nothing remembered */ }
      const sp = window.localStorage.getItem('eb-spellcheck');
      if (sp != null) { this.spellcheck = sp === '1'; }
      const al = window.localStorage.getItem('eb-autolink');
      if (al != null) { this.autolink = al === '1'; }
      const g = window.localStorage.getItem('eb-guides');
      if (g != null) { this.guides = g === '1'; }
      const bx = window.localStorage.getItem('eb-boxes');
      if (bx != null) { this.boxes = bx === '1'; }
      const po = window.localStorage.getItem('eb-paste-object');
      if (po != null) { this.pasteObject = po === '1'; }
      const ly = window.localStorage.getItem('eb-layers');
      if (ly != null) { this.layersOpen = ly === '1'; }
      const pv = window.localStorage.getItem('eb-preview');
      if (pv != null) { this.previewOpen = pv === '1'; }
      const rl = window.localStorage.getItem('eb-ruler');
      if (rl != null) { this.ruler = rl === '1'; }
      const rv = window.localStorage.getItem('eb-review');
      if (rv != null) { this.review = rv === '1'; }
      const z = Number(window.localStorage.getItem('eb-zoom') || 0);
      if (z >= 50 && z <= 200) { this.zoom = z; }
      document.addEventListener('click', (e) => {
        if (this.menu && !e.target.closest('.eb-pop')) { this.menu = ''; }
      });
      // Escape closes whatever is on top: a popup menu, then a modal, then the find bar.
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') { return; }
        if (this.ctx.open) { this.closeCtx(); e.preventDefault(); return; }
        if (this.menu) { this.menu = ''; e.preventDefault(); return; }
        const modals = ['charsOpen', 'tocOpen', 'paraOpen', 'linkOpen', 'altOpen', 'fontsOpen', 'pickerOpen', 'mergeOpen', 'sourceOpen', 'mathOpen',
          'tableOpen', 'paperOpen', 'settingsOpen', 'menuOpen'];
        for (const key of modals) {
          if (!this[key]) { continue; }
          if (key === 'fontsOpen') { this.closeFonts(); } else { this[key] = false; }
          e.preventDefault();
          return;
        }
        if (this.find.open) { this.closeFind(); e.preventDefault(); }
      });

      const c = canvasEl;
      c.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
      c.addEventListener('compositionstart', () => { if (this.review) { ensureIns(); } });
      c.addEventListener('input', () => {
        // Splitting a paragraph inside a mark leaves the empty half behind, and
        // typing does not go through a command, so it is swept up here.
        if (this.review) { tidyMarks(); this.changes = countChanges(); }
        this.touch();
        this.recount();
        this.queueWrap();
        this.keepCaretVisible();
      });
      c.addEventListener('paste', (e) => {
        const files = e.clipboardData ? Array.from(e.clipboardData.files || []) : [];
        if (files.some((f) => /^image\//.test(f.type))) {
          e.preventDefault();
          this.insertPastedFiles(files);
          return;
        }
        const plain = pastePlain;
        pastePlain = false;
        const asObject = this.pasteObject && !plain && !pasteWouldNest();
        const out = handlePaste(e, plain, asObject) || {};
        if (out.made) {
          frameEl = out.made;
          frameMore = [];
          framePinned = true;
          frameTaken = true;
          this.frame.bar = true;
          this.settleFrame();
        }
        this.touch();
        this.recount();
        this.askAboutForeign(out.foreign);
      });
      c.addEventListener('keydown', (e) => this.onKey(e));
      c.addEventListener('contextmenu', (e) => this.openCtx(e));

      c.addEventListener('pointerdown', (e) => this.onCanvasDown(e));
      c.addEventListener('pointermove', (e) => this.frameHover(e), { passive: true });
      // Safari on a phone does not always raise contextmenu, so a long press on
      // the page opens the same menu: half a second, without the finger moving.
      let holdTimer = null;
      let holdAt = null;
      let holdStart = 0;
      const cancelHold = () => { window.clearTimeout(holdTimer); holdTimer = null; };
      c.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) { return cancelHold(); }
        const t = e.touches[0];
        holdAt = { x: t.clientX, y: t.clientY };
        holdStart = Date.now();
        cancelHold();
        holdTimer = window.setTimeout(() => {
          this.openCtx({
            clientX: holdAt.x, clientY: holdAt.y, shiftKey: false,
            target: document.elementFromPoint(holdAt.x, holdAt.y),
            preventDefault() { /* nothing to cancel: the browser has not acted yet */ },
          });
        }, 550);
        return undefined;
      }, { passive: true });
      c.addEventListener('touchmove', (e) => {
        const t = e.touches && e.touches[0];
        if (!t || !holdAt) { return; }
        if (Math.abs(t.clientX - holdAt.x) > 8 || Math.abs(t.clientY - holdAt.y) > 8) { cancelHold(); }
      }, { passive: true });
      c.addEventListener('touchend', cancelHold, { passive: true });
      c.addEventListener('touchcancel', () => {
        // Safari cancels the touch when it takes the gesture for its own callout.
        // If the press was long enough, it was meant for our menu.
        if (holdTimer && holdAt && Date.now() - holdStart > 400) {
          const at = holdAt;
          cancelHold();
          this.openCtx({
            clientX: at.x, clientY: at.y, shiftKey: false,
            target: document.elementFromPoint(at.x, at.y),
            preventDefault() { /* the browser has already given up the gesture */ },
          });
          return;
        }
        cancelHold();
      }, { passive: true });
      // The browser's own menu, everywhere in the app at once. The canvas has its
      // own handler above; this one runs after it and refuses the browser's menu
      // whatever was clicked -- the toolbar, the shelf, the paper's margins, a
      // dialogue, the list of documents. One place, so there is no corner left.
      const appRoot = document.getElementById('editbase-root') || c;
      appRoot.addEventListener('contextmenu', (e) => { e.preventDefault(); });
      c.addEventListener('dragstart', (e) => this.onDragStart(e));
      c.addEventListener('dragover', (e) => this.onDragOver(e));
      c.addEventListener('drop', (e) => this.onDrop(e));
      c.addEventListener('dragend', () => this.onDragEnd());
      // Everywhere else in the app. Something dragged out of the document and
      // dropped on the toolbar, the shelf, the margin or the grey around the
      // paper must come to nothing -- not to a copy left wherever it landed.
      appRoot.addEventListener('dragstart', (e) => {
        if (dragObject || dragRange) { return; }
        this.onDragStart(e);
      });
      appRoot.addEventListener('dragover', (e) => {
        if (!dragObject && !dragRange) { return; }
        if (inCanvas(e.target)) { return; }
        e.preventDefault();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
      });
      appRoot.addEventListener('drop', (e) => {
        if (inCanvas(e.target)) { return; }
        // On the paper but off the writing: put it where the pointer is, which is
        // what the writer meant. Anywhere else in the app: nothing at all.
        if (dragObject || dragRange) { e.preventDefault(); }
        if (!dragObject) { dragRange = null; dragObject = null; return; }
        const onPaper = e.target && e.target.closest && e.target.closest('.eb-paperwrap');
        if (onPaper) {
          dropX = e.clientX;
          dropY = e.clientY;
          this.run(() => { dropAt(caretFromPoint(e.clientX, e.clientY), null); });
          this.settleFrame();
        }
        dragRange = null;
        dragObject = null;
      });
      window.addEventListener('resize', () => { this.closeCtx(); this.measureWidth(); });
      // A swipe in from the left edge opens the drawer, as a phone expects.
      let swipeFrom = null;
      document.addEventListener('touchstart', (e) => {
        const t = e.touches && e.touches[0];
        swipeFrom = (t && this.narrow && t.clientX < 24) ? { x: t.clientX, y: t.clientY } : null;
      }, { passive: true });
      document.addEventListener('touchmove', (e) => {
        const t = e.touches && e.touches[0];
        if (!swipeFrom || !t) { return; }
        if (t.clientX - swipeFrom.x > 40 && Math.abs(t.clientY - swipeFrom.y) < 40) {
          this.sideOpen = true;
          swipeFrom = null;
        }
      }, { passive: true });
      document.addEventListener('touchend', () => { swipeFrom = null; }, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => this.keepCaretVisible());
      }
      this.measureWidth();
      document.addEventListener('scroll', () => this.closeCtx(), true);
      document.addEventListener('selectionchange', () => { if (getRange()) { this.refreshState(); } });
      window.addEventListener('beforeunload', (e) => {
        if (this.dirty) { e.preventDefault(); e.returnValue = ''; }
      });
      this.boot();
    },
    beforeUnmount() { clearTimeout(this._saveTimer); clearTimeout(this._toastTimer); },
  });

  /** Nextcloud's dark mode is a theme app, not a media query, so ask the page. */
  const URL_BEFORE = /(?:^|[\s　(（「『])((?:https?:\/\/[^\s　）」』]+)|(?:www\.[^\s　）」』]+)|(?:[^\s　@（）「」]+@[^\s　@（）「」]+\.[A-Za-z]{2,}))$/;
  /** The address the caret has just finished typing, if that is what it is. */
  function urlBeforeCaret() {
    const r = getRange();
    if (!r || !r.collapsed || r.startContainer.nodeType !== 3) { return null; }
    if (linkAt(r.startContainer)) { return null; }
    const m = r.startContainer.data.slice(0, r.startOffset).match(URL_BEFORE);
    return m ? { node: r.startContainer, end: r.startOffset, text: m[1] } : null;
  }
  /** Turn it into a link and leave the caret outside, so the next word is plain. */
  function autoLink() {
    const found = urlBeforeCaret();
    if (!found) { return false; }
    const r = document.createRange();
    r.setStart(found.node, found.end - found.text.length);
    r.setEnd(found.node, found.end);
    selectRange(r);
    if (!applyLink(found.text, '')) { return false; }
    const a = linkAt();
    if (a) {
      const after = document.createRange();
      after.setStartAfter(a);
      after.collapse(true);
      selectRange(after);
    }
    return true;
  }

  // ---- dragging inside the document ------------------------------------------------
  // Left to itself the browser moves the markup its own way: blocks end up inside
  // paragraphs, computed styles come along for the ride, and nothing reaches the
  // undo history. So the drop is done here, through the same path as every edit.
  let dragRange = null;
  let dragObject = null;
  let dragGrabX = 0;
  let dragGrabY = 0;
  let dropY = null;
  let dropX = null;
  /** The block a drop landed on, at the level the object would stand at. */
  function blockUnder(node) {
    const c = canvas();
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== c && n.nodeType === 1) {
      const parent = n.parentNode;
      if (parent === c || (parent && parent.matches && parent.matches(BLOCK_HOSTS))) { return n; }
      n = parent;
    }
    return null;
  }

  /** Is the drop point inside the thing being dragged? Then there is nowhere to put it. */
  function pointInsideRange(range, point) {
    if (!range || !point) { return false; }
    try {
      return range.comparePoint(point.startContainer, point.startOffset) === 0;
    } catch (e) {
      return false;
    }
  }

  /** Markup from somewhere else, cleaned the same way a paste is. */
  function fragmentFromTransfer(data) {
    if (!data) { return null; }
    const html = data.getData('text/html');
    const holder = document.createElement('div');
    if (html) {
      holder.innerHTML = html;
      sanitiseInto(holder);
      holder.querySelectorAll('*').forEach((el) => {
        if (el.hasAttribute('style')) {
          const keep = cleanStyle(el.getAttribute('style')).split('; ')
            .filter((d) => /^(color|background-color|text-align)/.test(d)).join('; ');
          if (keep) { el.setAttribute('style', keep); } else { el.removeAttribute('style'); }
        }
      });
      stripFurniture(holder, true);
    } else {
      const text = data.getData('text/plain') || '';
      if (!text) { return null; }
      text.split(/\r?\n/).forEach((line, i) => {
        if (i) { holder.appendChild(document.createElement('br')); }
        holder.appendChild(document.createTextNode(line));
      });
    }
    if (!holder.firstChild) { return null; }
    const frag = document.createDocumentFragment();
    while (holder.firstChild) { frag.appendChild(holder.firstChild); }
    return frag;
  }

  /**
   * A move inside the document takes the markup itself rather than the browser's
   * copy of it, so a formula or a table arrives exactly as it left.
   */
  /**
   * The block the pointer is over, when the caret cannot be read from the point.
   * A browser only answers caretRangeFromPoint for what is on the screen, so a
   * drop just past the bottom edge came back with nothing and the drop was
   * refused -- "there is nowhere to drop that" over a perfectly good paragraph.
   */
  function blockAtPointer() {
    if (dropX == null || dropY == null || !document.elementFromPoint) { return null; }
    const el = document.elementFromPoint(dropX, dropY);
    return el && inCanvas(el) ? blockUnder(el) : null;
  }
  function dropAt(point, data) {
    // Something from this document, dragged: it moves. The browser would hand us
    // a copy of it and leave the original standing.
    if (dragObject) {
      const at = point && inCanvas(point.startContainer) ? point.startContainer : null;
      const say = (why) => { window.__eb_lastDrop = { refused: why }; return false; };
      if (at && dragObject.contains(at)) { return say('dropped on itself'); }
      const ref = (at ? blockUnder(at) : null) || blockAtPointer();
      if (!ref) { return say('no block under the pointer'); }
      if (ref === dragObject || dragObject.contains(ref)) { return say('that block is inside it'); }
      const r = ref.getBoundingClientRect ? ref.getBoundingClientRect() : null;
      const after = !!(r && dropY != null && dropY > r.top + r.height / 2);
      // What the drop decided, so a check can hold the result against it.
      window.__eb_lastDrop = { refIndex: Array.prototype.indexOf.call(canvas().children, ref),
        ref: ref.nodeName, after: after, dropY: dropY };
      return moveObjectTo(dragObject, ref, after);
    }
    if (!point || !inCanvas(point.startContainer)) { return false; }
    if (dragRange && pointInsideRange(dragRange, point)) { return false; }
    const frag = dragRange ? dragRange.extractContents() : fragmentFromTransfer(data);
    if (!frag || !frag.firstChild) { return false; }
    selectRange(point);
    insertFragmentAt(frag);
    return true;
  }

  /** The caret position under the pointer, however this browser spells it. */
  function caretFromPoint(x, y) {
    if (document.caretRangeFromPoint) { return document.caretRangeFromPoint(x, y); }
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) { return null; }
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    }
    return null;
  }

  function ncIsDark() {
    try {
      // Nextcloud sets its theme variables on <body>, not on <html>, and a theme
      // may state the colour as rgb().  Read both, and normalise, before falling
      // back to the device preference — the dark theme is an app, not a media query.
      let probe = getComputedStyle(document.body).getPropertyValue('--color-main-background').trim()
        || getComputedStyle(document.documentElement).getPropertyValue('--color-main-background').trim();
      probe = rgbToHex(probe) || probe;
      const m = probe.match(/^#?([0-9a-f]{6})$/i);
      if (m) {
        const n = parseInt(m[1], 16);
        const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
        return lum < 128;
      }
    } catch (e) { /* fall through */ }
    if (window.matchMedia) { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
    return null;
  }

  function rgbToHex(value) {
    const m = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) { return /^#[0-9a-f]{6}$/i.test(value) ? value : null; }
    return '#' + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('');
  }

  // The page planner is pure arithmetic and is unit-tested on its own.
  window.__eb_planPages = planPages;
  // the paste path, so the tests can drive it without a clipboard event
  window.__eb_pasteHtmlAt = pasteHtmlAt;
  // moving a frame is driven by the pointer, which jsdom has no layout for
  window.__eb_moveObjectTo = moveObjectTo;
  // dragging within the document: jsdom has no drag and no caretRangeFromPoint,
  // so the two halves are driven straight
  window.__eb_dropAt = dropAt;
  window.__eb_dragObject = () => dragObject;
  // where a picture lands is decided without any layout, so it is testable
  window.__eb_insertImage = insertImage;
  window.__eb_captionPlace = captionPlace;
  // the 文節 rule, which is arithmetic over the script and testable on its own
  window.__eb_bunsetsu = (text) => {
    const out = [];
    let from = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || bunsetsuBreak(text, i)) { out.push(text.slice(from, i)); from = i; }
    }
    return out.filter((x) => x !== '');
  };
  window.__eb_frameText = frameText;
  window.__eb_restack = restack;
  window.__eb_familiesInBody = familiesInBody;
  window.__eb_stylesCss = stylesCss;
  window.__eb_setColumnWidths = setColumnWidths;
  window.__eb_width = { wide: toWide, narrow: toNarrow };
  window.__eb_moveBlock = moveBlock;
  window.__eb_setCrop = setCrop;
  window.__eb_review = { markDeleted, ensureIns, accept: acceptChanges, reject: rejectChanges, count: countChanges };

  if (document.getElementById('editbase-root')) {
    app.mount('#editbase-root');
  }
})();
