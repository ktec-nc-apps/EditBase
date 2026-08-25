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
    'IMG', 'FIGURE', 'FIGCAPTION', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'DL', 'DT', 'DD', 'RUBY', 'RT', 'RP', 'WBR', 'ABBR', 'TIME', 'BDI', 'BDO']);
  const MATHML_TAGS = new Set(['math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
    'munderover', 'mmultiscripts', 'mprescripts', 'mstyle', 'mpadded', 'mphantom', 'merror', 'menclose', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'maction', 'semantics', 'annotation', 'annotation-xml']);
  const ATTR_OK = new Set(['class', 'style', 'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'span', 'start', 'type', 'lang', 'dir', 'id', 'datetime', 'data-label', 'display', 'mathvariant', 'stretchy', 'fence', 'separator', 'accent', 'notation', 'columnalign', 'rowalign', 'scope']);
  const STYLE_OK = /^(color|background-color|font-weight|font-style|font-size|font-family|text-decoration|text-decoration-line|text-align|text-emphasis|line-height|margin-left|margin-right|margin-top|margin-bottom|text-indent|padding-left|padding-right|padding-top|padding-bottom|width|height|max-width|border|border-radius|border-color|border-width|border-style|border-collapse|vertical-align|letter-spacing|writing-mode|float|clear|break-before|break-after|break-inside|page-break-before|page-break-after|page-break-inside|column-count|column-gap|column-rule|orphans|widows|text-transform|font-variant|white-space|list-style-type|table-layout)$/;

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
  // The selection a dialog interrupted, so that applying it lands where it was.
  let ctxRange = null;
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
  function selectedBlocks() {
    const range = getRange();
    if (!range) { return []; }
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
    const block = selectedBlocks()[0];
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
      pageBefore: s.getPropertyValue('break-before') === 'page',
      keepWithNext: s.getPropertyValue('break-after') === 'avoid',
      keepTogether: s.getPropertyValue('break-inside') === 'avoid',
    };
  }

  /**
   * Every property is written as an inline style, because that is what the saved
   * file carries: no class the reader would have to be given a stylesheet for.
   */
  function setParagraphProps(v) {
    const blocks = selectedBlocks();
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
  const IMG_FLOATS = ['eb-img-left', 'eb-img-right'];
  /** Text wrapping is a float in HTML, which is exactly what prints too. */
  function setImageFloat(kind) {
    const fig = imageAt();
    if (!fig) { return; }
    IMG_FLOATS.forEach((c) => fig.classList.remove(c));
    if (kind === 'left' || kind === 'right') { fig.classList.add('eb-img-' + kind); }
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
    cells.forEach((cell) => {
      if (align) { cell.style.textAlign = align; } else { cell.style.removeProperty('text-align'); }
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

  function makeSpacer(height) {
    const el = document.createElement('div');
    el.className = 'eb-pagespacer';
    el.setAttribute('contenteditable', 'false');
    el.setAttribute('aria-hidden', 'true');
    el.style.height = height + 'px';
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
    const pageH = sheet ? sheet.offsetHeight : 0;
    if (!pageH || !c.offsetHeight) { return 1; }
    const style = window.getComputedStyle(c);
    const mt = parseFloat(style.paddingTop) || 0;
    const mb = parseFloat(style.paddingBottom) || 0;
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
        const top = child.offsetTop - mt;
        const height = child.offsetHeight;
        while (top >= pageTop + usable) { pageTop += usable + extra; }
        const boundary = pageTop + usable;
        const forced = pendingBreak;
        pendingBreak = false;
        if (forced || (height <= usable && top < boundary && top + height > boundary + 0.5)) {
          const wanted = boundary + extra;
          const spacer = makeSpacer(Math.max(0, boundary - top) + extra);
          c.insertBefore(spacer, child);
          // Putting an element between two blocks stops their margins collapsing, so
          // the block lands a little lower than the arithmetic says. Measure where it
          // actually went and take the difference back out of the spacer.
          const landed = child.offsetTop - mt;
          const drift = landed - wanted;
          if (Math.abs(drift) > 0.5) {
            spacer.style.height = Math.max(0, parseFloat(spacer.style.height) - drift) + 'px';
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
    return Math.max(1, Math.ceil((c.offsetHeight + PAGE_GAP - 1) / (pageH + PAGE_GAP)));
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
    'eb-box', 'eb-box-title', 'sq', 'dashed', 'tint', 'note', 'borderless', 'rows',
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
    if (html) { pasteHtmlAt(html); } else { pasteTextAt(data.getData('text/plain') || ''); }
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

  function pasteHtmlAt(html) {
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
    stripFurniture(holder, true);
    const frag = document.createDocumentFragment();
    while (holder.firstChild) { frag.appendChild(holder.firstChild); }
    insertFragmentAt(frag);
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
const { openBlock: _openBlock, createElementBlock: _createElementBlock, createCommentVNode: _createCommentVNode, createElementVNode: _createElementVNode, toDisplayString: _toDisplayString, renderList: _renderList, Fragment: _Fragment, normalizeClass: _normalizeClass, vModelText: _vModelText, withDirectives: _withDirectives, createTextVNode: _createTextVNode, withModifiers: _withModifiers, normalizeStyle: _normalizeStyle, withKeys: _withKeys, vModelCheckbox: _vModelCheckbox, vShow: _vShow, vModelSelect: _vModelSelect, vModelRadio: _vModelRadio } = Vue

const _hoisted_1 = { class: "eb-shell" }
const _hoisted_2 = { class: "brand" }
const _hoisted_3 = ["innerHTML"]
const _hoisted_4 = /*#__PURE__*/_createElementVNode("span", { class: "name" }, "EditBase", -1 /* HOISTED */)
const _hoisted_5 = {
  key: 0,
  class: "ver"
}
const _hoisted_6 = ["title"]
const _hoisted_7 = ["innerHTML"]
const _hoisted_8 = { class: "side-actions" }
const _hoisted_9 = { class: "eb-doclist" }
const _hoisted_10 = {
  key: 0,
  class: "hint"
}
const _hoisted_11 = ["onClick"]
const _hoisted_12 = { class: "t" }
const _hoisted_13 = { class: "m" }
const _hoisted_14 = { class: "side-foot" }
const _hoisted_15 = { class: "eb-main" }
const _hoisted_16 = { class: "eb-topbar" }
const _hoisted_17 = ["title"]
const _hoisted_18 = ["innerHTML"]
const _hoisted_19 = ["placeholder", "disabled"]
const _hoisted_20 = ["disabled"]
const _hoisted_21 = { class: "lbl" }
const _hoisted_22 = ["disabled"]
const _hoisted_23 = { class: "lbl" }
const _hoisted_24 = ["title"]
const _hoisted_25 = {
  class: "body",
  style: {"display":"flex","flex-direction":"column","gap":"6px","padding-bottom":"16px"}
}
const _hoisted_26 = {
  key: 0,
  class: "eb-toolbar"
}
const _hoisted_27 = ["value", "title"]
const _hoisted_28 = { value: "P" }
const _hoisted_29 = { value: "H1" }
const _hoisted_30 = { value: "H2" }
const _hoisted_31 = { value: "H3" }
const _hoisted_32 = { value: "H4" }
const _hoisted_33 = { value: "BLOCKQUOTE" }
const _hoisted_34 = { value: "PRE" }
const _hoisted_35 = ["title"]
const _hoisted_36 = ["innerHTML"]
const _hoisted_37 = ["title"]
const _hoisted_38 = ["innerHTML"]
const _hoisted_39 = ["innerHTML"]
const _hoisted_40 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_41 = ["title"]
const _hoisted_42 = /*#__PURE__*/_createElementVNode("span", { class: "b" }, "B", -1 /* HOISTED */)
const _hoisted_43 = [
  _hoisted_42
]
const _hoisted_44 = ["title"]
const _hoisted_45 = /*#__PURE__*/_createElementVNode("span", { class: "i" }, "I", -1 /* HOISTED */)
const _hoisted_46 = [
  _hoisted_45
]
const _hoisted_47 = ["title"]
const _hoisted_48 = /*#__PURE__*/_createElementVNode("span", { class: "u" }, "U", -1 /* HOISTED */)
const _hoisted_49 = [
  _hoisted_48
]
const _hoisted_50 = ["title"]
const _hoisted_51 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "S", -1 /* HOISTED */)
const _hoisted_52 = [
  _hoisted_51
]
const _hoisted_53 = ["title"]
const _hoisted_54 = /*#__PURE__*/_createElementVNode("span", { class: "kt" }, "A", -1 /* HOISTED */)
const _hoisted_55 = [
  _hoisted_54
]
const _hoisted_56 = ["title"]
const _hoisted_57 = /*#__PURE__*/_createElementVNode("span", { class: "sx" }, [
  /*#__PURE__*/_createTextVNode("x"),
  /*#__PURE__*/_createElementVNode("sup", null, "2")
], -1 /* HOISTED */)
const _hoisted_58 = [
  _hoisted_57
]
const _hoisted_59 = ["title"]
const _hoisted_60 = /*#__PURE__*/_createElementVNode("span", { class: "sx" }, [
  /*#__PURE__*/_createTextVNode("x"),
  /*#__PURE__*/_createElementVNode("sub", null, "2")
], -1 /* HOISTED */)
const _hoisted_61 = [
  _hoisted_60
]
const _hoisted_62 = ["title"]
const _hoisted_63 = /*#__PURE__*/_createElementVNode("span", { class: "mono" }, "</>", -1 /* HOISTED */)
const _hoisted_64 = [
  _hoisted_63
]
const _hoisted_65 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_66 = { class: "eb-pop" }
const _hoisted_67 = ["title"]
const _hoisted_68 = ["innerHTML"]
const _hoisted_69 = ["onClick"]
const _hoisted_70 = /*#__PURE__*/_createElementVNode("span", { class: "eb-swatch none" }, null, -1 /* HOISTED */)
const _hoisted_71 = ["title"]
const _hoisted_72 = ["innerHTML"]
const _hoisted_73 = ["value"]
const _hoisted_74 = ["title"]
const _hoisted_75 = ["innerHTML"]
const _hoisted_76 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_77 = ["title"]
const _hoisted_78 = ["innerHTML"]
const _hoisted_79 = ["title"]
const _hoisted_80 = ["innerHTML"]
const _hoisted_81 = ["onClick", "title", "innerHTML"]
const _hoisted_82 = ["title"]
const _hoisted_83 = ["innerHTML"]
const _hoisted_84 = ["title"]
const _hoisted_85 = ["innerHTML"]
const _hoisted_86 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_87 = { class: "eb-pop" }
const _hoisted_88 = ["title"]
const _hoisted_89 = ["innerHTML"]
const _hoisted_90 = { class: "lbl" }
const _hoisted_91 = ["innerHTML"]
const _hoisted_92 = ["innerHTML"]
const _hoisted_93 = ["innerHTML"]
const _hoisted_94 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_95 = ["onClick"]
const _hoisted_96 = ["innerHTML"]
const _hoisted_97 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_98 = ["onClick"]
const _hoisted_99 = ["innerHTML"]
const _hoisted_100 = /*#__PURE__*/_createElementVNode("div", { class: "eb-menu-sep" }, null, -1 /* HOISTED */)
const _hoisted_101 = ["innerHTML"]
const _hoisted_102 = ["innerHTML"]
const _hoisted_103 = ["innerHTML"]
const _hoisted_104 = ["innerHTML"]
const _hoisted_105 = {
  key: 0,
  class: "eb-menu-sep"
}
const _hoisted_106 = ["onClick"]
const _hoisted_107 = ["innerHTML"]
const _hoisted_108 = ["title"]
const _hoisted_109 = ["innerHTML"]
const _hoisted_110 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_111 = ["title"]
const _hoisted_112 = ["innerHTML"]
const _hoisted_113 = ["title"]
const _hoisted_114 = ["innerHTML"]
const _hoisted_115 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_116 = ["title"]
const _hoisted_117 = ["innerHTML"]
const _hoisted_118 = ["title"]
const _hoisted_119 = ["innerHTML"]
const _hoisted_120 = ["innerHTML"]
const _hoisted_121 = {
  key: 1,
  class: "eb-find"
}
const _hoisted_122 = ["innerHTML"]
const _hoisted_123 = ["placeholder"]
const _hoisted_124 = { class: "count" }
const _hoisted_125 = ["title"]
const _hoisted_126 = ["title"]
const _hoisted_127 = { class: "opt" }
const _hoisted_128 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_129 = ["placeholder"]
const _hoisted_130 = ["disabled"]
const _hoisted_131 = ["disabled"]
const _hoisted_132 = ["title"]
const _hoisted_133 = ["innerHTML"]
const _hoisted_134 = {
  key: 2,
  class: "eb-toolbar sub"
}
const _hoisted_135 = { class: "grp" }
const _hoisted_136 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_137 = ["title"]
const _hoisted_138 = ["innerHTML"]
const _hoisted_139 = { class: "hint" }
const _hoisted_140 = {
  key: 3,
  class: "eb-toolbar sub"
}
const _hoisted_141 = { class: "grp" }
const _hoisted_142 = ["title"]
const _hoisted_143 = ["innerHTML"]
const _hoisted_144 = ["title"]
const _hoisted_145 = ["innerHTML"]
const _hoisted_146 = ["title"]
const _hoisted_147 = ["innerHTML"]
const _hoisted_148 = ["title"]
const _hoisted_149 = ["innerHTML"]
const _hoisted_150 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_151 = ["title"]
const _hoisted_152 = ["innerHTML"]
const _hoisted_153 = ["title"]
const _hoisted_154 = ["innerHTML"]
const _hoisted_155 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_156 = ["title"]
const _hoisted_157 = ["innerHTML"]
const _hoisted_158 = ["value", "title"]
const _hoisted_159 = { value: "" }
const _hoisted_160 = { value: "rows" }
const _hoisted_161 = { value: "borderless" }
const _hoisted_162 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_163 = ["title"]
const _hoisted_164 = ["innerHTML"]
const _hoisted_165 = { class: "hint" }
const _hoisted_166 = {
  class: "eb-sheets",
  "aria-hidden": "true"
}
const _hoisted_167 = ["spellcheck"]
const _hoisted_168 = {
  key: 0,
  class: "eb-empty"
}
const _hoisted_169 = ["innerHTML"]
const _hoisted_170 = {
  key: 4,
  class: "eb-status"
}
const _hoisted_171 = { class: "grow" }
const _hoisted_172 = { class: "body" }
const _hoisted_173 = { class: "eb-row" }
const _hoisted_174 = { class: "eb-field" }
const _hoisted_175 = ["value"]
const _hoisted_176 = { class: "eb-field" }
const _hoisted_177 = { value: "portrait" }
const _hoisted_178 = { value: "landscape" }
const _hoisted_179 = { class: "eb-row" }
const _hoisted_180 = { class: "eb-field" }
const _hoisted_181 = { class: "eb-field" }
const _hoisted_182 = { class: "eb-field" }
const _hoisted_183 = { class: "eb-field" }
const _hoisted_184 = { class: "eb-row" }
const _hoisted_185 = { class: "eb-field" }
const _hoisted_186 = { class: "eb-field" }
const _hoisted_187 = { class: "eb-field" }
const _hoisted_188 = { class: "font-rows" }
const _hoisted_189 = ["onClick"]
const _hoisted_190 = { class: "role" }
const _hoisted_191 = {
  key: 0,
  class: "tag"
}
const _hoisted_192 = ["innerHTML"]
const _hoisted_193 = { class: "eb-note" }
const _hoisted_194 = { class: "eb-note" }
const _hoisted_195 = { class: "foot" }
const _hoisted_196 = { class: "body" }
const _hoisted_197 = { class: "eb-row" }
const _hoisted_198 = { class: "eb-field" }
const _hoisted_199 = { class: "eb-field" }
const _hoisted_200 = { class: "eb-field" }
const _hoisted_201 = { value: "" }
const _hoisted_202 = { value: "rows" }
const _hoisted_203 = { value: "borderless" }
const _hoisted_204 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_205 = { class: "foot" }
const _hoisted_206 = { class: "body" }
const _hoisted_207 = { style: {"display":"flex","flex-wrap":"wrap","gap":"6px","margin-bottom":"8px"} }
const _hoisted_208 = ["onClick"]
const _hoisted_209 = { class: "eb-field" }
const _hoisted_210 = /*#__PURE__*/_createElementVNode("label", null, "MathML", -1 /* HOISTED */)
const _hoisted_211 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_212 = { class: "eb-field" }
const _hoisted_213 = ["innerHTML"]
const _hoisted_214 = { class: "eb-note" }
const _hoisted_215 = { class: "foot" }
const _hoisted_216 = ["innerHTML"]
const _hoisted_217 = { class: "body" }
const _hoisted_218 = {
  key: 0,
  class: "hint"
}
const _hoisted_219 = {
  key: 1,
  class: "eb-note",
  style: {"color":"var(--danger)"}
}
const _hoisted_220 = {
  key: 0,
  class: "font-list"
}
const _hoisted_221 = ["onClick"]
const _hoisted_222 = { class: "ic" }
const _hoisted_223 = { class: "nm" }
const _hoisted_224 = {
  key: 0,
  class: "hint"
}
const _hoisted_225 = { class: "eb-note" }
const _hoisted_226 = { class: "opt" }
const _hoisted_227 = { class: "src-preview" }
const _hoisted_228 = { class: "eb-table" }
const _hoisted_229 = { key: 0 }
const _hoisted_230 = { class: "font-search" }
const _hoisted_231 = ["innerHTML"]
const _hoisted_232 = ["placeholder"]
const _hoisted_233 = { class: "font-list" }
const _hoisted_234 = ["onClick"]
const _hoisted_235 = { class: "nm" }
const _hoisted_236 = { class: "meta" }
const _hoisted_237 = {
  key: 0,
  class: "hint"
}
const _hoisted_238 = { class: "eb-note" }
const _hoisted_239 = { class: "chips" }
const _hoisted_240 = ["onClick"]
const _hoisted_241 = { class: "eb-row" }
const _hoisted_242 = { class: "eb-field" }
const _hoisted_243 = { class: "eb-field" }
const _hoisted_244 = { class: "eb-field" }
const _hoisted_245 = { value: "" }
const _hoisted_246 = ["value"]
const _hoisted_247 = { class: "font-list" }
const _hoisted_248 = { class: "nm" }
const _hoisted_249 = { class: "meta" }
const _hoisted_250 = {
  key: 0,
  class: "hint"
}
const _hoisted_251 = {
  key: 0,
  class: "font-list"
}
const _hoisted_252 = ["onClick"]
const _hoisted_253 = { class: "ic" }
const _hoisted_254 = { class: "nm" }
const _hoisted_255 = { class: "meta" }
const _hoisted_256 = {
  key: 0,
  class: "hint"
}
const _hoisted_257 = { class: "eb-note" }
const _hoisted_258 = { class: "chips" }
const _hoisted_259 = ["onClick"]
const _hoisted_260 = { class: "font-list" }
const _hoisted_261 = ["onClick"]
const _hoisted_262 = { class: "nm" }
const _hoisted_263 = { class: "meta" }
const _hoisted_264 = {
  key: 0,
  class: "font-list"
}
const _hoisted_265 = ["onClick"]
const _hoisted_266 = { class: "ic" }
const _hoisted_267 = { class: "nm" }
const _hoisted_268 = {
  key: 0,
  class: "hint"
}
const _hoisted_269 = {
  key: 1,
  class: "font-list"
}
const _hoisted_270 = ["onClick"]
const _hoisted_271 = { class: "nm" }
const _hoisted_272 = { class: "meta mono" }
const _hoisted_273 = {
  key: 7,
  class: "font-list"
}
const _hoisted_274 = ["onClick"]
const _hoisted_275 = { class: "nm" }
const _hoisted_276 = { class: "meta" }
const _hoisted_277 = {
  key: 0,
  class: "hint"
}
const _hoisted_278 = { class: "foot" }
const _hoisted_279 = { class: "body" }
const _hoisted_280 = {
  key: 0,
  class: "eb-note"
}
const _hoisted_281 = { class: "eb-note" }
const _hoisted_282 = { class: "chips" }
const _hoisted_283 = {
  class: "opt",
  style: {"margin-top":"10px"}
}
const _hoisted_284 = { class: "opt" }
const _hoisted_285 = { class: "foot" }
const _hoisted_286 = ["disabled"]
const _hoisted_287 = ["innerHTML"]
const _hoisted_288 = { class: "body" }
const _hoisted_289 = { class: "fp-path" }
const _hoisted_290 = ["disabled"]
const _hoisted_291 = ["innerHTML"]
const _hoisted_292 = { class: "crumbs" }
const _hoisted_293 = { class: "font-list" }
const _hoisted_294 = {
  key: 0,
  class: "hint"
}
const _hoisted_295 = {
  key: 1,
  class: "hint"
}
const _hoisted_296 = ["onClick", "onDblclick"]
const _hoisted_297 = ["innerHTML"]
const _hoisted_298 = { class: "nm" }
const _hoisted_299 = {
  key: 0,
  class: "meta"
}
const _hoisted_300 = {
  key: 2,
  class: "hint"
}
const _hoisted_301 = { class: "eb-note" }
const _hoisted_302 = { class: "foot" }
const _hoisted_303 = ["disabled"]
const _hoisted_304 = ["innerHTML"]
const _hoisted_305 = { class: "body" }
const _hoisted_306 = { class: "font-search" }
const _hoisted_307 = ["innerHTML"]
const _hoisted_308 = ["placeholder"]
const _hoisted_309 = { class: "chips" }
const _hoisted_310 = ["onClick"]
const _hoisted_311 = { class: "chips" }
const _hoisted_312 = { value: "auto" }
const _hoisted_313 = { value: "all" }
const _hoisted_314 = ["value"]
const _hoisted_315 = { class: "count" }
const _hoisted_316 = { class: "font-list" }
const _hoisted_317 = { class: "nm" }
const _hoisted_318 = { class: "meta" }
const _hoisted_319 = ["onClick"]
const _hoisted_320 = { class: "meta" }
const _hoisted_321 = {
  key: 0,
  class: "hint"
}
const _hoisted_322 = {
  key: 1,
  class: "hint"
}
const _hoisted_323 = { class: "eb-field" }
const _hoisted_324 = { class: "foot" }
const _hoisted_325 = { class: "body" }
const _hoisted_326 = { class: "eb-field" }
const _hoisted_327 = { class: "eb-note" }
const _hoisted_328 = { class: "eb-row" }
const _hoisted_329 = { class: "eb-field" }
const _hoisted_330 = { value: "auto" }
const _hoisted_331 = { value: "light" }
const _hoisted_332 = { value: "dark" }
const _hoisted_333 = { class: "eb-field" }
const _hoisted_334 = { value: "auto" }
const _hoisted_335 = ["value"]
const _hoisted_336 = { class: "eb-field" }
const _hoisted_337 = { class: "opt" }
const _hoisted_338 = ["checked"]
const _hoisted_339 = { class: "opt" }
const _hoisted_340 = ["checked"]
const _hoisted_341 = { class: "eb-note" }
const _hoisted_342 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_343 = { class: "foot" }
const _hoisted_344 = { class: "body" }
const _hoisted_345 = { class: "eb-note" }
const _hoisted_346 = ["value"]
const _hoisted_347 = { class: "foot" }
const _hoisted_348 = ["disabled"]
const _hoisted_349 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Ctrl+X", -1 /* HOISTED */)
const _hoisted_350 = ["disabled"]
const _hoisted_351 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Ctrl+C", -1 /* HOISTED */)
const _hoisted_352 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Ctrl+V", -1 /* HOISTED */)
const _hoisted_353 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Ctrl+Shift+V", -1 /* HOISTED */)
const _hoisted_354 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_355 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Ctrl+K", -1 /* HOISTED */)
const _hoisted_356 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_357 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_358 = { class: "fly" }
const _hoisted_359 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_360 = { class: "fly" }
const _hoisted_361 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Ctrl+B", -1 /* HOISTED */)
const _hoisted_362 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Ctrl+I", -1 /* HOISTED */)
const _hoisted_363 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Ctrl+U", -1 /* HOISTED */)
const _hoisted_364 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_365 = { class: "fly" }
const _hoisted_366 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_367 = { class: "fly" }
const _hoisted_368 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Tab", -1 /* HOISTED */)
const _hoisted_369 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "Shift+Tab", -1 /* HOISTED */)
const _hoisted_370 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_371 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_372 = { class: "fly" }
const _hoisted_373 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_374 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_375 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_376 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_377 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_378 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "›", -1 /* HOISTED */)
const _hoisted_379 = { class: "fly" }
const _hoisted_380 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_381 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_382 = /*#__PURE__*/_createElementVNode("div", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_383 = { class: "body" }
const _hoisted_384 = { class: "eb-row" }
const _hoisted_385 = { class: "eb-field" }
const _hoisted_386 = { value: "" }
const _hoisted_387 = { value: "left" }
const _hoisted_388 = { value: "center" }
const _hoisted_389 = { value: "right" }
const _hoisted_390 = { value: "justify" }
const _hoisted_391 = { class: "eb-field" }
const _hoisted_392 = ["placeholder"]
const _hoisted_393 = { class: "eb-row" }
const _hoisted_394 = { class: "eb-field" }
const _hoisted_395 = { class: "eb-field" }
const _hoisted_396 = { class: "eb-row" }
const _hoisted_397 = { class: "eb-field" }
const _hoisted_398 = { class: "eb-field" }
const _hoisted_399 = { class: "eb-field" }
const _hoisted_400 = { class: "opt" }
const _hoisted_401 = { class: "opt" }
const _hoisted_402 = { class: "opt" }
const _hoisted_403 = { class: "eb-note" }
const _hoisted_404 = { class: "foot" }
const _hoisted_405 = { class: "body" }
const _hoisted_406 = { class: "eb-field" }
const _hoisted_407 = { class: "eb-note" }
const _hoisted_408 = { class: "foot" }
const _hoisted_409 = { class: "body" }
const _hoisted_410 = { class: "chips" }
const _hoisted_411 = ["onClick"]
const _hoisted_412 = { class: "eb-chargrid" }
const _hoisted_413 = ["onClick"]
const _hoisted_414 = { class: "eb-note" }
const _hoisted_415 = { class: "foot" }
const _hoisted_416 = { class: "body" }
const _hoisted_417 = { class: "eb-field" }
const _hoisted_418 = ["placeholder"]
const _hoisted_419 = { class: "eb-field" }
const _hoisted_420 = { class: "eb-note" }
const _hoisted_421 = { class: "foot" }
const _hoisted_422 = { class: "body" }
const _hoisted_423 = { class: "eb-field" }
const _hoisted_424 = { class: "eb-note" }
const _hoisted_425 = { class: "foot" }
const _hoisted_426 = {
  key: 17,
  class: "eb-toast"
}

return function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
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
      _createElementVNode("div", _hoisted_2, [
        _createElementVNode("span", {
          class: "logo",
          innerHTML: _ctx.logo
        }, null, 8 /* PROPS */, _hoisted_3),
        _hoisted_4,
        (!_ctx.narrow)
          ? (_openBlock(), _createElementBlock("span", _hoisted_5, _toDisplayString(_ctx.version), 1 /* TEXT */))
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
              }, null, 8 /* PROPS */, _hoisted_7)
            ], 8 /* PROPS */, _hoisted_6))
          : _createCommentVNode("v-if", true)
      ]),
      _createElementVNode("div", _hoisted_8, [
        _createElementVNode("button", {
          class: "eb-btn primary wide",
          onClick: _cache[2] || (_cache[2] = (...args) => (_ctx.newDoc && _ctx.newDoc(...args)))
        }, "＋ " + _toDisplayString(_ctx.t('New document')), 1 /* TEXT */)
      ]),
      _createElementVNode("div", _hoisted_9, [
        (!_ctx.docs.length)
          ? (_openBlock(), _createElementBlock("p", _hoisted_10, _toDisplayString(_ctx.t('No documents yet. Everything you write here is saved to {folder} in your Files as a plain .html file.', { folder: _ctx.settings.folder })), 1 /* TEXT */))
          : _createCommentVNode("v-if", true),
        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.docs, (d) => {
          return (_openBlock(), _createElementBlock("button", {
            key: d.id,
            class: _normalizeClass(["eb-docitem", { active: d.id === _ctx.doc.id }]),
            onClick: $event => (_ctx.openDoc(d.id))
          }, [
            _createElementVNode("span", _hoisted_12, _toDisplayString(d.title), 1 /* TEXT */),
            _createElementVNode("span", _hoisted_13, _toDisplayString(_ctx.when(d.mtime)) + " · " + _toDisplayString(_ctx.size(d.size)), 1 /* TEXT */)
          ], 10 /* CLASS, PROPS */, _hoisted_11))
        }), 128 /* KEYED_FRAGMENT */))
      ]),
      _createElementVNode("div", _hoisted_14, [
        _createElementVNode("button", {
          class: "eb-btn ghost wide",
          onClick: _cache[3] || (_cache[3] = $event => (_ctx.paperOpen = true))
        }, "🖹 " + _toDisplayString(_ctx.t('Paper setup')), 1 /* TEXT */),
        _createElementVNode("button", {
          class: "eb-btn ghost wide",
          onClick: _cache[4] || (_cache[4] = $event => (_ctx.settingsOpen = true))
        }, "⚙ " + _toDisplayString(_ctx.t('Settings')), 1 /* TEXT */)
      ])
    ], 2 /* CLASS */),
    _createElementVNode("section", _hoisted_15, [
      _createElementVNode("div", _hoisted_16, [
        _createElementVNode("button", {
          class: "eb-tb menu-btn",
          onClick: _cache[5] || (_cache[5] = $event => (_ctx.sideOpen = !_ctx.sideOpen)),
          title: _ctx.t('Documents')
        }, [
          _createElementVNode("span", {
            innerHTML: _ctx.icons.menu
          }, null, 8 /* PROPS */, _hoisted_18)
        ], 8 /* PROPS */, _hoisted_17),
        _withDirectives(_createElementVNode("input", {
          class: "title-input",
          "onUpdate:modelValue": _cache[6] || (_cache[6] = $event => ((_ctx.doc.title) = $event)),
          placeholder: _ctx.t('Untitled document'),
          onChange: _cache[7] || (_cache[7] = (...args) => (_ctx.applyTitle && _ctx.applyTitle(...args))),
          disabled: !_ctx.doc.id
        }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_19), [
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
          _createElementVNode("span", _hoisted_21, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
        ], 8 /* PROPS */, _hoisted_20),
        _createElementVNode("button", {
          class: "eb-btn",
          onClick: _cache[9] || (_cache[9] = (...args) => (_ctx.printDoc && _ctx.printDoc(...args))),
          disabled: !_ctx.doc.id
        }, [
          _createTextVNode("🖨 "),
          _createElementVNode("span", _hoisted_23, _toDisplayString(_ctx.t('Print / PDF')), 1 /* TEXT */)
        ], 8 /* PROPS */, _hoisted_22),
        _createElementVNode("button", {
          class: "eb-btn ghost",
          onClick: _cache[10] || (_cache[10] = $event => (_ctx.menuOpen = !_ctx.menuOpen)),
          title: _ctx.t('More')
        }, "⋯", 8 /* PROPS */, _hoisted_24),
        (_ctx.menuOpen)
          ? (_openBlock(), _createElementBlock("div", {
              key: 0,
              class: "eb-modal-back",
              onClick: _cache[17] || (_cache[17] = $event => (_ctx.menuOpen = false))
            }, [
              _createElementVNode("div", {
                class: "eb-modal",
                style: {"width":"min(360px,100%)"},
                onClick: _cache[16] || (_cache[16] = _withModifiers(() => {}, ["stop"]))
              }, [
                _createElementVNode("h3", null, _toDisplayString(_ctx.doc.title || _ctx.t('Untitled document')), 1 /* TEXT */),
                _createElementVNode("div", _hoisted_25, [
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[11] || (_cache[11] = (...args) => (_ctx.download && _ctx.download(...args)))
                  }, "⬇ " + _toDisplayString(_ctx.t('Download a copy')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[12] || (_cache[12] = (...args) => (_ctx.duplicate && _ctx.duplicate(...args)))
                  }, "⧉ " + _toDisplayString(_ctx.t('Duplicate')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[13] || (_cache[13] = $event => {_ctx.paperOpen = true; _ctx.menuOpen = false})
                  }, "🖹 " + _toDisplayString(_ctx.t('Paper setup')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[14] || (_cache[14] = (...args) => (_ctx.showSource && _ctx.showSource(...args)))
                  }, "</> " + _toDisplayString(_ctx.t('View the HTML')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide danger",
                    onClick: _cache[15] || (_cache[15] = (...args) => (_ctx.removeDoc && _ctx.removeDoc(...args)))
                  }, "🗑 " + _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */)
                ])
              ])
            ]))
          : _createCommentVNode("v-if", true)
      ]),
      (_ctx.doc.id)
        ? (_openBlock(), _createElementBlock("div", _hoisted_26, [
            _createElementVNode("select", {
              class: "tb-style",
              value: _ctx.fmt.block || 'P',
              onChange: _cache[18] || (_cache[18] = $event => (_ctx.setBlock($event.target.value))),
              title: _ctx.t('Paragraph style')
            }, [
              _createElementVNode("option", _hoisted_28, _toDisplayString(_ctx.t('Body text')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_29, _toDisplayString(_ctx.t('Heading 1')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_30, _toDisplayString(_ctx.t('Heading 2')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_31, _toDisplayString(_ctx.t('Heading 3')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_32, _toDisplayString(_ctx.t('Heading 4')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_33, _toDisplayString(_ctx.t('Quotation')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_34, _toDisplayString(_ctx.t('Preformatted')), 1 /* TEXT */)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_27),
            _createElementVNode("button", {
              class: "eb-tb text font-btn",
              onMousedown: _cache[19] || (_cache[19] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[20] || (_cache[20] = $event => (_ctx.openFonts('body'))),
              title: _ctx.t('Body typeface')
            }, [
              _createElementVNode("span", {
                class: "fname",
                style: _normalizeStyle({ fontFamily: _ctx.fontPreviewStack(_ctx.fontsInUse.body) })
              }, _toDisplayString(_ctx.fontsInUse.body), 5 /* TEXT, STYLE */),
              _createElementVNode("span", {
                class: "caret",
                innerHTML: _ctx.icons.down
              }, null, 8 /* PROPS */, _hoisted_36)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_35),
            _createElementVNode("span", {
              class: "eb-num",
              title: _ctx.t('Body size (pt)')
            }, [
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[21] || (_cache[21] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[22] || (_cache[22] = $event => (_ctx.stepSize(-0.5))),
                innerHTML: _ctx.icons.minus
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_38),
              _withDirectives(_createElementVNode("input", {
                type: "number",
                min: "6",
                max: "36",
                step: "0.5",
                "onUpdate:modelValue": _cache[23] || (_cache[23] = $event => ((_ctx.doc.paper.fontSize) = $event))
              }, null, 512 /* NEED_PATCH */), [
                [
                  _vModelText,
                  _ctx.doc.paper.fontSize,
                  void 0,
                  { number: true }
                ]
              ]),
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[24] || (_cache[24] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[25] || (_cache[25] = $event => (_ctx.stepSize(0.5))),
                innerHTML: _ctx.icons.plus
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_39)
            ], 8 /* PROPS */, _hoisted_37),
            _hoisted_40,
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.bold }]),
              onMousedown: _cache[26] || (_cache[26] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[27] || (_cache[27] = $event => (_ctx.inline('bold'))),
              title: _ctx.t('Bold') + ' (Ctrl+B)'
            }, _hoisted_43, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_41),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.italic }]),
              onMousedown: _cache[28] || (_cache[28] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[29] || (_cache[29] = $event => (_ctx.inline('italic'))),
              title: _ctx.t('Italic') + ' (Ctrl+I)'
            }, _hoisted_46, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_44),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.underline }]),
              onMousedown: _cache[30] || (_cache[30] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[31] || (_cache[31] = $event => (_ctx.inline('underline'))),
              title: _ctx.t('Underline') + ' (Ctrl+U)'
            }, _hoisted_49, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_47),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.strike }]),
              onMousedown: _cache[32] || (_cache[32] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[33] || (_cache[33] = $event => (_ctx.inline('strike'))),
              title: _ctx.t('Strikethrough')
            }, _hoisted_52, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_50),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.kenten }]),
              onMousedown: _cache[34] || (_cache[34] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[35] || (_cache[35] = $event => (_ctx.inline('kenten'))),
              title: _ctx.t('Emphasis dots')
            }, _hoisted_55, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_53),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.sup }]),
              onMousedown: _cache[36] || (_cache[36] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[37] || (_cache[37] = $event => (_ctx.inline('sup'))),
              title: _ctx.t('Superscript')
            }, _hoisted_58, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_56),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.sub }]),
              onMousedown: _cache[38] || (_cache[38] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[39] || (_cache[39] = $event => (_ctx.inline('sub'))),
              title: _ctx.t('Subscript')
            }, _hoisted_61, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_59),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.code }]),
              onMousedown: _cache[40] || (_cache[40] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[41] || (_cache[41] = $event => (_ctx.inline('code'))),
              title: _ctx.t('Inline code')
            }, _hoisted_64, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_62),
            _hoisted_65,
            _createElementVNode("span", _hoisted_66, [
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.menu === 'hl' }]),
                onMousedown: _cache[42] || (_cache[42] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[43] || (_cache[43] = $event => (_ctx.toggleMenu('hl'))),
                title: _ctx.t('Highlight')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.highlight
                }, null, 8 /* PROPS */, _hoisted_68)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_67),
              (_ctx.menu === 'hl')
                ? (_openBlock(), _createElementBlock("div", {
                    key: 0,
                    class: "eb-menu",
                    onMousedown: _cache[45] || (_cache[45] = _withModifiers(() => {}, ["prevent"]))
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
                      ], 8 /* PROPS */, _hoisted_69))
                    }), 128 /* KEYED_FRAGMENT */)),
                    _createElementVNode("button", {
                      class: "eb-menu-item",
                      onClick: _cache[44] || (_cache[44] = $event => {_ctx.clearHighlight(); _ctx.menu = ''})
                    }, [
                      _hoisted_70,
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
              }, null, 8 /* PROPS */, _hoisted_72),
              _createElementVNode("span", {
                class: "colour-bar",
                style: _normalizeStyle({ background: _ctx.colour })
              }, null, 4 /* STYLE */),
              _createElementVNode("input", {
                type: "color",
                value: _ctx.colour,
                onInput: _cache[46] || (_cache[46] = $event => (_ctx.setColour($event.target.value)))
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_73)
            ], 8 /* PROPS */, _hoisted_71),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[47] || (_cache[47] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[48] || (_cache[48] = (...args) => (_ctx.clearColour && _ctx.clearColour(...args))),
              title: _ctx.t('Remove text colour')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.nocolour
              }, null, 8 /* PROPS */, _hoisted_75)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_74),
            _hoisted_76,
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.list === 'UL' }]),
              onMousedown: _cache[49] || (_cache[49] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[50] || (_cache[50] = $event => (_ctx.list('UL'))),
              title: _ctx.t('Bulleted list')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.ul
              }, null, 8 /* PROPS */, _hoisted_78)
            ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_77),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.list === 'OL' }]),
              onMousedown: _cache[51] || (_cache[51] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[52] || (_cache[52] = $event => (_ctx.list('OL'))),
              title: _ctx.t('Numbered list')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.ol
              }, null, 8 /* PROPS */, _hoisted_80)
            ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_79),
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.aligns, (a) => {
              return (_openBlock(), _createElementBlock("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.align === a.cls }]),
                key: a.cls,
                onMousedown: _cache[53] || (_cache[53] = _withModifiers(() => {}, ["prevent"])),
                onClick: $event => (_ctx.align(a.cls)),
                title: a.label,
                innerHTML: a.icon
              }, null, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_81))
            }), 128 /* KEYED_FRAGMENT */)),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[54] || (_cache[54] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[55] || (_cache[55] = $event => (_ctx.indent(1))),
              title: _ctx.t('Increase indent')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.indent
              }, null, 8 /* PROPS */, _hoisted_83)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_82),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[56] || (_cache[56] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[57] || (_cache[57] = $event => (_ctx.indent(-1))),
              title: _ctx.t('Decrease indent')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.outdent
              }, null, 8 /* PROPS */, _hoisted_85)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_84),
            _hoisted_86,
            _createElementVNode("span", _hoisted_87, [
              _createElementVNode("button", {
                class: _normalizeClass(["eb-tb text", { on: _ctx.menu === 'insert' }]),
                onMousedown: _cache[58] || (_cache[58] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[59] || (_cache[59] = $event => (_ctx.toggleMenu('insert'))),
                title: _ctx.t('Insert')
              }, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.plus
                }, null, 8 /* PROPS */, _hoisted_89),
                _createElementVNode("span", _hoisted_90, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */),
                _createElementVNode("span", {
                  class: "caret",
                  innerHTML: _ctx.icons.down
                }, null, 8 /* PROPS */, _hoisted_91)
              ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_88),
              (_ctx.menu === 'insert')
                ? (_openBlock(), _createElementBlock("div", {
                    key: 0,
                    class: "eb-menu wide",
                    onMousedown: _cache[66] || (_cache[66] = _withModifiers(() => {}, ["prevent"]))
                  }, [
                    _createElementVNode("button", {
                      class: "eb-menu-item",
                      onClick: _cache[60] || (_cache[60] = $event => {_ctx.tableOpen = true; _ctx.menu = ''})
                    }, [
                      _createElementVNode("span", {
                        innerHTML: _ctx.icons.table
                      }, null, 8 /* PROPS */, _hoisted_92),
                      _createTextVNode(_toDisplayString(_ctx.t('Insert table')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("button", {
                      class: "eb-menu-item",
                      onClick: _cache[61] || (_cache[61] = $event => {_ctx.openPicker(); _ctx.menu = ''})
                    }, [
                      _createElementVNode("span", {
                        innerHTML: _ctx.icons.image
                      }, null, 8 /* PROPS */, _hoisted_93),
                      _createTextVNode(_toDisplayString(_ctx.t('Insert picture')), 1 /* TEXT */)
                    ]),
                    _hoisted_94,
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.boxes, (b) => {
                      return (_openBlock(), _createElementBlock("button", {
                        key: b.variant,
                        class: "eb-menu-item",
                        onClick: $event => {_ctx.addBox(b.variant); _ctx.menu = ''}
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.box
                        }, null, 8 /* PROPS */, _hoisted_96),
                        _createTextVNode(_toDisplayString(b.label), 1 /* TEXT */)
                      ], 8 /* PROPS */, _hoisted_95))
                    }), 128 /* KEYED_FRAGMENT */)),
                    _hoisted_97,
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.rules, (r) => {
                      return (_openBlock(), _createElementBlock("button", {
                        key: r.cls,
                        class: "eb-menu-item",
                        onClick: $event => {_ctx.addRule(r.cls); _ctx.menu = ''}
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.rule
                        }, null, 8 /* PROPS */, _hoisted_99),
                        _createTextVNode(_toDisplayString(r.label), 1 /* TEXT */)
                      ], 8 /* PROPS */, _hoisted_98))
                    }), 128 /* KEYED_FRAGMENT */)),
                    _hoisted_100,
                    _createElementVNode("button", {
                      class: "eb-menu-item",
                      onClick: _cache[62] || (_cache[62] = $event => {_ctx.addPageBreak(); _ctx.menu = ''})
                    }, [
                      _createElementVNode("span", {
                        innerHTML: _ctx.icons.pagebreak
                      }, null, 8 /* PROPS */, _hoisted_101),
                      _createTextVNode(_toDisplayString(_ctx.t('Page break')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("button", {
                      class: "eb-menu-item",
                      onClick: _cache[63] || (_cache[63] = $event => {_ctx.openMath(); _ctx.menu = ''})
                    }, [
                      _createElementVNode("span", {
                        innerHTML: _ctx.icons.formula
                      }, null, 8 /* PROPS */, _hoisted_102),
                      _createTextVNode(_toDisplayString(_ctx.t('Insert formula (MathML)')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("button", {
                      class: "eb-menu-item",
                      onClick: _cache[64] || (_cache[64] = $event => {_ctx.openToc(); _ctx.menu = ''})
                    }, [
                      _createElementVNode("span", {
                        innerHTML: _ctx.icons.doc
                      }, null, 8 /* PROPS */, _hoisted_103),
                      _createTextVNode(_toDisplayString(_ctx.t('Table of contents…')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("button", {
                      class: "eb-menu-item",
                      onClick: _cache[65] || (_cache[65] = $event => {_ctx.openChars(); _ctx.menu = ''})
                    }, [
                      _createElementVNode("span", {
                        innerHTML: _ctx.icons.text
                      }, null, 8 /* PROPS */, _hoisted_104),
                      _createTextVNode(_toDisplayString(_ctx.t('Special character…')), 1 /* TEXT */)
                    ]),
                    (_ctx.anySource)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_105))
                      : _createCommentVNode("v-if", true),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.sourceKeys, (key) => {
                      return (_openBlock(), _createElementBlock("button", {
                        key: key,
                        class: "eb-menu-item",
                        onClick: $event => (_ctx.openSource(key))
                      }, [
                        _createElementVNode("span", {
                          innerHTML: _ctx.icons.link
                        }, null, 8 /* PROPS */, _hoisted_107),
                        _createTextVNode(_toDisplayString(_ctx.sourceLabel(key)), 1 /* TEXT */)
                      ], 8 /* PROPS */, _hoisted_106))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 32 /* NEED_HYDRATION */))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[67] || (_cache[67] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[68] || (_cache[68] = (...args) => (_ctx.clearFmt && _ctx.clearFmt(...args))),
              title: _ctx.t('Clear formatting')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.clear
              }, null, 8 /* PROPS */, _hoisted_109)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_108),
            _hoisted_110,
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[69] || (_cache[69] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[70] || (_cache[70] = (...args) => (_ctx.undo && _ctx.undo(...args))),
              title: _ctx.t('Undo') + ' (Ctrl+Z)'
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.undo
              }, null, 8 /* PROPS */, _hoisted_112)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_111),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[71] || (_cache[71] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[72] || (_cache[72] = (...args) => (_ctx.redo && _ctx.redo(...args))),
              title: _ctx.t('Redo') + ' (Ctrl+Shift+Z)'
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.redo
              }, null, 8 /* PROPS */, _hoisted_114)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_113),
            _hoisted_115,
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.guides }]),
              onMousedown: _cache[73] || (_cache[73] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[74] || (_cache[74] = $event => (_ctx.guides = !_ctx.guides)),
              title: _ctx.t('Show page guides')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.guides
              }, null, 8 /* PROPS */, _hoisted_117)
            ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_116),
            _createElementVNode("span", {
              class: "eb-num",
              title: _ctx.t('Zoom')
            }, [
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[75] || (_cache[75] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[76] || (_cache[76] = $event => (_ctx.stepZoom(-10))),
                innerHTML: _ctx.icons.minus
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_119),
              _createElementVNode("button", {
                class: "eb-tb text zoomv",
                onMousedown: _cache[77] || (_cache[77] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[78] || (_cache[78] = $event => {_ctx.zoomSetByHand = true; _ctx.zoom = 100})
              }, _toDisplayString(_ctx.zoom) + "%", 33 /* TEXT, NEED_HYDRATION */),
              _createElementVNode("button", {
                class: "eb-tb",
                onMousedown: _cache[79] || (_cache[79] = _withModifiers(() => {}, ["prevent"])),
                onClick: _cache[80] || (_cache[80] = $event => (_ctx.stepZoom(10))),
                innerHTML: _ctx.icons.plus
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_120)
            ], 8 /* PROPS */, _hoisted_118)
          ]))
        : _createCommentVNode("v-if", true),
      (_ctx.doc.id && _ctx.find.open)
        ? (_openBlock(), _createElementBlock("div", _hoisted_121, [
            _createElementVNode("span", {
              class: "ic",
              innerHTML: _ctx.icons.search
            }, null, 8 /* PROPS */, _hoisted_122),
            _withDirectives(_createElementVNode("input", {
              ref: "findInput",
              type: "text",
              "onUpdate:modelValue": _cache[81] || (_cache[81] = $event => ((_ctx.find.query) = $event)),
              placeholder: _ctx.t('Find'),
              onInput: _cache[82] || (_cache[82] = $event => (_ctx.runFind())),
              onKeydown: [
                _cache[83] || (_cache[83] = _withKeys(_withModifiers($event => (_ctx.findNext(1)), ["prevent"]), ["enter"])),
                _cache[84] || (_cache[84] = _withKeys(_withModifiers((...args) => (_ctx.closeFind && _ctx.closeFind(...args)), ["prevent"]), ["esc"]))
              ]
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_123), [
              [_vModelText, _ctx.find.query]
            ]),
            _createElementVNode("span", _hoisted_124, _toDisplayString(_ctx.find.hits.length ? (_ctx.find.index + 1) + ' / ' + _ctx.find.hits.length : _ctx.t('none')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "eb-tb",
              onClick: _cache[85] || (_cache[85] = $event => (_ctx.findNext(-1))),
              title: _ctx.t('Previous')
            }, "↑", 8 /* PROPS */, _hoisted_125),
            _createElementVNode("button", {
              class: "eb-tb",
              onClick: _cache[86] || (_cache[86] = $event => (_ctx.findNext(1))),
              title: _ctx.t('Next')
            }, "↓", 8 /* PROPS */, _hoisted_126),
            _createElementVNode("label", _hoisted_127, [
              _withDirectives(_createElementVNode("input", {
                type: "checkbox",
                "onUpdate:modelValue": _cache[87] || (_cache[87] = $event => ((_ctx.find.caseSensitive) = $event)),
                onChange: _cache[88] || (_cache[88] = $event => (_ctx.runFind()))
              }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                [_vModelCheckbox, _ctx.find.caseSensitive]
              ]),
              _createTextVNode(" " + _toDisplayString(_ctx.t('Match case')), 1 /* TEXT */)
            ]),
            _hoisted_128,
            _withDirectives(_createElementVNode("input", {
              type: "text",
              "onUpdate:modelValue": _cache[89] || (_cache[89] = $event => ((_ctx.find.replace) = $event)),
              placeholder: _ctx.t('Replace with'),
              onKeydown: _cache[90] || (_cache[90] = _withKeys(_withModifiers((...args) => (_ctx.replaceOne && _ctx.replaceOne(...args)), ["prevent"]), ["enter"]))
            }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_129), [
              [_vModelText, _ctx.find.replace]
            ]),
            _createElementVNode("button", {
              class: "eb-btn",
              onClick: _cache[91] || (_cache[91] = (...args) => (_ctx.replaceOne && _ctx.replaceOne(...args))),
              disabled: !_ctx.find.hits.length
            }, _toDisplayString(_ctx.t('Replace')), 9 /* TEXT, PROPS */, _hoisted_130),
            _createElementVNode("button", {
              class: "eb-btn",
              onClick: _cache[92] || (_cache[92] = (...args) => (_ctx.replaceAll && _ctx.replaceAll(...args))),
              disabled: !_ctx.find.hits.length
            }, _toDisplayString(_ctx.t('Replace all')), 9 /* TEXT, PROPS */, _hoisted_131),
            _createElementVNode("button", {
              class: "eb-tb",
              onClick: _cache[93] || (_cache[93] = (...args) => (_ctx.closeFind && _ctx.closeFind(...args))),
              title: _ctx.t('Close')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.close
              }, null, 8 /* PROPS */, _hoisted_133)
            ], 8 /* PROPS */, _hoisted_132)
          ]))
        : _createCommentVNode("v-if", true),
      (_ctx.doc.id && _ctx.fmt.image)
        ? (_openBlock(), _createElementBlock("div", _hoisted_134, [
            _createElementVNode("span", _hoisted_135, _toDisplayString(_ctx.t('Picture')), 1 /* TEXT */),
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
            _hoisted_136,
            _createElementVNode("button", {
              class: "eb-tb danger",
              onMousedown: _cache[100] || (_cache[100] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[101] || (_cache[101] = $event => (_ctx.imageCmd('delete'))),
              title: _ctx.t('Delete picture')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.clear
              }, null, 8 /* PROPS */, _hoisted_138)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_137),
            _createElementVNode("span", _hoisted_139, _toDisplayString(_ctx.t('The caption sits under the picture; leave it empty and it does not print.')), 1 /* TEXT */)
          ]))
        : _createCommentVNode("v-if", true),
      (_ctx.doc.id && _ctx.fmt.table)
        ? (_openBlock(), _createElementBlock("div", _hoisted_140, [
            _createElementVNode("span", _hoisted_141, _toDisplayString(_ctx.t('Table')), 1 /* TEXT */),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[102] || (_cache[102] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[103] || (_cache[103] = $event => (_ctx.tableCmd('rowAbove'))),
              title: _ctx.t('Insert row above')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.rowAbove
              }, null, 8 /* PROPS */, _hoisted_143)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_142),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[104] || (_cache[104] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[105] || (_cache[105] = $event => (_ctx.tableCmd('rowBelow'))),
              title: _ctx.t('Insert row below')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.rowBelow
              }, null, 8 /* PROPS */, _hoisted_145)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_144),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[106] || (_cache[106] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[107] || (_cache[107] = $event => (_ctx.tableCmd('colLeft'))),
              title: _ctx.t('Insert column left')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.colLeft
              }, null, 8 /* PROPS */, _hoisted_147)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_146),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[108] || (_cache[108] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[109] || (_cache[109] = $event => (_ctx.tableCmd('colRight'))),
              title: _ctx.t('Insert column right')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.colRight
              }, null, 8 /* PROPS */, _hoisted_149)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_148),
            _hoisted_150,
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[110] || (_cache[110] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[111] || (_cache[111] = $event => (_ctx.tableCmd('rowDel'))),
              title: _ctx.t('Delete row')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.rowDel
              }, null, 8 /* PROPS */, _hoisted_152)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_151),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[112] || (_cache[112] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[113] || (_cache[113] = $event => (_ctx.tableCmd('colDel'))),
              title: _ctx.t('Delete column')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.colDel
              }, null, 8 /* PROPS */, _hoisted_154)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_153),
            _hoisted_155,
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.tableHeader }]),
              onMousedown: _cache[114] || (_cache[114] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[115] || (_cache[115] = $event => (_ctx.tableCmd('header'))),
              title: _ctx.t('First row is a header')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.header
              }, null, 8 /* PROPS */, _hoisted_157)
            ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_156),
            _createElementVNode("select", {
              value: _ctx.fmt.tableVariant,
              onChange: _cache[116] || (_cache[116] = $event => (_ctx.tableCmd('variant', $event.target.value))),
              title: _ctx.t('Style')
            }, [
              _createElementVNode("option", _hoisted_159, _toDisplayString(_ctx.t('All borders')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_160, _toDisplayString(_ctx.t('Horizontal lines only')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_161, _toDisplayString(_ctx.t('No borders')), 1 /* TEXT */)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_158),
            _hoisted_162,
            _createElementVNode("button", {
              class: "eb-tb danger",
              onMousedown: _cache[117] || (_cache[117] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[118] || (_cache[118] = $event => (_ctx.tableCmd('delete'))),
              title: _ctx.t('Delete table')
            }, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.tableDel
              }, null, 8 /* PROPS */, _hoisted_164)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_163),
            _createElementVNode("span", _hoisted_165, _toDisplayString(_ctx.t('Tab moves to the next cell; a new row is added at the end.')), 1 /* TEXT */)
          ]))
        : _createCommentVNode("v-if", true),
      _createElementVNode("div", {
        class: _normalizeClass(["eb-desk", { empty: !_ctx.doc.id }])
      }, [
        _withDirectives(_createElementVNode("div", {
          class: _normalizeClass(["eb-paperwrap", { noguides: !_ctx.guides }]),
          style: _normalizeStyle([_ctx.paperStyle, { zoom: _ctx.zoom / 100 }])
        }, [
          _createElementVNode("div", _hoisted_166, [
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.pageCount, (n) => {
              return (_openBlock(), _createElementBlock("div", {
                class: "eb-sheet",
                key: n
              }))
            }), 128 /* KEYED_FRAGMENT */))
          ]),
          _createElementVNode("div", {
            id: "eb-canvas",
            class: "eb-paper eb-doc",
            style: _normalizeStyle(_ctx.paperStyle),
            contenteditable: "true",
            spellcheck: _ctx.spellcheck,
            role: "textbox",
            "aria-multiline": "true"
          }, null, 12 /* STYLE, PROPS */, _hoisted_167)
        ], 6 /* CLASS, STYLE */), [
          [_vShow, _ctx.doc.id]
        ]),
        (!_ctx.doc.id)
          ? (_openBlock(), _createElementBlock("div", _hoisted_168, [
              _createElementVNode("span", {
                class: "mark",
                innerHTML: _ctx.logo
              }, null, 8 /* PROPS */, _hoisted_169),
              _createElementVNode("p", null, _toDisplayString(_ctx.t('No document is open.')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[119] || (_cache[119] = (...args) => (_ctx.newDoc && _ctx.newDoc(...args)))
              }, _toDisplayString(_ctx.t('New document')), 1 /* TEXT */)
            ]))
          : _createCommentVNode("v-if", true)
      ], 2 /* CLASS */),
      (_ctx.doc.id)
        ? (_openBlock(), _createElementBlock("div", _hoisted_170, [
            _createElementVNode("span", _hoisted_171, _toDisplayString(_ctx.doc.name), 1 /* TEXT */),
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
          onClick: _cache[139] || (_cache[139] = $event => (_ctx.paperOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[138] || (_cache[138] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "🖹 " + _toDisplayString(_ctx.t('Paper setup')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_172, [
              _createElementVNode("div", _hoisted_173, [
                _createElementVNode("div", _hoisted_174, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Paper size')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[120] || (_cache[120] = $event => ((_ctx.doc.paper.size) = $event)),
                    onChange: _cache[121] || (_cache[121] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.paperSizes, (p) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: p,
                        value: p
                      }, _toDisplayString(p), 9 /* TEXT, PROPS */, _hoisted_175))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelSelect, _ctx.doc.paper.size]
                  ])
                ]),
                _createElementVNode("div", _hoisted_176, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Orientation')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[122] || (_cache[122] = $event => ((_ctx.doc.paper.orientation) = $event)),
                    onChange: _cache[123] || (_cache[123] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, [
                    _createElementVNode("option", _hoisted_177, _toDisplayString(_ctx.t('Portrait')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_178, _toDisplayString(_ctx.t('Landscape')), 1 /* TEXT */)
                  ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelSelect, _ctx.doc.paper.orientation]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_179, [
                _createElementVNode("div", _hoisted_180, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Top margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[124] || (_cache[124] = $event => ((_ctx.doc.paper.margin.top) = $event)),
                    onChange: _cache[125] || (_cache[125] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.top,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_181, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Bottom margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[126] || (_cache[126] = $event => ((_ctx.doc.paper.margin.bottom) = $event)),
                    onChange: _cache[127] || (_cache[127] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.bottom,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_182, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Left margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[128] || (_cache[128] = $event => ((_ctx.doc.paper.margin.left) = $event)),
                    onChange: _cache[129] || (_cache[129] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.left,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_183, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Right margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[130] || (_cache[130] = $event => ((_ctx.doc.paper.margin.right) = $event)),
                    onChange: _cache[131] || (_cache[131] = (...args) => (_ctx.touch && _ctx.touch(...args)))
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
              _createElementVNode("div", _hoisted_184, [
                _createElementVNode("div", _hoisted_185, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Body size (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "6",
                    max: "36",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[132] || (_cache[132] = $event => ((_ctx.doc.paper.fontSize) = $event)),
                    onChange: _cache[133] || (_cache[133] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.fontSize,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_186, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Line height')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "3",
                    step: "0.05",
                    "onUpdate:modelValue": _cache[134] || (_cache[134] = $event => ((_ctx.doc.paper.lineHeight) = $event)),
                    onChange: _cache[135] || (_cache[135] = (...args) => (_ctx.touch && _ctx.touch(...args)))
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
              _createElementVNode("div", _hoisted_187, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Typefaces')), 1 /* TEXT */),
                _createElementVNode("div", _hoisted_188, [
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontRoles, (r) => {
                    return (_openBlock(), _createElementBlock("button", {
                      key: r.key,
                      class: "font-row",
                      onClick: $event => (_ctx.openFonts(r.key))
                    }, [
                      _createElementVNode("span", _hoisted_190, _toDisplayString(r.label), 1 /* TEXT */),
                      _createElementVNode("span", {
                        class: "fam",
                        style: _normalizeStyle({ fontFamily: _ctx.fontPreviewStack(_ctx.fontsInUse[r.key]) })
                      }, _toDisplayString(_ctx.fontsInUse[r.key]), 5 /* TEXT, STYLE */),
                      (!_ctx.doc.paper.fonts[r.key])
                        ? (_openBlock(), _createElementBlock("span", _hoisted_191, _toDisplayString(_ctx.t('default')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true),
                      _createElementVNode("span", {
                        class: "caret",
                        innerHTML: _ctx.icons.down
                      }, null, 8 /* PROPS */, _hoisted_192)
                    ], 8 /* PROPS */, _hoisted_189))
                  }), 128 /* KEYED_FRAGMENT */))
                ]),
                _createElementVNode("p", _hoisted_193, _toDisplayString(_ctx.t('Any family on Google Fonts can be used. The document carries its typefaces with it, so the file looks the same on a machine where they are not installed.')), 1 /* TEXT */)
              ]),
              _createElementVNode("p", _hoisted_194, _toDisplayString(_ctx.t('Page numbers and running headers come from your browser print dialogue: browsers do not yet support headers inside the page rule. Everything else here is written into the file.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_195, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[136] || (_cache[136] = (...args) => (_ctx.saveDefaultPaper && _ctx.saveDefaultPaper(...args)))
              }, _toDisplayString(_ctx.t('Use as default for new documents')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[137] || (_cache[137] = $event => (_ctx.paperOpen = false))
              }, _toDisplayString(_ctx.t('Done')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" insert table "),
    (_ctx.tableOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 2,
          class: "eb-modal-back",
          onClick: _cache[147] || (_cache[147] = $event => (_ctx.tableOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[146] || (_cache[146] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "▦ " + _toDisplayString(_ctx.t('Insert table')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_196, [
              _createElementVNode("div", _hoisted_197, [
                _createElementVNode("div", _hoisted_198, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Rows')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "60",
                    "onUpdate:modelValue": _cache[140] || (_cache[140] = $event => ((_ctx.table.rows) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.table.rows,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_199, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Columns')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "16",
                    "onUpdate:modelValue": _cache[141] || (_cache[141] = $event => ((_ctx.table.cols) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.table.cols,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_200, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Style')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[142] || (_cache[142] = $event => ((_ctx.table.variant) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_201, _toDisplayString(_ctx.t('All borders')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_202, _toDisplayString(_ctx.t('Horizontal lines only')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_203, _toDisplayString(_ctx.t('No borders')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.table.variant]
                  ])
                ])
              ]),
              _createElementVNode("label", _hoisted_204, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[143] || (_cache[143] = $event => ((_ctx.table.header) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.table.header]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('First row is a header')), 1 /* TEXT */)
              ])
            ]),
            _createElementVNode("div", _hoisted_205, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[144] || (_cache[144] = $event => (_ctx.tableOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[145] || (_cache[145] = (...args) => (_ctx.addTable && _ctx.addTable(...args)))
              }, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" formula "),
    (_ctx.mathOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 3,
          class: "eb-modal-back",
          onClick: _cache[153] || (_cache[153] = $event => (_ctx.mathOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[152] || (_cache[152] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "∑ " + _toDisplayString(_ctx.t('Insert formula (MathML)')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_206, [
              _createElementVNode("div", _hoisted_207, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.mathSnippets, (s) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: s.label,
                    class: "eb-btn",
                    onClick: $event => (_ctx.math.source = s.code)
                  }, _toDisplayString(s.label), 9 /* TEXT, PROPS */, _hoisted_208))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("div", _hoisted_209, [
                _hoisted_210,
                _withDirectives(_createElementVNode("textarea", {
                  "onUpdate:modelValue": _cache[148] || (_cache[148] = $event => ((_ctx.math.source) = $event)),
                  rows: "7",
                  spellcheck: "false"
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelText, _ctx.math.source]
                ])
              ]),
              _createElementVNode("label", _hoisted_211, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[149] || (_cache[149] = $event => ((_ctx.math.block) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.math.block]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Own line, centred')), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_212, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Preview')), 1 /* TEXT */),
                _createElementVNode("div", {
                  class: "eb-doc",
                  style: {"background":"#fff","color":"#111","border-radius":"9px","padding":"10px 12px","overflow-x":"auto"},
                  innerHTML: _ctx.mathPreview
                }, null, 8 /* PROPS */, _hoisted_213)
              ]),
              _createElementVNode("p", _hoisted_214, _toDisplayString(_ctx.t('MathML is drawn by the browser itself, so the formula stays text in the file — searchable, selectable and never a picture.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_215, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[150] || (_cache[150] = $event => (_ctx.mathOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[151] || (_cache[151] = (...args) => (_ctx.addMath && _ctx.addMath(...args)))
              }, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the other apps on this server "),
    (_ctx.sourceOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 4,
          class: "eb-modal-back",
          onClick: _cache[171] || (_cache[171] = $event => (_ctx.sourceOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal tall",
            onClick: _cache[170] || (_cache[170] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.link
              }, null, 8 /* PROPS */, _hoisted_216),
              _createTextVNode(" " + _toDisplayString(_ctx.sourceLabel(_ctx.source)), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_217, [
              (_ctx.src.loading)
                ? (_openBlock(), _createElementBlock("p", _hoisted_218, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.src.error)
                ? (_openBlock(), _createElementBlock("p", _hoisted_219, _toDisplayString(_ctx.src.error), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" Tables "),
              (_ctx.source === 'tables')
                ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                    (!_ctx.src.detail)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_220, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (x) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: x.id,
                              class: "fp-item",
                              onClick: $event => (_ctx.openCollection(x))
                            }, [
                              _createElementVNode("span", _hoisted_222, _toDisplayString(x.emoji || '▦'), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_223, _toDisplayString(x.title), 1 /* TEXT */)
                            ], 8 /* PROPS */, _hoisted_221))
                          }), 128 /* KEYED_FRAGMENT */)),
                          (!_ctx.src.items.length && !_ctx.src.loading)
                            ? (_openBlock(), _createElementBlock("p", _hoisted_224, _toDisplayString(_ctx.t('There is nothing here yet.')), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.src.detail)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("p", _hoisted_225, _toDisplayString(_ctx.t('{name}: {c} columns, {r} rows', { name: _ctx.src.detail.title, c: _ctx.src.detail.columns.length, r: _ctx.src.detail.rows.length })), 1 /* TEXT */),
                          _createElementVNode("label", _hoisted_226, [
                            _withDirectives(_createElementVNode("input", {
                              type: "checkbox",
                              "onUpdate:modelValue": _cache[154] || (_cache[154] = $event => ((_ctx.src.withHeader) = $event))
                            }, null, 512 /* NEED_PATCH */), [
                              [_vModelCheckbox, _ctx.src.withHeader]
                            ]),
                            _createTextVNode(" " + _toDisplayString(_ctx.t('First row is a header')), 1 /* TEXT */)
                          ]),
                          _createElementVNode("div", _hoisted_227, [
                            _createElementVNode("table", _hoisted_228, [
                              (_ctx.src.withHeader)
                                ? (_openBlock(), _createElementBlock("tr", _hoisted_229, [
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
                    _createElementVNode("div", _hoisted_230, [
                      _createElementVNode("span", {
                        innerHTML: _ctx.icons.search
                      }, null, 8 /* PROPS */, _hoisted_231),
                      _withDirectives(_createElementVNode("input", {
                        type: "text",
                        "onUpdate:modelValue": _cache[155] || (_cache[155] = $event => ((_ctx.src.query) = $event)),
                        onKeydown: _cache[156] || (_cache[156] = _withKeys(_withModifiers((...args) => (_ctx.searchContacts && _ctx.searchContacts(...args)), ["prevent"]), ["enter"])),
                        placeholder: _ctx.t('Search contacts…')
                      }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_232), [
                        [_vModelText, _ctx.src.query]
                      ]),
                      _createElementVNode("button", {
                        class: "eb-btn",
                        onClick: _cache[157] || (_cache[157] = (...args) => (_ctx.searchContacts && _ctx.searchContacts(...args)))
                      }, _toDisplayString(_ctx.t('Search')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("div", _hoisted_233, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (p) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: p.id,
                          class: "fp-item",
                          onClick: $event => (_ctx.insertContact(p))
                        }, [
                          _createElementVNode("span", _hoisted_235, _toDisplayString(p.name), 1 /* TEXT */),
                          _createElementVNode("span", _hoisted_236, _toDisplayString(p.org) + _toDisplayString(p.system ? ' · ' + _ctx.t('User directory') : ''), 1 /* TEXT */)
                        ], 8 /* PROPS */, _hoisted_234))
                      }), 128 /* KEYED_FRAGMENT */)),
                      (!_ctx.src.items.length && !_ctx.src.loading)
                        ? (_openBlock(), _createElementBlock("p", _hoisted_237, _toDisplayString(_ctx.t('No contact matches that.')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true)
                    ]),
                    _createElementVNode("p", _hoisted_238, _toDisplayString(_ctx.t('Choosing a contact writes the address block at the cursor. For one letter per contact, use the merge fields below.')), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_239, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.contactFields, (k) => {
                        return (_openBlock(), _createElementBlock("button", {
                          key: k,
                          class: "chip",
                          onClick: $event => (_ctx.insertField(k))
                        }, _toDisplayString(_ctx.fieldTag(k)), 9 /* TEXT, PROPS */, _hoisted_240))
                      }), 128 /* KEYED_FRAGMENT */))
                    ])
                  ], 64 /* STABLE_FRAGMENT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" Calendar "),
              (_ctx.source === 'calendar')
                ? (_openBlock(), _createElementBlock(_Fragment, { key: 4 }, [
                    _createElementVNode("div", _hoisted_241, [
                      _createElementVNode("div", _hoisted_242, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('From')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "date",
                          "onUpdate:modelValue": _cache[158] || (_cache[158] = $event => ((_ctx.src.from) = $event)),
                          onChange: _cache[159] || (_cache[159] = (...args) => (_ctx.loadEvents && _ctx.loadEvents(...args)))
                        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [_vModelText, _ctx.src.from]
                        ])
                      ]),
                      _createElementVNode("div", _hoisted_243, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('To')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("input", {
                          type: "date",
                          "onUpdate:modelValue": _cache[160] || (_cache[160] = $event => ((_ctx.src.to) = $event)),
                          onChange: _cache[161] || (_cache[161] = (...args) => (_ctx.loadEvents && _ctx.loadEvents(...args)))
                        }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [_vModelText, _ctx.src.to]
                        ])
                      ]),
                      _createElementVNode("div", _hoisted_244, [
                        _createElementVNode("label", null, _toDisplayString(_ctx.t('Calendar')), 1 /* TEXT */),
                        _withDirectives(_createElementVNode("select", {
                          "onUpdate:modelValue": _cache[162] || (_cache[162] = $event => ((_ctx.src.calendar) = $event)),
                          onChange: _cache[163] || (_cache[163] = (...args) => (_ctx.loadEvents && _ctx.loadEvents(...args)))
                        }, [
                          _createElementVNode("option", _hoisted_245, _toDisplayString(_ctx.t('All calendars')), 1 /* TEXT */),
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (c) => {
                            return (_openBlock(), _createElementBlock("option", {
                              key: c.key,
                              value: c.key
                            }, _toDisplayString(c.name), 9 /* TEXT, PROPS */, _hoisted_246))
                          }), 128 /* KEYED_FRAGMENT */))
                        ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                          [_vModelSelect, _ctx.src.calendar]
                        ])
                      ])
                    ]),
                    _createElementVNode("div", _hoisted_247, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.records, (e, i) => {
                        return (_openBlock(), _createElementBlock("div", {
                          key: i,
                          class: "fp-item"
                        }, [
                          _createElementVNode("span", _hoisted_248, _toDisplayString(e.summary), 1 /* TEXT */),
                          _createElementVNode("span", _hoisted_249, _toDisplayString(e.start.slice(0, 16).replace('T', ' ')) + _toDisplayString(e.allDay ? ' · ' + _ctx.t('All day') : '') + _toDisplayString(e.location ? ' · ' + e.location : ''), 1 /* TEXT */)
                        ]))
                      }), 128 /* KEYED_FRAGMENT */)),
                      (!_ctx.src.records.length && !_ctx.src.loading)
                        ? (_openBlock(), _createElementBlock("p", _hoisted_250, _toDisplayString(_ctx.t('No events in that range.')), 1 /* TEXT */))
                        : _createCommentVNode("v-if", true)
                    ])
                  ], 64 /* STABLE_FRAGMENT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" RegiBase "),
              (_ctx.source === 'regibase')
                ? (_openBlock(), _createElementBlock(_Fragment, { key: 5 }, [
                    (!_ctx.src.collection)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_251, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (x) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: x.id,
                              class: "fp-item",
                              onClick: $event => (_ctx.openCollection(x))
                            }, [
                              _createElementVNode("span", _hoisted_253, _toDisplayString(x.icon || '🗄'), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_254, _toDisplayString(x.name), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_255, _toDisplayString(x.count), 1 /* TEXT */)
                            ], 8 /* PROPS */, _hoisted_252))
                          }), 128 /* KEYED_FRAGMENT */)),
                          (!_ctx.src.items.length && !_ctx.src.loading)
                            ? (_openBlock(), _createElementBlock("p", _hoisted_256, _toDisplayString(_ctx.t('There is nothing here yet.')), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.src.collection)
                      ? (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                          _createElementVNode("p", _hoisted_257, _toDisplayString(_ctx.t('{name}: {c} fields, {r} records', { name: _ctx.src.collection.name, c: _ctx.src.fields.length, r: _ctx.src.records.length })), 1 /* TEXT */),
                          _createElementVNode("div", _hoisted_258, [
                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.fields, (f) => {
                              return (_openBlock(), _createElementBlock("button", {
                                key: f.key,
                                class: "chip",
                                onClick: $event => (_ctx.insertField(f.key))
                              }, _toDisplayString(_ctx.fieldTag(f.key)) + " " + _toDisplayString(f.label), 9 /* TEXT, PROPS */, _hoisted_259))
                            }), 128 /* KEYED_FRAGMENT */))
                          ]),
                          _createElementVNode("div", _hoisted_260, [
                            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.records, (r) => {
                              return (_openBlock(), _createElementBlock("button", {
                                key: r.id,
                                class: "fp-item",
                                onClick: $event => (_ctx.insertRecord(r))
                              }, [
                                _createElementVNode("span", _hoisted_262, _toDisplayString(r.data[_ctx.src.fields[0] && _ctx.src.fields[0].key] || '—'), 1 /* TEXT */),
                                _createElementVNode("span", _hoisted_263, _toDisplayString(_ctx.t('Insert as a table')), 1 /* TEXT */)
                              ], 8 /* PROPS */, _hoisted_261))
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
                      ? (_openBlock(), _createElementBlock("div", _hoisted_264, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (x) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: x.id,
                              class: "fp-item",
                              onClick: $event => (_ctx.openCollection(x))
                            }, [
                              _createElementVNode("span", _hoisted_266, _toDisplayString(x.icon || '∑'), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_267, _toDisplayString(x.name), 1 /* TEXT */)
                            ], 8 /* PROPS */, _hoisted_265))
                          }), 128 /* KEYED_FRAGMENT */)),
                          (!_ctx.src.items.length && !_ctx.src.loading)
                            ? (_openBlock(), _createElementBlock("p", _hoisted_268, _toDisplayString(_ctx.t('There is nothing here yet.')), 1 /* TEXT */))
                            : _createCommentVNode("v-if", true)
                        ]))
                      : _createCommentVNode("v-if", true),
                    (_ctx.src.collection)
                      ? (_openBlock(), _createElementBlock("div", _hoisted_269, [
                          (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.records, (f) => {
                            return (_openBlock(), _createElementBlock("button", {
                              key: f.id,
                              class: "fp-item",
                              onClick: $event => (_ctx.insertFormula(f))
                            }, [
                              _createElementVNode("span", _hoisted_271, _toDisplayString(f.name), 1 /* TEXT */),
                              _createElementVNode("span", _hoisted_272, _toDisplayString(f.expression), 1 /* TEXT */)
                            ], 8 /* PROPS */, _hoisted_270))
                          }), 128 /* KEYED_FRAGMENT */))
                        ]))
                      : _createCommentVNode("v-if", true)
                  ], 64 /* STABLE_FRAGMENT */))
                : _createCommentVNode("v-if", true),
              _createCommentVNode(" Notes "),
              (_ctx.source === 'notes')
                ? (_openBlock(), _createElementBlock("div", _hoisted_273, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.src.items, (n) => {
                      return (_openBlock(), _createElementBlock("button", {
                        key: n.id,
                        class: "fp-item",
                        onClick: $event => (_ctx.insertNote(n))
                      }, [
                        _createElementVNode("span", _hoisted_275, _toDisplayString(n.title), 1 /* TEXT */),
                        _createElementVNode("span", _hoisted_276, _toDisplayString(n.category), 1 /* TEXT */)
                      ], 8 /* PROPS */, _hoisted_274))
                    }), 128 /* KEYED_FRAGMENT */)),
                    (!_ctx.src.items.length && !_ctx.src.loading)
                      ? (_openBlock(), _createElementBlock("p", _hoisted_277, _toDisplayString(_ctx.t('There is nothing here yet.')), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ]))
                : _createCommentVNode("v-if", true)
            ]),
            _createElementVNode("div", _hoisted_278, [
              (_ctx.src.detail || _ctx.src.collection)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 0,
                    class: "eb-btn ghost",
                    onClick: _cache[164] || (_cache[164] = $event => {_ctx.src.detail = null; _ctx.src.collection = null})
                  }, _toDisplayString(_ctx.t('Back')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.source === 'contacts' || (_ctx.source === 'regibase' && _ctx.src.collection))
                ? (_openBlock(), _createElementBlock("button", {
                    key: 1,
                    class: "eb-btn ghost",
                    onClick: _cache[165] || (_cache[165] = $event => (_ctx.openMerge(_ctx.source === 'contacts' ? 'contacts' : 'regibase')))
                  }, _toDisplayString(_ctx.t('Mail merge…')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.source === 'calendar' && _ctx.src.records.length)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 2,
                    class: "eb-btn",
                    onClick: _cache[166] || (_cache[166] = $event => (_ctx.insertEvents(true)))
                  }, _toDisplayString(_ctx.t('Insert as a table')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.source === 'calendar' && _ctx.src.records.length)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 3,
                    class: "eb-btn primary",
                    onClick: _cache[167] || (_cache[167] = $event => (_ctx.insertEvents(false)))
                  }, _toDisplayString(_ctx.t('Insert as a list')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              (_ctx.source === 'tables' && _ctx.src.detail)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 4,
                    class: "eb-btn primary",
                    onClick: _cache[168] || (_cache[168] = (...args) => (_ctx.insertTableData && _ctx.insertTableData(...args)))
                  }, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[169] || (_cache[169] = $event => (_ctx.sourceOpen = false))
              }, _toDisplayString(_ctx.t('Close')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" mail merge "),
    (_ctx.mergeOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 5,
          class: "eb-modal-back",
          onClick: _cache[177] || (_cache[177] = $event => (_ctx.mergeOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[176] || (_cache[176] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Mail merge')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_279, [
              (!_ctx.merge.keys.length)
                ? (_openBlock(), _createElementBlock("p", _hoisted_280, _toDisplayString(_ctx.mergeHint), 1 /* TEXT */))
                : (_openBlock(), _createElementBlock(_Fragment, { key: 1 }, [
                    _createElementVNode("p", _hoisted_281, _toDisplayString(_ctx.t('{n} records will be filled into {k} fields:', { n: _ctx.merge.count, k: _ctx.merge.keys.length })), 1 /* TEXT */),
                    _createElementVNode("div", _hoisted_282, [
                      (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.merge.keys, (k) => {
                        return (_openBlock(), _createElementBlock("span", {
                          key: k,
                          class: "chip"
                        }, _toDisplayString(_ctx.fieldTag(k)), 1 /* TEXT */))
                      }), 128 /* KEYED_FRAGMENT */))
                    ]),
                    _createElementVNode("label", _hoisted_283, [
                      _withDirectives(_createElementVNode("input", {
                        type: "radio",
                        value: false,
                        "onUpdate:modelValue": _cache[172] || (_cache[172] = $event => ((_ctx.merge.separate) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelRadio, _ctx.merge.separate]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('One document, one page per record')), 1 /* TEXT */)
                    ]),
                    _createElementVNode("label", _hoisted_284, [
                      _withDirectives(_createElementVNode("input", {
                        type: "radio",
                        value: true,
                        "onUpdate:modelValue": _cache[173] || (_cache[173] = $event => ((_ctx.merge.separate) = $event))
                      }, null, 512 /* NEED_PATCH */), [
                        [_vModelRadio, _ctx.merge.separate]
                      ]),
                      _createTextVNode(" " + _toDisplayString(_ctx.t('A separate document per record')), 1 /* TEXT */)
                    ])
                  ], 64 /* STABLE_FRAGMENT */))
            ]),
            _createElementVNode("div", _hoisted_285, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[174] || (_cache[174] = $event => (_ctx.mergeOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                disabled: !_ctx.merge.keys.length || _ctx.merge.busy,
                onClick: _cache[175] || (_cache[175] = (...args) => (_ctx.runMerge && _ctx.runMerge(...args)))
              }, _toDisplayString(_ctx.merge.busy ? _ctx.t('Working…') : _ctx.t('Merge')), 9 /* TEXT, PROPS */, _hoisted_286)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" pictures from Files "),
    (_ctx.pickerOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 6,
          class: "eb-modal-back",
          onClick: _cache[182] || (_cache[182] = $event => (_ctx.pickerOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal tall",
            onClick: _cache[181] || (_cache[181] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.image
              }, null, 8 /* PROPS */, _hoisted_287),
              _createTextVNode(" " + _toDisplayString(_ctx.t('Insert picture')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_288, [
              _createElementVNode("div", _hoisted_289, [
                _createElementVNode("button", {
                  class: "eb-btn ghost",
                  disabled: _ctx.picker.parent === null || _ctx.picker.loading,
                  onClick: _cache[178] || (_cache[178] = $event => (_ctx.pickerLoad(_ctx.picker.parent)))
                }, [
                  _createElementVNode("span", {
                    innerHTML: _ctx.icons.up
                  }, null, 8 /* PROPS */, _hoisted_291)
                ], 8 /* PROPS */, _hoisted_290),
                _createElementVNode("span", _hoisted_292, "/" + _toDisplayString(_ctx.picker.path), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_293, [
                (_ctx.picker.loading)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_294, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                (_ctx.picker.error)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_295, _toDisplayString(_ctx.picker.error), 1 /* TEXT */))
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
                    }, null, 8 /* PROPS */, _hoisted_297),
                    _createElementVNode("span", _hoisted_298, _toDisplayString(x.name), 1 /* TEXT */),
                    (!x.is_dir)
                      ? (_openBlock(), _createElementBlock("span", _hoisted_299, _toDisplayString(_ctx.size(x.size)), 1 /* TEXT */))
                      : _createCommentVNode("v-if", true)
                  ], 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_296))
                }), 128 /* KEYED_FRAGMENT */)),
                (!_ctx.picker.loading && !_ctx.picker.entries.length)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_300, _toDisplayString(_ctx.t('This folder is empty.')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true)
              ]),
              _createElementVNode("p", _hoisted_301, _toDisplayString(_ctx.t('The picture is embedded in the document itself, so it travels with the file. Large photographs are scaled down on the way in.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_302, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[179] || (_cache[179] = $event => (_ctx.pickerOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                disabled: !_ctx.picker.selected || _ctx.picker.busy,
                onClick: _cache[180] || (_cache[180] = $event => (_ctx.pickerConfirm()))
              }, _toDisplayString(_ctx.picker.busy ? _ctx.t('Loading…') : _ctx.t('Insert')), 9 /* TEXT, PROPS */, _hoisted_303)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" typeface picker "),
    (_ctx.fontsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 7,
          class: "eb-modal-back",
          onClick: _cache[191] || (_cache[191] = (...args) => (_ctx.closeFonts && _ctx.closeFonts(...args)))
        }, [
          _createElementVNode("div", {
            class: "eb-modal tall",
            onClick: _cache[190] || (_cache[190] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, [
              _createElementVNode("span", {
                innerHTML: _ctx.icons.text
              }, null, 8 /* PROPS */, _hoisted_304),
              _createTextVNode(" " + _toDisplayString(_ctx.t('Typeface')) + " — " + _toDisplayString(_ctx.fontRoleLabel), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_305, [
              _createElementVNode("div", _hoisted_306, [
                _createElementVNode("span", {
                  innerHTML: _ctx.icons.search
                }, null, 8 /* PROPS */, _hoisted_307),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[183] || (_cache[183] = $event => ((_ctx.fontQuery) = $event)),
                  onInput: _cache[184] || (_cache[184] = $event => (_ctx.fontPage = 1)),
                  placeholder: _ctx.t('Search Google Fonts…')
                }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_308), [
                  [_vModelText, _ctx.fontQuery]
                ])
              ]),
              _createElementVNode("div", _hoisted_309, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontCats, (c) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: c.key,
                    class: _normalizeClass(["chip", { on: _ctx.fontCat === c.key }]),
                    onClick: $event => {_ctx.fontCat = c.key; _ctx.fontPage = 1}
                  }, _toDisplayString(c.label), 11 /* TEXT, CLASS, PROPS */, _hoisted_310))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("div", _hoisted_311, [
                _withDirectives(_createElementVNode("select", {
                  "onUpdate:modelValue": _cache[185] || (_cache[185] = $event => ((_ctx.fontScript) = $event)),
                  onChange: _cache[186] || (_cache[186] = $event => (_ctx.fontPage = 1))
                }, [
                  _createElementVNode("option", _hoisted_312, _toDisplayString(_ctx.t('Script of this document')) + " — " + _toDisplayString(_ctx.scriptLabel(_ctx.docScript)), 1 /* TEXT */),
                  _createElementVNode("option", _hoisted_313, _toDisplayString(_ctx.t('Every script')), 1 /* TEXT */),
                  (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontScripts, (sc) => {
                    return (_openBlock(), _createElementBlock("option", {
                      key: sc,
                      value: sc
                    }, _toDisplayString(_ctx.scriptLabel(sc)), 9 /* TEXT, PROPS */, _hoisted_314))
                  }), 128 /* KEYED_FRAGMENT */))
                ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelSelect, _ctx.fontScript]
                ]),
                _createElementVNode("span", _hoisted_315, _toDisplayString(_ctx.t('{n} families', { n: _ctx.fontResults.length })), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_316, [
                _createElementVNode("button", {
                  class: _normalizeClass(["font-item", { on: !_ctx.doc.paper.fonts[_ctx.fontRole] }]),
                  onClick: _cache[187] || (_cache[187] = $event => (_ctx.chooseFont('')))
                }, [
                  _createElementVNode("span", _hoisted_317, _toDisplayString(_ctx.t('Default for this language')), 1 /* TEXT */),
                  _createElementVNode("span", _hoisted_318, _toDisplayString(_ctx.defaultFontName), 1 /* TEXT */)
                ], 2 /* CLASS */),
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.fontPageItems, (f) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: f.f,
                    class: _normalizeClass(["font-item", { on: _ctx.doc.paper.fonts[_ctx.fontRole] === f.f }]),
                    onClick: $event => (_ctx.chooseFont(f.f))
                  }, [
                    _createElementVNode("span", {
                      class: "nm",
                      style: _normalizeStyle({ fontFamily: _ctx.fontPreviewStack(f.f) })
                    }, _toDisplayString(f.f), 5 /* TEXT, STYLE */),
                    _createElementVNode("span", _hoisted_320, _toDisplayString(_ctx.catLabel(f.c)) + " · " + _toDisplayString(_ctx.t('{n} weights', { n: f.w.length })), 1 /* TEXT */)
                  ], 10 /* CLASS, PROPS */, _hoisted_319))
                }), 128 /* KEYED_FRAGMENT */)),
                (!_ctx.fontResults.length && _ctx.fontsLoading)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_321, _toDisplayString(_ctx.t('Loading…')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true),
                (!_ctx.fontResults.length && !_ctx.fontsLoading)
                  ? (_openBlock(), _createElementBlock("p", _hoisted_322, _toDisplayString(_ctx.t('No family matches that.')), 1 /* TEXT */))
                  : _createCommentVNode("v-if", true)
              ]),
              (_ctx.fontPageItems.length < _ctx.fontResults.length)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 0,
                    class: "eb-btn wide",
                    onClick: _cache[188] || (_cache[188] = $event => (_ctx.fontPage++))
                  }, _toDisplayString(_ctx.t('Show more')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createElementVNode("div", _hoisted_323, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Preview')), 1 /* TEXT */),
                _createElementVNode("div", {
                  class: "font-sample",
                  style: _normalizeStyle({ fontFamily: _ctx.fontPreviewStack(_ctx.previewFamily) })
                }, _toDisplayString(_ctx.sampleText), 5 /* TEXT, STYLE */)
              ])
            ]),
            _createElementVNode("div", _hoisted_324, [
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[189] || (_cache[189] = (...args) => (_ctx.closeFonts && _ctx.closeFonts(...args)))
              }, _toDisplayString(_ctx.t('Done')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" settings "),
    (_ctx.settingsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 8,
          class: "eb-modal-back",
          onClick: _cache[201] || (_cache[201] = $event => (_ctx.settingsOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[200] || (_cache[200] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "⚙ " + _toDisplayString(_ctx.t('Settings')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_325, [
              _createElementVNode("div", _hoisted_326, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Save documents in')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[192] || (_cache[192] = $event => ((_ctx.settings.folder) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelText, _ctx.settings.folder]
                ]),
                _createElementVNode("p", _hoisted_327, _toDisplayString(_ctx.t('A folder in your own Files. Documents already saved elsewhere stay where they are.')), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_328, [
                _createElementVNode("div", _hoisted_329, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Theme')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[193] || (_cache[193] = $event => ((_ctx.settings.theme) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_330, _toDisplayString(_ctx.t('Follow Nextcloud')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_331, _toDisplayString(_ctx.t('Light')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_332, _toDisplayString(_ctx.t('Dark')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.settings.theme]
                  ])
                ]),
                _createElementVNode("div", _hoisted_333, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Language')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[194] || (_cache[194] = $event => ((_ctx.settings.language) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_334, _toDisplayString(_ctx.t('Follow Nextcloud')), 1 /* TEXT */),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.settings.languages, (l) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: l.code,
                        value: l.code
                      }, _toDisplayString(l.name), 9 /* TEXT, PROPS */, _hoisted_335))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.settings.language]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_336, [
                _createElementVNode("label", _hoisted_337, [
                  _createElementVNode("input", {
                    type: "checkbox",
                    checked: _ctx.spellcheck,
                    onChange: _cache[195] || (_cache[195] = (...args) => (_ctx.toggleSpellcheck && _ctx.toggleSpellcheck(...args)))
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_338),
                  _createTextVNode(" " + _toDisplayString(_ctx.t('Check spelling while typing')), 1 /* TEXT */)
                ]),
                _createElementVNode("label", _hoisted_339, [
                  _createElementVNode("input", {
                    type: "checkbox",
                    checked: _ctx.autolink,
                    onChange: _cache[196] || (_cache[196] = (...args) => (_ctx.toggleAutolink && _ctx.toggleAutolink(...args)))
                  }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_340),
                  _createTextVNode(" " + _toDisplayString(_ctx.t('Turn an address into a link as it is typed')), 1 /* TEXT */)
                ]),
                _createElementVNode("p", _hoisted_341, _toDisplayString(_ctx.t('Spelling is checked by the browser itself, in the language it is set to. Shift+right-click reaches its suggestions.')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_342, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[197] || (_cache[197] = $event => ((_ctx.autosave) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.autosave]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Save automatically while typing')), 1 /* TEXT */)
              ])
            ]),
            _createElementVNode("div", _hoisted_343, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[198] || (_cache[198] = $event => (_ctx.settingsOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[199] || (_cache[199] = (...args) => (_ctx.saveSettings && _ctx.saveSettings(...args)))
              }, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the file itself "),
    (_ctx.sourceOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 9,
          class: "eb-modal-back",
          onClick: _cache[204] || (_cache[204] = $event => (_ctx.sourceOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(860px,100%)"},
            onClick: _cache[203] || (_cache[203] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "</> " + _toDisplayString(_ctx.t('View the HTML')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_344, [
              _createElementVNode("p", _hoisted_345, _toDisplayString(_ctx.t('This is exactly what is stored in Files — one file, styles included, nothing else needed to open it.')), 1 /* TEXT */),
              _createElementVNode("textarea", {
                rows: "18",
                spellcheck: "false",
                readonly: "",
                value: _ctx.source,
                style: {"width":"100%","font-family":"monospace","font-size":"12px"}
              }, null, 8 /* PROPS */, _hoisted_346)
            ]),
            _createElementVNode("div", _hoisted_347, [
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[202] || (_cache[202] = $event => (_ctx.sourceOpen = false))
              }, _toDisplayString(_ctx.t('Close')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the right button, as a word processor uses it "),
    (_ctx.ctx.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 10,
          class: "eb-ctx-back",
          onMousedown: _cache[205] || (_cache[205] = _withModifiers(() => {}, ["prevent"])),
          onClick: _cache[206] || (_cache[206] = (...args) => (_ctx.closeCtx && _ctx.closeCtx(...args))),
          onContextmenu: _cache[207] || (_cache[207] = _withModifiers((...args) => (_ctx.closeCtx && _ctx.closeCtx(...args)), ["prevent"]))
        }, null, 32 /* NEED_HYDRATION */))
      : _createCommentVNode("v-if", true),
    (_ctx.ctx.open)
      ? (_openBlock(), _createElementBlock("div", {
          key: 11,
          class: _normalizeClass(["eb-ctxmenu", { flip: _ctx.ctx.flip }]),
          style: _normalizeStyle({ left: _ctx.ctx.x + 'px', top: _ctx.ctx.y + 'px' }),
          onMousedown: _cache[275] || (_cache[275] = _withModifiers(() => {}, ["prevent"])),
          onContextmenu: _cache[276] || (_cache[276] = _withModifiers(() => {}, ["prevent"]))
        }, [
          _createElementVNode("button", {
            class: "ci",
            disabled: !_ctx.ctx.selection,
            onClick: _cache[208] || (_cache[208] = $event => (_ctx.ctxDo('cut')))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Cut')), 1 /* TEXT */),
            _hoisted_349
          ], 8 /* PROPS */, _hoisted_348),
          _createElementVNode("button", {
            class: "ci",
            disabled: !_ctx.ctx.selection,
            onClick: _cache[209] || (_cache[209] = $event => (_ctx.ctxDo('copy')))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Copy')), 1 /* TEXT */),
            _hoisted_351
          ], 8 /* PROPS */, _hoisted_350),
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[210] || (_cache[210] = $event => (_ctx.ctxDo('paste')))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Paste')), 1 /* TEXT */),
            _hoisted_352
          ]),
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[211] || (_cache[211] = $event => (_ctx.ctxDo('pasteText')))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Paste as plain text')), 1 /* TEXT */),
            _hoisted_353
          ]),
          _hoisted_354,
          (_ctx.ctx.link)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 0 }, [
                _createElementVNode("button", {
                  class: "ci",
                  onClick: _cache[212] || (_cache[212] = $event => (_ctx.ctxDo('linkOpen')))
                }, _toDisplayString(_ctx.t('Open the link')), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "ci",
                  onClick: _cache[213] || (_cache[213] = $event => (_ctx.ctxDo('link')))
                }, _toDisplayString(_ctx.t('Edit the link…')), 1 /* TEXT */),
                _createElementVNode("button", {
                  class: "ci",
                  onClick: _cache[214] || (_cache[214] = $event => (_ctx.ctxDo('linkDel')))
                }, _toDisplayString(_ctx.t('Remove the link')), 1 /* TEXT */)
              ], 64 /* STABLE_FRAGMENT */))
            : (_openBlock(), _createElementBlock("button", {
                key: 1,
                class: "ci",
                onClick: _cache[215] || (_cache[215] = $event => (_ctx.ctxDo('link')))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Hyperlink…')), 1 /* TEXT */),
                _hoisted_355
              ])),
          _hoisted_356,
          _createElementVNode("div", {
            class: "ci has-sub",
            onMouseenter: _cache[223] || (_cache[223] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
            onClick: _cache[224] || (_cache[224] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Paragraph style')), 1 /* TEXT */),
            _hoisted_357,
            _createElementVNode("div", _hoisted_358, [
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[216] || (_cache[216] = $event => (_ctx.ctxDo('block','P')))
              }, _toDisplayString(_ctx.t('Body text')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[217] || (_cache[217] = $event => (_ctx.ctxDo('block','H1')))
              }, _toDisplayString(_ctx.t('Heading 1')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[218] || (_cache[218] = $event => (_ctx.ctxDo('block','H2')))
              }, _toDisplayString(_ctx.t('Heading 2')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[219] || (_cache[219] = $event => (_ctx.ctxDo('block','H3')))
              }, _toDisplayString(_ctx.t('Heading 3')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[220] || (_cache[220] = $event => (_ctx.ctxDo('block','H4')))
              }, _toDisplayString(_ctx.t('Heading 4')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[221] || (_cache[221] = $event => (_ctx.ctxDo('block','BLOCKQUOTE')))
              }, _toDisplayString(_ctx.t('Quotation')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[222] || (_cache[222] = $event => (_ctx.ctxDo('block','PRE')))
              }, _toDisplayString(_ctx.t('Preformatted')), 1 /* TEXT */)
            ])
          ], 32 /* NEED_HYDRATION */),
          _createElementVNode("div", {
            class: "ci has-sub",
            onMouseenter: _cache[233] || (_cache[233] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
            onClick: _cache[234] || (_cache[234] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Character')), 1 /* TEXT */),
            _hoisted_359,
            _createElementVNode("div", _hoisted_360, [
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[225] || (_cache[225] = $event => (_ctx.ctxDo('inline','bold')))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Bold')), 1 /* TEXT */),
                _hoisted_361
              ]),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[226] || (_cache[226] = $event => (_ctx.ctxDo('inline','italic')))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Italic')), 1 /* TEXT */),
                _hoisted_362
              ]),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[227] || (_cache[227] = $event => (_ctx.ctxDo('inline','underline')))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Underline')), 1 /* TEXT */),
                _hoisted_363
              ]),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[228] || (_cache[228] = $event => (_ctx.ctxDo('inline','strike')))
              }, _toDisplayString(_ctx.t('Strikethrough')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[229] || (_cache[229] = $event => (_ctx.ctxDo('inline','kenten')))
              }, _toDisplayString(_ctx.t('Emphasis dots')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[230] || (_cache[230] = $event => (_ctx.ctxDo('inline','sup')))
              }, _toDisplayString(_ctx.t('Superscript')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[231] || (_cache[231] = $event => (_ctx.ctxDo('inline','sub')))
              }, _toDisplayString(_ctx.t('Subscript')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[232] || (_cache[232] = $event => (_ctx.ctxDo('inline','code')))
              }, _toDisplayString(_ctx.t('Monospaced')), 1 /* TEXT */)
            ])
          ], 32 /* NEED_HYDRATION */),
          _createElementVNode("div", {
            class: "ci has-sub",
            onMouseenter: _cache[239] || (_cache[239] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
            onClick: _cache[240] || (_cache[240] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('Alignment')), 1 /* TEXT */),
            _hoisted_364,
            _createElementVNode("div", _hoisted_365, [
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[235] || (_cache[235] = $event => (_ctx.ctxDo('align','left')))
              }, _toDisplayString(_ctx.t('Left')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[236] || (_cache[236] = $event => (_ctx.ctxDo('align','center')))
              }, _toDisplayString(_ctx.t('Centre')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[237] || (_cache[237] = $event => (_ctx.ctxDo('align','right')))
              }, _toDisplayString(_ctx.t('Right')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[238] || (_cache[238] = $event => (_ctx.ctxDo('align','justify')))
              }, _toDisplayString(_ctx.t('Justified')), 1 /* TEXT */)
            ])
          ], 32 /* NEED_HYDRATION */),
          _createElementVNode("div", {
            class: "ci has-sub",
            onMouseenter: _cache[245] || (_cache[245] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
            onClick: _cache[246] || (_cache[246] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
          }, [
            _createElementVNode("span", null, _toDisplayString(_ctx.t('List')), 1 /* TEXT */),
            _hoisted_366,
            _createElementVNode("div", _hoisted_367, [
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[241] || (_cache[241] = $event => (_ctx.ctxDo('list','UL')))
              }, _toDisplayString(_ctx.t('Bulleted list')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[242] || (_cache[242] = $event => (_ctx.ctxDo('list','OL')))
              }, _toDisplayString(_ctx.t('Numbered list')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[243] || (_cache[243] = $event => (_ctx.ctxDo('indent',1)))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Increase indent')), 1 /* TEXT */),
                _hoisted_368
              ]),
              _createElementVNode("button", {
                class: "ci",
                onClick: _cache[244] || (_cache[244] = $event => (_ctx.ctxDo('indent',-1)))
              }, [
                _createElementVNode("span", null, _toDisplayString(_ctx.t('Decrease indent')), 1 /* TEXT */),
                _hoisted_369
              ])
            ])
          ], 32 /* NEED_HYDRATION */),
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[247] || (_cache[247] = $event => (_ctx.ctxDo('para')))
          }, _toDisplayString(_ctx.t('Paragraph settings…')), 1 /* TEXT */),
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[248] || (_cache[248] = $event => (_ctx.ctxDo('chars')))
          }, _toDisplayString(_ctx.t('Special character…')), 1 /* TEXT */),
          (_ctx.ctx.table)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 2 }, [
                _hoisted_370,
                _createElementVNode("div", {
                  class: "ci has-sub",
                  onMouseenter: _cache[262] || (_cache[262] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                  onClick: _cache[263] || (_cache[263] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                }, [
                  _createElementVNode("span", null, _toDisplayString(_ctx.t('Table')), 1 /* TEXT */),
                  _hoisted_371,
                  _createElementVNode("div", _hoisted_372, [
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[249] || (_cache[249] = $event => (_ctx.ctxDo('table','rowAbove')))
                    }, _toDisplayString(_ctx.t('Insert a row above')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[250] || (_cache[250] = $event => (_ctx.ctxDo('table','rowBelow')))
                    }, _toDisplayString(_ctx.t('Insert a row below')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[251] || (_cache[251] = $event => (_ctx.ctxDo('table','colLeft')))
                    }, _toDisplayString(_ctx.t('Insert a column to the left')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[252] || (_cache[252] = $event => (_ctx.ctxDo('table','colRight')))
                    }, _toDisplayString(_ctx.t('Insert a column to the right')), 1 /* TEXT */),
                    _hoisted_373,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[253] || (_cache[253] = $event => (_ctx.ctxDo('table','rowDel')))
                    }, _toDisplayString(_ctx.t('Delete the row')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[254] || (_cache[254] = $event => (_ctx.ctxDo('table','colDel')))
                    }, _toDisplayString(_ctx.t('Delete the column')), 1 /* TEXT */),
                    _hoisted_374,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[255] || (_cache[255] = $event => (_ctx.ctxDo('merge')))
                    }, _toDisplayString(_ctx.t('Merge the cells')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[256] || (_cache[256] = $event => (_ctx.ctxDo('split')))
                    }, _toDisplayString(_ctx.t('Split the cell')), 1 /* TEXT */),
                    _hoisted_375,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[257] || (_cache[257] = $event => (_ctx.ctxDo('cellAlign','left')))
                    }, _toDisplayString(_ctx.t('Cell text left')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[258] || (_cache[258] = $event => (_ctx.ctxDo('cellAlign','center')))
                    }, _toDisplayString(_ctx.t('Cell text centred')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[259] || (_cache[259] = $event => (_ctx.ctxDo('cellAlign','right')))
                    }, _toDisplayString(_ctx.t('Cell text right')), 1 /* TEXT */),
                    _hoisted_376,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[260] || (_cache[260] = $event => (_ctx.ctxDo('table','header')))
                    }, _toDisplayString(_ctx.t('Header row')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[261] || (_cache[261] = $event => (_ctx.ctxDo('table','delete')))
                    }, _toDisplayString(_ctx.t('Delete the table')), 1 /* TEXT */)
                  ])
                ], 32 /* NEED_HYDRATION */)
              ], 64 /* STABLE_FRAGMENT */))
            : _createCommentVNode("v-if", true),
          (_ctx.ctx.image)
            ? (_openBlock(), _createElementBlock(_Fragment, { key: 3 }, [
                _hoisted_377,
                _createElementVNode("div", {
                  class: "ci has-sub",
                  onMouseenter: _cache[272] || (_cache[272] = (...args) => (_ctx.placeFly && _ctx.placeFly(...args))),
                  onClick: _cache[273] || (_cache[273] = (...args) => (_ctx.toggleFly && _ctx.toggleFly(...args)))
                }, [
                  _createElementVNode("span", null, _toDisplayString(_ctx.t('Picture')), 1 /* TEXT */),
                  _hoisted_378,
                  _createElementVNode("div", _hoisted_379, [
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[264] || (_cache[264] = $event => (_ctx.ctxDo('image','eb-img-s')))
                    }, _toDisplayString(_ctx.t('Small')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[265] || (_cache[265] = $event => (_ctx.ctxDo('image','eb-img-m')))
                    }, _toDisplayString(_ctx.t('Medium')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[266] || (_cache[266] = $event => (_ctx.ctxDo('image','eb-img-l')))
                    }, _toDisplayString(_ctx.t('Large')), 1 /* TEXT */),
                    _hoisted_380,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[267] || (_cache[267] = $event => (_ctx.ctxDo('float','')))
                    }, _toDisplayString(_ctx.t('No text wrap')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[268] || (_cache[268] = $event => (_ctx.ctxDo('float','left')))
                    }, _toDisplayString(_ctx.t('Wrap text on the right')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[269] || (_cache[269] = $event => (_ctx.ctxDo('float','right')))
                    }, _toDisplayString(_ctx.t('Wrap text on the left')), 1 /* TEXT */),
                    _hoisted_381,
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[270] || (_cache[270] = $event => (_ctx.ctxDo('alt')))
                    }, _toDisplayString(_ctx.t('Alternative text…')), 1 /* TEXT */),
                    _createElementVNode("button", {
                      class: "ci",
                      onClick: _cache[271] || (_cache[271] = $event => (_ctx.ctxDo('imageDel')))
                    }, _toDisplayString(_ctx.t('Delete the picture')), 1 /* TEXT */)
                  ])
                ], 32 /* NEED_HYDRATION */)
              ], 64 /* STABLE_FRAGMENT */))
            : _createCommentVNode("v-if", true),
          _hoisted_382,
          _createElementVNode("button", {
            class: "ci",
            onClick: _cache[274] || (_cache[274] = $event => (_ctx.ctxDo('clear')))
          }, _toDisplayString(_ctx.t('Clear formatting')), 1 /* TEXT */)
        ], 38 /* CLASS, STYLE, NEED_HYDRATION */))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" paragraph properties, written as inline styles so the file carries them "),
    (_ctx.paraOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 12,
          class: "eb-modal-back",
          onClick: _cache[291] || (_cache[291] = $event => (_ctx.paraOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(580px,100%)"},
            onClick: _cache[290] || (_cache[290] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Paragraph settings…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_383, [
              _createElementVNode("div", _hoisted_384, [
                _createElementVNode("div", _hoisted_385, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Alignment')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[277] || (_cache[277] = $event => ((_ctx.para.align) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_386, _toDisplayString(_ctx.t('Unchanged')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_387, _toDisplayString(_ctx.t('Left')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_388, _toDisplayString(_ctx.t('Centre')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_389, _toDisplayString(_ctx.t('Right')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_390, _toDisplayString(_ctx.t('Justified')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.para.align]
                  ])
                ]),
                _createElementVNode("div", _hoisted_391, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Line height')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "4",
                    step: "0.05",
                    "onUpdate:modelValue": _cache[278] || (_cache[278] = $event => ((_ctx.para.lineHeight) = $event)),
                    placeholder: _ctx.t('From the paper setup')
                  }, null, 8 /* PROPS */, _hoisted_392), [
                    [_vModelText, _ctx.para.lineHeight]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_393, [
                _createElementVNode("div", _hoisted_394, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space above (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[279] || (_cache[279] = $event => ((_ctx.para.before) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.before]
                  ])
                ]),
                _createElementVNode("div", _hoisted_395, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Space below (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[280] || (_cache[280] = $event => ((_ctx.para.after) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.after]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_396, [
                _createElementVNode("div", _hoisted_397, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Indent left (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-100",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[281] || (_cache[281] = $event => ((_ctx.para.left) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.left]
                  ])
                ]),
                _createElementVNode("div", _hoisted_398, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Indent right (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-100",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[282] || (_cache[282] = $event => ((_ctx.para.right) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.right]
                  ])
                ]),
                _createElementVNode("div", _hoisted_399, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('First line (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "-100",
                    max: "200",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[283] || (_cache[283] = $event => ((_ctx.para.firstLine) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [_vModelText, _ctx.para.firstLine]
                  ])
                ])
              ]),
              _createElementVNode("label", _hoisted_400, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[284] || (_cache[284] = $event => ((_ctx.para.pageBefore) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.para.pageBefore]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Start a new page before this paragraph')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_401, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[285] || (_cache[285] = $event => ((_ctx.para.keepWithNext) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.para.keepWithNext]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Keep with the next paragraph')), 1 /* TEXT */)
              ]),
              _createElementVNode("label", _hoisted_402, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[286] || (_cache[286] = $event => ((_ctx.para.keepTogether) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.para.keepTogether]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Do not split this paragraph across pages')), 1 /* TEXT */)
              ]),
              _createElementVNode("p", _hoisted_403, _toDisplayString(_ctx.t('Empty means the paragraph inherits from the paper setup. These are written into the file as ordinary CSS, so a browser prints them the same way.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_404, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[287] || (_cache[287] = (...args) => (_ctx.clearPara && _ctx.clearPara(...args)))
              }, _toDisplayString(_ctx.t('Reset')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[288] || (_cache[288] = $event => (_ctx.paraOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[289] || (_cache[289] = (...args) => (_ctx.applyPara && _ctx.applyPara(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" a table of contents, as links rather than page numbers "),
    (_ctx.tocOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 13,
          class: "eb-modal-back",
          onClick: _cache[297] || (_cache[297] = $event => (_ctx.tocOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(520px,100%)"},
            onClick: _cache[296] || (_cache[296] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Table of contents…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_405, [
              _createElementVNode("div", _hoisted_406, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Title')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[292] || (_cache[292] = $event => ((_ctx.tocTitle) = $event)),
                  onKeydown: _cache[293] || (_cache[293] = _withKeys(_withModifiers((...args) => (_ctx.applyToc && _ctx.applyToc(...args)), ["prevent"]), ["enter"]))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelText, _ctx.tocTitle]
                ])
              ]),
              _createElementVNode("p", _hoisted_407, _toDisplayString(_ctx.t('Built from the headings in the document, as links to them. Running it again brings an existing contents list up to date.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_408, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[294] || (_cache[294] = $event => (_ctx.tocOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[295] || (_cache[295] = (...args) => (_ctx.applyToc && _ctx.applyToc(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" characters that are awkward to type "),
    (_ctx.charsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 14,
          class: "eb-modal-back",
          onClick: _cache[300] || (_cache[300] = $event => (_ctx.charsOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(620px,100%)"},
            onClick: _cache[299] || (_cache[299] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Special character…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_409, [
              _createElementVNode("div", _hoisted_410, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.charSets, (c) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: c.key,
                    class: _normalizeClass(["chip", { on: _ctx.charSet === c.key }]),
                    onClick: $event => (_ctx.charSet = c.key)
                  }, _toDisplayString(_ctx.t(c.key)), 11 /* TEXT, CLASS, PROPS */, _hoisted_411))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("div", _hoisted_412, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.charsOf(_ctx.charSet), (ch, i) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: i,
                    class: "eb-charcell",
                    onClick: $event => (_ctx.pickChar(ch))
                  }, _toDisplayString(ch), 9 /* TEXT, PROPS */, _hoisted_413))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("p", _hoisted_414, _toDisplayString(_ctx.t('The character goes in at the caret. The dialog stays open so several can be picked.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_415, [
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[298] || (_cache[298] = $event => (_ctx.charsOpen = false))
              }, _toDisplayString(_ctx.t('Close')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" a hyperlink "),
    (_ctx.linkOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 15,
          class: "eb-modal-back",
          onClick: _cache[308] || (_cache[308] = $event => (_ctx.linkOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(520px,100%)"},
            onClick: _cache[307] || (_cache[307] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.link.editing ? _ctx.t('Edit the link…') : _ctx.t('Hyperlink…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_416, [
              _createElementVNode("div", _hoisted_417, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Text')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[301] || (_cache[301] = $event => ((_ctx.link.text) = $event)),
                  placeholder: _ctx.t('The words that carry the link')
                }, null, 8 /* PROPS */, _hoisted_418), [
                  [_vModelText, _ctx.link.text]
                ])
              ]),
              _createElementVNode("div", _hoisted_419, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Address')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[302] || (_cache[302] = $event => ((_ctx.link.url) = $event)),
                  placeholder: "example.org/page",
                  onKeydown: _cache[303] || (_cache[303] = _withKeys(_withModifiers((...args) => (_ctx.applyLinkDialog && _ctx.applyLinkDialog(...args)), ["prevent"]), ["enter"]))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelText, _ctx.link.url]
                ])
              ]),
              _createElementVNode("p", _hoisted_420, _toDisplayString(_ctx.t('A bare address becomes https://, and an e-mail address becomes a mailto: link.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_421, [
              (_ctx.link.editing)
                ? (_openBlock(), _createElementBlock("button", {
                    key: 0,
                    class: "eb-btn ghost",
                    onClick: _cache[304] || (_cache[304] = $event => {_ctx.linkOpen = false; _ctx.ctxDo('linkDel')})
                  }, _toDisplayString(_ctx.t('Remove the link')), 1 /* TEXT */))
                : _createCommentVNode("v-if", true),
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[305] || (_cache[305] = $event => (_ctx.linkOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[306] || (_cache[306] = (...args) => (_ctx.applyLinkDialog && _ctx.applyLinkDialog(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" what a reader hears in place of the picture "),
    (_ctx.altOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 16,
          class: "eb-modal-back",
          onClick: _cache[314] || (_cache[314] = $event => (_ctx.altOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(520px,100%)"},
            onClick: _cache[313] || (_cache[313] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, _toDisplayString(_ctx.t('Alternative text…')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_422, [
              _createElementVNode("div", _hoisted_423, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Alternative text')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[309] || (_cache[309] = $event => ((_ctx.altText) = $event)),
                  onKeydown: _cache[310] || (_cache[310] = _withKeys(_withModifiers((...args) => (_ctx.applyAlt && _ctx.applyAlt(...args)), ["prevent"]), ["enter"]))
                }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                  [_vModelText, _ctx.altText]
                ])
              ]),
              _createElementVNode("p", _hoisted_424, _toDisplayString(_ctx.t('This is what a screen reader says, and what shows if the picture cannot be loaded. It is written into the file as the alt attribute.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_425, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[311] || (_cache[311] = $event => (_ctx.altOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[312] || (_cache[312] = (...args) => (_ctx.applyAlt && _ctx.applyAlt(...args)))
              }, _toDisplayString(_ctx.t('Apply')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    (_ctx.toast)
      ? (_openBlock(), _createElementBlock("div", _hoisted_426, _toDisplayString(_ctx.toast), 1 /* TEXT */))
      : _createCommentVNode("v-if", true)
  ]))
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
        ctx: { open: false, x: 0, y: 0, flip: false, table: false, image: false, link: false, list: false, selection: false },
        paraOpen: false,
        para: { align: '', lineHeight: '', before: '', after: '', left: '', right: '', firstLine: '', pageBefore: false, keepWithNext: false, keepTogether: false },
        charsOpen: false,
        charSets: CHAR_SETS,
        charSet: 'Punctuation',
        tocOpen: false,
        tocTitle: '',
        spellcheck: false,
        autolink: true,
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
        if (this.narrow) { this.sideOpen = false; }
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
        clone.querySelectorAll('.eb-pagespacer').forEach((el) => el.remove());
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
      /**
       * Lay the text over the sheets and keep the right number of sheets under it.
       * Runs on the next frame so the measurements are of the layout as it now is,
       * and once more afterwards because adding a sheet can change what fits.
       */
      repaginate() {
        if (!canvas()) { return; }
        clearTimeout(this._pageTimer);
        this._pageTimer = setTimeout(() => {
          const pages = paginate();
          if (pages !== this.pageCount) {
            this.pageCount = pages;
            this.$nextTick(() => { this.pageCount = paginate(); });
          }
        }, 60);
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
      stepSize(d) {
        const next = Math.min(36, Math.max(6, Math.round((Number(this.doc.paper.fontSize) + d) * 2) / 2));
        this.doc.paper.fontSize = next;
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
        this.ctx.link = !!linkAt(at);
        this.ctx.list = !!(topBlockOf(at) && closestMatching(at, { tag: 'LI' }));
        this.ctx.selection = !!(range && !range.collapsed);
        // Keep the whole menu on screen; its own height is capped in the stylesheet.
        this.ctx.flip = e.clientX > window.innerWidth - 500;
        this.ctx.x = Math.max(6, Math.min(e.clientX, window.innerWidth - 250));
        this.ctx.y = Math.max(6, Math.min(e.clientY, window.innerHeight - 430));
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
        };
        if (acts[kind]) { acts[kind](); }
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
        this.run(() => setParagraphProps(v));
        this.repaginate();
      },
      clearPara() {
        this.para = { align: '', lineHeight: '', before: '', after: '', left: '', right: '', firstLine: '', pageBefore: false, keepWithNext: false, keepTogether: false };
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

      // ---- narrow screens ------------------------------------------------------
      /**
       * A phone has no room for a sidebar beside the page, so it becomes a drawer
       * that starts closed; and an A4 page is wider than the screen, so the zoom
       * starts at whatever makes it fit.
       */
      measureWidth() {
        const narrow = window.innerWidth <= 860;
        const became = narrow && !this.narrow;
        this.narrow = narrow;
        if (became) { this.sideOpen = false; }
        if (!narrow && !this.sideOpen && window.innerWidth > 1100) { this.sideOpen = true; }
        this.fitZoom();
      },
      fitZoom() {
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
      guides() { this.$nextTick(() => this.repaginate()); },
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
      const sp = window.localStorage.getItem('eb-spellcheck');
      if (sp != null) { this.spellcheck = sp === '1'; }
      const al = window.localStorage.getItem('eb-autolink');
      if (al != null) { this.autolink = al === '1'; }
      const g = window.localStorage.getItem('eb-guides');
      if (g != null) { this.guides = g === '1'; }
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
      c.addEventListener('contextmenu', (e) => this.openCtx(e));
      // Safari on a phone does not always raise contextmenu, so a long press on
      // the page opens the same menu: half a second, without the finger moving.
      let holdTimer = null;
      let holdAt = null;
      const cancelHold = () => { window.clearTimeout(holdTimer); holdTimer = null; };
      c.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) { return cancelHold(); }
        const t = e.touches[0];
        holdAt = { x: t.clientX, y: t.clientY };
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
      c.addEventListener('touchcancel', cancelHold, { passive: true });
      c.addEventListener('dragstart', () => this.onDragStart());
      c.addEventListener('dragover', (e) => this.onDragOver(e));
      c.addEventListener('drop', (e) => this.onDrop(e));
      c.addEventListener('dragend', () => this.onDragEnd());
      window.addEventListener('resize', () => { this.closeCtx(); this.measureWidth(); });
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

  if (document.getElementById('editbase-root')) {
    app.mount('#editbase-root');
  }
})();
