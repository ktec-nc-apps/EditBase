/*
 * SPDX-FileCopyrightText: 2026 KTEC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * EditBase's table calculation: formulas in the cells of a table, as LibreOffice
 * Calc and Excel write them (=SUM(B2:B5), =B2*C2, =IF(A1>0;"yes";"no")).
 *
 * This file knows nothing of the page. A table is handed to it as a grid of the
 * text written in each cell; it answers with what each cell shows. The editor
 * keeps the grid and the page in step (editbase.js), and a later spreadsheet app
 * can use the same part with a grid of its own. It is bundled under its own name
 * (EditBaseCalc), so two apps carrying a copy each do not share one.
 *
 * Where Calc and Excel differ, Calc is followed: ; and , both separate the
 * arguments of a function, a circular reference is Err:522, text in arithmetic
 * is #VALUE!, an empty cell counts as 0 in arithmetic and is not counted by
 * COUNT or AVERAGE.
 */
(function (root) {
  'use strict';

  const ERR = {
    DIV0: '#DIV/0!', VALUE: '#VALUE!', REF: '#REF!', NAME: '#NAME?', NA: '#N/A', NUM: '#NUM!',
    CIRC: 'Err:522', PARSE: 'Err:509',
  };
  class CalcError { constructor(code) { this.code = code; } toString() { return this.code; } }
  const fail = (code) => { throw new CalcError(code); };
  const isErr = (v) => v instanceof CalcError;

  /** A1 → { r: 0, c: 0 }. Column letters as in a spreadsheet: A … Z, AA … */
  function parseRef(text) {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,6})$/.exec(text);
    if (!m) { return null; }
    let c = 0;
    for (const ch of m[1].toUpperCase()) { c = c * 26 + (ch.charCodeAt(0) - 64); }
    return { r: Number(m[2]) - 1, c: c - 1 };
  }
  function colName(c) {
    let s = '';
    let n = c + 1;
    while (n > 0) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  // ---- reading a formula -------------------------------------------------

  function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') {
        let j = i + 1;
        let s = '';
        for (;;) {
          if (j >= src.length) { fail(ERR.PARSE); }
          if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
          s += src[j]; j++;
        }
        out.push({ t: 'str', v: s });
        i = j + 1;
        continue;
      }
      const num = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
      if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
      const word = /^\$?[A-Za-z_][A-Za-z0-9_.]*\$?\d*(?::\$?[A-Za-z]{1,3}\$?\d{1,6})?/.exec(src.slice(i));
      if (word) { out.push({ t: 'word', v: word[0] }); i += word[0].length; continue; }
      const two = src.slice(i, i + 2);
      if (two === '<>' || two === '<=' || two === '>=') { out.push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/^&=<>%(),;'.indexOf(ch) >= 0) { out.push({ t: 'op', v: ch }); i++; continue; }
      fail(ERR.PARSE);
    }
    return out;
  }

  /** Recursive descent, with Calc's order: comparison < & < + - < * / < ^ < unary - < %. */
  function parse(src) {
    const toks = tokenize(src);
    let k = 0;
    const peek = () => toks[k];
    const take = (v) => { if (toks[k] && toks[k].t === 'op' && toks[k].v === v) { k++; return true; } return false; };
    const cmp = () => {
      let a = concat();
      for (;;) {
        const t = peek();
        if (t && t.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].indexOf(t.v) >= 0) { k++; a = { k: 'bin', op: t.v, a, b: concat() }; } else { return a; }
      }
    };
    const concat = () => { let a = add(); while (take('&')) { a = { k: 'bin', op: '&', a, b: add() }; } return a; };
    const add = () => {
      let a = mul();
      for (;;) {
        if (take('+')) { a = { k: 'bin', op: '+', a, b: mul() }; } else if (take('-')) { a = { k: 'bin', op: '-', a, b: mul() }; } else { return a; }
      }
    };
    const mul = () => {
      let a = pow();
      for (;;) {
        if (take('*')) { a = { k: 'bin', op: '*', a, b: pow() }; } else if (take('/')) { a = { k: 'bin', op: '/', a, b: pow() }; } else { return a; }
      }
    };
    const pow = () => { let a = unary(); while (take('^')) { a = { k: 'bin', op: '^', a, b: unary() }; } return a; };
    const unary = () => {
      if (take('-')) { return { k: 'neg', a: unary() }; }
      if (take('+')) { return unary(); }
      return percent();
    };
    const percent = () => { let a = atom(); while (take('%')) { a = { k: 'pct', a }; } return a; };
    const atom = () => {
      const t = toks[k++];
      if (!t) { fail(ERR.PARSE); }
      if (t.t === 'num') { return { k: 'num', v: t.v }; }
      if (t.t === 'str') { return { k: 'str', v: t.v }; }
      if (t.t === 'op' && t.v === '(') { const e = cmp(); if (!take(')')) { fail(ERR.PARSE); } return e; }
      if (t.t === 'word') {
        const w = t.v;
        if (take('(')) {
          const args = [];
          if (!take(')')) {
            for (;;) {
              args.push(peekSep() ? { k: 'empty' } : cmp());
              if (take(')')) { break; }
              if (!(take(';') || take(','))) { fail(ERR.PARSE); }
            }
          }
          return { k: 'fn', name: w.toUpperCase(), args };
        }
        const up = w.toUpperCase();
        if (up === 'TRUE') { return { k: 'bool', v: true }; }
        if (up === 'FALSE') { return { k: 'bool', v: false }; }
        const parts = w.split(':');
        if (parts.length === 2) {
          const a = parseRef(parts[0]); const b = parseRef(parts[1]);
          if (!a || !b) { return { k: 'name', v: w }; }
          return { k: 'range', r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) };
        }
        const ref = parseRef(w);
        return ref ? { k: 'ref', r: ref.r, c: ref.c } : { k: 'name', v: w };
      }
      fail(ERR.PARSE);
      return null;
    };
    const peekSep = () => { const t = peek(); return t && t.t === 'op' && (t.v === ';' || t.v === ',' || t.v === ')'); };
    const tree = cmp();
    if (k !== toks.length) { fail(ERR.PARSE); }
    return tree;
  }

  // ---- values ------------------------------------------------------------

  /**
   * What a plain cell holds: a number when its text reads as one (1,234 and 12%
   * as well, as Calc reads them), otherwise its text. Empty is ''.
   */
  function literal(text) {
    const s = String(text == null ? '' : text).replace(/ /g, ' ').trim();
    if (s === '') { return ''; }
    const t = s.replace(/[０-９．－＋，％]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    const m = /^([-+]?)((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)([eE][-+]?\d+)?(%?)$/.exec(t);
    if (m) {
      let n = Number((m[1] || '') + m[2].replace(/,/g, '') + (m[3] || ''));
      if (m[4]) { n /= 100; }
      if (isFinite(n)) { return n; }
    }
    const up = s.toUpperCase();
    if (up === 'TRUE') { return true; }
    if (up === 'FALSE') { return false; }
    const day = dateLiteral(s);
    if (day != null) { return day; }
    return s;
  }
  const toNum = (v) => {
    if (isErr(v)) { throw v; }
    if (typeof v === 'number') { return v; }
    if (typeof v === 'boolean') { return v ? 1 : 0; }
    if (v === '' || v == null) { return 0; }
    const n = literal(v);
    if (typeof n === 'number') { return n; }
    return fail(ERR.VALUE);
  };
  const toText = (v) => {
    if (isErr(v)) { throw v; }
    if (typeof v === 'number') { return format(v); }
    if (typeof v === 'boolean') { return v ? 'TRUE' : 'FALSE'; }
    return v == null ? '' : String(v);
  };
  const toBool = (v) => {
    if (isErr(v)) { throw v; }
    if (typeof v === 'boolean') { return v; }
    if (typeof v === 'number') { return v !== 0; }
    if (v === '' || v == null) { return false; }
    const up = String(v).toUpperCase();
    if (up === 'TRUE') { return true; }
    if (up === 'FALSE') { return false; }
    return fail(ERR.VALUE);
  };

  /** Calc's "General" format: up to ten significant digits, no trailing zeros. */
  function format(v) {
    if (isErr(v)) { return v.code; }
    if (typeof v === 'boolean') { return v ? 'TRUE' : 'FALSE'; }
    if (typeof v !== 'number') { return v == null ? '' : String(v); }
    if (!isFinite(v)) { return ERR.NUM; }
    if (v === 0) { return '0'; }
    const a = Math.abs(v);
    if (a >= 1e15 || a < 1e-9) {
      return v.toExponential(5).replace(/\.?0+e/, 'E').replace(/E\+?/, 'E+').replace('E+-', 'E-');
    }
    let s = String(Number(v.toPrecision(10)));
    if (/e/.test(s)) { s = Number(s).toFixed(10).replace(/\.?0+$/, ''); }
    return s;
  }

  // ---- functions ---------------------------------------------------------

  /** Every value an argument gives, ranges opened out (cells kept as they are). */
  function flat(args, ctx) {
    const out = [];
    args.forEach((a) => {
      if (a.k === 'range') {
        for (let r = a.r0; r <= a.r1; r++) { for (let c = a.c0; c <= a.c1; c++) { out.push({ v: ctx.cell(r, c), ref: true }); } }
      } else if (a.k === 'ref') {
        out.push({ v: ctx.cell(a.r, a.c), ref: true });
      } else if (a.k !== 'empty') {
        out.push({ v: ev(a, ctx), ref: false });
      }
    });
    return out;
  }
  /** The numbers among them: from cells, only real numbers; typed in, anything that reads as one. */
  function numbers(args, ctx) {
    const out = [];
    flat(args, ctx).forEach(({ v, ref }) => {
      if (isErr(v)) { throw v; }
      if (ref) { if (typeof v === 'number') { out.push(v); } return; }
      out.push(toNum(v));
    });
    return out;
  }
  const round = (n, d) => { const f = Math.pow(10, d); return Math.round(Math.abs(n) * f + 1e-9) / f * Math.sign(n); };
  /** A criterion as COUNTIF writes it: ">5", "<>x", "apple", 3. */
  function criterion(c) {
    if (typeof c === 'number') { return (v) => typeof v === 'number' && v === c; }
    const m = /^(<>|>=|<=|=|>|<)?(.*)$/.exec(String(c));
    const op = m[1] || '=';
    const rhs = literal(m[2]);
    return (v) => {
      if (typeof rhs === 'number') {
        if (typeof v !== 'number') { return op === '<>'; }
        return { '=': v === rhs, '<>': v !== rhs, '>': v > rhs, '<': v < rhs, '>=': v >= rhs, '<=': v <= rhs }[op];
      }
      const a = String(v == null ? '' : v).toLowerCase(); const b = String(rhs).toLowerCase();
      return { '=': a === b, '<>': a !== b, '>': a > b, '<': a < b, '>=': a >= b, '<=': a <= b }[op];
    };
  }
  const cellsOf = (a, ctx) => {
    if (a.k === 'range') { const out = []; for (let r = a.r0; r <= a.r1; r++) { for (let c = a.c0; c <= a.c1; c++) { out.push([r, c]); } } return out; }
    if (a.k === 'ref') { return [[a.r, a.c]]; }
    return fail(ERR.VALUE);
  };

  const FN = {
    SUM: (a, x) => numbers(a, x).reduce((s, n) => s + n, 0),
    PRODUCT: (a, x) => numbers(a, x).reduce((s, n) => s * n, 1),
    AVERAGE: (a, x) => { const n = numbers(a, x); return n.length ? n.reduce((s, v) => s + v, 0) / n.length : fail(ERR.DIV0); },
    MIN: (a, x) => { const n = numbers(a, x); return n.length ? Math.min(...n) : 0; },
    MAX: (a, x) => { const n = numbers(a, x); return n.length ? Math.max(...n) : 0; },
    MEDIAN: (a, x) => {
      const n = numbers(a, x).sort((p, q) => p - q);
      if (!n.length) { return fail(ERR.NUM); }
      const h = Math.floor(n.length / 2);
      return n.length % 2 ? n[h] : (n[h - 1] + n[h]) / 2;
    },
    COUNT: (a, x) => flat(a, x).filter(({ v, ref }) => (ref ? typeof v === 'number' : typeof literal(toText(v)) === 'number')).length,
    COUNTA: (a, x) => flat(a, x).filter(({ v }) => !(v === '' || v == null)).length,
    COUNTBLANK: (a, x) => flat(a, x).filter(({ v }) => v === '' || v == null).length,
    COUNTIF: (a, x) => { const ok = criterion(ev(a[1], x)); return cellsOf(a[0], x).filter(([r, c]) => ok(x.cell(r, c))).length; },
    SUMIF: (a, x) => {
      const ok = criterion(ev(a[1], x));
      const test = cellsOf(a[0], x);
      const sum = a[2] ? cellsOf(a[2], x) : test;
      let s = 0;
      test.forEach(([r, c], i) => { if (ok(x.cell(r, c)) && sum[i]) { const v = x.cell(sum[i][0], sum[i][1]); if (typeof v === 'number') { s += v; } } });
      return s;
    },
    ABS: (a, x) => Math.abs(num1(a, x)),
    INT: (a, x) => Math.floor(num1(a, x)),
    ROUND: (a, x) => round(num1(a, x), a[1] ? Math.trunc(toNum(ev(a[1], x))) : 0),
    ROUNDUP: (a, x) => { const n = num1(a, x); const f = Math.pow(10, a[1] ? Math.trunc(toNum(ev(a[1], x))) : 0); return Math.sign(n) * Math.ceil(Math.abs(n) * f - 1e-9) / f; },
    ROUNDDOWN: (a, x) => { const n = num1(a, x); const f = Math.pow(10, a[1] ? Math.trunc(toNum(ev(a[1], x))) : 0); return Math.sign(n) * Math.floor(Math.abs(n) * f + 1e-9) / f; },
    TRUNC: (a, x) => FN.ROUNDDOWN(a, x),
    MOD: (a, x) => { const n = num1(a, x); const d = toNum(ev(a[1], x)); if (d === 0) { return fail(ERR.DIV0); } return n - d * Math.floor(n / d); },
    POWER: (a, x) => pw(num1(a, x), toNum(ev(a[1], x))),
    SQRT: (a, x) => { const n = num1(a, x); return n < 0 ? fail(ERR.NUM) : Math.sqrt(n); },
    PI: () => Math.PI,
    IF: (a, x) => (toBool(ev(a[0], x)) ? (a[1] ? ev(a[1], x) : true) : (a[2] ? ev(a[2], x) : false)),
    IFERROR: (a, x) => { try { const v = ev(a[0], x); if (isErr(v)) { throw v; } return v; } catch (e) { if (isErr(e)) { return a[1] ? ev(a[1], x) : ''; } throw e; } },
    AND: (a, x) => flat(a, x).every(({ v }) => (v === '' ? true : toBool(v))),
    OR: (a, x) => flat(a, x).some(({ v }) => (v === '' ? false : toBool(v))),
    NOT: (a, x) => !toBool(ev(a[0], x)),
    CONCATENATE: (a, x) => flat(a, x).map(({ v }) => toText(v)).join(''),
    CONCAT: (a, x) => FN.CONCATENATE(a, x),
    LEN: (a, x) => Array.from(toText(ev(a[0], x))).length,
    LEFT: (a, x) => Array.from(toText(ev(a[0], x))).slice(0, a[1] ? toNum(ev(a[1], x)) : 1).join(''),
    RIGHT: (a, x) => { const s = Array.from(toText(ev(a[0], x))); const n = a[1] ? toNum(ev(a[1], x)) : 1; return n > 0 ? s.slice(-n).join('') : ''; },
    MID: (a, x) => Array.from(toText(ev(a[0], x))).slice(toNum(ev(a[1], x)) - 1, toNum(ev(a[1], x)) - 1 + toNum(ev(a[2], x))).join(''),
    UPPER: (a, x) => toText(ev(a[0], x)).toUpperCase(),
    LOWER: (a, x) => toText(ev(a[0], x)).toLowerCase(),
    TRIM: (a, x) => toText(ev(a[0], x)).replace(/\s+/g, ' ').trim(),
    NA: () => fail(ERR.NA),
  };
  const num1 = (a, x) => { if (!a[0]) { return fail(ERR.VALUE); } return toNum(ev(a[0], x)); };
  const pw = (a, b) => { const v = Math.pow(a, b); return isFinite(v) && !isNaN(v) ? v : fail(ERR.NUM); };

  // ---- evaluation --------------------------------------------------------

  function ev(n, ctx) {
    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'bool': return n.v;
      case 'empty': return '';
      case 'ref': { const v = ctx.cell(n.r, n.c); if (isErr(v)) { throw v; } return v; }
      case 'range': {
        // A range where one value is wanted: Calc takes the cell in the same row
        // or column as the formula (implicit intersection).
        if (n.c0 === n.c1 && ctx.at.r >= n.r0 && ctx.at.r <= n.r1) { return ev({ k: 'ref', r: ctx.at.r, c: n.c0 }, ctx); }
        if (n.r0 === n.r1 && ctx.at.c >= n.c0 && ctx.at.c <= n.c1) { return ev({ k: 'ref', r: n.r0, c: ctx.at.c }, ctx); }
        return fail(ERR.VALUE);
      }
      case 'name': return fail(ERR.NAME);
      case 'neg': return -toNum(ev(n.a, ctx));
      case 'pct': return toNum(ev(n.a, ctx)) / 100;
      case 'fn': {
        const f = FN[n.name];
        if (!f) { return fail(ERR.NAME); }
        return f(n.args, ctx);
      }
      case 'bin': {
        const a = ev(n.a, ctx);
        const b = ev(n.b, ctx);
        switch (n.op) {
          case '+': return toNum(a) + toNum(b);
          case '-': return toNum(a) - toNum(b);
          case '*': return toNum(a) * toNum(b);
          case '/': { const d = toNum(b); return d === 0 ? fail(ERR.DIV0) : toNum(a) / d; }
          case '^': return pw(toNum(a), toNum(b));
          case '&': return toText(a) + toText(b);
          default: {
            let c;
            const na = typeof a === 'number' || a === '';
            const nb = typeof b === 'number' || b === '';
            if (na && nb) { const p = a === '' ? 0 : a; const q = b === '' ? 0 : b; c = p < q ? -1 : p > q ? 1 : 0; }
            else if (typeof a === 'number' || typeof b === 'number') { c = typeof a === 'number' ? -1 : 1; } // numbers sort before text
            else { const p = toText(a).toLowerCase(); const q = toText(b).toLowerCase(); c = p < q ? -1 : p > q ? 1 : 0; }
            return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[n.op];
          }
        }
      }
      default: return fail(ERR.PARSE);
    }
  }

  /**
   * Work out a whole table. grid[r][c] is the text written in each cell -- a
   * formula when it starts with "=". The answer has the same shape: for each
   * cell, { value, text, error, formula } where text is what the cell shows.
   * Cells are worked out on demand and remembered; a cell met again while it is
   * still being worked out is a circle (Err:522), as Calc says.
   */
  function compute(grid, formats) {
    const rows = grid.length;
    const memo = new Map();
    const busy = new Set();
    const trees = new Map();
    const key = (r, c) => r + ',' + c;
    const valueAt = (r, c) => {
      if (r < 0 || c < 0 || r >= rows || !grid[r] || c >= grid[r].length) { return new CalcError(ERR.REF); }
      const k = key(r, c);
      if (memo.has(k)) { return memo.get(k); }
      const src = grid[r][c] == null ? '' : String(grid[r][c]);
      if (src.charAt(0) !== '=' || src.length < 2) { const v = literal(src); memo.set(k, v); return v; }
      if (busy.has(k)) { return new CalcError(ERR.CIRC); }
      busy.add(k);
      let v;
      try {
        let tree = trees.get(src);
        if (!tree) { tree = parse(src.slice(1)); trees.set(src, tree); }
        v = ev(tree, { cell: valueAt, at: { r, c } });
        if (typeof v === 'number' && !isFinite(v)) { v = new CalcError(ERR.NUM); }
      } catch (e) {
        if (isErr(e)) { v = e; } else { throw e; }
      }
      busy.delete(k);
      // A cell inside a circle is itself in error, whatever it made of the circle.
      memo.set(k, v);
      return v;
    };
    return grid.map((row, r) => (row || []).map((src, c) => {
      const v = valueAt(r, c);
      const formula = String(src == null ? '' : src).charAt(0) === '=' && String(src).length > 1;
      const code = formats && formats[r] ? formats[r][c] || '' : '';
      return { value: isErr(v) ? null : v, text: formatAs(v, code), error: isErr(v) ? v.code : '', formula };
    }));
  }

  // ---- number formats (BUGS #291) ---------------------------------------
  // A cell's number format, written as Calc writes a format code: 0, 0.00,
  // #,##0, 0%, ¥#,##0, 0.00E+00, YYYY/MM/DD, @ (text). A date is a day count
  // from 1899-12-30, as in Calc and Excel.
  const DAY0 = Date.UTC(1899, 11, 30);
  function dateParts(n) {
    const d = new Date(DAY0 + Math.floor(n) * 86400000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  function formatDate(n, code) {
    const p = dateParts(n);
    const two = (x) => String(x).padStart(2, '0');
    return code.replace(/YYYY|YY|MM|M|DD|D|"([^"]*)"/g, (t, lit) => {
      if (lit != null) { return lit; }
      return { YYYY: String(p.y), YY: two(p.y % 100), MM: two(p.m), M: String(p.m), DD: two(p.d), D: String(p.d) }[t];
    });
  }
  function formatNumberCode(n, code) {
    let c = code;
    // A % in quotes is only a character; a bare one means times 100.
    const pct = /%/.test(c.replace(/"[^"]*"/g, ''));
    if (pct) { n *= 100; c = c.replace(/%(?=(?:[^"]*"[^"]*")*[^"]*$)/, ''); }
    const m = /^([^#0]*)([#0][#0,]*)(?:\.(0+))?(E\+0+)?(.*)$/.exec(c);
    if (!m) { return format(n); }
    const pre = m[1].replace(/"/g, ''); const int = m[2]; const dec = m[3] ? m[3].length : 0; const exp = m[4]; const post = m[5].replace(/"/g, '');
    const neg = n < 0;
    let body;
    if (exp) {
      const e = n === 0 ? 0 : Math.floor(Math.log10(Math.abs(n)));
      const mant = Math.abs(n) / Math.pow(10, e);
      body = mant.toFixed(dec) + 'E' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(exp.length - 2, '0');
    } else {
      body = Math.abs(n).toFixed(dec);
      if (/,/.test(int)) { const parts = body.split('.'); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); body = parts.join('.'); }
      if (!/0/.test(int) && /^0(\.|$)/.test(body)) { body = body.replace(/^0/, ''); }
    }
    const zero = Number(body.replace(/[^\d]/g, '')) === 0;
    return (neg && !zero ? '-' : '') + pre + body + (pct ? '%' : '') + post;
  }
  /** What a value shows in a cell with a format code ('' is Calc's "General"). */
  function formatAs(v, code) {
    if (isErr(v)) { return v.code; }
    if (!code || code === 'General') { return format(v); }
    if (code === '@') { return toText(v); }
    if (typeof v !== 'number') { return format(v); }
    if (/[YMD]/.test(code.replace(/"[^"]*"/g, ''))) { return formatDate(v, code); }
    return formatNumberCode(v, code);
  }
  /** A date typed as 2026/9/29 or 2026-09-29 reads as its day count, as in Calc. */
  function dateLiteral(s) {
    const m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(String(s).trim());
    if (!m) { return null; }
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Math.round((t - DAY0) / 86400000);
  }

  /**
   * The functions, as the formula bar lists them: the group, how the call is
   * written (Calc's ; between arguments), and what it does. The words are English
   * and translated by the app that shows them.
   */
  const FUNCS = [
    ['SUM', 'Mathematical', 'SUM(number 1; number 2; …)', 'Adds the numbers.'],
    ['PRODUCT', 'Mathematical', 'PRODUCT(number 1; number 2; …)', 'Multiplies the numbers.'],
    ['ROUND', 'Mathematical', 'ROUND(number; places)', 'Rounds to the given number of decimal places.'],
    ['ROUNDUP', 'Mathematical', 'ROUNDUP(number; places)', 'Rounds away from zero.'],
    ['ROUNDDOWN', 'Mathematical', 'ROUNDDOWN(number; places)', 'Rounds towards zero.'],
    ['INT', 'Mathematical', 'INT(number)', 'Rounds down to a whole number.'],
    ['ABS', 'Mathematical', 'ABS(number)', 'The number without its sign.'],
    ['MOD', 'Mathematical', 'MOD(number; divisor)', 'The remainder after dividing.'],
    ['POWER', 'Mathematical', 'POWER(number; power)', 'A number raised to a power.'],
    ['SQRT', 'Mathematical', 'SQRT(number)', 'The square root.'],
    ['PI', 'Mathematical', 'PI()', 'The number π.'],
    ['SUMIF', 'Mathematical', 'SUMIF(range; criterion; sum range)', 'Adds the cells that meet a criterion.'],
    ['AVERAGE', 'Statistical', 'AVERAGE(number 1; number 2; …)', 'The average of the numbers.'],
    ['MIN', 'Statistical', 'MIN(number 1; number 2; …)', 'The smallest number.'],
    ['MAX', 'Statistical', 'MAX(number 1; number 2; …)', 'The largest number.'],
    ['MEDIAN', 'Statistical', 'MEDIAN(number 1; number 2; …)', 'The middle number.'],
    ['COUNT', 'Statistical', 'COUNT(value 1; value 2; …)', 'Counts the numbers.'],
    ['COUNTA', 'Statistical', 'COUNTA(value 1; value 2; …)', 'Counts the cells that are not empty.'],
    ['COUNTBLANK', 'Statistical', 'COUNTBLANK(range)', 'Counts the empty cells.'],
    ['COUNTIF', 'Statistical', 'COUNTIF(range; criterion)', 'Counts the cells that meet a criterion.'],
    ['IF', 'Logical', 'IF(test; then; otherwise)', 'One value if the test is true, another if it is not.'],
    ['IFERROR', 'Logical', 'IFERROR(value; if error)', 'The value, or something else when it is an error.'],
    ['AND', 'Logical', 'AND(test 1; test 2; …)', 'TRUE when every test is true.'],
    ['OR', 'Logical', 'OR(test 1; test 2; …)', 'TRUE when any test is true.'],
    ['NOT', 'Logical', 'NOT(test)', 'The opposite of the test.'],
    ['CONCATENATE', 'Text', 'CONCATENATE(text 1; text 2; …)', 'Joins the texts together.'],
    ['LEN', 'Text', 'LEN(text)', 'The number of characters.'],
    ['LEFT', 'Text', 'LEFT(text; count)', 'The first characters.'],
    ['RIGHT', 'Text', 'RIGHT(text; count)', 'The last characters.'],
    ['MID', 'Text', 'MID(text; start; count)', 'Characters from the middle.'],
    ['UPPER', 'Text', 'UPPER(text)', 'In capital letters.'],
    ['LOWER', 'Text', 'LOWER(text)', 'In small letters.'],
    ['TRIM', 'Text', 'TRIM(text)', 'Without extra spaces.'],
  ].map(([name, group, syntax, about]) => ({ name, group, syntax, about }));

  const api = { compute, format, formatAs, literal, parseRef, colName, ERR, FUNCS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root) { root.EditBaseCalc = api; }
}(typeof window !== 'undefined' ? window : null));
