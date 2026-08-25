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
  };
  // fonts: '' on any of the three means "whatever suits the document's language".
  const DEFAULT_PAPER = {
    size: 'A4', orientation: 'portrait', margin: { top: 25, right: 20, bottom: 25, left: 20 },
    font: 'serif', fontSize: 10.5, lineHeight: 1.75, fonts: { body: '', heading: '', mono: '' },
    header: { l: '', c: '', r: '' }, footer: { l: '', c: '', r: '' },
    headingNumbers: '',
    vertical: false,
  };

  function normalisePaper(p) {
    const out = JSON.parse(JSON.stringify(DEFAULT_PAPER));
    if (!p || typeof p !== 'object') { return out; }
    if (PAPERS[p.size]) { out.size = p.size; }
    if (p.orientation === 'landscape') { out.orientation = 'landscape'; }
    if (p.font === 'sans') { out.font = 'sans'; }
    if (p.headingNumbers === 'decimal' || p.headingNumbers === 'japanese') { out.headingNumbers = p.headingNumbers; }
    out.vertical = !!p.vertical;
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
  /** Sheet size in mm with the orientation applied. */
  function sheet(paper) {
    const s = PAPERS[paper.size] || PAPERS.A4;
    return paper.orientation === 'landscape' ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
  }
  /** The @page rule — the one piece of CSS that differs per document. */
  function pageRule(paper) {
    const s = PAPERS[paper.size] || PAPERS.A4;
    const m = paper.margin;
    const named = { A3: 'A3', A4: 'A4', A5: 'A5', B4: 'B4', B5: 'B5', Letter: 'letter', Legal: 'legal' }[paper.size];
    const size = named ? named + ' ' + paper.orientation : (s.w + 'mm ' + s.h + 'mm');
    return '@page { size: ' + size + '; margin: ' + m.top + 'mm ' + m.right + 'mm ' + m.bottom + 'mm ' + m.left + 'mm; }';
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
.eb-doc .eb-tate { writing-mode: vertical-rl; }

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
/* An object placed by hand is parked in a zero-height anchor left at the point in
   the text it belongs to. That is what makes it print on the page its text is on:
   HTML has no coordinate system that spans pages, but a box positioned against a
   paragraph goes wherever that paragraph goes. */
.eb-doc div.eb-anchor { position: relative; height: 0; margin: 0; }
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
.eb-doc .eb-math-block { display: block; margin: 1em 0; break-inside: avoid; }
:where(.eb-doc .eb-math-block) { text-align: center; }

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
  const ATTR_OK = new Set(['class', 'style', 'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'span', 'start', 'type', 'lang', 'dir', 'id', 'datetime', 'data-label', 'display', 'mathvariant', 'stretchy', 'fence', 'separator', 'accent', 'notation', 'columnalign', 'rowalign', 'scope']);
  const STYLE_OK = /^(color|background-color|font-weight|font-style|font-size|font-family|text-decoration|text-decoration-line|text-align|text-emphasis|line-height|margin|margin-left|margin-right|margin-top|margin-bottom|padding|text-indent|padding-left|padding-right|padding-top|padding-bottom|width|height|max-width|border|border-top|border-right|border-bottom|border-left|border-radius|border-color|border-width|border-style|border-collapse|z-index|vertical-align|letter-spacing|writing-mode|float|clear|break-before|break-after|break-inside|page-break-before|page-break-after|page-break-inside|column-count|column-gap|column-rule|orphans|widows|text-transform|font-variant|white-space|list-style-type|table-layout|position|left|top|right|bottom|min-width|min-height|max-height|box-sizing|overflow|overflow-x|overflow-y|aspect-ratio|object-fit|object-position|orphans|widows|opacity|transform|transform-origin|box-shadow|mix-blend-mode|shape-outside|shape-margin)$/;

  function cleanStyle(value) {
    const kept = [];
    String(value).split(';').forEach((decl) => {
      const i = decl.indexOf(':');
      if (i < 0) { return; }
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (!STYLE_OK.test(prop)) { return; }
      if (/url\s*\(|expression|javascript:/i.test(val)) { return; }
      // A document may lay its own frames out; it may not pin anything to the
      // window, which in the editor means over the app's own chrome.
      if (prop === 'position' && !/^(static|relative|absolute)$/i.test(val)) { return; }
      kept.push(prop + ': ' + val);
    });
    return kept.join('; ');
  }

  function sanitiseInto(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    const drop = [];
    const unwrap = [];
    let el = walker.nextNode();
    while (el) {
      const isMath = el.namespaceURI === 'http://www.w3.org/1998/Math/MathML';
      const name = isMath ? el.localName : el.nodeName;
      if (isMath ? !MATHML_TAGS.has(name) : !HTML_TAGS.has(name)) {
        // Scripts and frames go entirely; anything else merely loses its tag.
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
      + '@media screen { body.eb-doc { margin: 0 auto; max-width: 100%;'
      + (paper.vertical ? ' height: ' + s.h + 'mm;' : ' width: ' + s.w + 'mm;')
      + ' padding: ' + paper.margin.top + 'mm ' + paper.margin.right + 'mm '
      + paper.margin.bottom + 'mm ' + paper.margin.left + 'mm; } }';
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
      + runningBlock('eb-runhead', paper.header)
      + body + '\n'
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
    Array.from(body.querySelectorAll('.eb-runhead, .eb-runfoot')).forEach((n) => n.remove());
    sanitiseInto(body);
    return {
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
  const BLOCK_NAMES = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'ASIDE', 'FIGURE', 'DIV', 'HR', 'SECTION']);
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

  function insertBlockNode(node) {
    const range = getRange();
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
    insertBlockNode(fig);
    const after = document.createElement('p');
    after.appendChild(document.createElement('br'));
    fig.parentNode.insertBefore(after, fig.nextSibling);
    placeCaretIn(cap);
    return fig;
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
  const OBJECT_SEL = 'figure.eb-img, table.eb-table, aside.eb-box, div.eb-note, div.eb-math-block, nav.eb-toc, div.eb-frame, span.eb-frame, div.eb-shape, hr';
  /** Elements that may hold blocks of their own, so a frame can be dropped into them. */
  const BLOCK_HOSTS = 'aside.eb-box, div.eb-frame, div.eb-note, blockquote, li, td, th';
  const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double'];
  /** One CSS pixel in millimetres: the whole app measures paper, not screens. */
  const MM = 25.4 / 96;
  const round1 = (n) => Math.round(n * 10) / 10;

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
    return el.nodeName;
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
      shadow: !!(el.classList && el.classList.contains('eb-shadow')),
      keep: s.breakInside === 'avoid',
    };
  }

  const FRAME_PROPS = ['left', 'top', 'float', 'width', 'max-width', 'height', 'min-height',
    'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
    'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
    'border', 'border-radius', 'background-color', 'break-inside', 'z-index'];

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
    if (v.border === 'none') {
      s.border = 'none';
    } else if (v.border) {
      s.border = (num(v.borderWidth) || 0.75) + 'pt ' + v.border + ' ' + (/^#[0-9a-f]{6}$/i.test(v.borderColour || '') ? v.borderColour : '#666666');
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
    'eb-frame', 'eb-anchor', 'eb-ink', 'eb-shadow',
    'eb-shape', 'eb-sh-rect', 'eb-sh-round', 'eb-sh-ellipse', 'eb-sh-line', 'eb-sh-arrow',
    'eb-fnref', 'eb-notes', 'eb-notes-title', 'eb-cols', 'eb-runhead', 'eb-runfoot', 'l', 'c', 'r',
    'eb-ins', 'eb-del',
    'eb-rule-thick', 'eb-rule-dashed', 'eb-table', 'eb-tate', 'eb-note',
    'eb-img', 'eb-img-s', 'eb-img-m', 'eb-img-l', 'eb-img-left', 'eb-img-right',
    'eb-math-block', 'eb-kenten', 'eb-hl-g', 'eb-hl-b', 'eb-hl-p', 'eb-hl-r',
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
    Array.from(c.querySelectorAll('[style]')).forEach((el) => {
      if (/^(IMG|FIGURE|TABLE|TD|TH|COL|COLGROUP)$/.test(el.nodeName)) { return; }
      // A frame is allowed its own size: that is the whole point of a frame.
      if (el.matches && el.matches(OBJECT_SEL)) { return; }
      el.style.removeProperty('width');
      el.style.removeProperty('height');
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

  function normaliseCanvas(pageBreakLabel, captionLabel) {
    const c = canvas();
    if (!c) { return; }
    repairNesting();
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
  function handlePaste(e, plainOnly) {
    const data = e.clipboardData;
    if (!data) { return; }
    e.preventDefault();
    const html = plainOnly ? '' : data.getData('text/html');
    const uri = (data.getData('text/uri-list') || '').split(/\r?\n/).find((l) => /^https?:/i.test(l)) || '';
    history.push(true);
    if (html) { pasteHtmlAt(html, uri); } else { pasteTextAt(data.getData('text/plain') || ''); }
    normaliseCanvas();
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

  function pasteHtmlAt(html, base) {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    sanitiseInto(holder);
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
    const frag = document.createDocumentFragment();
    while (holder.firstChild) { frag.appendChild(holder.firstChild); }
    insertFragmentAt(frag);
  }

  /** Chrome and Safari put the page's own address in the clipboard markup. */
  function baseFromHtml(html) {
    const m = String(html || '').match(/<base[^>]+href=["']([^"']+)["']/i)
      || String(html || '').match(/<!--\s*(?:StartFragment|SourceURL)\s*:?\s*(https?:\/\/[^\s>-]+)/i);
    return m ? m[1] : '';
  }
  function pasteTextAt(text) {
    const frag = document.createDocumentFragment();
    String(text == null ? '' : text).split(/\r?\n/).forEach((line, i) => {
      if (i) { frag.appendChild(document.createElement('br')); }
      frag.appendChild(document.createTextNode(line));
    });
    insertFragmentAt(frag);
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
  async function shrinkImage(dataUrl, mime, maxEdge) {
    const limit = maxEdge || 2200;
    if (mime === 'image/svg+xml' || mime === 'image/gif') { return dataUrl; }
    const probe = document.createElement('canvas');
    if (typeof probe.getContext !== 'function') { return dataUrl; }
    let img;
    try { img = await loadImage(dataUrl); } catch (e) { return dataUrl; }
    const edge = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (edge <= limit) { return dataUrl; }
    const scale = limit / edge;
    const canvasEl = document.createElement('canvas');
    canvasEl.width = Math.round((img.naturalWidth || img.width) * scale);
    canvasEl.height = Math.round((img.naturalHeight || img.height) * scale);
    const ctx = canvasEl.getContext('2d');
    if (!ctx) { return dataUrl; }
    ctx.drawImage(img, 0, 0, canvasEl.width, canvasEl.height);
    const out = mime === 'image/png' ? canvasEl.toDataURL('image/png') : canvasEl.toDataURL('image/jpeg', 0.85);
    return out.length < dataUrl.length ? out : dataUrl;
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

  const TEMPLATE = `
<div class="eb-shell" :class="{ narrow: narrow }">
  <div v-if="narrow && sideOpen" class="eb-backdrop" @click="sideOpen = false"></div>
  <aside class="eb-side" :class="{ hidden: !sideOpen }">
    <div class="brand">
      <span class="logo" v-html="logo"></span>
      <span class="name">EditBase</span>
      <span class="ver" v-if="!narrow">{{ version }}</span>
      <button v-if="narrow" class="eb-tb side-close" @click="sideOpen = false" :title="t('Close')"><span v-html="icons.close"></span></button>
    </div>
    <div class="side-actions">
      <button class="eb-btn primary wide" @click="newDoc">＋ {{ t('New document') }}</button>
    </div>
    <div class="eb-doclist">
      <p class="hint" v-if="!docs.length">{{ t('No documents yet. Everything you write here is saved to {folder} in your Files as a plain .html file.', { folder: settings.folder }) }}</p>
      <button v-for="d in docs" :key="d.id" class="eb-docitem" :class="{ active: d.id === doc.id }" @click="openDoc(d.id)">
        <span class="t">{{ d.title }}</span>
        <span class="m">{{ when(d.mtime) }} · {{ size(d.size) }}</span>
      </button>
    </div>
    <div class="side-foot">
      <button class="eb-btn ghost wide" @click="paperOpen = true">🖹 {{ t('Paper setup') }}</button>
      <button class="eb-btn ghost wide" @click="settingsOpen = true">⚙ {{ t('Settings') }}</button>
    </div>
  </aside>

  <section class="eb-main">
    <div class="eb-topbar">
      <button class="eb-tb menu-btn" @touchend.prevent="sideOpen = !sideOpen" @click="sideOpen = !sideOpen" :title="t('Documents')"><span v-html="icons.menu"></span></button>
      <input class="title-input" v-model="doc.title" :placeholder="t('Untitled document')" @change="applyTitle" :disabled="!doc.id">
      <span class="state" :class="{ dirty: dirty }">{{ stateText }}</span>
      <button class="eb-btn" @click="save" :disabled="!doc.id || saving">💾 <span class="lbl">{{ t('Save') }}</span></button>
      <button class="eb-btn" @click="printDoc" :disabled="!doc.id">🖨 <span class="lbl">{{ t('Print / PDF') }}</span></button>
      <button class="eb-btn ghost" @click="menuOpen = !menuOpen" :title="t('More')">⋯</button>
      <div v-if="menuOpen" class="eb-modal-back" @click="menuOpen = false">
        <div class="eb-modal" style="width:min(360px,100%)" @click.stop>
          <h3>{{ doc.title || t('Untitled document') }}</h3>
          <div class="body" style="display:flex;flex-direction:column;gap:6px;padding-bottom:16px">
            <template v-if="narrow">
              <button class="eb-btn wide primary" @click="newDoc(); menuOpen = false">＋ {{ t('New document') }}</button>
              <div class="eb-menu-docs" v-if="docs.length">
                <button v-for="d in docs" :key="d.id" class="eb-btn wide ghost" :class="{ on: d.id === doc.id }" @click="openDoc(d.id); menuOpen = false">{{ d.title }}</button>
              </div>
              <div class="eb-menu-sep"></div>
            </template>
            <button class="eb-btn wide" @click="download">⬇ {{ t('Download a copy') }}</button>
            <button class="eb-btn wide" @click="duplicate">⧉ {{ t('Duplicate') }}</button>
            <button class="eb-btn wide" @click="paperOpen = true; menuOpen = false">🖹 {{ t('Paper setup') }}</button>
            <button class="eb-btn wide" :class="{ on: review }" @click="review = !review; menuOpen = false">✎ {{ review ? t('Stop recording changes') : t('Record changes') }}</button>
            <button class="eb-btn wide" @click="showSource">&lt;/&gt; {{ t('View the HTML') }}</button>
            <button class="eb-btn wide danger" @click="removeDoc">🗑 {{ t('Delete') }}</button>
          </div>
        </div>
      </div>
    </div>

    <div class="eb-toolbar" v-if="doc.id">
      <select class="tb-style" :value="fmt.block || 'P'" @change="setBlock($event.target.value)" :title="t('Paragraph style')">
        <option value="P">{{ t('Body text') }}</option>
        <option value="H1">{{ t('Heading 1') }}</option>
        <option value="H2">{{ t('Heading 2') }}</option>
        <option value="H3">{{ t('Heading 3') }}</option>
        <option value="H4">{{ t('Heading 4') }}</option>
        <option value="BLOCKQUOTE">{{ t('Quotation') }}</option>
        <option value="PRE">{{ t('Preformatted') }}</option>
      </select>
      <button class="eb-tb" @mousedown.prevent @click="openStyles()" :title="t('Change this style everywhere…')"><span v-html="icons.props"></span></button>
      <span class="eb-pop wide-ctl">
        <button class="eb-tb text font-btn" :class="{ on: menu === 'font' }" @mousedown.prevent @click="toggleMenu('font')" :title="t('Typeface of the text')">
          <span class="fname" :style="{ fontFamily: fontPreviewStack(fmt.family) }">{{ fmt.family || fontsInUse.body }}</span>
          <span class="caret" v-html="icons.down"></span>
        </button>
        <div class="eb-menu wide" v-if="menu === 'font'" @mousedown.prevent>
          <button class="eb-menu-item" @click="setFamily(''); menu = ''">{{ t('As the paragraph style says') }}</button>
          <div class="eb-menu-sep"></div>
          <button v-for="r in fontRoles" :key="r.key" class="eb-menu-item" @click="setFamily(fontsInUse[r.key]); menu = ''">
            <span :style="{ fontFamily: fontPreviewStack(fontsInUse[r.key]) }">{{ fontsInUse[r.key] }}</span>
            <span class="k">{{ r.label }}</span>
          </button>
          <div class="eb-menu-sep"></div>
          <button class="eb-menu-item" @click="openFonts('selection')">{{ t('Another typeface…') }}</button>
          <button class="eb-menu-item" @click="paperOpen = true; menu = ''">{{ t('The typefaces of the document…') }}</button>
        </div>
      </span>
      <span class="eb-pop wide-ctl">
        <span class="eb-num" :title="t('Size of the text (pt)')">
          <button class="eb-tb" @mousedown.prevent @click="stepSize(-0.5)" v-html="icons.minus"></button>
          <input type="number" min="4" max="200" step="0.5" :value="fmt.size"
            @change="setSize($event.target.value)" @keydown.enter.prevent="setSize($event.target.value)">
          <button class="eb-tb" @mousedown.prevent @click="stepSize(0.5)" v-html="icons.plus"></button>
          <button class="eb-tb caret" :class="{ on: menu === 'size' }" @mousedown.prevent @click="toggleMenu('size')" v-html="icons.down"></button>
        </span>
        <div class="eb-menu sizes" v-if="menu === 'size'" @mousedown.prevent>
          <button v-for="n in fontSizes" :key="n" class="eb-menu-item" :class="{ on: fmt.size === n }" @click="setSize(n); menu = ''">{{ n }}</button>
          <div class="eb-menu-sep"></div>
          <button class="eb-menu-item" @click="setSize(''); menu = ''">{{ t('As the paragraph style says') }}</button>
        </div>
      </span>
      <span class="sep"></span>
      <button class="eb-tb" :class="{ on: fmt.bold }" @mousedown.prevent @click="inline('bold')" :title="t('Bold') + ' (Ctrl+B)'"><span class="b">B</span></button>
      <button class="eb-tb" :class="{ on: fmt.italic }" @mousedown.prevent @click="inline('italic')" :title="t('Italic') + ' (Ctrl+I)'"><span class="i">I</span></button>
      <button class="eb-tb" :class="{ on: fmt.underline }" @mousedown.prevent @click="inline('underline')" :title="t('Underline') + ' (Ctrl+U)'"><span class="u">U</span></button>
      <button class="eb-tb" :class="{ on: fmt.strike }" @mousedown.prevent @click="inline('strike')" :title="t('Strikethrough')"><span class="s">S</span></button>
      <button class="eb-tb" :class="{ on: fmt.kenten }" @mousedown.prevent @click="inline('kenten')" :title="t('Emphasis dots')"><span class="kt">A</span></button>
      <button class="eb-tb" :class="{ on: fmt.sup }" @mousedown.prevent @click="inline('sup')" :title="t('Superscript')"><span class="sx">x<sup>2</sup></span></button>
      <button class="eb-tb" :class="{ on: fmt.sub }" @mousedown.prevent @click="inline('sub')" :title="t('Subscript')"><span class="sx">x<sub>2</sub></span></button>
      <button class="eb-tb" :class="{ on: fmt.code }" @mousedown.prevent @click="inline('code')" :title="t('Inline code')"><span class="mono">&lt;/&gt;</span></button>
      <span class="sep"></span>
      <span class="eb-pop">
        <button class="eb-tb" :class="{ on: menu === 'hl' }" @mousedown.prevent @click="toggleMenu('hl')" :title="t('Highlight')"><span v-html="icons.highlight"></span></button>
        <div class="eb-menu" v-if="menu === 'hl'" @mousedown.prevent>
          <button v-for="h in highlights" :key="h.key" class="eb-menu-item" @click="inline(h.key); menu = ''">
            <span class="eb-swatch" :style="{ background: h.color }"></span>{{ h.label }}
          </button>
          <button class="eb-menu-item" @click="clearHighlight(); menu = ''"><span class="eb-swatch none"></span>{{ t('Remove highlight') }}</button>
        </div>
      </span>
      <label class="eb-tb" :title="t('Text colour')">
        <span v-html="icons.colour"></span>
        <span class="colour-bar" :style="{ background: colour }"></span>
        <input type="color" :value="colour" @input="setColour($event.target.value)">
      </label>
      <button class="eb-tb" @mousedown.prevent @click="clearColour" :title="t('Remove text colour')"><span v-html="icons.nocolour"></span></button>
      <span class="sep"></span>
      <button class="eb-tb" :class="{ on: fmt.list === 'UL' }" @mousedown.prevent @click="list('UL')" :title="t('Bulleted list')"><span v-html="icons.ul"></span></button>
      <button class="eb-tb" :class="{ on: fmt.list === 'OL' }" @mousedown.prevent @click="list('OL')" :title="t('Numbered list')"><span v-html="icons.ol"></span></button>
      <span class="eb-pop">
        <button class="eb-tb caret" :class="{ on: menu === 'marker' }" @mousedown.prevent @click="toggleMenu('marker')" :title="t('Kind of marker')" v-html="icons.down"></button>
        <div class="eb-menu markers" v-if="menu === 'marker'" @mousedown.prevent>
          <button v-for="m in listMarkers" :key="m.type" class="eb-menu-item" :class="{ on: fmt.marker === m.type }" @click="setMarker(m.type); menu = ''">
            <span class="mk">{{ m.sample }}</span><span>{{ m.label }}</span>
          </button>
        </div>
      </span>
      <button class="eb-tb" v-for="a in aligns" :key="a.cls" :class="{ on: fmt.align === a.cls }" @mousedown.prevent @click="align(a.cls)" :title="a.label" v-html="a.icon"></button>
      <button class="eb-tb" @mousedown.prevent @click="indent(1)" :title="t('Increase indent')"><span v-html="icons.indent"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="indent(-1)" :title="t('Decrease indent')"><span v-html="icons.outdent"></span></button>
      <span class="sep"></span>
      <span class="eb-pop">
        <button class="eb-tb text" :class="{ on: menu === 'insert' }" @mousedown.prevent @click="toggleMenu('insert')" :title="t('Insert')">
          <span v-html="icons.plus"></span><span class="lbl">{{ t('Insert') }}</span><span class="caret" v-html="icons.down"></span>
        </button>
        <div class="eb-menu wide" v-if="menu === 'insert'" @mousedown.prevent>
          <button class="eb-menu-item" @click="tableOpen = true; menu = ''"><span v-html="icons.table"></span>{{ t('Insert table') }}</button>
          <button class="eb-menu-item" @click="openPicker(); menu = ''"><span v-html="icons.image"></span>{{ t('Insert picture') }}</button>
          <div class="eb-menu-sep"></div>
          <button class="eb-menu-item" @click="addFrame(); menu = ''"><span v-html="icons.frame"></span>{{ t('Text frame') }}</button>
          <div class="eb-menu-sep"></div>
          <button v-for="sh in shapes" :key="sh.kind" class="eb-menu-item" draggable="true"
            @dragstart="shapeDragStart($event, sh.kind)" @click="addShape(sh.kind); menu = ''">
            <span class="eb-shape-icon" v-html="sh.icon"></span>{{ sh.label }}</button>
          <button v-for="b in boxes" :key="b.variant" class="eb-menu-item" @click="addBox(b.variant); menu = ''"><span v-html="icons.box"></span>{{ b.label }}</button>
          <div class="eb-menu-sep"></div>
          <button v-for="r in rules" :key="r.cls" class="eb-menu-item" @click="addRule(r.cls); menu = ''"><span v-html="icons.rule"></span>{{ r.label }}</button>
          <div class="eb-menu-sep"></div>
          <button class="eb-menu-item" @click="addPageBreak(); menu = ''"><span v-html="icons.pagebreak"></span>{{ t('Page break') }}</button>
          <button class="eb-menu-item" @click="openMath(); menu = ''"><span v-html="icons.formula"></span>{{ t('Insert formula (MathML)') }}</button>
          <button class="eb-menu-item" @click="webOpen = true; menu = ''"><span v-html="icons.link"></span>{{ t('Bring in a web page…') }}</button>
          <button class="eb-menu-item" @click="openToc(); menu = ''"><span v-html="icons.doc"></span>{{ t('Table of contents…') }}</button>
          <button class="eb-menu-item" @click="openChars(); menu = ''"><span v-html="icons.text"></span>{{ t('Special character…') }}</button>
          <div class="eb-menu-sep"></div>
          <button class="eb-menu-item" @click="openRuby()"><span v-html="icons.ruby"></span>{{ t('Reading over the word…') }}</button>
          <button class="eb-menu-item" @click="openNote()"><span v-html="icons.note"></span>{{ t('Note…') }}</button>
          <button class="eb-menu-item" @click="openCols()"><span v-html="icons.columns"></span>{{ t('Columns…') }}</button>
          <button class="eb-menu-item" @click="openRunning()"><span v-html="icons.header"></span>{{ t('Header and footer…') }}</button>
          <div class="eb-menu-sep" v-if="anySource"></div>
          <button v-for="key in sourceKeys" :key="key" class="eb-menu-item" @click="openSource(key)">
            <span v-html="icons.link"></span>{{ sourceLabel(key) }}
          </button>
        </div>
      </span>
      <button class="eb-tb" :class="{ on: !!brush }" @mousedown.prevent @click="useBrush" :title="brush ? t('Put this format on the selection') : t('Copy the format at the cursor')"><span v-html="icons.brush"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="clearFmt" :title="t('Clear formatting')"><span v-html="icons.clear"></span></button>
      <span class="sep"></span>
      <button class="eb-tb" @mousedown.prevent @click="undo" :title="t('Undo') + ' (Ctrl+Z)'"><span v-html="icons.undo"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="redo" :title="t('Redo') + ' (Ctrl+Shift+Z)'"><span v-html="icons.redo"></span></button>
      <span class="sep"></span>
      <button class="eb-tb" :class="{ on: ruler }" v-if="!flow && !tategaki" @mousedown.prevent @click="ruler = !ruler" :title="t('Ruler')"><span v-html="icons.ruler"></span></button>
      <button class="eb-tb" :class="{ on: guides }" v-if="!flow" @mousedown.prevent @click="guides = !guides" :title="guides ? t('Hide the margin boundaries') : t('Show the margin boundaries')"><span v-html="icons.guides"></span></button>
      <button class="eb-tb" :class="{ on: !flow }" @mousedown.prevent @click="toggleFlow"
        :title="flow ? t('Show the page as it prints') : t('Fit the text to the screen')">
        <span v-html="flow ? icons.screenView : icons.pageView"></span>
      </button>
      <span class="eb-num" :title="t('Zoom')" v-if="!flow">
        <span class="cap">{{ t('Zoom') }}</span>
        <button class="eb-tb" @mousedown.prevent @click="stepZoom(-10)" v-html="icons.minus"></button>
        <button class="eb-tb text zoomv" @mousedown.prevent @click="zoomSetByHand = true; zoom = 100">{{ zoom }}%</button>
        <button class="eb-tb" @mousedown.prevent @click="stepZoom(10)" v-html="icons.plus"></button>
      </span>
    </div>

    <div class="eb-find" v-if="doc.id && find.open">
      <span class="ic" v-html="icons.search"></span>
      <input ref="findInput" type="text" v-model="find.query" :placeholder="t('Find')" @input="runFind()" @keydown.enter.prevent="findNext(1)" @keydown.esc.prevent="closeFind">
      <span class="count">{{ find.hits.length ? (find.index + 1) + ' / ' + find.hits.length : t('none') }}</span>
      <button class="eb-tb" @click="findNext(-1)" :title="t('Previous')">↑</button>
      <button class="eb-tb" @click="findNext(1)" :title="t('Next')">↓</button>
      <label class="opt"><input type="checkbox" v-model="find.caseSensitive" @change="runFind()"> {{ t('Match case') }}</label>
      <span class="sep"></span>
      <input type="text" v-model="find.replace" :placeholder="t('Replace with')" @keydown.enter.prevent="replaceOne">
      <button class="eb-btn" @click="replaceOne" :disabled="!find.hits.length">{{ t('Replace') }}</button>
      <button class="eb-btn" @click="replaceAll" :disabled="!find.hits.length">{{ t('Replace all') }}</button>
      <button class="eb-tb" @click="closeFind" :title="t('Close')"><span v-html="icons.close"></span></button>
    </div>

    <div class="eb-toolbar sub" v-if="doc.id && (review || changes)">
      <span class="grp">{{ t('Review') }}</span>
      <button class="eb-tb text" :class="{ on: review }" @mousedown.prevent @click="review = !review" :title="t('Record what is changed from now on')">
        <span v-html="icons.review"></span><span class="lbl">{{ review ? t('Recording') : t('Not recording') }}</span>
      </button>
      <span class="sep"></span>
      <button class="eb-tb text" :class="{ on: !showChanges }" @mousedown.prevent @click="showChanges = !showChanges">
        <span class="lbl">{{ showChanges ? t('Showing the marks') : t('As it would read') }}</span>
      </button>
      <span class="sep"></span>
      <button class="eb-tb text" @mousedown.prevent @click="reviewCmd('acceptOne')" :disabled="!fmt.change">{{ t('Keep this one') }}</button>
      <button class="eb-tb text" @mousedown.prevent @click="reviewCmd('rejectOne')" :disabled="!fmt.change">{{ t('Undo this one') }}</button>
      <span class="sep"></span>
      <button class="eb-tb text" @mousedown.prevent @click="reviewCmd('acceptAll')" :disabled="!changes">{{ t('Keep them all') }}</button>
      <button class="eb-tb text" @mousedown.prevent @click="reviewCmd('rejectAll')" :disabled="!changes">{{ t('Undo them all') }}</button>
      <span class="hint">{{ t('{n} changes marked', { n: changes }) }}</span>
    </div>

    <div class="eb-toolbar sub" v-if="doc.id && fmt.image">
      <span class="grp">{{ t('Picture') }}</span>
      <button class="eb-tb text" :class="{ on: fmt.imageSize === 'eb-img-s' }" @mousedown.prevent @click="imageCmd('size', 'eb-img-s')">{{ t('Small') }}</button>
      <button class="eb-tb text" :class="{ on: fmt.imageSize === 'eb-img-m' }" @mousedown.prevent @click="imageCmd('size', 'eb-img-m')">{{ t('Medium') }}</button>
      <button class="eb-tb text" :class="{ on: fmt.imageSize === 'eb-img-l' }" @mousedown.prevent @click="imageCmd('size', 'eb-img-l')">{{ t('Full width') }}</button>
      <span class="sep"></span>
      <button class="eb-tb" @mousedown.prevent @click="openCrop" :title="t('Crop…')"><span v-html="icons.crop"></span></button>
      <button class="eb-tb danger" @mousedown.prevent @click="imageCmd('delete')" :title="t('Delete picture')"><span v-html="icons.clear"></span></button>
      <span class="hint">{{ t('The caption sits under the picture; leave it empty and it does not print.') }}</span>
    </div>

    <div class="eb-toolbar sub" v-if="doc.id && fmt.table">
      <span class="grp">{{ t('Table') }}</span>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('rowAbove')" :title="t('Insert row above')"><span v-html="icons.rowAbove"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('rowBelow')" :title="t('Insert row below')"><span v-html="icons.rowBelow"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('colLeft')" :title="t('Insert column left')"><span v-html="icons.colLeft"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('colRight')" :title="t('Insert column right')"><span v-html="icons.colRight"></span></button>
      <span class="sep"></span>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('rowDel')" :title="t('Delete row')"><span v-html="icons.rowDel"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('colDel')" :title="t('Delete column')"><span v-html="icons.colDel"></span></button>
      <span class="sep"></span>
      <button class="eb-tb" :class="{ on: fmt.tableHeader }" @mousedown.prevent @click="tableCmd('header')" :title="t('First row is a header')"><span v-html="icons.header"></span></button>
      <select :value="fmt.tableVariant" @change="tableCmd('variant', $event.target.value)" :title="t('Style')">
        <option value="">{{ t('All borders') }}</option>
        <option value="rows">{{ t('Horizontal lines only') }}</option>
        <option value="borderless">{{ t('No borders') }}</option>
      </select>
      <span class="sep"></span>
      <label class="eb-tb" :title="t('Cell colour')">
        <span class="colour-bar" :style="{ background: cellFill || 'transparent' }"></span>
        <span v-html="icons.highlight"></span>
        <input type="color" :value="cellFill || '#eef1f6'" @input="tableCmd('fill', $event.target.value)">
      </label>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('fill', '')" :title="t('No cell colour')"><span v-html="icons.nocolour"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('valign', 'top')" :title="t('Cell text at the top')"><span v-html="icons.vTop"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('valign', 'middle')" :title="t('Cell text in the middle')"><span v-html="icons.vMid"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="tableCmd('valign', 'bottom')" :title="t('Cell text at the bottom')"><span v-html="icons.vBot"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="openCellBorder" :title="t('Rule round the cells…')"><span v-html="icons.cellBorder"></span></button>
      <span class="sep"></span>
      <button class="eb-tb danger" @mousedown.prevent @click="tableCmd('delete')" :title="t('Delete table')"><span v-html="icons.tableDel"></span></button>
      <span class="hint">{{ t('Tab moves to the next cell; a new row is added at the end.') }}</span>
    </div>

    <div class="eb-desk" :class="{ empty: !doc.id }">
      <div class="eb-paperwrap" :class="{ noguides: !guides, flow: flow, ruled: ruler && !flow && !tategaki, tate: tategaki && !flow }" v-show="doc.id" :style="[paperStyle, { zoom: flow ? 1 : zoom / 100 }]">
        <div class="eb-ruler" v-if="ruler && !flow && !tategaki" @pointerdown.prevent>
          <div class="band" :style="{ left: rulerMm.ml + 'mm', right: rulerMm.mr + 'mm' }"></div>
          <span class="tick" v-for="n in rulerMm.ticks" :key="n" :style="{ left: ((n - 1) * 10) + 'mm' }">{{ (n - 1) * 10 }}</span>
          <span class="hm left" :style="{ left: rulerMm.ml + 'mm' }" @pointerdown.prevent.stop="rulerGrab($event, 'ml')" :title="t('Left margin')"></span>
          <span class="hm right" :style="{ left: (rulerMm.w - rulerMm.mr) + 'mm' }" @pointerdown.prevent.stop="rulerGrab($event, 'mr')" :title="t('Right margin')"></span>
          <span class="ind first" :style="{ left: (rulerMm.ml + ind.left + ind.first) + 'mm' }" @pointerdown.prevent.stop="rulerGrab($event, 'first')" :title="t('First line')"></span>
          <span class="ind il" :style="{ left: (rulerMm.ml + ind.left) + 'mm' }" @pointerdown.prevent.stop="rulerGrab($event, 'left')" :title="t('Indent left')"></span>
          <span class="ind ir" :style="{ left: (rulerMm.w - rulerMm.mr - ind.right) + 'mm' }" @pointerdown.prevent.stop="rulerGrab($event, 'right')" :title="t('Indent right')"></span>
        </div>
        <div class="eb-sheets" aria-hidden="true" v-if="!flow">
          <div class="eb-sheet" v-for="n in pageCount" :key="n">
            <div class="run head" v-if="hasRunning">
              <span class="l">{{ doc.paper.header.l }}</span><span class="c">{{ doc.paper.header.c }}</span><span class="r">{{ doc.paper.header.r }}</span>
            </div>
            <div class="run foot" v-if="hasRunning">
              <span class="l">{{ doc.paper.footer.l }}</span><span class="c">{{ doc.paper.footer.c }}</span><span class="r">{{ doc.paper.footer.r }}</span>
            </div>
          </div>
        </div>
        <div id="eb-canvas" class="eb-paper eb-doc" :class="numberClass"
          :style="paperStyle" contenteditable="true" :spellcheck="spellcheck" role="textbox" aria-multiline="true"></div>
        <div class="eb-fdrop" v-if="frame.drop >= 0" :style="{ top: frame.drop + 'px' }"></div>
        <!-- The line a frame has just snapped to, drawn while it is being dragged
             so the writer can see what it caught on. -->
        <div class="eb-snap v" v-if="frame.gx !== null" :style="{ left: frame.gx + 'px' }"></div>
        <div class="eb-snap h" v-if="frame.gy !== null" :style="{ top: frame.gy + 'px' }"></div>
        <!-- Text is an object too, and this is the box round the 文節 the caret is
             standing in, or round whatever is selected. It is a marker and nothing
             more: it takes no pointer and carries no bar, because anything floating
             over the line above would cover the words there and slide across the
             page every time the paragraph is aligned. What can be done to a phrase
             is on the right button, under its own heading. -->
        <div class="eb-tsel" v-if="tsel.on">
          <div v-for="(b, i) in tsel.boxes" :key="i" class="tbox"
            :style="{ left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' }"></div>
        </div>
        <div class="eb-fsel" v-if="frame.on" :class="{ dragging: frame.dragging }" :style="{ left: frame.x + 'px', top: frame.y + 'px', width: frame.w + 'px', height: frame.h + 'px' }">
          <div class="box"></div>
          <div v-for="e in ['t','r','b','l']" :key="'e' + e" class="ed" :class="e"
            @pointerdown.prevent="frameGrab($event, 'move')" @contextmenu.prevent.stop="openFrameProps"></div>
          <span v-for="h in frameHandles" :key="h" class="hd" :class="h"
            @pointerdown.prevent.stop="frameGrab($event, h)"></span>
          <span v-for="g in frame.grips" :key="'cg' + g.index" class="cg" :style="{ left: g.x + 'px' }"
            @pointerdown.prevent.stop="colGrab($event, g.index)" :title="t('Drag to set the column width')"></span>
          <div class="bar" v-if="frame.bar" :class="{ below: frame.y < 44 }" @pointerdown.stop @mousedown.prevent @contextmenu.prevent.stop="openFrameProps">
            <span class="nm">{{ frameLabel }}</span>
            <button class="eb-tb" :class="{ on: frame.free }" @click="frameCmd('free')" :title="t('Place it freely')"><span v-html="icons.free"></span></button>
            <button class="eb-tb" @click="frameCmd('wrap', '')" :title="t('No text wrap')"><span v-html="icons.wrapNone"></span></button>
            <button class="eb-tb" @click="frameCmd('wrap', 'left')" :title="t('Wrap text on the right')"><span v-html="icons.wrapLeft"></span></button>
            <button class="eb-tb" @click="frameCmd('wrap', 'right')" :title="t('Wrap text on the left')"><span v-html="icons.wrapRight"></span></button>
            <span class="sep"></span>
            <button class="eb-tb" @click="frameCmd('align', 'eb-al-l')" :title="t('Put the frame at the left margin')"><span v-html="icons.boxL"></span></button>
            <button class="eb-tb" @click="frameCmd('align', 'eb-al-c')" :title="t('Centre the frame in the column')"><span v-html="icons.boxC"></span></button>
            <button class="eb-tb" @click="frameCmd('align', 'eb-al-r')" :title="t('Put the frame at the right margin')"><span v-html="icons.boxR"></span></button>
            <button class="eb-tb" @click="frameCmd('fit')" :title="t('Make the frame the width of the column')"><span v-html="icons.boxW"></span></button>
            <span class="sep"></span>
            <button class="eb-tb" @click="openFrameProps" :title="t('Frame properties…')"><span v-html="icons.props"></span></button>
            <button class="eb-tb danger" @click="frameCmd('delete')" :title="t('Delete')"><span v-html="icons.clear"></span></button>
          </div>
        </div>
      </div>
      <div class="eb-empty" v-if="!doc.id">
        <span class="mark" v-html="logo"></span>
        <p>{{ t('No document is open.') }}</p>
        <button class="eb-btn primary" @click="newDoc">{{ t('New document') }}</button>
      </div>
    </div>

    <div class="eb-status" v-if="doc.id">
      <span class="grow">{{ doc.name }}</span>
      <span>{{ t('{n} pages', { n: pageCount }) }}</span>
      <span>{{ t('{n} characters', { n: counts }) }}</span>
      <span>{{ paperLabel }}</span>
    </div>
  </section>

  <!-- paper setup -->
  <div v-if="paperOpen" class="eb-modal-back" @click="paperOpen = false">
    <div class="eb-modal" @click.stop>
      <h3>🖹 {{ t('Paper setup') }}</h3>
      <div class="body">
        <div class="eb-row">
          <div class="eb-field">
            <label>{{ t('Paper size') }}</label>
            <select v-model="doc.paper.size" @change="touchSettings"><option v-for="p in paperSizes" :key="p" :value="p">{{ p }}</option></select>
          </div>
          <div class="eb-field">
            <label>{{ t('Orientation') }}</label>
            <select v-model="doc.paper.orientation" @change="touchSettings">
              <option value="portrait">{{ t('Portrait') }}</option>
              <option value="landscape">{{ t('Landscape') }}</option>
            </select>
          </div>
        </div>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Top margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="doc.paper.margin.top" @change="touchSettings"></div>
          <div class="eb-field"><label>{{ t('Bottom margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="doc.paper.margin.bottom" @change="touchSettings"></div>
          <div class="eb-field"><label>{{ t('Left margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="doc.paper.margin.left" @change="touchSettings"></div>
          <div class="eb-field"><label>{{ t('Right margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="doc.paper.margin.right" @change="touchSettings"></div>
        </div>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Default body size (pt)') }}</label><input type="number" min="6" max="36" step="0.5" v-model.number="doc.paper.fontSize" @change="touchSettings"></div>
          <div class="eb-field"><label>{{ t('Default line height') }}</label><input type="number" min="1" max="3" step="0.05" v-model.number="doc.paper.lineHeight" @change="touchSettings"></div>
        </div>
        <div class="eb-field">
          <label>{{ t('Direction of the text') }}</label>
          <select :value="doc.paper.vertical ? 'v' : 'h'" @change="setVertical($event.target.value === 'v')">
            <option value="h">{{ t('Across the page (horizontal)') }}</option>
            <option value="v">{{ t('Down the page (vertical, 縦書き)') }}</option>
          </select>
        </div>
        <div class="eb-field">
          <label>{{ t('Number the headings') }}</label>
          <select v-model="doc.paper.headingNumbers" @change="touchSettings">
            <option value="">{{ t('Not numbered') }}</option>
            <option value="decimal">{{ t('1. / 1.1 / 1.1.1') }}</option>
            <option value="japanese">{{ t('Chapter 1 / Section 1 / (1), in Japanese') }}</option>
          </select>
          <p class="eb-tip">{{ t('The numbers are counted by the file itself, so adding a section renumbers everything after it. They are not part of the text and do not appear in a contents list.') }}</p>
        </div>
        <p class="eb-tip">{{ t('These are the document’s own defaults — what text is set in when nothing else has been said about it. To change one passage, use the size and typeface boxes in the toolbar; they act on what is selected, or on the paragraph the cursor is in.') }}</p>
        <div class="eb-field">
          <label>{{ t('Default typefaces') }}</label>
          <div class="font-rows">
            <button v-for="r in fontRoles" :key="r.key" class="font-row" @click="openFonts(r.key)">
              <span class="role">{{ r.label }}</span>
              <span class="fam" :style="{ fontFamily: fontPreviewStack(fontsInUse[r.key]) }">{{ fontsInUse[r.key] }}</span>
              <span class="tag" v-if="!doc.paper.fonts[r.key]">{{ t('default') }}</span>
              <span class="caret" v-html="icons.down"></span>
            </button>
          </div>
          <p class="eb-tip">{{ t('Any family on Google Fonts can be used. The document carries its typefaces with it, so the file looks the same on a machine where they are not installed.') }}</p>
        </div>
        <p class="eb-tip">{{ t('Page numbers and running headers come from your browser print dialogue: browsers do not yet support headers inside the page rule. Everything else here is written into the file.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="saveDefaultPaper">{{ t('Use as default for new documents') }}</button>
        <button class="eb-btn primary" @click="paperOpen = false">{{ t('Done') }}</button>
      </div>
    </div>
  </div>

  <!-- insert table -->
  <div v-if="tableOpen" class="eb-modal-back" @click="tableOpen = false">
    <div class="eb-modal" @click.stop>
      <h3>▦ {{ t('Insert table') }}</h3>
      <div class="body">
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Rows') }}</label><input type="number" min="1" max="60" v-model.number="table.rows"></div>
          <div class="eb-field"><label>{{ t('Columns') }}</label><input type="number" min="1" max="16" v-model.number="table.cols"></div>
          <div class="eb-field">
            <label>{{ t('Style') }}</label>
            <select v-model="table.variant">
              <option value="">{{ t('All borders') }}</option>
              <option value="rows">{{ t('Horizontal lines only') }}</option>
              <option value="borderless">{{ t('No borders') }}</option>
            </select>
          </div>
        </div>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" v-model="table.header"> {{ t('First row is a header') }}</label>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="tableOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="addTable">{{ t('Insert') }}</button>
      </div>
    </div>
  </div>

  <!-- formula -->
  <div v-if="mathOpen" class="eb-modal-back" @click="mathOpen = false">
    <div class="eb-modal" @click.stop>
      <h3>∑ {{ t('Insert formula (MathML)') }}</h3>
      <div class="body">
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
          <button v-for="s in mathSnippets" :key="s.label" class="eb-btn" @click="math.source = s.code">{{ s.label }}</button>
        </div>
        <div class="eb-field">
          <label>MathML</label>
          <textarea v-model="math.source" rows="7" spellcheck="false"></textarea>
        </div>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" v-model="math.block"> {{ t('Own line, centred') }}</label>
        <div class="eb-field">
          <label>{{ t('Preview') }}</label>
          <div class="eb-doc" style="background:#fff;color:#111;border-radius:9px;padding:10px 12px;overflow-x:auto" v-html="mathPreview"></div>
        </div>
        <p class="eb-tip">{{ t('MathML is drawn by the browser itself, so the formula stays text in the file — searchable, selectable and never a picture.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="mathOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="addMath">{{ t('Insert') }}</button>
      </div>
    </div>
  </div>

  <!-- the other apps on this server -->
  <div v-if="sourceOpen" class="eb-modal-back" @click="sourceOpen = false">
    <div class="eb-modal tall" @click.stop>
      <h3><span v-html="icons.link"></span> {{ sourceLabel(source) }}</h3>
      <div class="body">
        <p class="hint" v-if="src.loading">{{ t('Loading…') }}</p>
        <p class="eb-tip" v-if="src.error" style="color:var(--danger)">{{ src.error }}</p>

        <!-- Tables -->
        <template v-if="source === 'tables'">
          <div class="font-list" v-if="!src.detail">
            <button v-for="x in src.items" :key="x.id" class="fp-item" @click="openCollection(x)">
              <span class="ic">{{ x.emoji || '▦' }}</span><span class="nm">{{ x.title }}</span>
            </button>
            <p class="hint" v-if="!src.items.length && !src.loading">{{ t('There is nothing here yet.') }}</p>
          </div>
          <template v-if="src.detail">
            <p class="eb-tip">{{ t('{name}: {c} columns, {r} rows', { name: src.detail.title, c: src.detail.columns.length, r: src.detail.rows.length }) }}</p>
            <label class="opt"><input type="checkbox" v-model="src.withHeader"> {{ t('First row is a header') }}</label>
            <div class="src-preview">
              <table class="eb-table">
                <tr v-if="src.withHeader"><th v-for="(c, i) in src.detail.columns" :key="i">{{ c }}</th></tr>
                <tr v-for="(row, i) in src.detail.rows.slice(0, 8)" :key="i"><td v-for="(cell, j) in row" :key="j">{{ cell }}</td></tr>
              </table>
            </div>
          </template>
        </template>

        <!-- Contacts -->
        <template v-if="source === 'contacts'">
          <div class="font-search">
            <span v-html="icons.search"></span>
            <input type="text" v-model="src.query" @keydown.enter.prevent="searchContacts" :placeholder="t('Search contacts…')">
            <button class="eb-btn" @click="searchContacts">{{ t('Search') }}</button>
          </div>
          <div class="font-list">
            <button v-for="p in src.items" :key="p.id" class="fp-item" @click="insertContact(p)">
              <span class="nm">{{ p.name }}</span>
              <span class="meta">{{ p.org }}{{ p.system ? ' · ' + t('User directory') : '' }}</span>
            </button>
            <p class="hint" v-if="!src.items.length && !src.loading">{{ t('No contact matches that.') }}</p>
          </div>
          <p class="eb-tip">{{ t('Choosing a contact writes the address block at the cursor. For one letter per contact, use the merge fields below.') }}</p>
          <div class="chips">
            <button v-for="k in contactFields" :key="k" class="chip" @click="insertField(k)">{{ fieldTag(k) }}</button>
          </div>
        </template>

        <!-- Calendar -->
        <template v-if="source === 'calendar'">
          <div class="eb-row">
            <div class="eb-field"><label>{{ t('From') }}</label><input type="date" v-model="src.from" @change="loadEvents"></div>
            <div class="eb-field"><label>{{ t('To') }}</label><input type="date" v-model="src.to" @change="loadEvents"></div>
            <div class="eb-field">
              <label>{{ t('Calendar') }}</label>
              <select v-model="src.calendar" @change="loadEvents">
                <option value="">{{ t('All calendars') }}</option>
                <option v-for="c in src.items" :key="c.key" :value="c.key">{{ c.name }}</option>
              </select>
            </div>
          </div>
          <div class="font-list">
            <div v-for="(e, i) in src.records" :key="i" class="fp-item">
              <span class="nm">{{ e.summary }}</span>
              <span class="meta">{{ e.start.slice(0, 16).replace('T', ' ') }}{{ e.allDay ? ' · ' + t('All day') : '' }}{{ e.location ? ' · ' + e.location : '' }}</span>
            </div>
            <p class="hint" v-if="!src.records.length && !src.loading">{{ t('No events in that range.') }}</p>
          </div>
        </template>

        <!-- RegiBase -->
        <template v-if="source === 'regibase'">
          <div class="font-list" v-if="!src.collection">
            <button v-for="x in src.items" :key="x.id" class="fp-item" @click="openCollection(x)">
              <span class="ic">{{ x.icon || '🗄' }}</span><span class="nm">{{ x.name }}</span><span class="meta">{{ x.count }}</span>
            </button>
            <p class="hint" v-if="!src.items.length && !src.loading">{{ t('There is nothing here yet.') }}</p>
          </div>
          <template v-if="src.collection">
            <p class="eb-tip">{{ t('{name}: {c} fields, {r} records', { name: src.collection.name, c: src.fields.length, r: src.records.length }) }}</p>
            <div class="font-list">
              <button v-for="r in src.records" :key="r.id" class="fp-item" @click="insertRecord(r)">
                <span class="nm">{{ recordName(r) }}</span>
                <span class="meta">{{ recordMeta(r) }}</span>
              </button>
              <p class="hint" v-if="!src.records.length && !src.loading">{{ t('There is nothing here yet.') }}</p>
            </div>
            <p class="eb-tip">{{ t('Choosing a record writes it at the cursor as a two-column table, leaving out the fields it has nothing in. For one letter per record, use the merge fields below.') }}</p>
            <div class="chips">
              <button v-for="f in src.fields" :key="f.key" class="chip" @click="insertField(f.key)">{{ fieldTag(f.key) }} {{ f.label }}</button>
            </div>
          </template>
        </template>

        <!-- FormulaBase -->
        <template v-if="source === 'formulabase'">
          <div class="font-list" v-if="!src.collection">
            <button v-for="x in src.items" :key="x.id" class="fp-item" @click="openCollection(x)">
              <span class="ic">{{ x.icon || '∑' }}</span><span class="nm">{{ x.name }}</span>
            </button>
            <p class="hint" v-if="!src.items.length && !src.loading">{{ t('There is nothing here yet.') }}</p>
          </div>
          <div class="font-list" v-if="src.collection">
            <button v-for="f in src.records" :key="f.id" class="fp-item" @click="insertFormula(f)">
              <span class="nm">{{ f.name }}</span>
              <span class="meta mono">{{ f.expression }}</span>
            </button>
          </div>
        </template>

        <!-- Notes -->
        <template v-if="source === 'notes'">
          <div class="font-list">
            <button v-for="n in src.items" :key="n.id" class="fp-item" @click="insertNote(n)">
              <span class="nm">{{ n.title }}</span>
              <span class="meta">{{ n.category }}</span>
            </button>
            <p class="hint" v-if="!src.items.length && !src.loading">{{ t('There is nothing here yet.') }}</p>
          </div>
        </template>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" v-if="src.detail || src.collection" @click="src.detail = null; src.collection = null">{{ t('Back') }}</button>
        <button class="eb-btn ghost" v-if="source === 'contacts' || (source === 'regibase' && src.collection)" @click="openMerge(source === 'contacts' ? 'contacts' : 'regibase')">{{ t('Mail merge…') }}</button>
        <button class="eb-btn" v-if="source === 'calendar' && src.records.length" @click="insertEvents(true)">{{ t('Insert as a table') }}</button>
        <button class="eb-btn primary" v-if="source === 'calendar' && src.records.length" @click="insertEvents(false)">{{ t('Insert as a list') }}</button>
        <button class="eb-btn primary" v-if="source === 'tables' && src.detail" @click="insertTableData">{{ t('Insert') }}</button>
        <button class="eb-btn ghost" @click="sourceOpen = false">{{ t('Close') }}</button>
      </div>
    </div>
  </div>

  <!-- mail merge -->
  <div v-if="mergeOpen" class="eb-modal-back" @click="mergeOpen = false">
    <div class="eb-modal" @click.stop>
      <h3>{{ t('Mail merge') }}</h3>
      <div class="body">
        <p class="eb-tip" v-if="!merge.keys.length">{{ mergeHint }}</p>
        <template v-else>
          <p class="eb-tip">{{ t('{n} records will be filled into {k} fields:', { n: merge.count, k: merge.keys.length }) }}</p>
          <div class="chips"><span v-for="k in merge.keys" :key="k" class="chip">{{ fieldTag(k) }}</span></div>
          <label class="opt" style="margin-top:10px"><input type="radio" :value="false" v-model="merge.separate"> {{ t('One document, one page per record') }}</label>
          <label class="opt"><input type="radio" :value="true" v-model="merge.separate"> {{ t('A separate document per record') }}</label>
        </template>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="mergeOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" :disabled="!merge.keys.length || merge.busy" @click="runMerge">{{ merge.busy ? t('Working…') : t('Merge') }}</button>
      </div>
    </div>
  </div>

  <!-- pictures from Files -->
  <div v-if="pickerOpen" class="eb-modal-back" @click="pickerOpen = false">
    <div class="eb-modal tall" @click.stop>
      <h3><span v-html="icons.image"></span> {{ t('Insert picture') }}</h3>
      <div class="body">
        <div class="fp-path">
          <button class="eb-btn ghost" :disabled="picker.parent === null || picker.loading" @click="pickerLoad(picker.parent)"><span v-html="icons.up"></span></button>
          <span class="crumbs">/{{ picker.path }}</span>
        </div>
        <div class="font-list">
          <p class="hint" v-if="picker.loading">{{ t('Loading…') }}</p>
          <p class="hint" v-if="picker.error">{{ picker.error }}</p>
          <button v-for="x in picker.entries" :key="x.path" class="fp-item"
            :class="{ on: picker.selected && picker.selected.path === x.path, dim: !x.is_dir && !x.is_image }"
            @click="pickerClick(x)" @dblclick="pickerConfirm(x)">
            <span class="ic" v-html="x.is_dir ? icons.folder : icons.image"></span>
            <span class="nm">{{ x.name }}</span>
            <span class="meta" v-if="!x.is_dir">{{ size(x.size) }}</span>
          </button>
          <p class="hint" v-if="!picker.loading && !picker.entries.length">{{ t('This folder is empty.') }}</p>
        </div>
        <p class="eb-tip">{{ t('The picture is embedded in the document itself, so it travels with the file. Large photographs are scaled down on the way in.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="pickerOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" :disabled="!picker.selected || picker.busy" @click="pickerConfirm()">{{ picker.busy ? t('Loading…') : t('Insert') }}</button>
      </div>
    </div>
  </div>

  <!-- typeface picker -->
  <div v-if="fontsOpen" class="eb-modal-back" @click="closeFonts">
    <div class="eb-modal tall" @click.stop>
      <h3><span v-html="icons.text"></span> {{ t('Typeface') }} — {{ fontRoleLabel }}</h3>
      <div class="body">
        <div class="font-search">
          <span v-html="icons.search"></span>
          <input type="text" v-model="fontQuery" @input="fontPage = 1" :placeholder="t('Search Google Fonts…')">
        </div>
        <div class="chips">
          <button v-for="c in fontCats" :key="c.key" class="chip" :class="{ on: fontCat === c.key }" @click="fontCat = c.key; fontPage = 1">{{ c.label }}</button>
        </div>
        <div class="chips">
          <select v-model="fontScript" @change="fontPage = 1">
            <option value="auto">{{ t('Script of this document') }} — {{ scriptLabel(docScript) }}</option>
            <option value="all">{{ t('Every script') }}</option>
            <option v-for="sc in fontScripts" :key="sc" :value="sc">{{ scriptLabel(sc) }}</option>
          </select>
          <span class="count">{{ t('{n} families', { n: fontResults.length }) }}</span>
        </div>
        <div class="font-list">
          <button class="font-item" :class="{ on: fontRole === 'selection' ? !fmt.family : !doc.paper.fonts[fontRole] }" @click="chooseFont('')">
            <span class="nm">{{ fontRole === 'selection' ? t('As the paragraph style says') : t('Default for this language') }}</span>
            <span class="meta">{{ fontRole === 'selection' ? fontsInUse.body : defaultFontName }}</span>
          </button>
          <button v-for="f in fontPageItems" :key="f.f" class="font-item" :class="{ on: fontRole === 'selection' ? fmt.family === f.f : doc.paper.fonts[fontRole] === f.f }" @click="chooseFont(f.f)">
            <span class="nm" :style="{ fontFamily: fontPreviewStack(f.f) }">{{ f.f }}</span>
            <span class="meta">{{ catLabel(f.c) }} · {{ t('{n} weights', { n: f.w.length }) }}</span>
          </button>
          <p class="hint" v-if="!fontResults.length && fontsLoading">{{ t('Loading…') }}</p>
          <p class="hint" v-if="!fontResults.length && !fontsLoading">{{ t('No family matches that.') }}</p>
        </div>
        <button class="eb-btn wide" v-if="fontPageItems.length < fontResults.length" @click="fontPage++">{{ t('Show more') }}</button>
        <div class="eb-field">
          <label>{{ t('Preview') }}</label>
          <div class="font-sample" :style="{ fontFamily: fontPreviewStack(previewFamily) }">{{ sampleText }}</div>
        </div>
      </div>
      <div class="foot"><button class="eb-btn primary" @click="closeFonts">{{ t('Done') }}</button></div>
    </div>
  </div>

  <!-- settings -->
  <div v-if="settingsOpen" class="eb-modal-back" @click="settingsOpen = false">
    <div class="eb-modal" @click.stop>
      <h3>⚙ {{ t('Settings') }}</h3>
      <div class="body">
        <div class="eb-field">
          <label>{{ t('Save documents in') }}</label>
          <input type="text" v-model="settings.folder">
          <p class="eb-tip">{{ t('A folder in your own Files. Documents already saved elsewhere stay where they are.') }}</p>
        </div>
        <div class="eb-row">
          <div class="eb-field">
            <label>{{ t('Theme') }}</label>
            <select v-model="settings.theme">
              <option value="auto">{{ t('Follow Nextcloud') }}</option>
              <option value="light">{{ t('Light') }}</option>
              <option value="dark">{{ t('Dark') }}</option>
            </select>
          </div>
          <div class="eb-field">
            <label>{{ t('Language') }}</label>
            <select v-model="settings.language">
              <option value="auto">{{ t('Follow Nextcloud') }}</option>
              <option v-for="l in settings.languages" :key="l.code" :value="l.code">{{ l.name }}</option>
            </select>
          </div>
        </div>
        <div class="eb-field">
          <label class="opt"><input type="checkbox" :checked="spellcheck" @change="toggleSpellcheck"> {{ t('Check spelling while typing') }}</label>
          <label class="opt"><input type="checkbox" :checked="autolink" @change="toggleAutolink"> {{ t('Turn an address into a link as it is typed') }}</label>
          <p class="eb-tip">{{ t('Spelling is checked by the browser itself, in the language it is set to. Shift+right-click reaches its suggestions.') }}</p>
        </div>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" v-model="autosave"> {{ t('Save automatically while typing') }}</label>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="settingsOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="saveSettings">{{ t('Save') }}</button>
      </div>
    </div>
  </div>

  <!-- the file itself -->
  <div v-if="htmlOpen" class="eb-modal-back" @click="htmlOpen = false">
    <div class="eb-modal" style="width:min(860px,100%)" @click.stop>
      <h3>&lt;/&gt; {{ t('View the HTML') }}</h3>
      <div class="body">
        <p class="eb-tip">{{ t('This is exactly what is stored in Files — one file, styles included, nothing else needed to open it.') }}</p>
        <textarea rows="18" spellcheck="false" readonly :value="htmlText" style="width:100%;font-family:monospace;font-size:12px"></textarea>
      </div>
      <div class="foot"><button class="eb-btn primary" @click="htmlOpen = false">{{ t('Close') }}</button></div>
    </div>
  </div>

  <!-- the right button, as a word processor uses it -->
  <!-- the styles of the document: one rule per kind of paragraph -->
  <div v-if="stylesOpen" class="eb-modal-back" @click="closeStyles">
    <div class="eb-modal" @click.stop>
      <h3>{{ t('Styles of this document') }}</h3>
      <div class="body">
        <div class="eb-field">
          <label>{{ t('Which style') }}</label>
          <select v-model="styleKey">
            <option v-for="t2 in styleTargets" :key="t2.key" :value="t2.key">{{ t2.label }}</option>
          </select>
        </div>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Typeface') }}</label>
            <select :value="styleNow.family" @change="styleNow.family = $event.target.value; touchStyles()">
              <option value="">{{ t('As the document says') }}</option>
              <option v-for="f in styleFamilies" :key="f" :value="f">{{ f }}</option>
            </select>
          </div>
          <div class="eb-field"><label>{{ t('Size (pt)') }}</label><input type="number" min="4" max="200" step="0.5" v-model="styleNow.size" @input="touchStyles"></div>
          <div class="eb-field"><label>{{ t('Colour') }}</label>
            <div class="colour-pair">
              <input type="color" :value="styleNow.colour || '#111111'" @input="styleNow.colour = $event.target.value; touchStyles()">
              <button class="eb-btn ghost" @click="styleNow.colour = ''; touchStyles()">{{ t('None') }}</button>
            </div>
          </div>
        </div>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Alignment') }}</label>
            <select v-model="styleNow.align" @change="touchStyles">
              <option value="">{{ t('Unchanged') }}</option>
              <option value="left">{{ t('Left') }}</option>
              <option value="center">{{ t('Centre') }}</option>
              <option value="right">{{ t('Right') }}</option>
              <option value="justify">{{ t('Justified') }}</option>
            </select>
          </div>
          <div class="eb-field"><label>{{ t('Line height') }}</label><input type="number" min="1" max="4" step="0.05" v-model="styleNow.lineHeight" @input="touchStyles"></div>
          <div class="eb-field"><label>{{ t('Space above (pt)') }}</label><input type="number" min="0" max="200" step="0.5" v-model="styleNow.before" @input="touchStyles"></div>
          <div class="eb-field"><label>{{ t('Space below (pt)') }}</label><input type="number" min="0" max="200" step="0.5" v-model="styleNow.after" @input="touchStyles"></div>
        </div>
        <label class="opt"><input type="checkbox" v-model="styleNow.bold" @change="touchStyles"> {{ t('Bold') }}</label>
        <label class="opt"><input type="checkbox" v-model="styleNow.italic" @change="touchStyles"> {{ t('Italic') }}</label>
        <p class="eb-tip">{{ t('This changes every paragraph of that kind at once, now and later, because it is written as a rule in the file rather than on each paragraph. Anything you have set on one paragraph by hand still wins over it.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="clearStyle">{{ t('Reset this style') }}</button>
        <button class="eb-btn primary" @click="closeStyles">{{ t('Done') }}</button>
      </div>
    </div>
  </div>

  <!-- cropping a picture: a shape for the frame and a place to look at -->
  <div v-if="cropOpen" class="eb-modal-back" @click="cropOpen = false">
    <div class="eb-modal" style="width:min(520px,100%)" @click.stop>
      <h3>{{ t('Crop') }}</h3>
      <div class="body">
        <div class="eb-field">
          <label>{{ t('Shape') }}</label>
          <select v-model="crop.ratio">
            <option value="">{{ t('The whole picture') }}</option>
            <option value="1 / 1">{{ t('Square (1:1)') }}</option>
            <option value="4 / 3">4 : 3</option>
            <option value="3 / 2">3 : 2</option>
            <option value="16 / 9">16 : 9</option>
            <option value="3 / 4">3 : 4</option>
            <option value="2 / 3">2 : 3</option>
          </select>
        </div>
        <div class="eb-cropbox" v-if="crop.ratio" :style="{ aspectRatio: crop.ratio }" @pointerdown.prevent="cropGrab">
          <img :src="cropSrc" :style="{ objectPosition: crop.x + '% ' + crop.y + '%' }">
          <span class="hint">{{ t('Drag the picture to choose what shows.') }}</span>
        </div>
        <p class="eb-tip">{{ t('Nothing is cut away: the whole picture stays in the file and the frame simply shows part of it, so the crop can be changed or undone at any time.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="crop.ratio = ''">{{ t('The whole picture') }}</button>
        <button class="eb-btn" @click="cropOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyCrop">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <!-- a rule round the chosen cells -->
  <div v-if="cellBorderOpen" class="eb-modal-back" @click="cellBorderOpen = false">
    <div class="eb-modal" style="width:min(560px,100%)" @click.stop>
      <h3>{{ t('Rule round the cells') }}</h3>
      <div class="body">
        <div class="eb-row eb-frow">
          <div class="eb-field b-style">
            <label>{{ t('Rule') }}</label>
            <select v-model="cellBorder.style">
              <option value="">{{ t('As the style says') }}</option>
              <option value="none">{{ t('None') }}</option>
              <option value="solid">{{ t('Solid') }}</option>
              <option value="dashed">{{ t('Dashed') }}</option>
              <option value="dotted">{{ t('Dotted') }}</option>
              <option value="double">{{ t('Double') }}</option>
            </select>
          </div>
          <div class="eb-field b-style">
            <label>{{ t('On which edges') }}</label>
            <select v-model="cellBorder.sides">
              <option value="all">{{ t('All four') }}</option>
              <option value="top">{{ t('Above') }}</option>
              <option value="bottom">{{ t('Below') }}</option>
              <option value="topbottom">{{ t('Above and below') }}</option>
              <option value="left">{{ t('At the left') }}</option>
            </select>
          </div>
          <div class="eb-field"><label>{{ t('Thickness (pt)') }}</label><input type="number" min="0.25" step="0.25" v-model="cellBorder.width"></div>
          <div class="eb-field"><label>{{ t('Line colour') }}</label><input type="color" v-model="cellBorder.colour"></div>
        </div>
        <p class="eb-tip">{{ t('This is put on every cell the selection touches. Select across several cells first to do a block of them at once.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn" @click="cellBorderOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyCellBorder">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <!-- a reading over a word -->
  <div v-if="rubyOpen" class="eb-modal-back" @click="rubyOpen = false">
    <div class="eb-modal" style="width:min(420px,100%)" @click.stop>
      <h3>{{ t('Reading') }}</h3>
      <div class="body">
        <div class="eb-field"><label>{{ t('Word') }}</label><input type="text" :value="rubyWord" readonly></div>
        <div class="eb-field"><label>{{ t('Reading') }}</label><input ref="rubyInput" type="text" v-model="rubyText" @keydown.enter.prevent="applyRubyText"></div>
        <p class="eb-tip">{{ t('The reading is written above the word, at half its size, using the element HTML has for exactly this.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" v-if="fmt.ruby" @click="dropRuby">{{ t('Remove the reading') }}</button>
        <button class="eb-btn" @click="rubyOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyRubyText">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <!-- a note -->
  <div v-if="noteOpen" class="eb-modal-back" @click="noteOpen = false">
    <div class="eb-modal" style="width:min(520px,100%)" @click.stop>
      <h3>{{ t('Note') }}</h3>
      <div class="body">
        <div class="eb-field"><label>{{ t('The note') }}</label><textarea ref="noteInput" rows="4" v-model="noteText"></textarea></div>
        <p class="eb-tip">{{ t('A number goes in at the cursor and the note is added to the list at the end of the document. The numbers follow the order the notes are cited in and look after themselves. A browser cannot put a note at the foot of the page that cites it: nothing in CSS moves text from one page to another.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn" @click="noteOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyNote">{{ t('Insert') }}</button>
      </div>
    </div>
  </div>

  <!-- columns -->
  <div v-if="colsOpen" class="eb-modal-back" @click="colsOpen = false">
    <div class="eb-modal" style="width:min(460px,100%)" @click.stop>
      <h3>{{ t('Columns') }}</h3>
      <div class="body">
        <div class="eb-row">
          <div class="eb-field">
            <label>{{ t('Columns') }}</label>
            <select v-model.number="cols.count">
              <option :value="1">{{ t('One (no columns)') }}</option>
              <option :value="2">{{ t('Two') }}</option>
              <option :value="3">{{ t('Three') }}</option>
              <option :value="4">{{ t('Four') }}</option>
            </select>
          </div>
          <div class="eb-field"><label>{{ t('Gap (mm)') }}</label><input type="number" min="0" max="40" step="1" v-model.number="cols.gap"></div>
        </div>
        <p class="eb-tip">{{ t('The paragraphs you have selected are laid out in columns. Select a paragraph inside them and choose one column to take the columns off again.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn" @click="colsOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyCols">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <!-- the running header and footer -->
  <div v-if="runOpen" class="eb-modal-back" @click="runOpen = false">
    <div class="eb-modal" @click.stop>
      <h3>{{ t('Header and footer') }}</h3>
      <div class="body">
        <label>{{ t('Header') }}</label>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Left') }}</label><input type="text" maxlength="120" v-model="doc.paper.header.l" @input="touch"></div>
          <div class="eb-field"><label>{{ t('Centre') }}</label><input type="text" maxlength="120" v-model="doc.paper.header.c" @input="touch"></div>
          <div class="eb-field"><label>{{ t('Right') }}</label><input type="text" maxlength="120" v-model="doc.paper.header.r" @input="touch"></div>
        </div>
        <label>{{ t('Footer') }}</label>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Left') }}</label><input type="text" maxlength="120" v-model="doc.paper.footer.l" @input="touch"></div>
          <div class="eb-field"><label>{{ t('Centre') }}</label><input type="text" maxlength="120" v-model="doc.paper.footer.c" @input="touch"></div>
          <div class="eb-field"><label>{{ t('Right') }}</label><input type="text" maxlength="120" v-model="doc.paper.footer.r" @input="touch"></div>
        </div>
        <p class="eb-tip">{{ t('These repeat in the margin of every printed page. They are plain text: page numbers cannot be counted by a browser, and come from its own print dialogue instead.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="clearRunning">{{ t('Clear') }}</button>
        <button class="eb-btn primary" @click="runOpen = false">{{ t('Done') }}</button>
      </div>
    </div>
  </div>

  <!-- frame properties: everything here is written on the object as inline CSS,
       so the saved file carries its own layout and needs nothing to read it -->
  <div v-if="fpropsOpen" class="eb-modal-back" @click="fpropsOpen = false">
    <div class="eb-modal" @click.stop>
      <h3>{{ t('{name} properties', { name: frameLabel }) }}</h3>
      <div class="body">
        <div class="eb-row">
          <div class="eb-field">
            <label>{{ t('Placement') }}</label>
            <select v-model="fprops.place">
              <option value="">{{ t('In the flow of the text') }}</option>
              <option value="left">{{ t('In the flow, at the left') }}</option>
              <option value="center">{{ t('In the flow, centred') }}</option>
              <option value="right">{{ t('In the flow, at the right') }}</option>
              <option value="free">{{ t('Placed freely') }}</option>
            </select>
          </div>
          <div class="eb-field">
            <label>{{ t('Text inside it') }}</label>
            <select v-model="fprops.inner">
              <option value="">{{ t('As the document is set') }}</option>
              <option value="eb-al-l">{{ t('Ranged left') }}</option>
              <option value="eb-al-c">{{ t('Centred') }}</option>
              <option value="eb-al-r">{{ t('Ranged right') }}</option>
              <option value="eb-al-j">{{ t('Justified') }}</option>
            </select>
          </div>
          <div class="eb-field">
            <label>{{ t('Text wrap') }}</label>
            <select v-model="fprops.wrap">
              <option value="">{{ t('None') }}</option>
              <option value="left">{{ t('Text wraps on the right') }}</option>
              <option value="right">{{ t('Text wraps on the left') }}</option>
            </select>
          </div>
        </div>
        <div class="eb-row" v-if="freePlacement">
          <div class="eb-field"><label>{{ t('From the left (mm)') }}</label><input type="number" step="1" v-model="fprops.x"></div>
          <div class="eb-field"><label>{{ t('From the top (mm)') }}</label><input type="number" step="1" v-model="fprops.y"></div>
          <div class="eb-field">
            <label>{{ t('Overlapping') }}</label>
            <div class="colour-pair">
              <button class="eb-btn ghost" @click="stackFromProps('front')">{{ t('Bring to front') }}</button>
              <button class="eb-btn ghost" @click="stackFromProps('back')">{{ t('Send to back') }}</button>
            </div>
          </div>
        </div>
        <p class="eb-tip" v-if="freePlacement">{{ t('A frame placed freely is measured from the line of text it was put on, so it keeps to that page when the document is printed. The text runs underneath it rather than round it.') }}</p>
        <p class="eb-tip" v-else-if="fprops.wrap">{{ t('The text runs round a wrapped frame. Move it with the four spacings below: they are what holds it away from the words.') }}</p>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Width (mm)') }}</label><input type="number" min="5" step="1" v-model="fprops.width" :placeholder="t('auto')"></div>
          <div class="eb-field"><label>{{ t('Height (mm)') }}</label><input type="number" min="3" step="1" v-model="fprops.height" :placeholder="t('auto')"></div>
          <div class="eb-field"><label>{{ t('Inner margin (mm)') }}</label><input type="number" min="0" step="1" v-model="fprops.pad" :placeholder="t('auto')"></div>
        </div>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Space above (mm)') }}</label><input type="number" min="0" step="1" v-model="fprops.mt"></div>
          <div class="eb-field"><label>{{ t('Space below (mm)') }}</label><input type="number" min="0" step="1" v-model="fprops.mb"></div>
          <div class="eb-field"><label>{{ t('Space left (mm)') }}</label><input type="number" min="0" step="1" v-model="fprops.ml"></div>
          <div class="eb-field"><label>{{ t('Space right (mm)') }}</label><input type="number" min="0" step="1" v-model="fprops.mr"></div>
        </div>
        <div class="eb-row eb-frow">
          <div class="eb-field b-style">
            <label>{{ t('Border') }}</label>
            <select v-model="fprops.border">
              <option value="">{{ t('As the style says') }}</option>
              <option value="none">{{ t('None') }}</option>
              <option value="solid">{{ t('Solid') }}</option>
              <option value="dashed">{{ t('Dashed') }}</option>
              <option value="dotted">{{ t('Dotted') }}</option>
              <option value="double">{{ t('Double') }}</option>
            </select>
          </div>
          <div class="eb-field"><label>{{ t('Thickness (pt)') }}</label><input type="number" min="0.25" step="0.25" v-model="fprops.borderWidth"></div>
          <div class="eb-field"><label>{{ t('Line colour') }}</label><input type="color" v-model="fprops.borderColour"></div>
          <div class="eb-field"><label>{{ t('Corners (pt)') }}</label><input type="number" min="0" step="1" v-model="fprops.radius"></div>
        </div>
        <div class="eb-row">
          <div class="eb-field">
            <label>{{ t('Fill colour') }}</label>
            <div class="colour-pair">
              <input type="color" :value="fprops.fill || '#ffffff'" @input="fprops.fill = $event.target.value">
              <button class="eb-btn ghost" :class="{ on: !fprops.fill }" @click="fprops.fill = ''">{{ t('Transparent') }}</button>
            </div>
          </div>
          <div class="eb-field">
            <label>{{ t('Opacity (%)') }}</label>
            <input type="number" min="10" max="100" step="5" v-model="fprops.opacity" placeholder="100">
          </div>
          <div class="eb-field">
            <label>{{ t('Effects') }}</label>
            <label class="opt"><input type="checkbox" v-model="fprops.shadow"> {{ t('Drop shadow') }}</label>
            <label class="opt"><input type="checkbox" v-model="fprops.keep"> {{ t('Do not split across pages') }}</label>
          </div>
        </div>
        <p class="eb-tip">{{ t('Fill colours are printed: the file tells the browser to print them even when it would normally leave backgrounds out.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="clearFrameProps">{{ t('Clear') }}</button>
        <button class="eb-btn" @click="fpropsOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyFrameProps">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <div v-if="ctx.open" class="eb-ctx-back" @mousedown.prevent @click="closeCtxIfSettled" @touchend.prevent="closeCtxIfSettled" @contextmenu.prevent="closeCtx"></div>
  <div v-if="ctx.open" class="eb-ctxmenu" :class="{ flip: ctx.flip }" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @mousedown.prevent @contextmenu.prevent>
    <button class="ci" :disabled="!ctx.selection" @click="ctxDo('cut')"><span>{{ t('Cut') }}</span><span class="s k">Ctrl+X</span></button>
    <button class="ci" :disabled="!ctx.selection" @click="ctxDo('copy')"><span>{{ t('Copy') }}</span><span class="s k">Ctrl+C</span></button>
    <button class="ci" @click="ctxDo('paste')"><span>{{ t('Paste') }}</span><span class="s k">Ctrl+V</span></button>
    <button class="ci" @click="ctxDo('pasteText')"><span>{{ t('Paste as plain text') }}</span><span class="s k">Ctrl+Shift+V</span></button>
    <div class="sep"></div>

    <template v-if="ctx.link">
      <button class="ci" @click="ctxDo('linkOpen')">{{ t('Open the link') }}</button>
      <button class="ci" @click="ctxDo('link')">{{ t('Edit the link…') }}</button>
      <button class="ci" @click="ctxDo('linkDel')">{{ t('Remove the link') }}</button>
    </template>
    <button v-else class="ci" @click="ctxDo('link')"><span>{{ t('Hyperlink…') }}</span><span class="s k">Ctrl+K</span></button>
    <div class="sep"></div>

    <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
      <span>{{ t('Paragraph style') }}</span><span class="s">›</span>
      <div class="fly">
        <button class="ci" @click="ctxDo('block','P')">{{ t('Body text') }}</button>
        <button class="ci" @click="ctxDo('block','H1')">{{ t('Heading 1') }}</button>
        <button class="ci" @click="ctxDo('block','H2')">{{ t('Heading 2') }}</button>
        <button class="ci" @click="ctxDo('block','H3')">{{ t('Heading 3') }}</button>
        <button class="ci" @click="ctxDo('block','H4')">{{ t('Heading 4') }}</button>
        <button class="ci" @click="ctxDo('block','BLOCKQUOTE')">{{ t('Quotation') }}</button>
        <button class="ci" @click="ctxDo('block','PRE')">{{ t('Preformatted') }}</button>
      </div>
    </div>
    <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
      <span>{{ t('Character') }}</span><span class="s">›</span>
      <div class="fly">
        <button class="ci" @click="ctxDo('inline','bold')"><span>{{ t('Bold') }}</span><span class="s k">Ctrl+B</span></button>
        <button class="ci" @click="ctxDo('inline','italic')"><span>{{ t('Italic') }}</span><span class="s k">Ctrl+I</span></button>
        <button class="ci" @click="ctxDo('inline','underline')"><span>{{ t('Underline') }}</span><span class="s k">Ctrl+U</span></button>
        <button class="ci" @click="ctxDo('inline','strike')">{{ t('Strikethrough') }}</button>
        <button class="ci" @click="ctxDo('inline','kenten')">{{ t('Emphasis dots') }}</button>
        <button class="ci" @click="ctxDo('inline','sup')">{{ t('Superscript') }}</button>
        <button class="ci" @click="ctxDo('inline','sub')">{{ t('Subscript') }}</button>
        <button class="ci" @click="ctxDo('inline','code')">{{ t('Monospaced') }}</button>
        <div class="sep"></div>
        <button class="ci" @click="ctxDo('case','wide')">{{ t('To full width') }}</button>
        <button class="ci" @click="ctxDo('case','narrow')">{{ t('To half width') }}</button>
        <button class="ci" @click="ctxDo('case','upper')">{{ t('UPPER CASE') }}</button>
        <button class="ci" @click="ctxDo('case','lower')">{{ t('lower case') }}</button>
        <button class="ci" @click="ctxDo('case','title')">{{ t('Capitalise Each Word') }}</button>
      </div>
    </div>
    <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
      <span>{{ t('Alignment') }}</span><span class="s">›</span>
      <div class="fly">
        <button class="ci" @click="ctxDo('align','left')">{{ t('Left') }}</button>
        <button class="ci" @click="ctxDo('align','center')">{{ t('Centre') }}</button>
        <button class="ci" @click="ctxDo('align','right')">{{ t('Right') }}</button>
        <button class="ci" @click="ctxDo('align','justify')">{{ t('Justified') }}</button>
      </div>
    </div>
    <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
      <span>{{ t('List') }}</span><span class="s">›</span>
      <div class="fly">
        <button class="ci" @click="ctxDo('list','UL')">{{ t('Bulleted list') }}</button>
        <button class="ci" @click="ctxDo('list','OL')">{{ t('Numbered list') }}</button>
        <button class="ci" @click="ctxDo('indent',1)"><span>{{ t('Increase indent') }}</span><span class="s k">Tab</span></button>
        <button class="ci" @click="ctxDo('indent',-1)"><span>{{ t('Decrease indent') }}</span><span class="s k">Shift+Tab</span></button>
      </div>
    </div>

    <button class="ci" @click="ctxDo('para')">{{ t('Paragraph settings…') }}</button>
    <button class="ci" @click="ctxDo('chars')">{{ t('Special character…') }}</button>

    <template v-if="ctx.table">
      <div class="sep"></div>
      <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
        <span>{{ t('Table') }}</span><span class="s">›</span>
        <div class="fly">
          <button class="ci" @click="ctxDo('table','rowAbove')">{{ t('Insert a row above') }}</button>
          <button class="ci" @click="ctxDo('table','rowBelow')">{{ t('Insert a row below') }}</button>
          <button class="ci" @click="ctxDo('table','colLeft')">{{ t('Insert a column to the left') }}</button>
          <button class="ci" @click="ctxDo('table','colRight')">{{ t('Insert a column to the right') }}</button>
          <div class="sep"></div>
          <button class="ci" @click="ctxDo('table','rowDel')">{{ t('Delete the row') }}</button>
          <button class="ci" @click="ctxDo('table','colDel')">{{ t('Delete the column') }}</button>
          <div class="sep"></div>
          <button class="ci" @click="ctxDo('merge')">{{ t('Merge the cells') }}</button>
          <button class="ci" @click="ctxDo('split')">{{ t('Split the cell') }}</button>
          <div class="sep"></div>
          <button class="ci" @click="ctxDo('cellAlign','left')">{{ t('Cell text left') }}</button>
          <button class="ci" @click="ctxDo('cellAlign','center')">{{ t('Cell text centred') }}</button>
          <button class="ci" @click="ctxDo('cellAlign','right')">{{ t('Cell text right') }}</button>
          <div class="sep"></div>
          <button class="ci" @click="ctxDo('table','header')">{{ t('Header row') }}</button>
          <button class="ci" @click="ctxDo('table','delete')">{{ t('Delete the table') }}</button>
        </div>
      </div>
    </template>

    <template v-if="ctx.image">
      <div class="sep"></div>
      <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
        <span>{{ t('Picture') }}</span><span class="s">›</span>
        <div class="fly">
          <button class="ci" @click="ctxDo('image','eb-img-s')">{{ t('Small') }}</button>
          <button class="ci" @click="ctxDo('image','eb-img-m')">{{ t('Medium') }}</button>
          <button class="ci" @click="ctxDo('image','eb-img-l')">{{ t('Large') }}</button>
          <div class="sep"></div>
          <button class="ci" @click="ctxDo('float','')">{{ t('No text wrap') }}</button>
          <button class="ci" @click="ctxDo('float','left')">{{ t('Wrap text on the right') }}</button>
          <button class="ci" @click="ctxDo('float','right')">{{ t('Wrap text on the left') }}</button>
          <div class="sep"></div>
          <button class="ci" @click="ctxDo('alt')">{{ t('Alternative text…') }}</button>
          <button class="ci" @click="ctxDo('imageDel')">{{ t('Delete the picture') }}</button>
        </div>
      </div>
    </template>

    <template v-if="ctx.frame || ctx.text">
      <div class="sep"></div>
      <div class="ci has-sub" @mouseenter="placeFly" @click="toggleFly">
        <span>{{ ctx.frame ? t('Frame') : t('This phrase') }}</span><span class="s">›</span>
        <div class="fly">
          <button class="ci" @click="ctxDo('frameProps')">{{ t('Frame properties…') }}</button>
          <div class="sep"></div>
          <button class="ci" @click="ctxDo('frameFree')">{{ t('Place it freely') }}</button>
          <button class="ci" @click="ctxDo('frameWrap','')">{{ t('No text wrap') }}</button>
          <button class="ci" @click="ctxDo('frameWrap','left')">{{ t('Wrap text on the right') }}</button>
          <button class="ci" @click="ctxDo('frameWrap','right')">{{ t('Wrap text on the left') }}</button>
          <div class="sep"></div>
          <button class="ci" @click="ctxDo('frameFront')">{{ t('Bring to front') }}</button>
          <button class="ci" @click="ctxDo('frameBack')">{{ t('Send to back') }}</button>
          <div class="sep"></div>
          <button class="ci" v-if="ctx.frame" @click="ctxDo('frameDel')">{{ t('Delete the frame') }}</button>
        </div>
      </div>
    </template>

    <div class="sep"></div>
    <button class="ci" v-if="!flow" @click="ctxDo('guides')">{{ guides ? t('Hide the margin boundaries') : t('Show the margin boundaries') }}</button>
    <button class="ci" @click="ctxDo('clear')">{{ t('Clear formatting') }}</button>
  </div>

  <!-- paragraph properties, written as inline styles so the file carries them -->
  <div v-if="paraOpen" class="eb-modal-back" @click="paraOpen = false">
    <div class="eb-modal" style="width:min(580px,100%)" @click.stop>
      <h3>{{ t('Paragraph settings…') }}</h3>
      <div class="body">
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Alignment') }}</label>
            <select v-model="para.align">
              <option value="">{{ t('Unchanged') }}</option>
              <option value="left">{{ t('Left') }}</option>
              <option value="center">{{ t('Centre') }}</option>
              <option value="right">{{ t('Right') }}</option>
              <option value="justify">{{ t('Justified') }}</option>
            </select>
          </div>
          <div class="eb-field"><label>{{ t('Line height') }}</label><input type="number" min="1" max="4" step="0.05" v-model="para.lineHeight" :placeholder="t('From the paper setup')"></div>
        </div>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Space above (pt)') }}</label><input type="number" min="0" max="200" step="0.5" v-model="para.before"></div>
          <div class="eb-field"><label>{{ t('Space below (pt)') }}</label><input type="number" min="0" max="200" step="0.5" v-model="para.after"></div>
        </div>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Indent left (mm)') }}</label><input type="number" min="-100" max="200" step="0.5" v-model="para.left"></div>
          <div class="eb-field"><label>{{ t('Indent right (mm)') }}</label><input type="number" min="-100" max="200" step="0.5" v-model="para.right"></div>
          <div class="eb-field"><label>{{ t('First line (mm)') }}</label><input type="number" min="-100" max="200" step="0.5" v-model="para.firstLine"></div>
        </div>
        <div class="eb-row eb-frow">
          <div class="eb-field b-style">
            <label>{{ t('Rule round the paragraph') }}</label>
            <select v-model="para.border">
              <option value="">{{ t('None') }}</option>
              <option value="solid">{{ t('Solid') }}</option>
              <option value="dashed">{{ t('Dashed') }}</option>
              <option value="dotted">{{ t('Dotted') }}</option>
              <option value="double">{{ t('Double') }}</option>
            </select>
          </div>
          <div class="eb-field b-style">
            <label>{{ t('On which edges') }}</label>
            <select v-model="para.borderSides" :disabled="!para.border">
              <option value="all">{{ t('All four') }}</option>
              <option value="top">{{ t('Above') }}</option>
              <option value="bottom">{{ t('Below') }}</option>
              <option value="topbottom">{{ t('Above and below') }}</option>
              <option value="left">{{ t('At the left') }}</option>
            </select>
          </div>
          <div class="eb-field"><label>{{ t('Thickness (pt)') }}</label><input type="number" min="0.25" step="0.25" v-model="para.borderWidth" :disabled="!para.border"></div>
          <div class="eb-field"><label>{{ t('Line colour') }}</label><input type="color" v-model="para.borderColour" :disabled="!para.border"></div>
        </div>
        <div class="eb-row">
          <div class="eb-field">
            <label>{{ t('Shading') }}</label>
            <div class="colour-pair">
              <input type="color" :value="para.fill || '#ffffff'" @input="para.fill = $event.target.value">
              <button class="eb-btn ghost" @click="para.fill = ''">{{ t('None') }}</button>
            </div>
          </div>
          <div class="eb-field"><label>{{ t('Inner margin (mm)') }}</label><input type="number" min="0" max="40" step="0.5" v-model="para.pad"></div>
        </div>
        <label class="opt"><input type="checkbox" v-model="para.pageBefore"> {{ t('Start a new page before this paragraph') }}</label>
        <label class="opt"><input type="checkbox" v-model="para.keepWithNext"> {{ t('Keep with the next paragraph') }}</label>
        <label class="opt"><input type="checkbox" v-model="para.keepTogether"> {{ t('Do not split this paragraph across pages') }}</label>
        <label class="opt"><input type="checkbox" v-model="para.noLoneLines"> {{ t('Never leave one line of it alone on a page') }}</label>
        <p class="eb-tip">{{ t('Empty means the paragraph inherits from the paper setup. These are written into the file as ordinary CSS, so a browser prints them the same way.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="clearPara">{{ t('Reset') }}</button>
        <button class="eb-btn ghost" @click="paraOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyPara">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <!-- a table of contents, as links rather than page numbers -->
  <div v-if="tocOpen" class="eb-modal-back" @click="tocOpen = false">
    <div class="eb-modal" style="width:min(520px,100%)" @click.stop>
      <h3>{{ t('Table of contents…') }}</h3>
      <div class="body">
        <div class="eb-field"><label>{{ t('Title') }}</label><input type="text" v-model="tocTitle" @keydown.enter.prevent="applyToc"></div>
        <p class="eb-tip">{{ t('Built from the headings in the document, as links to them. Running it again brings an existing contents list up to date.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="tocOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyToc">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <!-- characters that are awkward to type -->
  <div v-if="charsOpen" class="eb-modal-back" @click="charsOpen = false">
    <div class="eb-modal" style="width:min(620px,100%)" @click.stop>
      <h3>{{ t('Special character…') }}</h3>
      <div class="body">
        <div class="chips">
          <button v-for="c in charSets" :key="c.key" class="chip" :class="{ on: charSet === c.key }" @click="charSet = c.key">{{ t(c.key) }}</button>
        </div>
        <div class="eb-chargrid">
          <button v-for="(ch, i) in charsOf(charSet)" :key="i" class="eb-charcell" @click="pickChar(ch)">{{ ch }}</button>
        </div>
        <p class="eb-tip">{{ t('The character goes in at the caret. The dialog stays open so several can be picked.') }}</p>
      </div>
      <div class="foot"><button class="eb-btn primary" @click="charsOpen = false">{{ t('Close') }}</button></div>
    </div>
  </div>

  <!-- a hyperlink -->
  <div v-if="webOpen" class="eb-modal-back" @click="webOpen = false">
    <div class="eb-modal" style="width:min(560px,100%)" @click.stop>
      <h3>{{ t('Bring in a web page…') }}</h3>
      <div class="body">
        <div class="eb-field"><label>{{ t('Address') }}</label>
          <input type="text" v-model="webUrl" placeholder="https://example.org/page" @keydown.enter.prevent="fetchWebPage"></div>
        <p class="eb-tip">{{ t('The writing on the page is brought in: headings, paragraphs, lists, tables and pictures. Navigation, sidebars and advertising are left behind. Copying a page and pasting it here does the same thing.') }}</p>
        <p class="eb-tip" v-if="webBusy">{{ t('Fetching…') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="webOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" :disabled="webBusy || !webUrl" @click="fetchWebPage">{{ t('Bring it in') }}</button>
      </div>
    </div>
  </div>
  <div v-if="linkOpen" class="eb-modal-back" @click="linkOpen = false">
    <div class="eb-modal" style="width:min(520px,100%)" @click.stop>
      <h3>{{ link.editing ? t('Edit the link…') : t('Hyperlink…') }}</h3>
      <div class="body">
        <div class="eb-field"><label>{{ t('Text') }}</label><input type="text" v-model="link.text" :placeholder="t('The words that carry the link')"></div>
        <div class="eb-field"><label>{{ t('Address') }}</label><input type="text" v-model="link.url" placeholder="example.org/page" @keydown.enter.prevent="applyLinkDialog"></div>
        <p class="eb-tip">{{ t('A bare address becomes https://, and an e-mail address becomes a mailto: link.') }}</p>
      </div>
      <div class="foot">
        <button v-if="link.editing" class="eb-btn ghost" @click="linkOpen = false; ctxDo('linkDel')">{{ t('Remove the link') }}</button>
        <button class="eb-btn ghost" @click="linkOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyLinkDialog">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <!-- what a reader hears in place of the picture -->
  <div v-if="altOpen" class="eb-modal-back" @click="altOpen = false">
    <div class="eb-modal" style="width:min(520px,100%)" @click.stop>
      <h3>{{ t('Alternative text…') }}</h3>
      <div class="body">
        <div class="eb-field"><label>{{ t('Alternative text') }}</label><input type="text" v-model="altText" @keydown.enter.prevent="applyAlt"></div>
        <p class="eb-tip">{{ t('This is what a screen reader says, and what shows if the picture cannot be loaded. It is written into the file as the alt attribute.') }}</p>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="altOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="applyAlt">{{ t('Apply') }}</button>
      </div>
    </div>
  </div>

  <div v-if="toast" class="eb-toast">{{ toast }}</div>
</div>
`;

  const app = createApp({
    template: TEMPLATE,
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
        menuOpen: false, paperOpen: false, tableOpen: false, mathOpen: false,
        settingsOpen: false, hlOpen: false, boxOpen: false, ruleOpen: false,
        // The file as text, and the panel that reads another app on this server:
        // two dialogues, two names. They shared one for a while, and opening either
        // put both on the screen.
        htmlOpen: false,
        htmlText: '',
        defaultPaper: normalisePaper(null),
        ctx: { open: false, x: 0, y: 0, flip: false, table: false, image: false, link: false, list: false, selection: false, frame: false, text: false },
        frame: { on: false, x: 0, y: 0, w: 0, h: 0, free: false, drop: -1, kind: '', bar: false, dragging: false, grips: [], gx: null, gy: null },
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
          border: '', borderWidth: '', borderColour: '#666666', radius: '', fill: '', opacity: '', shadow: false, keep: false,
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
        picker: { path: '', parent: null, entries: [], selected: null, loading: false, busy: false, error: '' },
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
        return {
          '--eb-paper-w': s.w + 'mm',
          '--eb-paper-h': s.h + 'mm',
          '--eb-mt': p.margin.top + 'mm',
          '--eb-mr': p.margin.right + 'mm',
          '--eb-mb': p.margin.bottom + 'mm',
          '--eb-ml': p.margin.left + 'mm',
          '--eb-pageh': (s.h - p.margin.top - p.margin.bottom) + 'mm',
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
      frameHandles() { return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']; },
      /** Wrapping and free placement cannot both be true: CSS has only one answer. */
      freePlacement() { return this.fprops.place === 'free' && !this.fprops.wrap; },
      /** What the frame is, in the writer's words, for the bar and the dialogue. */
      frameLabel() {
        const kind = this.frame.kind;
        const names = {
          FIGURE: this.t('Picture'), TABLE: this.t('Table'), ASIDE: this.t('Box'),
          NAV: this.t('Contents'), HR: this.t('Rule'), MATH: this.t('Formula'),
          NOTE: this.t('Note'), FRAME: this.t('Frame'), TEXT: this.t('Phrase'),
          SHAPE: this.t('Shape'),
        };
        return names[kind] || this.t('Frame');
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
      printDoc() { printHtml(this.currentHtml(!this.showChanges), pageRule(normalisePaper(this.doc.paper))); },
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
          this.run(() => pasteHtmlAt(got.html || '', got.url || ''));
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
          const url = await shrinkImage(raw, r.mime);
          this.pickerOpen = false;
          this.run(() => insertImage(url, r.name, 'eb-img-m'));
        } catch (e) {
          this.notify(this.t('Could not read the picture: {msg}', { msg: e.message }));
        } finally { this.picker.busy = false; }
      },
      imageCmd(kind, arg) {
        if (kind === 'size') { this.run(() => setImageSize(arg)); }
        if (kind === 'delete') { this.run(() => deleteImage()); }
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
          const at = range && inCanvas(range.startContainer) ? objectAt(range.startContainer) : null;
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
        this.frame.free = objectFree(el);
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
        const at = objectAt(e.target);
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
        if (d.mode === 'move' && !d.free && d.ref) { moveObjectTo(frameEl, d.ref, d.after); }
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
          paperLeft: r.left, paperRight: r.right, z };
      },
      /** Shift a parked frame sideways by so many client pixels. */
      nudgeFree(el, dx) {
        if (!dx) { return; }
        const z = this.frameZoom() || 1;
        const now = parseFloat(el.style.left) || 0;
        el.style.left = round1(now + dx * MM / z) + 'mm';
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
        if (off || !box || !wrap || !el || !el.getBoundingClientRect) { return; }
        const z = this.frameZoom() || 1;
        const near = 7 * z;
        const r = el.getBoundingClientRect();
        const mid = (box.left + box.right) / 2;
        const lines = [
          [box.left, r.left], [mid, (r.left + r.right) / 2], [box.right, r.right],
        ];
        let best = null;
        lines.forEach(([want, have]) => {
          const gap = want - have;
          if (Math.abs(gap) <= near && (!best || Math.abs(gap) < Math.abs(best[0]))) { best = [gap, want]; }
        });
        if (!best) { return; }
        this.nudgeFree(el, best[0]);
        const b = wrap.getBoundingClientRect();
        this.frame.gx = (best[1] - b.left) / z;
      },
      duplicateFrame() {
        const el = frameEl;
        if (!el || !el.parentNode) { return; }
        history.push(true);
        const host = objectFree(el) ? el.parentNode : el;
        const copy = host.cloneNode(true);
        host.parentNode.insertBefore(copy, host.nextSibling);
        const made = objectFree(el) ? copy.firstElementChild : copy;
        if (made && objectFree(made)) {
          made.style.left = round1((parseFloat(made.style.left) || 0) + 4) + 'mm';
          made.style.top = round1((parseFloat(made.style.top) || 0) + 4) + 'mm';
        }
        frameEl = made;
        framePinned = true;
        frameTaken = true;
        if (made) { this.keepOnPaper(made); }
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
      },
      alignObject(el, cls) {
        if (!el || cls === 'eb-al-j') { return false; }
        // A frame parked by hand is aligned by moving it: to the left margin, to
        // the middle of the column, or to the right margin. This is also the way
        // back for one that has been dragged off the paper altogether.
        if (objectFree(el)) { return this.alignFree(el, cls); }
        // A frame in the run of a sentence has no alignment of its own, and neither
        // has one parked by hand. Say so and let the paragraph command run: a
        // button that quietly does nothing is worse than one that moves the line
        // the frame is standing in, which is what the writer sees anyway.
        if (el.nodeName === 'SPAN' || objectFree(el)) { return false; }
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
          this.syncFrame();
        });
      },
      frameCmd(kind, arg) {
        if (!frameEl) { return; }
        // Where the frame itself sits in the column, as against what the words
        // inside it do. These two are the whole of the difference between the
        // frame's own bar and the alignment buttons above the page.
        if (kind === 'align') {
          framePinned = true;
          frameTaken = true;
          if (!this.alignObject(frameEl, arg)) { this.blockRun(() => setBlockClass('align', arg)); }
          return;
        }
        if (kind === 'fit') {
          const paper = normalisePaper(this.doc.paper);
          history.push(true);
          framePinned = true;
          frameEl.style.width = round1(sheet(paper).w - paper.margin.left - paper.margin.right) + 'mm';
          frameEl.style.maxWidth = 'none';
          if (objectFree(frameEl)) {
            const box = this.columnBox();
            if (box) { this.nudgeFree(frameEl, box.left - frameEl.getBoundingClientRect().left); }
          }
          this.settleFrame();
          return;
        }
        const el = frameEl;
        framePinned = true;
        history.push(true);
        if (kind === 'free') {
          if (objectFree(el)) {
            setObjectFree(el, false);
          } else {
            setObjectFree(el, true);
            el.style.left = '0mm';
            el.style.top = '0mm';
          }
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
          if (!objectFree(el)) {
            setObjectFree(el, true);
            el.style.left = '0mm';
            el.style.top = '0mm';
          }
          restack(el, arg);
        } else if (kind === 'delete') {
          deleteObject(el);
          this.clearFrame();
        }
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
          border: '', borderWidth: '', borderColour: '#666666', radius: '', fill: '', opacity: '', shadow: false, keep: false,
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
        history.push(true);
        setObjectProps(frameEl, v);
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
      shapeDragStart(e, kind) {
        try { e.dataTransfer.setData('text/eb-shape', kind); e.dataTransfer.effectAllowed = 'copy'; } catch (err) { /* older browsers */ }
        this.menu = '';
      },

      // ---- the context menu ----------------------------------------------------
      /**
       * LibreOffice puts its own menu on the right button, and so does this: the
       * items are the ones that apply where the pointer is. Shift+right-click is
       * left alone, which is how a reader still reaches the browser's own menu
       * (spelling suggestions live there).
       */
      openCtx(e) {
        if (e.shiftKey || !this.doc.id) { return; }
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
        // The right button acts on what it is over, so it also picks the frame up.
        const obj = objectAt(e.target) || objectAt(at);
        // The right button on an object shows that object's settings, whatever the
        // object is -- not only on the thin band of its border. Inside something
        // written in, a cell or a caption, the menu for text is what is wanted.
        if (obj && takesClick(obj, e.target, e.clientX, e.clientY)) {
          frameEl = obj;
          framePinned = true;
          frameTaken = true;
          this.frame.bar = true;
          this.syncFrame();
          this.openFrameProps();
          return;
        }
        if (obj) { frameEl = obj; framePinned = true; } else { frameEl = null; framePinned = false; }
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
          float: () => this.run(() => setImageFloat(arg)),
          alt: () => this.openAlt(),
          imageDel: () => this.imageCmd('delete'),
          frameProps: () => this.openFrameProps(),
          frameFree: () => (frameEl ? this.frameCmd('free') : this.textCmd('free')),
          frameWrap: () => (frameEl ? this.frameCmd('wrap', arg) : this.textCmd('wrap', arg)),
          frameFront: () => (frameEl ? this.frameCmd('stack', 'front') : this.textCmd('stack', 'front')),
          frameBack: () => (frameEl ? this.frameCmd('stack', 'back') : this.textCmd('stack', 'back')),
          frameDel: () => this.frameCmd('delete'),
          guides: () => { this.guides = !this.guides; },
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
      onDragStart() {
        const r = getRange();
        dragRange = r && !r.collapsed ? r.cloneRange() : null;
      },
      onDragOver(e) {
        if (!this.doc.id) { return; }
        e.preventDefault();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = dragRange ? 'move' : 'copy'; }
        // Show where it would land, the way a text cursor does.
        const point = caretFromPoint(e.clientX, e.clientY);
        if (point && !pointInsideRange(dragRange, point)) { selectRange(point); }
      },
      onDrop(e) {
        if (!this.doc.id) { return; }
        e.preventDefault();
        const point = caretFromPoint(e.clientX, e.clientY);
        const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
        if (files.some((f) => /^image\//.test(f.type))) {
          if (point) { selectRange(point); }
          dragRange = null;
          this.insertPastedFiles(files);
          return;
        }
        const data = e.dataTransfer;
        let ok = false;
        this.run(() => { ok = dropAt(point, data); });
        dragRange = null;
        if (!ok) { this.notify(this.t('There is nowhere to drop that.')); }
        this.repaginate();
      },
      onDragEnd() { dragRange = null; },

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
        this.run(() => { if (html) { pasteHtmlAt(html); } else { pasteTextAt(text); } });
        this.repaginate();
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
        if (e.key === 'Escape' && this.frame.on) { this.clearFrame(); return undefined; }
        // Arrow keys walk a parked frame about the page: a millimetre a press, five
        // with Shift, a fifth with Alt. Anywhere else they belong to the caret.
        if (frameTaken && frameEl && objectFree(frameEl) && !meta
          && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
          const step = e.shiftKey ? 5 : (e.altKey ? 0.2 : 1);
          const dx = (e.key === 'ArrowLeft' ? -step : (e.key === 'ArrowRight' ? step : 0));
          const dy = (e.key === 'ArrowUp' ? -step : (e.key === 'ArrowDown' ? step : 0));
          if (this.nudgeFrameBy(frameEl, dx, dy)) { e.preventDefault(); return undefined; }
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
        } catch (e) { /* the app still works with the defaults */ }
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
        this.keepCaretVisible();
      });
      c.addEventListener('paste', (e) => {
        const files = e.clipboardData ? Array.from(e.clipboardData.files || []) : [];
        if (files.some((f) => /^image\//.test(f.type))) {
          e.preventDefault();
          this.insertPastedFiles(files);
          return;
        }
        handlePaste(e, e.shiftKey);
        this.touch();
        this.recount();
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
      c.addEventListener('dragstart', () => this.onDragStart());
      c.addEventListener('dragover', (e) => this.onDragOver(e));
      c.addEventListener('drop', (e) => this.onDrop(e));
      c.addEventListener('dragend', () => this.onDragEnd());
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
  function dropAt(point, data) {
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
