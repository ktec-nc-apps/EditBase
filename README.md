# EditBase 📄

A word processor for Nextcloud whose documents are ordinary web pages.
Nextcloud 用のワードプロセッサです。文書そのものが、ふつうのWebページとして保存されます。

> A personal project, written for my own use and shared in case it is useful to someone.
> Self-hosted; your data stays in your own Nextcloud.
> 自分用に作った個人プロジェクトで、どなたかの役に立てばと思い公開しています。
> セルフホストで、データはあなた自身の Nextcloud の中だけに保存されます。

[English ↓](#english) · [日本語 ↓](#japanese)

---

<a id="english"></a>

## English

### What it is

EditBase saves every document as a single self-contained `.html` file in your own
Files, with its stylesheet inside it. There is no import step and no export step,
because the file you edit *is* the finished artefact: it opens in any browser, on
any device, and it will still open in ten years.

Because a document is HTML and CSS, printing is typesetting. Paper size,
orientation and margins are set in millimetres and written into the file as an
`@page` rule, page breaks are explicit, and your browser's own "Save as PDF"
produces the result. The editor lays the pages out itself and shows them as
sheets of paper, so what is on the screen is what comes out of the printer.

EditBase is a program for writing documents with HTML, CSS and JavaScript alone,
without relying on any external program. It is made to work like LibreOffice
Writer, with handling close to that of DTP software. It has grown into a very
large program, so many bugs may remain.

### Features

**Documents**

- Plain HTML files in your Files — shared, searched and versioned by Nextcloud
  like anything else
- The right button on a document opens it, copies it, shares it, moves it, throws
  it away, or says what it is: its file name, size, paper, and how much is written
  in it
- **Categories**: a box for each, in a colour of your choosing, opening one at a
  time, with documents carried between them by dragging. A category is an ordinary
  folder inside the save folder, so the same filing is there in Files
- **Shared with other accounts** on the same server, to read or to write — a
  single document, or a whole category, in which case everything filed in it goes
  too and the other person can add to it. It is Nextcloud's own sharing, undone
  from either place
- **Two people can write in one document at once.** The moment somebody else opens
  it, both go into shared mode: what is typed here appears on their screen in about
  a second — before it is saved — their caret is drawn with their name on it, and
  the paragraph they are writing in is held for them so that the one case that
  cannot be merged cannot happen. A document nobody else has open costs nothing
- **Versions** kept beside the document — `報告書.html` keeps `報告書.#01` and so on,
  as many as you allow, in plain HTML. They follow the document when it is renamed
  or moved
- Autosave, renaming, download

**Paper and pages**

- Paper setup in millimetres — A3, A4, A5, B4, B5, Letter and Legal, portrait or
  landscape, four margins, body typeface and size
- Page guides on screen, a ruler, a five-millimetre grid
- Explicit page breaks, and a blank page put in above or below any page
- A running header and footer that repeat on every printed page, each in a band of
  its own; they can carry `{page}`, `{pages}`, `{title}`, `{name}`, `{date}` and `{time}`
- Columns, and vertical writing (縦書き) for Japanese

**Writing**

- Headings, quotations, preformatted text, bulleted and numbered lists, alignment
  and indentation
- Readings over words (ruby) at half size, emphasis dots, five highlight colours,
  free text colour, superscript, subscript, inline code
- Special characters and the whole Unicode emoji set, searchable by name in your
  own language
- Footnotes gathered at the end, a table of contents built from the headings
- Find and replace, recorded changes, mail merge from a list of records

**Things on the page**

- Pictures pasted or dragged in, cropped, with the caption above, below, inside or
  nowhere
- Tables, callout boxes, shapes, rules, embedded pages, and formulas as native
  MathML — drawn by the browser, so a formula stays selectable text
- Formulas made in FormulaBase inserted into the document as they are
- An AI assistant, through the **AI-Hub** app: a chat beside the pages that knows
  EditBase, changes the open document when asked — every change undoable with
  Ctrl+Z — and reads from the other apps of the series only as the administrator
  allows. Without AI-Hub it is simply not shown
- Anything can be placed by hand and dragged about the page, or nudged with the
  arrow keys. Two ways of placing it: **standard placement** follows the rules of
  HTML and keeps clear of the text and of other objects — above and below, with the
  text to its left or to its right (and on both sides, with JavaScript); **free
  placement** puts it anywhere with CSS, over other things, in the stacking order
  you choose. Which one a new object gets is a setting
- **Tables that calculate**, like a small spreadsheet: write `=SUM(B2:B5)` or
  `=B2*C2` in a cell and it shows the answer, worked out again when a number
  changes. 33 functions, written as in LibreOffice Calc; a formula bar with a list
  of the functions, where pressing a cell puts its name into the formula; column
  letters and row numbers round the table
- **Cell properties in tabs, as in Excel**: number format (including your own codes
  such as `#,##0"cm"`), alignment, font, borders drawn edge by edge, and fill. Cells
  are chosen as a block by dragging, and formatted all at once; optimal row height
  and column width
- A frame too tall for its page carries its writing on into a frame of the same
  shape inside the next page, cut at the line rather than at the edge of the paper
- Anything placed by hand keeps to one sheet: dragged over the edge of the paper it
  moves on to the next page, and comes back when the page has room again
- A layer bar and a page bar, both of which can be dragged to rearrange the page

**How it looks**

- Styles for each kind of block — typeface, size, colour, letter spacing, weight,
  alignment, line height, indent, the space above and below, a fill, a border on
  any side, the mark in front of a list item — set with the mouse, with a sample
  that changes as you go, and written into the file as rules rather than on each
  paragraph
- **Heading designs**: twenty of them — underlines, a bar at the start, bands, boxes,
  speech bubbles and more — drawn with CSS alone, in one colour for every heading
  if you like
- The document's own stylesheet, written by hand, for anything those fields cannot
  say
- Light and dark themes per user; English and Japanese

**Looking after a document**

- A check over the document: a thing drawn across the edge of the paper, words
  running under something that was told to part them, a frame holding more than it
  can show, a photograph heavy enough to make the file slow, a page with nothing
  written on it
- Photographs made lighter in place
- **Web preview**: the saved document opened in a new tab as the web page it is,
  its JavaScript running
- An undo history of the editor's own, because an editor that rewrites the document
  tree cannot rely on the browser's

### HTML5 and CSS first, JavaScript only where they cannot

A document is one HTML file, and as much of it as possible is drawn with HTML5 and
CSS alone, so it reads the same wherever JavaScript does not run — opened from an
e-mail, in a browser with scripts off, printed, or as a PDF. JavaScript is used
only for what HTML and CSS cannot do, and each document can have it on or off
(Document settings → Use JavaScript). With it off, nothing the document says is
lost.

**HTML5 and CSS alone** — the same with JavaScript on or off:
text, headings, lists, quotations, tables, callout boxes, shapes, pictures and
captions; heading designs, styles and the document's own CSS; columns, vertical
writing, ruby and emphasis dots; standard and free placement, with the text kept
above and below, to the left or to the right; the answers and number formats of
the tables; paper, margins, page breaks, headers and footers with page numbers;
contents, notes and links.

**With the help of JavaScript:**

| Feature | Without JavaScript |
|---|---|
| Text on both sides of an object | Shown as it was saved; laid again only where another font has moved the words |
| Photographs enlarged with an effect: whole screen, all of them in turn, grown in place, a magnifying glass, lifted when pointed at | The photograph is shown as it is |
| Table calculation: the answers of the formulas | Worked out in the editor and saved as text, so the answers are read anywhere |

More will be added here as EditBase grows. The only script a document carries is
EditBase's own, recognised by its fingerprint (SHA-256).

### The toolbar

- **Document**: document list, save, print / PDF, view the HTML, paper setup
- **Editing**: undo, redo
- **Paragraph**: paragraph style (body text, headings 1–4, quotation, preformatted),
  change a style everywhere, alignment, bulleted and numbered lists and the kind of
  marker, increase and decrease indent
- **Characters**: typeface, size (pt), bold, italic, underline, strikethrough,
  emphasis dots, superscript, subscript, inline code, highlight, text colour, copy
  the format at the cursor and put it on a selection, clear formatting
- **Insert**: the insert menu, page layout, marks and notes, shapes, and bringing in
  from Notes, RegiBase and FormulaBase
- **View**: ruler, margin boundaries, the shelf of shapes, a 5 mm grid, the pages
  and layers panels, header, footer, a box round every object, the page exactly as
  it prints, fit to the screen, zoom
- **A selected picture, shape or frame**: how the words flow round it (above and
  below, to its left, to its right, on both sides, underneath), anchor, put it at
  the left or right margin or in the centre, the width of the column, space several
  evenly, make them the same size, properties, crop, delete
- **In a table**: insert a row above or below and a column left or right, delete a
  row, a column or the table, first row as a header, cell colour, text at the top,
  middle or bottom of the cell, rules round the cells
- **Recording changes**: record what is changed from now on, go to the previous or
  next change

### The markup it writes

Formatting is applied as semantic elements and `eb-` prefixed classes, never as a
pile of inline styles:

```html
<h2>Quarterly report</h2>
<p>Revenue rose by <strong>12%</strong>, mostly in <mark class="eb-hl-g">Q3</mark>.</p>
<aside class="eb-box tint">
  <div class="eb-box-title">Note</div>
  <p>Figures are provisional.</p>
</aside>
<div class="eb-pagebreak"></div>
```

### What it does not do

- **Vertical writing is behind.** The newest page-fitting work — frames that carry
  their writing on, and keeping placed things on one sheet — is written for
  horizontal text so far.
- **Writing together is by the paragraph, not by the letter.** Two people in
  different paragraphs see each other's typing in about a second; the paragraph
  somebody is writing in is held against the other, rather than the two being
  merged letter by letter. Nobody is locked out of a paragraph a colleague has
  merely left their cursor in — only one they are writing in.
- Printing has been checked in Chromium. The files open anywhere; how other
  browsers break them into pages has not been measured yet.

### Requirements

Nextcloud 30–35. No external service, no additional PHP extension, and nothing to
install in the browser. The AI assistant alone needs the free **AI-Hub** app, where
the AI service, its key and its limits are set once for every app on the server.

### Installation

Install EditBase from the Nextcloud App Store (Apps → Office & text), or copy the
app into `apps/editbase` and enable it:

```bash
sudo -u www-data php occ app:enable editbase
```

---

<a id="japanese"></a>

## 日本語

### 概要

EditBase は、すべての文書を、スタイルシートを内包した1枚の独立した `.html`
ファイルとして、ご自身の Files に保存します。取り込みも書き出しもありません。
編集しているファイルが、そのまま完成した成果物だからです。どの端末のどのブラウザ
でも開け、10年後でも同じように開けます。

文書が HTML と CSS であるということは、印刷がそのまま組版であるということです。
用紙サイズ・向き・余白はミリメートルで指定して `@page` 規則としてファイルに
書き込まれ、改ページは明示的に置かれ、仕上がりはブラウザ自身の「PDFに保存」で
得られます。エディタ自身がページを組んで紙として表示するので、画面で見えている
ものが、そのまま印刷されます。

EditBase は、外部のプログラムに頼らず、HTML・CSS・JavaScript だけで文書を作成する
ためのプログラムです。LibreOffice ライクかつ DTP ソフトに似た操作性を求めて作って
います。非常に大きなプログラムになっているため、不具合が多く残っている可能性が
あります。

### 主な機能

**文書**

- 自分の Files の中の素の HTML ファイル ― 共有・検索・版管理は他のファイルと同じ
- 文書を右クリックすると、開く・複製・共有・移動・削除・プロパティ（ファイル名、
  大きさ、用紙、文字数など）
- **カテゴリ** ― 色を選べる枠で表示し、開けるのは一度に一つ。ドラッグで文書を
  他のカテゴリへ移せます。カテゴリは保存フォルダの中のふつうのフォルダなので、
  Files でも同じように整理されています
- **同じサーバーの他のアカウントと共有**（読むだけ／書き込める）。**文書ごとにも、
  カテゴリごとにも**共有できます。カテゴリを共有すると中の文書はすべて渡り、相手が
  そこに文書を追加することもできます。Nextcloud 本体の共有機能そのものなので、
  どちらからでも解除できます
- **一つの文書を二人で同時に編集できます。** 他の人が開いた瞬間に共有モードに入り、
  入力した文字は**保存を待たず約1秒で相手の画面に現れます**。相手のカーソルは名前つきで
  表示され、相手が入力中の段落はこちらでは編集できないよう確保されます（併合できない
  唯一の場合を、そもそも起こさないためです）。誰も開いていない文書では何も動きません
- **バージョン** ― 保存の直前の内容を、同じフォルダに `報告書.#01` のような名前で
  残します（最大99個、中身は素のHTML）。文書の名前を変えたり、別のカテゴリへ移すと、
  バージョンも一緒についていきます
- 自動保存・名前の変更・ダウンロード

**用紙とページ**

- ミリメートル単位の用紙設定 ― A3・A4・A5・B4・B5・Letter・Legal、縦置き／横置き、
  上下左右の余白、本文の書体とサイズ
- 画面上のページガイド、ルーラー、5mm グリッド
- 明示的な改ページと、任意のページの上／下への白紙の挿入
- すべての印刷ページに繰り返し入るヘッダーとフッター（それぞれ専用の帯に入ります。`{page}`（ページ番号）・`{pages}`（総ページ数）も入れられます）。
  `{title}` `{name}` `{date}` `{time}` を差し込めます
- 段組み、縦書き

**文章**

- 見出し・引用・整形済みテキスト・箇条書き・番号付きリスト・行揃え・インデント
- ルビ（半分の大きさ・上の行に触れないよう行間を確保）、圏点、5色のハイライト、
  任意の文字色、上付き・下付き、インラインコード
- 特殊文字と、Unicode の絵文字全種（自分の言語の名前で検索できます）
- 文末にまとめる脚注、見出しから作る目次
- 検索と置換、変更履歴の記録、差し込み印刷

**ページに置くもの**

- 貼り付け・ドラッグで入る画像（トリミング可、説明文は下・上・中・なしから選択）
- 表・囲み記事・図形・罫線・埋め込みページ、そしてネイティブ MathML の数式
  （ブラウザが描画するので、数式は文字のまま残ります）
- FormulaBase で作った式を、そのまま文書に挿入できます
- **AI-Hub** アプリを通した AI アシスタント。EditBase を知っているチャットがページの横に
  出て、頼めば開いている文書を直し（すべて Ctrl+Z で戻せます）、同じシリーズのほかの
  アプリは管理者が許した範囲でだけ読みます。AI-Hub が無ければ表示されません
- どれもページ上をドラッグで動かせ、矢印キーで微調整できます。置き方は2つです。
  **標準配置**は HTML の規則に則って配置し、文字列やほかのオブジェクトをよけます
  （上下によける・文字列を左側に・文字列を右側に。JavaScript を使うと両側にも）。
  **自由配置**は CSS で自由に配置し、ほかのものと重ねられ、重ね順も指定できます。
  新しく置くときにどちらにするかは、設定で選べます
- **計算できる表**：小さな表計算のように、セルに `=SUM(B2:B5)` や `=B2*C2` と書くと
  答えが表示され、数値を変えると計算し直します。関数は LibreOffice Calc と同じ書き方で
  33 種類。数式バーから関数を選んで入れられ、セルをクリックするとそのセルの名前が式に
  入ります。表の上と左に列の記号と行の番号が出ます
- **Excel と同じタブのセルのプロパティ**：表示形式（`#,##0"cm"` のような書式コードも
  可）、文字揃え、フォント、辺ごとの罫線、塗りつぶし。セルはドラッグで範囲を選択して
  まとめて書式を設定できます。行の高さと列の幅の最適化もあります
- ページに入りきらない枠は、次ページの同じ形の枠に文章を続けます。用紙の端では
  なく、行の切れ目で分けます
- 自由に配置したものは必ず1枚の紙に収まります。用紙の端にかかると次のページへ移り、
  余裕ができると元の場所へ戻ります
- レイヤーバーとページバー。どちらもドラッグで並べ替えられます

**見た目**

- 種類ごとのスタイル（書体・サイズ・色・字間・太さ・行揃え・行間・字下げ・前後の
  間隔・背景色・辺ごとの罫線・行頭記号）。マウス操作で決められ、見本がその場で
  変わります。段落ごとではなく、ファイル内の規則として書き込まれます
- **見出しのデザイン** 20 種類（下線・先頭の太線・帯・囲み・吹き出しなど）。CSS だけで
  描き、すべての見出しを同じ色にそろえることもできます
- それでは書けないものは、文書自身のスタイルシートに CSS で直接書けます
- 利用者ごとのライト／ダークテーマ、日本語・英語

**文書の手入れ**

- 文書の点検 ― 用紙の端にかかっているもの、回り込みを設定したのに重なっている本文、
  入りきらない文章を抱えた枠、重すぎる画像、何も書かれていないページ
- 画像をその場で軽くする
- **Web プレビュー**：保存した文書を、Web ページとして新しいタブで開きます
  （文書の JavaScript も動きます）
- エディタ自身が持つ取り消し履歴（文書ツリーを書き換えるエディタは、ブラウザ標準の
  取り消しに頼れないため）

### HTML5 と CSS が先、JavaScript はそれで無理なところだけ

文書は HTML ファイル 1 つです。できるかぎり HTML5 と CSS だけで表示しているので、
JavaScript が動かないところ（メールに添付して開いたとき、JavaScript を止めたブラウザ、
印刷、PDF）でも同じように読めます。JavaScript は HTML と CSS ではできないことにだけ
使い、文書ごとに入り切りできます（文書の設定 → JavaScript を使う）。切っても、文書の
内容が失われることはありません。

**HTML5 と CSS だけで実現しているもの**（JavaScript の入り切りに関係なく同じ）：
文章・見出し・リスト・引用・表・囲み記事・図形・画像と説明文、見出しのデザイン・
スタイル・独自の CSS、段組み・縦書き・ルビ・傍点、標準配置と自由配置（上下・左・右への
回り込み）、表の答えと表示形式、用紙・余白・改ページ・ページ番号付きのヘッダーと
フッター、目次・注・リンク。

**JavaScript の力を借りているもの：**

| 機能 | JavaScript が無いとき |
|---|---|
| オブジェクトの両側への文字列の回り込み | 保存したときの形のまま表示されます。別のフォントで字がずれた場合だけ組み直します |
| 画像のエフェクト付きの拡大（画面いっぱい・全部を順に・その場で拡大・虫眼鏡・マウスを重ねると浮き上がる） | 画像はそのまま表示されます |
| 表計算（式の答えを出す） | 編集画面で計算し、答えを文字として保存するので、どこでも答えは読めます |

EditBase が育つにつれ、この表に足していきます。文書に入る JavaScript は EditBase 自身の
ものだけで、その指紋（SHA-256）で見分けます。

### ツールバー

- **文書**：文書一覧、保存、印刷／PDF、HTML を見る、用紙設定
- **編集**：元に戻す、やり直す
- **段落**：段落スタイル（本文・見出し1〜4・引用・整形済み）、スタイルのまとめて変更、
  揃え、箇条書き・番号付きリストと行頭の記号、インデントを深く・浅く
- **文字**：書体、大きさ（pt）、太字、斜体、下線、取り消し線、圏点、上付き文字、
  下付き文字、インラインコード、ハイライト、文字色、カーソル位置の書式をコピーして
  選択範囲に付ける、書式を消す
- **挿入**：挿入メニュー、ページ構成、記号・注記、図形、差し込み（Notes・RegiBase・
  FormulaBase から）
- **表示**：ルーラー、余白の境界線、図形パレット、5mm のマス目、ページとレイヤーの
  一覧、ヘッダー、フッター、オブジェクトの枠、印刷どおりの表示、画面幅に合わせる、
  倍率
- **画像・図形・枠を選んだとき**：文字の回り込み（上下・左・右・両側・重ね合わせ）、
  アンカー、左余白・中央・右余白に寄せる、段の幅いっぱいにする、等間隔に並べる、
  同じ大きさにする、プロパティ、切り抜き、削除
- **表の中**：上・下に行を追加、左・右に列を追加、行・列・表の削除、先頭行を見出しに
  する、セルの色、セル内の上・中央・下寄せ、セルの罫線
- **変更の記録**：これ以降の変更を記録する、前・次の変更へ

### 出力される HTML

書式は、インラインスタイルの山ではなく、意味のある要素と `eb-` 接頭辞の
クラスとして適用されます。

```html
<h2>四半期報告</h2>
<p>売上は <strong>12%</strong> 増、主に <mark class="eb-hl-g">第3四半期</mark> です。</p>
<aside class="eb-box tint">
  <div class="eb-box-title">注記</div>
  <p>数値は暫定値です。</p>
</aside>
<div class="eb-pagebreak"></div>
```

### できないこと

- **縦書きは遅れています。** 新しいページ調整（枠が次ページへ続く、自由配置物を
  1枚の紙に収める）は、いまのところ横書き向けに書かれています。
- **同時編集は段落単位です。** 別々の段落なら約1秒で互いに反映されます。同じ段落は、
  一文字ずつ併合するのではなく、**先に書き始めた人のものとして確保**します。カーソルを
  置いてあるだけの段落は確保されません（実際に入力している間だけです）。
- 印刷の確認は Chromium で行っています。ファイル自体はどこでも開けますが、他の
  ブラウザがどうページを割るかはまだ測っていません。

### 動作要件

Nextcloud 30〜35。外部サービスも、追加の PHP 拡張も、ブラウザに入れるものも
必要ありません。AI アシスタントだけは無料の **AI-Hub** アプリが必要で、AI サービス・
キー・制限はそこでサーバー内の全アプリ分を一度に設定します。

### 導入

Nextcloud の App Store（アプリ → オフィスとテキスト）から入れるか、`apps/editbase` に
配置して有効化します。

```bash
sudo -u www-data php occ app:enable editbase
```

---

## Licence

AGPL-3.0-or-later
