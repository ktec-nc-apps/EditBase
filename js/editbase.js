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
  };

  function normalisePaper(p) {
    const out = JSON.parse(JSON.stringify(DEFAULT_PAPER));
    if (!p || typeof p !== 'object') { return out; }
    if (PAPERS[p.size]) { out.size = p.size; }
    if (p.orientation === 'landscape') { out.orientation = 'landscape'; }
    if (p.font === 'sans') { out.font = 'sans'; }
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
.eb-doc {
  font-family: var(--eb-font-body, "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Times New Roman", serif);
  font-size: 10.5pt; line-height: 1.75; color: #111111; text-align: justify;
  word-break: normal; overflow-wrap: anywhere; hyphens: auto;
}
.eb-doc > *:first-child { margin-top: 0; }
.eb-doc p { margin: 0 0 0.9em; }
.eb-doc h1, .eb-doc h2, .eb-doc h3, .eb-doc h4, .eb-doc h5, .eb-doc h6 {
  font-family: var(--eb-font-head, "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif);
  line-height: 1.4; margin: 1.6em 0 0.7em; break-after: avoid-page; text-align: left;
  color: #111111;
}
.eb-doc h1 { font-size: 1.9em; letter-spacing: .02em; }
.eb-doc h2 { font-size: 1.5em; border-bottom: 1.5pt solid #222; padding-bottom: .2em; }
.eb-doc h3 { font-size: 1.25em; }
.eb-doc h4 { font-size: 1.1em; }
.eb-doc h5, .eb-doc h6 { font-size: 1em; }
.eb-doc ul, .eb-doc ol { margin: 0 0 0.9em; padding-left: 1.7em; }
.eb-doc li { margin: 0.15em 0; }
.eb-doc blockquote {
  margin: 1em 0; padding: .4em 0 .4em 1em; border-left: 3pt solid #999; color: #333;
}
.eb-doc pre {
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
.eb-doc figure.eb-img img { width: 100%; height: auto; }

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
.eb-doc table.eb-table { border-collapse: collapse; width: 100%; margin: 1.1em 0; font-size: .96em; }
.eb-doc table.eb-table th, .eb-doc table.eb-table td {
  border: .75pt solid #666; padding: .38em .6em; vertical-align: top; text-align: left;
}
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
.eb-doc .eb-al-j { text-align: justify; }
.eb-doc .eb-in1 { margin-left: 2em; }
.eb-doc .eb-in2 { margin-left: 4em; }
.eb-doc .eb-in3 { margin-left: 6em; }

/* mathematics — native MathML, no images and no renderer to install */
.eb-doc math { font-size: 1.06em; }
.eb-doc .eb-math-block { display: block; text-align: center; margin: 1em 0; break-inside: avoid; }

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

  // ---- sanitising -----------------------------------------------------------
  // A document is a file the user (or someone they shared with) may have edited by
  // hand, and it gets put into the page with innerHTML. Anything that could run is
  // removed on the way in; the structural markup is left exactly as written.
  const HTML_TAGS = new Set(['P', 'BR', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'INS', 'MARK', 'CODE', 'PRE', 'SUB', 'SUP', 'SMALL', 'A',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'COLGROUP', 'COL',
    'IMG', 'FIGURE', 'FIGCAPTION', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'DL', 'DT', 'DD', 'RUBY', 'RT', 'RP', 'WBR', 'ABBR', 'TIME', 'BDI', 'BDO']);
  const MATHML_TAGS = new Set(['math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
    'munderover', 'mmultiscripts', 'mprescripts', 'mstyle', 'mpadded', 'mphantom', 'merror', 'menclose', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'maction', 'semantics', 'annotation', 'annotation-xml']);
  const ATTR_OK = new Set(['class', 'style', 'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'span', 'start', 'type', 'lang', 'dir', 'id', 'datetime', 'data-label', 'display', 'mathvariant', 'stretchy', 'fence', 'separator', 'accent', 'notation', 'columnalign', 'rowalign', 'scope']);
  const STYLE_OK = /^(color|background-color|font-weight|font-style|font-size|font-family|text-decoration|text-decoration-line|text-align|text-emphasis|line-height|margin-left|margin-right|padding-left|width|height|max-width|border|border-radius|border-color|border-width|border-style|vertical-align|letter-spacing|writing-mode)$/;

  function cleanStyle(value) {
    const kept = [];
    String(value).split(';').forEach((decl) => {
      const i = decl.indexOf(':');
      if (i < 0) { return; }
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val = decl.slice(i + 1).trim();
      if (!STYLE_OK.test(prop)) { return; }
      if (/url\s*\(|expression|javascript:/i.test(val)) { return; }
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
  function buildHtml(doc) {
    const paper = normalisePaper(doc.paper);
    const lang = doc.lang || (document.documentElement.lang || 'ja');
    const body = stripEditorArtefacts(doc.body || '');
    const fonts = resolveFonts(paper, lang);
    const url = fontsUrl([fonts.body, fonts.head, fonts.mono]);
    const s = sheet(paper);
    const page = 'html { background: #ffffff; }\n'
      + 'body.eb-doc { margin: 0; font-size: ' + paper.fontSize + 'pt; line-height: ' + paper.lineHeight + '; }\n'
      + '.eb-doc { --eb-font-body: ' + fontStack(fonts.body, 'serif') + ';'
      + ' --eb-font-head: ' + fontStack(fonts.head, 'sans') + ';'
      + ' --eb-font-mono: ' + fontStack(fonts.mono, 'mono') + '; }\n'
      + '@media screen { body.eb-doc { max-width: ' + (s.w - paper.margin.left - paper.margin.right) + 'mm;'
      + ' margin: ' + paper.margin.top + 'mm auto ' + paper.margin.bottom + 'mm; padding: 0 8px; } }';
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
      + '<title>' + escapeAttr(doc.title || 'Document') + '</title>\n'
      + fontLinks
      + '<style>\n' + pageRule(paper) + '\n' + page + '\n' + DOC_CSS + '</style>\n'
      + '</head>\n<body class="eb-doc">\n'
      + body + '\n</body>\n</html>\n';
  }

  /** Read a file back. Anything not written by EditBase still opens; it just
   *  arrives without paper settings, and saving it will re-write its stylesheet. */
  function parseHtml(text) {
    const dom = new DOMParser().parseFromString(String(text || ''), 'text/html');
    const meta = dom.querySelector('meta[name="editbase-paper"]');
    const gen = dom.querySelector('meta[name="generator"]');
    let paper = null;
    if (meta) { try { paper = JSON.parse(meta.getAttribute('content') || '{}'); } catch (e) { paper = null; } }
    const body = dom.body || dom.createElement('body');
    sanitiseInto(body);
    return {
      title: (dom.title || '').trim(),
      lang: dom.documentElement.getAttribute('lang') || 'ja',
      paper: normalisePaper(paper),
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
  function selectedBlocks() {
    const range = getRange();
    if (!range) { return []; }
    const first = blockAt(range.startContainer, range.startOffset);
    const last = blockAt(range.endContainer, range.endOffset);
    if (!first) { return []; }
    const out = [];
    let n = first;
    while (n) {
      out.push(n);
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
  function setBlockClass(group, cls) {
    const groups = {
      align: ['eb-al-l', 'eb-al-c', 'eb-al-r', 'eb-al-j'],
      indent: ['eb-in1', 'eb-in2', 'eb-in3'],
    };
    const all = groups[group] || [];
    selectedBlocks().forEach((b) => {
      if (!b.classList) { return; }
      all.forEach((c) => b.classList.remove(c));
      if (cls) { b.classList.add(cls); }
    });
  }
  function stepIndent(dir) {
    const order = ['', 'eb-in1', 'eb-in2', 'eb-in3'];
    selectedBlocks().forEach((b) => {
      if (!b.classList) { return; }
      let level = 0;
      order.forEach((c, i) => { if (c && b.classList.contains(c)) { level = i; } });
      const next = Math.min(3, Math.max(0, level + dir));
      order.forEach((c) => { if (c) { b.classList.remove(c); } });
      if (order[next]) { b.classList.add(order[next]); }
    });
  }

  // ---- insertions ---------------------------------------------------------------
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
    ['eb-img-s', 'eb-img-m', 'eb-img-l'].forEach((c) => fig.classList.remove(c));
    fig.classList.add(cls);
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
    placeCaretIn(cell.parentNode.children[dir < 0 ? idx : idx + 1]);
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
  }
  function setTableVariant(variant) {
    const cell = cellAt();
    const table = cell ? tableOf(cell) : null;
    if (!table) { return; }
    table.className = 'eb-table' + (variant ? ' ' + variant : '');
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

  // ---- housekeeping -------------------------------------------------------------
  /** Keep the canvas a flat run of blocks: loose text is what makes contenteditable
   *  produce <div> soup, so it gets a paragraph of its own before that can happen. */
  function normaliseCanvas(pageBreakLabel, captionLabel) {
    const c = canvas();
    if (!c) { return; }
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
    push(force) {
      const c = canvas();
      if (!c) { return; }
      const now = Date.now();
      const html = c.innerHTML;
      const top = this.past[this.past.length - 1];
      if (top && top.html === html) { return; }
      // typing is coalesced into bursts; a command always starts a new entry
      if (!force && top && now - this.lastPush < 700) { return; }
      this.past.push({ html, caret: caretOffset() });
      if (this.past.length > this.limit) { this.past.shift(); }
      this.future.length = 0;
      this.lastPush = now;
    },
    undo() {
      const c = canvas();
      if (!c || !this.past.length) { return false; }
      const current = { html: c.innerHTML, caret: caretOffset() };
      let entry = this.past.pop();
      if (entry.html === current.html && this.past.length) { entry = this.past.pop(); }
      this.future.push(current);
      c.innerHTML = entry.html;
      setCaretOffset(entry.caret);
      this.lastPush = 0;
      return true;
    },
    redo() {
      const c = canvas();
      if (!c || !this.future.length) { return false; }
      const entry = this.future.pop();
      this.past.push({ html: c.innerHTML, caret: caretOffset() });
      c.innerHTML = entry.html;
      setCaretOffset(entry.caret);
      this.lastPush = 0;
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
      ['eb-al-l', 'eb-al-c', 'eb-al-r', 'eb-al-j'].forEach((c) => {
        if (block.classList && block.classList.contains(c)) { state.align = c; }
      });
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

  // ---- paste ---------------------------------------------------------------------
  function handlePaste(e, plainOnly) {
    const data = e.clipboardData;
    if (!data) { return; }
    e.preventDefault();
    const html = plainOnly ? '' : data.getData('text/html');
    history.push(true);
    if (html) {
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
        if (el.hasAttribute('class') && !/^eb-/.test(el.getAttribute('class'))) { el.removeAttribute('class'); }
      });
      const range = getRange();
      if (range) {
        range.deleteContents();
        const frag = document.createDocumentFragment();
        while (holder.firstChild) { frag.appendChild(holder.firstChild); }
        const last = frag.lastChild;
        range.insertNode(frag);
        if (last) {
          const after = document.createRange();
          after.setStartAfter(last);
          after.collapse(true);
          selectRange(after);
        }
      }
    } else {
      const text = data.getData('text/plain') || '';
      const range = getRange();
      if (range) {
        range.deleteContents();
        const lines = text.split(/\r?\n/);
        const frag = document.createDocumentFragment();
        lines.forEach((line, i) => {
          if (i) { frag.appendChild(document.createElement('br')); }
          frag.appendChild(document.createTextNode(line));
        });
        const last = frag.lastChild;
        range.insertNode(frag);
        if (last) {
          const after = document.createRange();
          after.setStartAfter(last);
          after.collapse(true);
          selectRange(after);
        }
      }
    }
    normaliseCanvas();
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
  function printHtml(html) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;';
    document.body.appendChild(frame);
    const done = () => { setTimeout(() => frame.remove(), 1000); };
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
  const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 100" width="1em" height="1em" aria-hidden="true">'
    + '<path fill="currentColor" fill-rule="evenodd" d="M8,0 h56 a8,8 0 0 1 8,8 v84 a8,8 0 0 1 -8,8 h-56 a8,8 0 0 1 -8,-8 v-84 a8,8 0 0 1 8,-8 z M11,7 a4,4 0 0 0 -4,4 v78 a4,4 0 0 0 4,4 h50 a4,4 0 0 0 4,-4 v-78 a4,4 0 0 0 -4,-4 z"/>'
    + '<path fill="currentColor" d="M18,24 h36 a3.5,3.5 0 0 1 0,7 h-36 a3.5,3.5 0 0 1 0,-7 z M18,42 h36 a3.5,3.5 0 0 1 0,7 h-36 a3.5,3.5 0 0 1 0,-7 z M18,60 h22 a3.5,3.5 0 0 1 0,7 h-22 a3.5,3.5 0 0 1 0,-7 z"/></svg>';

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
    guides: I('<rect x="2.5" y="1.8" width="11" height="12.4" rx="1"/><path d="M2.5 8h11" stroke-dasharray="2 1.6"/>'),
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

  const TEMPLATE = `
<div class="eb-shell">
  <aside class="eb-side" :class="{ hidden: !sideOpen }">
    <div class="brand">
      <span class="logo" v-html="logo"></span>
      <span class="name">EditBase</span>
      <span class="ver">{{ version }}</span>
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
      <button class="eb-tb" @click="sideOpen = !sideOpen" :title="t('Documents')">☰</button>
      <input class="title-input" v-model="doc.title" :placeholder="t('Untitled document')" @change="applyTitle" :disabled="!doc.id">
      <span class="state" :class="{ dirty: dirty }">{{ stateText }}</span>
      <button class="eb-btn" @click="save" :disabled="!doc.id || saving">💾 {{ t('Save') }}</button>
      <button class="eb-btn" @click="printDoc" :disabled="!doc.id">🖨 {{ t('Print / PDF') }}</button>
      <button class="eb-btn ghost" @click="menuOpen = !menuOpen" :title="t('More')">⋯</button>
      <div v-if="menuOpen" class="eb-modal-back" @click="menuOpen = false">
        <div class="eb-modal" style="width:min(360px,100%)" @click.stop>
          <h3>{{ doc.title || t('Untitled document') }}</h3>
          <div class="body" style="display:flex;flex-direction:column;gap:6px;padding-bottom:16px">
            <button class="eb-btn wide" @click="download">⬇ {{ t('Download a copy') }}</button>
            <button class="eb-btn wide" @click="duplicate">⧉ {{ t('Duplicate') }}</button>
            <button class="eb-btn wide" @click="paperOpen = true; menuOpen = false">🖹 {{ t('Paper setup') }}</button>
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
      <button class="eb-tb text font-btn" @mousedown.prevent @click="openFonts('body')" :title="t('Body typeface')">
        <span class="fname" :style="{ fontFamily: fontPreviewStack(fontsInUse.body) }">{{ fontsInUse.body }}</span>
        <span class="caret" v-html="icons.down"></span>
      </button>
      <span class="eb-num" :title="t('Body size (pt)')">
        <button class="eb-tb" @mousedown.prevent @click="stepSize(-0.5)" v-html="icons.minus"></button>
        <input type="number" min="6" max="36" step="0.5" v-model.number="doc.paper.fontSize">
        <button class="eb-tb" @mousedown.prevent @click="stepSize(0.5)" v-html="icons.plus"></button>
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
          <button v-for="b in boxes" :key="b.variant" class="eb-menu-item" @click="addBox(b.variant); menu = ''"><span v-html="icons.box"></span>{{ b.label }}</button>
          <div class="eb-menu-sep"></div>
          <button v-for="r in rules" :key="r.cls" class="eb-menu-item" @click="addRule(r.cls); menu = ''"><span v-html="icons.rule"></span>{{ r.label }}</button>
          <div class="eb-menu-sep"></div>
          <button class="eb-menu-item" @click="addPageBreak(); menu = ''"><span v-html="icons.pagebreak"></span>{{ t('Page break') }}</button>
          <button class="eb-menu-item" @click="openMath(); menu = ''"><span v-html="icons.formula"></span>{{ t('Insert formula (MathML)') }}</button>
          <div class="eb-menu-sep" v-if="anySource"></div>
          <button v-for="key in sourceKeys" :key="key" class="eb-menu-item" @click="openSource(key)">
            <span v-html="icons.link"></span>{{ sourceLabel(key) }}
          </button>
        </div>
      </span>
      <button class="eb-tb" @mousedown.prevent @click="clearFmt" :title="t('Clear formatting')"><span v-html="icons.clear"></span></button>
      <span class="sep"></span>
      <button class="eb-tb" @mousedown.prevent @click="undo" :title="t('Undo') + ' (Ctrl+Z)'"><span v-html="icons.undo"></span></button>
      <button class="eb-tb" @mousedown.prevent @click="redo" :title="t('Redo') + ' (Ctrl+Shift+Z)'"><span v-html="icons.redo"></span></button>
      <span class="sep"></span>
      <button class="eb-tb" :class="{ on: guides }" @mousedown.prevent @click="guides = !guides" :title="t('Show page guides')"><span v-html="icons.guides"></span></button>
      <span class="eb-num" :title="t('Zoom')">
        <button class="eb-tb" @mousedown.prevent @click="stepZoom(-10)" v-html="icons.minus"></button>
        <button class="eb-tb text zoomv" @mousedown.prevent @click="zoom = 100">{{ zoom }}%</button>
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

    <div class="eb-toolbar sub" v-if="doc.id && fmt.image">
      <span class="grp">{{ t('Picture') }}</span>
      <button class="eb-tb text" :class="{ on: fmt.imageSize === 'eb-img-s' }" @mousedown.prevent @click="imageCmd('size', 'eb-img-s')">{{ t('Small') }}</button>
      <button class="eb-tb text" :class="{ on: fmt.imageSize === 'eb-img-m' }" @mousedown.prevent @click="imageCmd('size', 'eb-img-m')">{{ t('Medium') }}</button>
      <button class="eb-tb text" :class="{ on: fmt.imageSize === 'eb-img-l' }" @mousedown.prevent @click="imageCmd('size', 'eb-img-l')">{{ t('Full width') }}</button>
      <span class="sep"></span>
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
      <button class="eb-tb danger" @mousedown.prevent @click="tableCmd('delete')" :title="t('Delete table')"><span v-html="icons.tableDel"></span></button>
      <span class="hint">{{ t('Tab moves to the next cell; a new row is added at the end.') }}</span>
    </div>

    <div class="eb-desk" :class="{ empty: !doc.id }">
      <div class="eb-paperwrap" v-show="doc.id" :style="{ zoom: zoom / 100 }">
        <div id="eb-canvas" class="eb-paper eb-doc" :class="{ noguides: !guides }"
          :style="paperStyle" contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true"></div>
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
            <select v-model="doc.paper.size" @change="touch"><option v-for="p in paperSizes" :key="p" :value="p">{{ p }}</option></select>
          </div>
          <div class="eb-field">
            <label>{{ t('Orientation') }}</label>
            <select v-model="doc.paper.orientation" @change="touch">
              <option value="portrait">{{ t('Portrait') }}</option>
              <option value="landscape">{{ t('Landscape') }}</option>
            </select>
          </div>
        </div>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Top margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="doc.paper.margin.top" @change="touch"></div>
          <div class="eb-field"><label>{{ t('Bottom margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="doc.paper.margin.bottom" @change="touch"></div>
          <div class="eb-field"><label>{{ t('Left margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="doc.paper.margin.left" @change="touch"></div>
          <div class="eb-field"><label>{{ t('Right margin (mm)') }}</label><input type="number" min="0" max="100" step="1" v-model.number="doc.paper.margin.right" @change="touch"></div>
        </div>
        <div class="eb-row">
          <div class="eb-field"><label>{{ t('Body size (pt)') }}</label><input type="number" min="6" max="36" step="0.5" v-model.number="doc.paper.fontSize" @change="touch"></div>
          <div class="eb-field"><label>{{ t('Line height') }}</label><input type="number" min="1" max="3" step="0.05" v-model.number="doc.paper.lineHeight" @change="touch"></div>
        </div>
        <div class="eb-field">
          <label>{{ t('Typefaces') }}</label>
          <div class="font-rows">
            <button v-for="r in fontRoles" :key="r.key" class="font-row" @click="openFonts(r.key)">
              <span class="role">{{ r.label }}</span>
              <span class="fam" :style="{ fontFamily: fontPreviewStack(fontsInUse[r.key]) }">{{ fontsInUse[r.key] }}</span>
              <span class="tag" v-if="!doc.paper.fonts[r.key]">{{ t('default') }}</span>
              <span class="caret" v-html="icons.down"></span>
            </button>
          </div>
          <p class="eb-note">{{ t('Any family on Google Fonts can be used. The document carries its typefaces with it, so the file looks the same on a machine where they are not installed.') }}</p>
        </div>
        <p class="eb-note">{{ t('Page numbers and running headers come from your browser print dialogue: browsers do not yet support headers inside the page rule. Everything else here is written into the file.') }}</p>
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
        <p class="eb-note">{{ t('MathML is drawn by the browser itself, so the formula stays text in the file — searchable, selectable and never a picture.') }}</p>
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
        <p class="eb-note" v-if="src.error" style="color:var(--danger)">{{ src.error }}</p>

        <!-- Tables -->
        <template v-if="source === 'tables'">
          <div class="font-list" v-if="!src.detail">
            <button v-for="x in src.items" :key="x.id" class="fp-item" @click="openCollection(x)">
              <span class="ic">{{ x.emoji || '▦' }}</span><span class="nm">{{ x.title }}</span>
            </button>
            <p class="hint" v-if="!src.items.length && !src.loading">{{ t('There is nothing here yet.') }}</p>
          </div>
          <template v-if="src.detail">
            <p class="eb-note">{{ t('{name}: {c} columns, {r} rows', { name: src.detail.title, c: src.detail.columns.length, r: src.detail.rows.length }) }}</p>
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
          <p class="eb-note">{{ t('Choosing a contact writes the address block at the cursor. For one letter per contact, use the merge fields below.') }}</p>
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
            <p class="eb-note">{{ t('{name}: {c} fields, {r} records', { name: src.collection.name, c: src.fields.length, r: src.records.length }) }}</p>
            <div class="chips">
              <button v-for="f in src.fields" :key="f.key" class="chip" @click="insertField(f.key)">{{ fieldTag(f.key) }} {{ f.label }}</button>
            </div>
            <div class="font-list">
              <button v-for="r in src.records" :key="r.id" class="fp-item" @click="insertRecord(r)">
                <span class="nm">{{ r.data[src.fields[0] && src.fields[0].key] || '—' }}</span>
                <span class="meta">{{ t('Insert as a table') }}</span>
              </button>
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
        <p class="eb-note" v-if="!merge.keys.length">{{ mergeHint }}</p>
        <template v-else>
          <p class="eb-note">{{ t('{n} records will be filled into {k} fields:', { n: merge.count, k: merge.keys.length }) }}</p>
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
        <p class="eb-note">{{ t('The picture is embedded in the document itself, so it travels with the file. Large photographs are scaled down on the way in.') }}</p>
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
          <button class="font-item" :class="{ on: !doc.paper.fonts[fontRole] }" @click="chooseFont('')">
            <span class="nm">{{ t('Default for this language') }}</span>
            <span class="meta">{{ defaultFontName }}</span>
          </button>
          <button v-for="f in fontPageItems" :key="f.f" class="font-item" :class="{ on: doc.paper.fonts[fontRole] === f.f }" @click="chooseFont(f.f)">
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
          <p class="eb-note">{{ t('A folder in your own Files. Documents already saved elsewhere stay where they are.') }}</p>
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
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" v-model="autosave"> {{ t('Save automatically while typing') }}</label>
      </div>
      <div class="foot">
        <button class="eb-btn ghost" @click="settingsOpen = false">{{ t('Cancel') }}</button>
        <button class="eb-btn primary" @click="saveSettings">{{ t('Save') }}</button>
      </div>
    </div>
  </div>

  <!-- the file itself -->
  <div v-if="sourceOpen" class="eb-modal-back" @click="sourceOpen = false">
    <div class="eb-modal" style="width:min(860px,100%)" @click.stop>
      <h3>&lt;/&gt; {{ t('View the HTML') }}</h3>
      <div class="body">
        <p class="eb-note">{{ t('This is exactly what is stored in Files — one file, styles included, nothing else needed to open it.') }}</p>
        <textarea rows="18" spellcheck="false" readonly :value="source" style="width:100%;font-family:monospace;font-size:12px"></textarea>
      </div>
      <div class="foot"><button class="eb-btn primary" @click="sourceOpen = false">{{ t('Close') }}</button></div>
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
        doc: { id: 0, name: '', title: '', paper: normalisePaper(null), lang: 'ja', foreign: false },
        dirty: false,
        saving: false,
        savedAt: 0,
        settings: { folder: 'EditBase', theme: 'auto', language: 'auto', languages: [] },
        autosave: true,
        guides: true,
        colour: '#111111',
        counts: 0,
        fmt: { block: 'P', align: '', list: '' },
        toast: '',
        source: '',
        menuOpen: false, paperOpen: false, tableOpen: false, mathOpen: false,
        settingsOpen: false, sourceOpen: false, hlOpen: false, boxOpen: false, ruleOpen: false,
        defaultPaper: normalisePaper(null),
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
          fontSize: p.fontSize + 'pt',
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
      previewFamily() { return this.doc.paper.fonts[this.fontRole] || this.defaultFontName; },
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
        if (this.dirty && this.doc.id && this.doc.id !== id) { await this.save(); }
        try {
          const d = await api('documents/' + id);
          const parsed = parseHtml(d.content);
          this.doc = {
            id: d.id, name: d.name, title: parsed.title || d.title,
            paper: parsed.paper, lang: parsed.lang, foreign: parsed.foreign, writable: d.writable,
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
          this.applyDocFonts();
          history.reset();
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
        return stripEditorArtefacts(clone.innerHTML);
      },
      currentHtml() {
        return buildHtml({
          title: this.doc.title || this.t('Untitled document'),
          paper: this.doc.paper,
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
      printDoc() { printHtml(this.currentHtml()); },
      showSource() {
        this.menuOpen = false;
        this.source = this.currentHtml();
        this.sourceOpen = true;
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
      /** How many sheets this would print on, near enough to be worth showing. */
      repaginate() {
        const c = canvas();
        if (!c) { return; }
        const p = normalisePaper(this.doc.paper);
        const mm = 96 / 25.4;
        const pageH = (sheet(p).h - p.margin.top - p.margin.bottom) * mm;
        const flow = c.scrollHeight - (p.margin.top + p.margin.bottom) * mm;
        const breaks = c.querySelectorAll('.eb-pagebreak').length;
        this.pageCount = Math.max(1, Math.ceil(Math.max(flow, 1) / pageH) + breaks);
      },
      refreshState() {
        if (!canvas()) { return; }
        const s = activeFormats();
        this.fmt = s;
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
      setBlock(tag) { this.run(() => setBlockType(tag)); },
      list(tag) { this.run(() => toggleList(tag)); },
      align(cls) { this.run(() => setBlockClass('align', cls)); },
      indent(dir) { this.run(() => stepIndent(dir)); },
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
        this.doc.paper.fonts[this.fontRole] = family;
        this.applyDocFonts();
        this.touch();
      },
      /** Load the families this document uses, for the editor's own canvas. */
      applyDocFonts() {
        const f = resolveFonts(normalisePaper(this.doc.paper), this.doc.lang);
        linkStylesheet('eb-doc-fonts', fontsUrl([f.body, f.head, f.mono]));
      },
      /** Load just enough of each listed family to draw its own name. */
      loadPreviewFonts() {
        const names = this.fontPageItems.map((f) => f.f).slice(0, 24);
        if (!names.length) { linkStylesheet('eb-font-preview', ''); return; }
        const text = names.join('') + this.sampleText;
        linkStylesheet('eb-font-preview', fontsUrl(names, text.slice(0, 1200)));
      },

      toggleMenu(key) { this.menu = this.menu === key ? '' : key; },
      stepSize(d) {
        const next = Math.min(36, Math.max(6, Math.round((Number(this.doc.paper.fontSize) + d) * 2) / 2));
        this.doc.paper.fontSize = next;
      },
      stepZoom(d) { this.zoom = Math.min(200, Math.max(50, this.zoom + d)); },
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
      insertRecord(record) {
        this.sourceOpen = false;
        const rows = this.src.fields.map((f) => [f.label, record.data[f.key] || '']);
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
          rowAbove: () => addRow(-1), rowBelow: () => addRow(1),
          colLeft: () => addColumn(-1), colRight: () => addColumn(1),
          rowDel: () => deleteRow(), colDel: () => deleteColumn(),
          header: () => toggleHeaderRow(), variant: () => setTableVariant(arg),
          delete: () => deleteTable(),
        };
        if (ops[kind]) { this.run(ops[kind]); }
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

      onKey(e) {
        const meta = e.ctrlKey || e.metaKey;
        if (meta && !e.altKey) {
          const k = e.key.toLowerCase();
          if (k === 'b') { e.preventDefault(); return this.inline('bold'); }
          if (k === 'i') { e.preventDefault(); return this.inline('italic'); }
          if (k === 'u') { e.preventDefault(); return this.inline('underline'); }
          if (k === 's') { e.preventDefault(); return this.save(); }
          if (k === 'p') { e.preventDefault(); return this.printDoc(); }
          if (k === 'f') { e.preventDefault(); return this.openFind(); }
          if (k === 'h') { e.preventDefault(); return this.openFind(); }
          if (k === 'z' && !e.shiftKey) { e.preventDefault(); return this.undo(); }
          if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); return this.redo(); }
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
      fontPageItems() { this.loadPreviewFonts(); },
      zoom(v) { window.localStorage.setItem('eb-zoom', String(v)); },
      'doc.paper': { deep: true, handler() { if (this.doc.id) { this.dirty = true; this.scheduleAutosave(); } } },
      autosave(v) { window.localStorage.setItem('eb-autosave', v ? '1' : '0'); },
      guides(v) { window.localStorage.setItem('eb-guides', v ? '1' : '0'); },
    },
    mounted() {
      canvasEl = document.getElementById('eb-canvas');
      const style = document.createElement('style');
      style.id = 'eb-doc-style';
      style.textContent = DOC_CSS + EDITOR_CSS;
      document.head.appendChild(style);

      const stored = window.localStorage.getItem('eb-autosave');
      if (stored != null) { this.autosave = stored === '1'; }
      const g = window.localStorage.getItem('eb-guides');
      if (g != null) { this.guides = g === '1'; }
      const z = Number(window.localStorage.getItem('eb-zoom') || 0);
      if (z >= 50 && z <= 200) { this.zoom = z; }
      document.addEventListener('click', (e) => {
        if (this.menu && !e.target.closest('.eb-pop')) { this.menu = ''; }
      });

      const c = canvasEl;
      c.addEventListener('beforeinput', () => history.push(false));
      c.addEventListener('input', () => { this.touch(); this.recount(); });
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
      document.addEventListener('selectionchange', () => { if (getRange()) { this.refreshState(); } });
      window.addEventListener('beforeunload', (e) => {
        if (this.dirty) { e.preventDefault(); e.returnValue = ''; }
      });
      this.boot();
    },
    beforeUnmount() { clearTimeout(this._saveTimer); clearTimeout(this._toastTimer); },
  });

  /** Nextcloud's dark mode is a theme app, not a media query, so ask the page. */
  function ncIsDark() {
    try {
      const probe = getComputedStyle(document.documentElement).getPropertyValue('--color-main-background').trim();
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

  if (document.getElementById('editbase-root')) {
    app.mount('#editbase-root');
  }
})();
