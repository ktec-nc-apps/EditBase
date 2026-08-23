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
  const DEFAULT_PAPER = { size: 'A4', orientation: 'portrait', margin: { top: 25, right: 20, bottom: 25, left: 20 }, font: 'serif', fontSize: 10.5 };

  function normalisePaper(p) {
    const out = JSON.parse(JSON.stringify(DEFAULT_PAPER));
    if (!p || typeof p !== 'object') { return out; }
    if (PAPERS[p.size]) { out.size = p.size; }
    if (p.orientation === 'landscape') { out.orientation = 'landscape'; }
    if (p.font === 'sans') { out.font = 'sans'; }
    const fs = Number(p.fontSize);
    if (fs >= 6 && fs <= 36) { out.fontSize = fs; }
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

  // ---- the document stylesheet ----------------------------------------------
  // Written into every saved file *and* applied to the editor canvas, so the
  // editor cannot drift from the artefact. Everything is scoped to .eb-doc: in a
  // saved file that class sits on <body>, in the editor it sits on the canvas.
  const DOC_CSS = `
.eb-doc {
  font-family: "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Times New Roman", serif;
  font-size: 10.5pt; line-height: 1.75; color: #111111; text-align: justify;
  word-break: normal; overflow-wrap: anywhere; hyphens: auto;
}
.eb-doc.font-sans {
  font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif;
}
.eb-doc > *:first-child { margin-top: 0; }
.eb-doc p { margin: 0 0 0.9em; }
.eb-doc h1, .eb-doc h2, .eb-doc h3, .eb-doc h4, .eb-doc h5, .eb-doc h6 {
  font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif;
  line-height: 1.4; margin: 1.6em 0 0.7em; break-after: avoid-page; text-align: left;
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
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: .92em;
  background: #f4f4f4; border: .75pt solid #d5d5d5; border-radius: 4pt; padding: .7em .9em;
  overflow-x: auto; white-space: pre-wrap; break-inside: avoid;
}
.eb-doc code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: .92em; }
.eb-doc a { color: #14509b; }
.eb-doc hr { border: none; border-top: .75pt solid #999; margin: 1.4em 0; }
.eb-doc hr.eb-rule-thick { border-top-width: 2pt; }
.eb-doc hr.eb-rule-dashed { border-top-style: dashed; }
.eb-doc img { max-width: 100%; height: auto; }
.eb-doc figure { margin: 1.2em 0; text-align: center; break-inside: avoid; }
.eb-doc figcaption { font-size: .88em; color: #444; margin-top: .4em; }

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
    const size = 'html { background: #ffffff; }\nbody.eb-doc { margin: 0; font-size: ' + paper.fontSize + 'pt; }\n' +
      '@media screen { body.eb-doc { max-width: ' + (sheet(paper).w - paper.margin.left - paper.margin.right) + 'mm; margin: ' + paper.margin.top + 'mm auto ' + paper.margin.bottom + 'mm; padding: 0 8px; } }';
    return '<!DOCTYPE html>\n'
      + '<html lang="' + escapeAttr(lang) + '">\n<head>\n'
      + '<meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      + '<meta name="generator" content="EditBase ' + escapeAttr(APP_VERSION) + '">\n'
      + '<meta name="editbase-paper" content="' + escapeAttr(JSON.stringify(paper)) + '">\n'
      + '<title>' + escapeAttr(doc.title || 'Document') + '</title>\n'
      + '<style>\n' + pageRule(paper) + '\n' + size + '\n' + DOC_CSS + '</style>\n'
      + '</head>\n<body class="eb-doc' + (paper.font === 'sans' ? ' font-sans' : '') + '">\n'
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
      last = insertBlockNode(node);
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
  function normaliseCanvas(pageBreakLabel) {
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
  function command(fn, pageBreakLabel) {
    if (!canvas()) { return; }
    history.push(true);
    try {
      fn();
    } finally {
      normaliseCanvas(pageBreakLabel);
      history.lastPush = Date.now();
    }
  }

  // ---- what is switched on at the caret ------------------------------------------
  function activeFormats() {
    const state = { block: '', align: '', list: '' };
    Object.keys(INLINE_SPECS).forEach((k) => { state[k] = false; });
    const range = getRange();
    if (!range) { return state; }
    const start = range.startContainer;
    Object.keys(INLINE_SPECS).forEach((k) => {
      state[k] = !!closestMatching(start, INLINE_SPECS[k]);
    });
    const block = topBlockOf(start);
    if (block) {
      state.block = block.nodeName === 'UL' || block.nodeName === 'OL' ? 'P' : block.nodeName;
      state.list = block.nodeName === 'UL' || block.nodeName === 'OL' ? block.nodeName : '';
      ['eb-al-l', 'eb-al-c', 'eb-al-r', 'eb-al-j'].forEach((c) => {
        if (block.classList && block.classList.contains(c)) { state.align = c; }
      });
      if (block.nodeName === 'LI' && block.parentNode) { state.list = block.parentNode.nodeName; }
    }
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

  // Precompiled render function (eval-free). Source template lives in editbase.js;
  // regenerate with regibase-build/editbase-build.mjs after editing the template.
  const render = (function () {
const { createElementVNode: _createElementVNode, toDisplayString: _toDisplayString, openBlock: _openBlock, createElementBlock: _createElementBlock, createCommentVNode: _createCommentVNode, renderList: _renderList, Fragment: _Fragment, normalizeClass: _normalizeClass, vModelText: _vModelText, withDirectives: _withDirectives, withModifiers: _withModifiers, normalizeStyle: _normalizeStyle, vModelSelect: _vModelSelect, vModelCheckbox: _vModelCheckbox, createTextVNode: _createTextVNode } = Vue

const _hoisted_1 = { class: "eb-shell" }
const _hoisted_2 = { class: "brand" }
const _hoisted_3 = ["innerHTML"]
const _hoisted_4 = /*#__PURE__*/_createElementVNode("span", { class: "name" }, "EditBase", -1 /* HOISTED */)
const _hoisted_5 = { class: "ver" }
const _hoisted_6 = { class: "side-actions" }
const _hoisted_7 = { class: "eb-doclist" }
const _hoisted_8 = {
  key: 0,
  class: "hint"
}
const _hoisted_9 = ["onClick"]
const _hoisted_10 = { class: "t" }
const _hoisted_11 = { class: "m" }
const _hoisted_12 = { class: "side-foot" }
const _hoisted_13 = { class: "eb-main" }
const _hoisted_14 = { class: "eb-topbar" }
const _hoisted_15 = ["title"]
const _hoisted_16 = ["placeholder", "disabled"]
const _hoisted_17 = ["disabled"]
const _hoisted_18 = ["disabled"]
const _hoisted_19 = ["title"]
const _hoisted_20 = {
  class: "body",
  style: {"display":"flex","flex-direction":"column","gap":"6px","padding-bottom":"16px"}
}
const _hoisted_21 = {
  key: 0,
  class: "eb-toolbar"
}
const _hoisted_22 = ["value", "title"]
const _hoisted_23 = { value: "P" }
const _hoisted_24 = { value: "H1" }
const _hoisted_25 = { value: "H2" }
const _hoisted_26 = { value: "H3" }
const _hoisted_27 = { value: "H4" }
const _hoisted_28 = { value: "BLOCKQUOTE" }
const _hoisted_29 = { value: "PRE" }
const _hoisted_30 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_31 = ["title"]
const _hoisted_32 = /*#__PURE__*/_createElementVNode("span", { class: "b" }, "B", -1 /* HOISTED */)
const _hoisted_33 = [
  _hoisted_32
]
const _hoisted_34 = ["title"]
const _hoisted_35 = /*#__PURE__*/_createElementVNode("span", { class: "i" }, "I", -1 /* HOISTED */)
const _hoisted_36 = [
  _hoisted_35
]
const _hoisted_37 = ["title"]
const _hoisted_38 = /*#__PURE__*/_createElementVNode("span", { class: "u" }, "U", -1 /* HOISTED */)
const _hoisted_39 = [
  _hoisted_38
]
const _hoisted_40 = ["title"]
const _hoisted_41 = /*#__PURE__*/_createElementVNode("span", { class: "s" }, "S", -1 /* HOISTED */)
const _hoisted_42 = [
  _hoisted_41
]
const _hoisted_43 = ["title"]
const _hoisted_44 = ["title"]
const _hoisted_45 = ["title"]
const _hoisted_46 = ["title"]
const _hoisted_47 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_48 = ["title"]
const _hoisted_49 = ["onClick", "title"]
const _hoisted_50 = ["title"]
const _hoisted_51 = /*#__PURE__*/_createElementVNode("span", { style: {"pointer-events":"none"} }, "🎨", -1 /* HOISTED */)
const _hoisted_52 = ["value"]
const _hoisted_53 = ["title"]
const _hoisted_54 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_55 = ["title"]
const _hoisted_56 = ["title"]
const _hoisted_57 = ["onClick", "title"]
const _hoisted_58 = ["title"]
const _hoisted_59 = ["title"]
const _hoisted_60 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_61 = ["title"]
const _hoisted_62 = ["title"]
const _hoisted_63 = ["onClick", "title"]
const _hoisted_64 = ["title"]
const _hoisted_65 = ["onClick", "title"]
const _hoisted_66 = ["title"]
const _hoisted_67 = ["title"]
const _hoisted_68 = ["title"]
const _hoisted_69 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_70 = ["title"]
const _hoisted_71 = ["title"]
const _hoisted_72 = /*#__PURE__*/_createElementVNode("span", { class: "sep" }, null, -1 /* HOISTED */)
const _hoisted_73 = ["title"]
const _hoisted_74 = {
  class: "state",
  style: {"margin-left":"auto"}
}
const _hoisted_75 = { class: "eb-desk" }
const _hoisted_76 = { class: "eb-paperwrap" }
const _hoisted_77 = { class: "body" }
const _hoisted_78 = { class: "eb-row" }
const _hoisted_79 = { class: "eb-field" }
const _hoisted_80 = ["value"]
const _hoisted_81 = { class: "eb-field" }
const _hoisted_82 = { value: "portrait" }
const _hoisted_83 = { value: "landscape" }
const _hoisted_84 = { class: "eb-row" }
const _hoisted_85 = { class: "eb-field" }
const _hoisted_86 = { class: "eb-field" }
const _hoisted_87 = { class: "eb-field" }
const _hoisted_88 = { class: "eb-field" }
const _hoisted_89 = { class: "eb-row" }
const _hoisted_90 = { class: "eb-field" }
const _hoisted_91 = { value: "serif" }
const _hoisted_92 = { value: "sans" }
const _hoisted_93 = { class: "eb-field" }
const _hoisted_94 = { class: "eb-note" }
const _hoisted_95 = { class: "foot" }
const _hoisted_96 = { class: "body" }
const _hoisted_97 = { class: "eb-row" }
const _hoisted_98 = { class: "eb-field" }
const _hoisted_99 = { class: "eb-field" }
const _hoisted_100 = { class: "eb-field" }
const _hoisted_101 = { value: "" }
const _hoisted_102 = { value: "rows" }
const _hoisted_103 = { value: "borderless" }
const _hoisted_104 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_105 = { class: "foot" }
const _hoisted_106 = { class: "body" }
const _hoisted_107 = { style: {"display":"flex","flex-wrap":"wrap","gap":"6px","margin-bottom":"8px"} }
const _hoisted_108 = ["onClick"]
const _hoisted_109 = { class: "eb-field" }
const _hoisted_110 = /*#__PURE__*/_createElementVNode("label", null, "MathML", -1 /* HOISTED */)
const _hoisted_111 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_112 = { class: "eb-field" }
const _hoisted_113 = ["innerHTML"]
const _hoisted_114 = { class: "eb-note" }
const _hoisted_115 = { class: "foot" }
const _hoisted_116 = { class: "body" }
const _hoisted_117 = { class: "eb-field" }
const _hoisted_118 = { class: "eb-note" }
const _hoisted_119 = { class: "eb-row" }
const _hoisted_120 = { class: "eb-field" }
const _hoisted_121 = { value: "auto" }
const _hoisted_122 = { value: "light" }
const _hoisted_123 = { value: "dark" }
const _hoisted_124 = { class: "eb-field" }
const _hoisted_125 = { value: "auto" }
const _hoisted_126 = ["value"]
const _hoisted_127 = { style: {"display":"flex","gap":"8px","align-items":"center"} }
const _hoisted_128 = { class: "foot" }
const _hoisted_129 = { class: "body" }
const _hoisted_130 = { class: "eb-note" }
const _hoisted_131 = ["value"]
const _hoisted_132 = { class: "foot" }
const _hoisted_133 = {
  key: 5,
  class: "eb-toast"
}

return function render(_ctx, _cache) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, [
    _createElementVNode("aside", {
      class: _normalizeClass(["eb-side", { hidden: !_ctx.sideOpen }])
    }, [
      _createElementVNode("div", _hoisted_2, [
        _createElementVNode("span", {
          class: "logo",
          innerHTML: _ctx.logo
        }, null, 8 /* PROPS */, _hoisted_3),
        _hoisted_4,
        _createElementVNode("span", _hoisted_5, _toDisplayString(_ctx.version), 1 /* TEXT */)
      ]),
      _createElementVNode("div", _hoisted_6, [
        _createElementVNode("button", {
          class: "eb-btn primary wide",
          onClick: _cache[0] || (_cache[0] = (...args) => (_ctx.newDoc && _ctx.newDoc(...args)))
        }, "＋ " + _toDisplayString(_ctx.t('New document')), 1 /* TEXT */)
      ]),
      _createElementVNode("div", _hoisted_7, [
        (!_ctx.docs.length)
          ? (_openBlock(), _createElementBlock("p", _hoisted_8, _toDisplayString(_ctx.t('No documents yet. Everything you write here is saved to {folder} in your Files as a plain .html file.', { folder: _ctx.settings.folder })), 1 /* TEXT */))
          : _createCommentVNode("v-if", true),
        (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.docs, (d) => {
          return (_openBlock(), _createElementBlock("button", {
            key: d.id,
            class: _normalizeClass(["eb-docitem", { active: d.id === _ctx.doc.id }]),
            onClick: $event => (_ctx.openDoc(d.id))
          }, [
            _createElementVNode("span", _hoisted_10, _toDisplayString(d.title), 1 /* TEXT */),
            _createElementVNode("span", _hoisted_11, _toDisplayString(_ctx.when(d.mtime)) + " · " + _toDisplayString(_ctx.size(d.size)), 1 /* TEXT */)
          ], 10 /* CLASS, PROPS */, _hoisted_9))
        }), 128 /* KEYED_FRAGMENT */))
      ]),
      _createElementVNode("div", _hoisted_12, [
        _createElementVNode("button", {
          class: "eb-btn ghost wide",
          onClick: _cache[1] || (_cache[1] = $event => (_ctx.paperOpen = true))
        }, "🖹 " + _toDisplayString(_ctx.t('Paper setup')), 1 /* TEXT */),
        _createElementVNode("button", {
          class: "eb-btn ghost wide",
          onClick: _cache[2] || (_cache[2] = $event => (_ctx.settingsOpen = true))
        }, "⚙ " + _toDisplayString(_ctx.t('Settings')), 1 /* TEXT */)
      ])
    ], 2 /* CLASS */),
    _createElementVNode("section", _hoisted_13, [
      _createElementVNode("div", _hoisted_14, [
        _createElementVNode("button", {
          class: "eb-tb",
          onClick: _cache[3] || (_cache[3] = $event => (_ctx.sideOpen = !_ctx.sideOpen)),
          title: _ctx.t('Documents')
        }, "☰", 8 /* PROPS */, _hoisted_15),
        _withDirectives(_createElementVNode("input", {
          class: "title-input",
          "onUpdate:modelValue": _cache[4] || (_cache[4] = $event => ((_ctx.doc.title) = $event)),
          placeholder: _ctx.t('Untitled document'),
          onChange: _cache[5] || (_cache[5] = (...args) => (_ctx.applyTitle && _ctx.applyTitle(...args))),
          disabled: !_ctx.doc.id
        }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_16), [
          [_vModelText, _ctx.doc.title]
        ]),
        _createElementVNode("span", {
          class: _normalizeClass(["state", { dirty: _ctx.dirty }])
        }, _toDisplayString(_ctx.stateText), 3 /* TEXT, CLASS */),
        _createElementVNode("button", {
          class: "eb-btn",
          onClick: _cache[6] || (_cache[6] = (...args) => (_ctx.save && _ctx.save(...args))),
          disabled: !_ctx.doc.id || _ctx.saving
        }, "💾 " + _toDisplayString(_ctx.t('Save')), 9 /* TEXT, PROPS */, _hoisted_17),
        _createElementVNode("button", {
          class: "eb-btn",
          onClick: _cache[7] || (_cache[7] = (...args) => (_ctx.printDoc && _ctx.printDoc(...args))),
          disabled: !_ctx.doc.id
        }, "🖨 " + _toDisplayString(_ctx.t('Print / PDF')), 9 /* TEXT, PROPS */, _hoisted_18),
        _createElementVNode("button", {
          class: "eb-btn ghost",
          onClick: _cache[8] || (_cache[8] = $event => (_ctx.menuOpen = !_ctx.menuOpen)),
          title: _ctx.t('More')
        }, "⋯", 8 /* PROPS */, _hoisted_19),
        (_ctx.menuOpen)
          ? (_openBlock(), _createElementBlock("div", {
              key: 0,
              class: "eb-modal-back",
              onClick: _cache[15] || (_cache[15] = $event => (_ctx.menuOpen = false))
            }, [
              _createElementVNode("div", {
                class: "eb-modal",
                style: {"width":"min(360px,100%)"},
                onClick: _cache[14] || (_cache[14] = _withModifiers(() => {}, ["stop"]))
              }, [
                _createElementVNode("h3", null, _toDisplayString(_ctx.doc.title || _ctx.t('Untitled document')), 1 /* TEXT */),
                _createElementVNode("div", _hoisted_20, [
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[9] || (_cache[9] = (...args) => (_ctx.download && _ctx.download(...args)))
                  }, "⬇ " + _toDisplayString(_ctx.t('Download a copy')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[10] || (_cache[10] = (...args) => (_ctx.duplicate && _ctx.duplicate(...args)))
                  }, "⧉ " + _toDisplayString(_ctx.t('Duplicate')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[11] || (_cache[11] = $event => {_ctx.paperOpen = true; _ctx.menuOpen = false})
                  }, "🖹 " + _toDisplayString(_ctx.t('Paper setup')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide",
                    onClick: _cache[12] || (_cache[12] = (...args) => (_ctx.showSource && _ctx.showSource(...args)))
                  }, "</> " + _toDisplayString(_ctx.t('View the HTML')), 1 /* TEXT */),
                  _createElementVNode("button", {
                    class: "eb-btn wide danger",
                    onClick: _cache[13] || (_cache[13] = (...args) => (_ctx.removeDoc && _ctx.removeDoc(...args)))
                  }, "🗑 " + _toDisplayString(_ctx.t('Delete')), 1 /* TEXT */)
                ])
              ])
            ]))
          : _createCommentVNode("v-if", true)
      ]),
      (_ctx.doc.id)
        ? (_openBlock(), _createElementBlock("div", _hoisted_21, [
            _createElementVNode("select", {
              value: _ctx.fmt.block,
              onChange: _cache[16] || (_cache[16] = $event => (_ctx.setBlock($event.target.value))),
              title: _ctx.t('Paragraph style')
            }, [
              _createElementVNode("option", _hoisted_23, _toDisplayString(_ctx.t('Body text')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_24, _toDisplayString(_ctx.t('Heading 1')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_25, _toDisplayString(_ctx.t('Heading 2')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_26, _toDisplayString(_ctx.t('Heading 3')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_27, _toDisplayString(_ctx.t('Heading 4')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_28, _toDisplayString(_ctx.t('Quotation')), 1 /* TEXT */),
              _createElementVNode("option", _hoisted_29, _toDisplayString(_ctx.t('Preformatted')), 1 /* TEXT */)
            ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_22),
            _hoisted_30,
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.bold }]),
              onMousedown: _cache[17] || (_cache[17] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[18] || (_cache[18] = $event => (_ctx.inline('bold'))),
              title: _ctx.t('Bold') + ' (Ctrl+B)'
            }, _hoisted_33, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_31),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.italic }]),
              onMousedown: _cache[19] || (_cache[19] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[20] || (_cache[20] = $event => (_ctx.inline('italic'))),
              title: _ctx.t('Italic') + ' (Ctrl+I)'
            }, _hoisted_36, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_34),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.underline }]),
              onMousedown: _cache[21] || (_cache[21] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[22] || (_cache[22] = $event => (_ctx.inline('underline'))),
              title: _ctx.t('Underline') + ' (Ctrl+U)'
            }, _hoisted_39, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_37),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.strike }]),
              onMousedown: _cache[23] || (_cache[23] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[24] || (_cache[24] = $event => (_ctx.inline('strike'))),
              title: _ctx.t('Strikethrough')
            }, _hoisted_42, 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_40),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.kenten }]),
              onMousedown: _cache[25] || (_cache[25] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[26] || (_cache[26] = $event => (_ctx.inline('kenten'))),
              title: _ctx.t('Emphasis dots')
            }, "•̈", 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_43),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.sup }]),
              onMousedown: _cache[27] || (_cache[27] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[28] || (_cache[28] = $event => (_ctx.inline('sup'))),
              title: _ctx.t('Superscript')
            }, "x²", 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_44),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.sub }]),
              onMousedown: _cache[29] || (_cache[29] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[30] || (_cache[30] = $event => (_ctx.inline('sub'))),
              title: _ctx.t('Subscript')
            }, "x₂", 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_45),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.code }]),
              onMousedown: _cache[31] || (_cache[31] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[32] || (_cache[32] = $event => (_ctx.inline('code'))),
              title: _ctx.t('Inline code')
            }, "</>", 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_46),
            _hoisted_47,
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[33] || (_cache[33] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[34] || (_cache[34] = $event => (_ctx.hlOpen = !_ctx.hlOpen)),
              title: _ctx.t('Highlight')
            }, "🖍", 40 /* PROPS, NEED_HYDRATION */, _hoisted_48),
            (_ctx.hlOpen)
              ? (_openBlock(true), _createElementBlock(_Fragment, { key: 0 }, _renderList(_ctx.highlights, (h) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: h.key,
                    class: "eb-tb",
                    onMousedown: _cache[35] || (_cache[35] = _withModifiers(() => {}, ["prevent"])),
                    onClick: $event => {_ctx.inline(h.key); _ctx.hlOpen = false},
                    title: h.label
                  }, [
                    _createElementVNode("span", {
                      class: "eb-swatch",
                      style: _normalizeStyle({ background: h.color })
                    }, null, 4 /* STYLE */)
                  ], 40 /* PROPS, NEED_HYDRATION */, _hoisted_49))
                }), 128 /* KEYED_FRAGMENT */))
              : _createCommentVNode("v-if", true),
            _createElementVNode("label", {
              class: "eb-tb",
              title: _ctx.t('Text colour'),
              style: {"position":"relative"}
            }, [
              _hoisted_51,
              _createElementVNode("input", {
                type: "color",
                value: _ctx.colour,
                onInput: _cache[36] || (_cache[36] = $event => (_ctx.setColour($event.target.value))),
                style: {"position":"absolute","inset":"0","opacity":"0","cursor":"pointer"}
              }, null, 40 /* PROPS, NEED_HYDRATION */, _hoisted_52)
            ], 8 /* PROPS */, _hoisted_50),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[37] || (_cache[37] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[38] || (_cache[38] = (...args) => (_ctx.clearColour && _ctx.clearColour(...args))),
              title: _ctx.t('Remove text colour')
            }, "🚫", 40 /* PROPS, NEED_HYDRATION */, _hoisted_53),
            _hoisted_54,
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.list === 'UL' }]),
              onMousedown: _cache[39] || (_cache[39] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[40] || (_cache[40] = $event => (_ctx.list('UL'))),
              title: _ctx.t('Bulleted list')
            }, "•≡", 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_55),
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.fmt.list === 'OL' }]),
              onMousedown: _cache[41] || (_cache[41] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[42] || (_cache[42] = $event => (_ctx.list('OL'))),
              title: _ctx.t('Numbered list')
            }, "1≡", 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_56),
            (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.aligns, (a) => {
              return (_openBlock(), _createElementBlock("button", {
                class: _normalizeClass(["eb-tb", { on: _ctx.fmt.align === a.cls }]),
                key: a.cls,
                onMousedown: _cache[43] || (_cache[43] = _withModifiers(() => {}, ["prevent"])),
                onClick: $event => (_ctx.align(a.cls)),
                title: a.label
              }, _toDisplayString(a.icon), 43 /* TEXT, CLASS, PROPS, NEED_HYDRATION */, _hoisted_57))
            }), 128 /* KEYED_FRAGMENT */)),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[44] || (_cache[44] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[45] || (_cache[45] = $event => (_ctx.indent(1))),
              title: _ctx.t('Increase indent')
            }, "⇥", 40 /* PROPS, NEED_HYDRATION */, _hoisted_58),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[46] || (_cache[46] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[47] || (_cache[47] = $event => (_ctx.indent(-1))),
              title: _ctx.t('Decrease indent')
            }, "⇤", 40 /* PROPS, NEED_HYDRATION */, _hoisted_59),
            _hoisted_60,
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[48] || (_cache[48] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[49] || (_cache[49] = $event => (_ctx.tableOpen = true)),
              title: _ctx.t('Insert table')
            }, "▦", 40 /* PROPS, NEED_HYDRATION */, _hoisted_61),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[50] || (_cache[50] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[51] || (_cache[51] = $event => (_ctx.boxOpen = !_ctx.boxOpen)),
              title: _ctx.t('Insert box')
            }, "▢", 40 /* PROPS, NEED_HYDRATION */, _hoisted_62),
            (_ctx.boxOpen)
              ? (_openBlock(true), _createElementBlock(_Fragment, { key: 1 }, _renderList(_ctx.boxes, (b) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: b.variant,
                    class: "eb-tb",
                    onMousedown: _cache[52] || (_cache[52] = _withModifiers(() => {}, ["prevent"])),
                    onClick: $event => {_ctx.addBox(b.variant); _ctx.boxOpen = false},
                    title: b.label
                  }, _toDisplayString(b.icon), 41 /* TEXT, PROPS, NEED_HYDRATION */, _hoisted_63))
                }), 128 /* KEYED_FRAGMENT */))
              : _createCommentVNode("v-if", true),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[53] || (_cache[53] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[54] || (_cache[54] = $event => (_ctx.ruleOpen = !_ctx.ruleOpen)),
              title: _ctx.t('Insert rule')
            }, "―", 40 /* PROPS, NEED_HYDRATION */, _hoisted_64),
            (_ctx.ruleOpen)
              ? (_openBlock(true), _createElementBlock(_Fragment, { key: 2 }, _renderList(_ctx.rules, (r) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: r.cls,
                    class: "eb-tb",
                    onMousedown: _cache[55] || (_cache[55] = _withModifiers(() => {}, ["prevent"])),
                    onClick: $event => {_ctx.addRule(r.cls); _ctx.ruleOpen = false},
                    title: r.label
                  }, _toDisplayString(r.icon), 41 /* TEXT, PROPS, NEED_HYDRATION */, _hoisted_65))
                }), 128 /* KEYED_FRAGMENT */))
              : _createCommentVNode("v-if", true),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[56] || (_cache[56] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[57] || (_cache[57] = (...args) => (_ctx.addPageBreak && _ctx.addPageBreak(...args))),
              title: _ctx.t('Page break')
            }, "⇩⇧", 40 /* PROPS, NEED_HYDRATION */, _hoisted_66),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[58] || (_cache[58] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[59] || (_cache[59] = (...args) => (_ctx.openMath && _ctx.openMath(...args))),
              title: _ctx.t('Insert formula (MathML)')
            }, "∑", 40 /* PROPS, NEED_HYDRATION */, _hoisted_67),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[60] || (_cache[60] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[61] || (_cache[61] = (...args) => (_ctx.clearFmt && _ctx.clearFmt(...args))),
              title: _ctx.t('Clear formatting')
            }, "✕", 40 /* PROPS, NEED_HYDRATION */, _hoisted_68),
            _hoisted_69,
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[62] || (_cache[62] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[63] || (_cache[63] = (...args) => (_ctx.undo && _ctx.undo(...args))),
              title: _ctx.t('Undo') + ' (Ctrl+Z)'
            }, "↶", 40 /* PROPS, NEED_HYDRATION */, _hoisted_70),
            _createElementVNode("button", {
              class: "eb-tb",
              onMousedown: _cache[64] || (_cache[64] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[65] || (_cache[65] = (...args) => (_ctx.redo && _ctx.redo(...args))),
              title: _ctx.t('Redo') + ' (Ctrl+Shift+Z)'
            }, "↷", 40 /* PROPS, NEED_HYDRATION */, _hoisted_71),
            _hoisted_72,
            _createElementVNode("button", {
              class: _normalizeClass(["eb-tb", { on: _ctx.guides }]),
              onMousedown: _cache[66] || (_cache[66] = _withModifiers(() => {}, ["prevent"])),
              onClick: _cache[67] || (_cache[67] = $event => (_ctx.guides = !_ctx.guides)),
              title: _ctx.t('Show page guides')
            }, "⌗", 42 /* CLASS, PROPS, NEED_HYDRATION */, _hoisted_73),
            _createElementVNode("span", _hoisted_74, _toDisplayString(_ctx.t('{n} characters', { n: _ctx.counts })), 1 /* TEXT */)
          ]))
        : _createCommentVNode("v-if", true),
      _createElementVNode("div", _hoisted_75, [
        _createElementVNode("div", _hoisted_76, [
          _createElementVNode("div", {
            id: "eb-canvas",
            class: _normalizeClass(["eb-paper eb-doc", { 'font-sans': _ctx.doc.paper.font === 'sans', noguides: !_ctx.guides }]),
            style: _normalizeStyle(_ctx.paperStyle),
            contenteditable: "true",
            spellcheck: "false",
            role: "textbox",
            "aria-multiline": "true"
          }, null, 6 /* CLASS, STYLE */)
        ])
      ])
    ]),
    _createCommentVNode(" paper setup "),
    (_ctx.paperOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 0,
          class: "eb-modal-back",
          onClick: _cache[87] || (_cache[87] = $event => (_ctx.paperOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[86] || (_cache[86] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "🖹 " + _toDisplayString(_ctx.t('Paper setup')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_77, [
              _createElementVNode("div", _hoisted_78, [
                _createElementVNode("div", _hoisted_79, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Paper size')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[68] || (_cache[68] = $event => ((_ctx.doc.paper.size) = $event)),
                    onChange: _cache[69] || (_cache[69] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, [
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.paperSizes, (p) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: p,
                        value: p
                      }, _toDisplayString(p), 9 /* TEXT, PROPS */, _hoisted_80))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelSelect, _ctx.doc.paper.size]
                  ])
                ]),
                _createElementVNode("div", _hoisted_81, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Orientation')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[70] || (_cache[70] = $event => ((_ctx.doc.paper.orientation) = $event)),
                    onChange: _cache[71] || (_cache[71] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, [
                    _createElementVNode("option", _hoisted_82, _toDisplayString(_ctx.t('Portrait')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_83, _toDisplayString(_ctx.t('Landscape')), 1 /* TEXT */)
                  ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelSelect, _ctx.doc.paper.orientation]
                  ])
                ])
              ]),
              _createElementVNode("div", _hoisted_84, [
                _createElementVNode("div", _hoisted_85, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Top margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[72] || (_cache[72] = $event => ((_ctx.doc.paper.margin.top) = $event)),
                    onChange: _cache[73] || (_cache[73] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.top,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_86, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Bottom margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[74] || (_cache[74] = $event => ((_ctx.doc.paper.margin.bottom) = $event)),
                    onChange: _cache[75] || (_cache[75] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.bottom,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_87, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Left margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[76] || (_cache[76] = $event => ((_ctx.doc.paper.margin.left) = $event)),
                    onChange: _cache[77] || (_cache[77] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.margin.left,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_88, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Right margin (mm)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "0",
                    max: "100",
                    step: "1",
                    "onUpdate:modelValue": _cache[78] || (_cache[78] = $event => ((_ctx.doc.paper.margin.right) = $event)),
                    onChange: _cache[79] || (_cache[79] = (...args) => (_ctx.touch && _ctx.touch(...args)))
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
              _createElementVNode("div", _hoisted_89, [
                _createElementVNode("div", _hoisted_90, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Typeface')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[80] || (_cache[80] = $event => ((_ctx.doc.paper.font) = $event)),
                    onChange: _cache[81] || (_cache[81] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, [
                    _createElementVNode("option", _hoisted_91, _toDisplayString(_ctx.t('Serif (Mincho)')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_92, _toDisplayString(_ctx.t('Sans serif (Gothic)')), 1 /* TEXT */)
                  ], 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [_vModelSelect, _ctx.doc.paper.font]
                  ])
                ]),
                _createElementVNode("div", _hoisted_93, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Body size (pt)')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "6",
                    max: "36",
                    step: "0.5",
                    "onUpdate:modelValue": _cache[82] || (_cache[82] = $event => ((_ctx.doc.paper.fontSize) = $event)),
                    onChange: _cache[83] || (_cache[83] = (...args) => (_ctx.touch && _ctx.touch(...args)))
                  }, null, 544 /* NEED_HYDRATION, NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.doc.paper.fontSize,
                      void 0,
                      { number: true }
                    ]
                  ])
                ])
              ]),
              _createElementVNode("p", _hoisted_94, _toDisplayString(_ctx.t('Page numbers and running headers come from your browser print dialogue: browsers do not yet support headers inside the page rule. Everything else here is written into the file.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_95, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[84] || (_cache[84] = (...args) => (_ctx.saveDefaultPaper && _ctx.saveDefaultPaper(...args)))
              }, _toDisplayString(_ctx.t('Use as default for new documents')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[85] || (_cache[85] = $event => (_ctx.paperOpen = false))
              }, _toDisplayString(_ctx.t('Done')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" insert table "),
    (_ctx.tableOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 1,
          class: "eb-modal-back",
          onClick: _cache[95] || (_cache[95] = $event => (_ctx.tableOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[94] || (_cache[94] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "▦ " + _toDisplayString(_ctx.t('Insert table')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_96, [
              _createElementVNode("div", _hoisted_97, [
                _createElementVNode("div", _hoisted_98, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Rows')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "60",
                    "onUpdate:modelValue": _cache[88] || (_cache[88] = $event => ((_ctx.table.rows) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.table.rows,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_99, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Columns')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("input", {
                    type: "number",
                    min: "1",
                    max: "16",
                    "onUpdate:modelValue": _cache[89] || (_cache[89] = $event => ((_ctx.table.cols) = $event))
                  }, null, 512 /* NEED_PATCH */), [
                    [
                      _vModelText,
                      _ctx.table.cols,
                      void 0,
                      { number: true }
                    ]
                  ])
                ]),
                _createElementVNode("div", _hoisted_100, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Style')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[90] || (_cache[90] = $event => ((_ctx.table.variant) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_101, _toDisplayString(_ctx.t('All borders')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_102, _toDisplayString(_ctx.t('Horizontal lines only')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_103, _toDisplayString(_ctx.t('No borders')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.table.variant]
                  ])
                ])
              ]),
              _createElementVNode("label", _hoisted_104, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[91] || (_cache[91] = $event => ((_ctx.table.header) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.table.header]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('First row is a header')), 1 /* TEXT */)
              ])
            ]),
            _createElementVNode("div", _hoisted_105, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[92] || (_cache[92] = $event => (_ctx.tableOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[93] || (_cache[93] = (...args) => (_ctx.addTable && _ctx.addTable(...args)))
              }, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" formula "),
    (_ctx.mathOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 2,
          class: "eb-modal-back",
          onClick: _cache[101] || (_cache[101] = $event => (_ctx.mathOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[100] || (_cache[100] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "∑ " + _toDisplayString(_ctx.t('Insert formula (MathML)')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_106, [
              _createElementVNode("div", _hoisted_107, [
                (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.mathSnippets, (s) => {
                  return (_openBlock(), _createElementBlock("button", {
                    key: s.label,
                    class: "eb-btn",
                    onClick: $event => (_ctx.math.source = s.code)
                  }, _toDisplayString(s.label), 9 /* TEXT, PROPS */, _hoisted_108))
                }), 128 /* KEYED_FRAGMENT */))
              ]),
              _createElementVNode("div", _hoisted_109, [
                _hoisted_110,
                _withDirectives(_createElementVNode("textarea", {
                  "onUpdate:modelValue": _cache[96] || (_cache[96] = $event => ((_ctx.math.source) = $event)),
                  rows: "7",
                  spellcheck: "false"
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelText, _ctx.math.source]
                ])
              ]),
              _createElementVNode("label", _hoisted_111, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[97] || (_cache[97] = $event => ((_ctx.math.block) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.math.block]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Own line, centred')), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_112, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Preview')), 1 /* TEXT */),
                _createElementVNode("div", {
                  class: "eb-doc",
                  style: {"background":"#fff","color":"#111","border-radius":"9px","padding":"10px 12px","overflow-x":"auto"},
                  innerHTML: _ctx.mathPreview
                }, null, 8 /* PROPS */, _hoisted_113)
              ]),
              _createElementVNode("p", _hoisted_114, _toDisplayString(_ctx.t('MathML is drawn by the browser itself, so the formula stays text in the file — searchable, selectable and never a picture.')), 1 /* TEXT */)
            ]),
            _createElementVNode("div", _hoisted_115, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[98] || (_cache[98] = $event => (_ctx.mathOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[99] || (_cache[99] = (...args) => (_ctx.addMath && _ctx.addMath(...args)))
              }, _toDisplayString(_ctx.t('Insert')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" settings "),
    (_ctx.settingsOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 3,
          class: "eb-modal-back",
          onClick: _cache[109] || (_cache[109] = $event => (_ctx.settingsOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            onClick: _cache[108] || (_cache[108] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "⚙ " + _toDisplayString(_ctx.t('Settings')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_116, [
              _createElementVNode("div", _hoisted_117, [
                _createElementVNode("label", null, _toDisplayString(_ctx.t('Save documents in')), 1 /* TEXT */),
                _withDirectives(_createElementVNode("input", {
                  type: "text",
                  "onUpdate:modelValue": _cache[102] || (_cache[102] = $event => ((_ctx.settings.folder) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelText, _ctx.settings.folder]
                ]),
                _createElementVNode("p", _hoisted_118, _toDisplayString(_ctx.t('A folder in your own Files. Documents already saved elsewhere stay where they are.')), 1 /* TEXT */)
              ]),
              _createElementVNode("div", _hoisted_119, [
                _createElementVNode("div", _hoisted_120, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Theme')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[103] || (_cache[103] = $event => ((_ctx.settings.theme) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_121, _toDisplayString(_ctx.t('Follow Nextcloud')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_122, _toDisplayString(_ctx.t('Light')), 1 /* TEXT */),
                    _createElementVNode("option", _hoisted_123, _toDisplayString(_ctx.t('Dark')), 1 /* TEXT */)
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.settings.theme]
                  ])
                ]),
                _createElementVNode("div", _hoisted_124, [
                  _createElementVNode("label", null, _toDisplayString(_ctx.t('Language')), 1 /* TEXT */),
                  _withDirectives(_createElementVNode("select", {
                    "onUpdate:modelValue": _cache[104] || (_cache[104] = $event => ((_ctx.settings.language) = $event))
                  }, [
                    _createElementVNode("option", _hoisted_125, _toDisplayString(_ctx.t('Follow Nextcloud')), 1 /* TEXT */),
                    (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(_ctx.settings.languages, (l) => {
                      return (_openBlock(), _createElementBlock("option", {
                        key: l.code,
                        value: l.code
                      }, _toDisplayString(l.name), 9 /* TEXT, PROPS */, _hoisted_126))
                    }), 128 /* KEYED_FRAGMENT */))
                  ], 512 /* NEED_PATCH */), [
                    [_vModelSelect, _ctx.settings.language]
                  ])
                ])
              ]),
              _createElementVNode("label", _hoisted_127, [
                _withDirectives(_createElementVNode("input", {
                  type: "checkbox",
                  "onUpdate:modelValue": _cache[105] || (_cache[105] = $event => ((_ctx.autosave) = $event))
                }, null, 512 /* NEED_PATCH */), [
                  [_vModelCheckbox, _ctx.autosave]
                ]),
                _createTextVNode(" " + _toDisplayString(_ctx.t('Save automatically while typing')), 1 /* TEXT */)
              ])
            ]),
            _createElementVNode("div", _hoisted_128, [
              _createElementVNode("button", {
                class: "eb-btn ghost",
                onClick: _cache[106] || (_cache[106] = $event => (_ctx.settingsOpen = false))
              }, _toDisplayString(_ctx.t('Cancel')), 1 /* TEXT */),
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[107] || (_cache[107] = (...args) => (_ctx.saveSettings && _ctx.saveSettings(...args)))
              }, _toDisplayString(_ctx.t('Save')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    _createCommentVNode(" the file itself "),
    (_ctx.sourceOpen)
      ? (_openBlock(), _createElementBlock("div", {
          key: 4,
          class: "eb-modal-back",
          onClick: _cache[112] || (_cache[112] = $event => (_ctx.sourceOpen = false))
        }, [
          _createElementVNode("div", {
            class: "eb-modal",
            style: {"width":"min(860px,100%)"},
            onClick: _cache[111] || (_cache[111] = _withModifiers(() => {}, ["stop"]))
          }, [
            _createElementVNode("h3", null, "</> " + _toDisplayString(_ctx.t('View the HTML')), 1 /* TEXT */),
            _createElementVNode("div", _hoisted_129, [
              _createElementVNode("p", _hoisted_130, _toDisplayString(_ctx.t('This is exactly what is stored in Files — one file, styles included, nothing else needed to open it.')), 1 /* TEXT */),
              _createElementVNode("textarea", {
                rows: "18",
                spellcheck: "false",
                readonly: "",
                value: _ctx.source,
                style: {"width":"100%","font-family":"monospace","font-size":"12px"}
              }, null, 8 /* PROPS */, _hoisted_131)
            ]),
            _createElementVNode("div", _hoisted_132, [
              _createElementVNode("button", {
                class: "eb-btn primary",
                onClick: _cache[110] || (_cache[110] = $event => (_ctx.sourceOpen = false))
              }, _toDisplayString(_ctx.t('Close')), 1 /* TEXT */)
            ])
          ])
        ]))
      : _createCommentVNode("v-if", true),
    (_ctx.toast)
      ? (_openBlock(), _createElementBlock("div", _hoisted_133, _toDisplayString(_ctx.toast), 1 /* TEXT */))
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
        sideOpen: true,
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
        return {
          '--eb-paper-w': s.w + 'mm',
          '--eb-paper-h': s.h + 'mm',
          '--eb-mt': p.margin.top + 'mm',
          '--eb-mr': p.margin.right + 'mm',
          '--eb-mb': p.margin.bottom + 'mm',
          '--eb-ml': p.margin.left + 'mm',
          '--eb-pageh': (s.h - p.margin.top - p.margin.bottom) + 'mm',
          fontSize: p.fontSize + 'pt',
        };
      },
      mathPreview() { return sanitiseHtml(this.math.source); },
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
        return [
          { cls: 'eb-al-l', icon: '⯀▏', label: this.t('Align left') },
          { cls: 'eb-al-c', icon: '▏⯀▏', label: this.t('Centre') },
          { cls: 'eb-al-r', icon: '▏⯀', label: this.t('Align right') },
          { cls: 'eb-al-j', icon: '▤', label: this.t('Justify') },
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
          normaliseCanvas(this.t('Page break'));
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
        command(fn, this.t('Page break'));
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
          if (k === 'z' && !e.shiftKey) { e.preventDefault(); return this.undo(); }
          if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); return this.redo(); }
        }
        // Tab indents the paragraph instead of leaving the document.
        if (e.key === 'Tab') {
          e.preventDefault();
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
        const wanted = Number((root && root.dataset.fileid) || 0);
        const last = Number(window.localStorage.getItem('eb-last-doc') || 0);
        const target = wanted || (this.docs.some((d) => d.id === last) ? last : (this.docs[0] && this.docs[0].id));
        if (target) { await this.openDoc(target); }
      },
    },
    watch: {
      'doc.id'(id) { if (id) { window.localStorage.setItem('eb-last-doc', String(id)); } },
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

      const c = canvasEl;
      c.addEventListener('beforeinput', () => history.push(false));
      c.addEventListener('input', () => { this.touch(); this.recount(); });
      c.addEventListener('paste', (e) => { handlePaste(e, e.shiftKey); this.touch(); this.recount(); });
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
