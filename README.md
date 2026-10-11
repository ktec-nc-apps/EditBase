# EditBase 📄

A word processor for Nextcloud whose documents are ordinary web pages.
Nextcloud で使えるワープロです。作った文書は、そのまま普通の Web ページになります。

> A personal project, written for my own use and shared in case it is useful to someone.
> Self-hosted; your data stays in your own Nextcloud.
> 自分で使うために作った個人プロジェクトです。どなたかのお役に立てればと思い、公開しています。
> セルフホスト型なので、データはお使いの Nextcloud の中にだけ保存されます。

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

EditBase は、文書を1つの `.html` ファイルとして、ご自身の Nextcloud の Files に保存します。スタイルシートもファイルの中に含まれます。編集しているファイルがそのまま完成品なので、取り込みや書き出しの作業はありません。どの端末のブラウザーでも開くことができ、10年後もそのまま開けます。

文書は HTML と CSS でできているので、印刷のレイアウトも CSS でそのまま組まれます。用紙サイズ・向き・余白はミリ単位で設定し、`@page` ルールとしてファイルに書き込まれます。改ページは明示的に入れ、PDF はブラウザーの「PDF に保存」で作成します。エディターがページを組んで用紙の形で表示するので、画面で見たとおりに印刷されます。

EditBase は、外部のプログラムを使わず、HTML・CSS・JavaScript だけで文書を作るためのプログラムです。LibreOffice Writer と同じように使えること、DTP ソフトに近い操作感を目指して作っています。規模の大きなプログラムになったため、不具合がまだ多く残っている可能性があります。

### 主な機能

**文書**

- 文書は Files に保存される標準の HTML ファイルです。共有・検索・バージョン管理は、ほかのファイルと同じように Nextcloud で行えます
- 文書を右クリックすると、開く・コピー・共有・移動・削除のほか、ファイル名・サイズ・用紙・文字数などの情報を確認できます
- **カテゴリ**：カテゴリごとに好きな色の枠で表示され、一度に開けるのは1つだけです。文書はドラッグでほかのカテゴリへ移動できます。カテゴリの実体は保存フォルダー内の普通のフォルダーなので、Files でも同じように分類されています
- **同じサーバーのほかのユーザーと共有**できます（閲覧のみ／編集可）。文書1つでも、カテゴリ単位でも共有できます。カテゴリを共有すると中の文書もすべて共有され、相手がそこに文書を追加することもできます。Nextcloud 標準の共有機能を使っているので、EditBase からでも Files からでも解除できます
- **1つの文書を2人で同時に編集できます。** ほかの人が文書を開くと、すぐに両方が共同編集モードになります。入力した内容は保存を待たずに約1秒で相手の画面に表示され、相手のカーソルは名前付きで表示されます。相手が入力中の段落は、こちらからは編集できないようにロックされます。自動で統合できない唯一のケースを起こさないためです。ほかに誰も開いていない文書には、余計な負荷はかかりません
- **バージョン**：文書と同じフォルダーに、保存する直前の内容を `報告書.#01` のような名前で残します（最大99個、中身は標準の HTML）。文書の名前を変えたり、別の場所へ移動したりすると、バージョンも一緒に移動します
- 自動保存・名前の変更・ダウンロード

**用紙とページ**

- ミリ単位の用紙設定：A3・A4・A5・B4・B5・Letter・Legal、縦向き／横向き、上下左右の余白、本文のフォントとサイズ
- 画面上のページガイド、ルーラー、5mm グリッド
- 改ページの挿入、任意のページの前後への白紙ページの挿入
- すべての印刷ページに入るヘッダーとフッター（それぞれ本文とは別の領域に入ります）。`{page}`（ページ番号）・`{pages}`（総ページ数）・`{title}`・`{name}`・`{date}`・`{time}` を差し込めます
- 段組み、縦書き

**文章**

- 見出し・引用・整形済みテキスト・箇条書き・番号付きリスト・配置・インデント
- ルビ（本文の半分のサイズ。上の行と重ならないよう行間を確保します）、傍点、5色の蛍光ペン、任意の文字色、上付き・下付き文字、インラインコード
- 特殊文字と、Unicode のすべての絵文字（お使いの言語で名前を検索できます）
- 脚注（文書の最後にまとめて表示）、見出しから作成する目次
- 検索と置換、変更の記録、データ一覧からの差し込み印刷

**ページに置くもの**

- 画像の貼り付けとドラッグ＆ドロップ、トリミング。説明文は画像の上・下・中に置くか、なしにできます
- 表・囲み枠・図形・罫線・埋め込みページ、MathML による数式（ブラウザーが描画するため、数式も選択できるテキストのままです）
- FormulaBase で作った数式を、そのまま文書に挿入できます
- **AI-Hub** アプリを使った AI アシスタント：ページの横にチャットが表示されます。アシスタントは EditBase の使い方を理解しており、頼めば開いている文書を編集します（変更はすべて Ctrl+Z で元に戻せます）。同じシリーズのほかのアプリのデータは、管理者が許可した範囲でのみ参照します。AI-Hub が入っていない場合は表示されません
- どのオブジェクトもページ上でドラッグして配置でき、矢印キーで細かく位置を調整できます。配置方法は2種類あります。**標準配置**は HTML のルールに従って配置し、文字列やほかのオブジェクトと重なりません（上下に文字列を避ける、文字列を左または右に回り込ませる。JavaScript を使えば両側への回り込みも可能です）。**自由配置**は CSS でどこにでも配置でき、ほかのオブジェクトと重ねたり、重なり順を指定したりできます。新しいオブジェクトをどちらで配置するかは、設定で選べます
- **計算できる表**：簡単な表計算のように、セルに `=SUM(B2:B5)` や `=B2*C2` と入力すると計算結果が表示され、数値を変えると再計算されます。関数は33種類で、書き方は LibreOffice Calc と同じです。数式バーの一覧から関数を選べ、セルをクリックするとそのセル番地が数式に入ります。表の上と左には列番号と行番号が表示されます
- **Excel のようなタブ形式のセルのプロパティ**：表示形式（`#,##0"cm"` のようなユーザー定義の書式も可）、配置、フォント、辺ごとの罫線、塗りつぶし。ドラッグで範囲を選択して、まとめて書式を設定できます。行の高さと列の幅の自動調整にも対応しています
- ページに収まらない枠は、次のページにある同じ形の枠へ文章を続けます。分割は用紙の端ではなく、行の区切りで行います
- 手動で配置したオブジェクトは、必ず1ページ内に収まります。用紙の端を越えてドラッグすると次のページへ移り、元のページに余裕ができると戻ります
- レイヤーバーとページバー。どちらもドラッグして並べ替えができます

**デザイン**

- 段落の種類ごとのスタイル（フォント・サイズ・色・文字間隔・太さ・配置・行間・インデント・前後の間隔・背景色・辺ごとの罫線・リストの行頭文字）をマウスで設定でき、見本がその場で変わります。設定は段落ごとではなく、スタイルのルールとしてファイルに書き込まれます
- **見出しのデザイン** 20種類（下線、行頭の縦線、帯、囲み、吹き出しなど）。CSS だけで描画し、すべての見出しを同じ色にそろえることもできます
- これらの設定で表現できないものは、文書専用のスタイルシートに CSS を直接書いて指定できます
- ユーザーごとに選べるライト／ダークテーマ、日本語・英語に対応

**文書のメンテナンス**

- 文書のチェック：用紙の端からはみ出したオブジェクト、回り込みを設定したのに重なっている文字列、収まりきらない文章が入った枠、ファイルが重くなるほど大きな画像、何も書かれていないページを見つけます
- 文書内の画像をその場で圧縮
- **Web プレビュー**：保存した文書を、Web ページとして新しいタブで開きます（文書の JavaScript も動きます）
- エディター独自の「元に戻す」履歴（エディターが文書の構造を書き換えるため、ブラウザー標準の機能には頼れません）

### HTML5 と CSS を基本に、JavaScript は必要な部分だけ

文書は1つの HTML ファイルです。できるかぎり HTML5 と CSS だけで表示しているため、JavaScript が動かない環境（メールから開いたとき、JavaScript を無効にしたブラウザー、印刷、PDF）でも同じように読めます。JavaScript は HTML と CSS ではできないことにだけ使い、文書ごとにオン／オフを切り替えられます（文書設定 → JavaScript を使用する）。オフにしても、文書の内容が失われることはありません。

**HTML5 と CSS だけで実現しているもの**（JavaScript のオン／オフに関係なく同じ）：
文章、見出し、リスト、引用、表、囲み枠、図形、画像と説明文。見出しのデザイン、スタイル、文書独自の CSS。段組み、縦書き、ルビ、傍点。標準配置と自由配置（上下・左・右への回り込み）。表の計算結果と表示形式。用紙、余白、改ページ、ページ番号入りのヘッダーとフッター。目次、注、リンク。

**JavaScript を使っているもの：**

| 機能 | JavaScript がオフのとき |
|---|---|
| オブジェクトの両側への文字列の回り込み | 保存したときのレイアウトのまま表示されます。別のフォントで文字の位置がずれた箇所だけ組み直されます |
| 画像の拡大効果（全画面表示、すべての画像を順に表示、その場で拡大、虫眼鏡、マウスを重ねると浮き上がる） | 画像はそのまま表示されます |
| 表の計算（数式の計算結果） | 編集画面で計算した結果をテキストとして保存するため、どこで開いても計算結果を読めます |

この表は、EditBase の機能が増えるのに合わせて追加していきます。文書に含まれるスクリプトは EditBase 自身のものだけで、ハッシュ値（SHA-256）で識別しています。

### ツールバー

- **文書**：文書一覧、保存、印刷／PDF、HTML の表示、用紙設定
- **編集**：元に戻す、やり直す
- **段落**：段落スタイル（本文、見出し1〜4、引用、整形済みテキスト）、スタイルの一括変更、配置、箇条書き・番号付きリストと行頭文字の種類、インデントを増やす／減らす
- **文字**：フォント、フォントサイズ（pt）、太字、斜体、下線、取り消し線、傍点、上付き文字、下付き文字、インラインコード、蛍光ペン、文字色、書式のコピー（カーソル位置の書式を選択範囲に適用）、書式のクリア
- **挿入**：挿入メニュー、ページ構成、記号と注、図形、メモ・RegiBase・FormulaBase からの取り込み
- **表示**：ルーラー、余白の境界線、図形パレット、5mm グリッド、ページとレイヤーのパネル、ヘッダー、フッター、オブジェクトの枠、印刷イメージで表示、画面幅に合わせる、ズーム
- **画像・図形・枠を選択したとき**：文字列の回り込み（上下、左、右、両側、前面）、アンカー、左余白・中央・右余白に揃える、段の幅に合わせる、等間隔に並べる、同じサイズにする、プロパティ、トリミング、削除
- **表の中**：上／下に行を追加、左／右に列を追加、行・列・表の削除、先頭行を見出し行にする、セルの色、セル内の文字の上揃え・上下中央揃え・下揃え、セルの罫線
- **変更の記録**：これ以降の変更を記録、前／次の変更へ移動

### 保存される HTML

書式は、インラインスタイルを大量に並べるのではなく、意味を表す要素と `eb-` で始まるクラスで指定します。

```html
<h2>四半期報告</h2>
<p>売上は <strong>12%</strong> 増、主に <mark class="eb-hl-g">第3四半期</mark> です。</p>
<aside class="eb-box tint">
  <div class="eb-box-title">注記</div>
  <p>数値は暫定値です。</p>
</aside>
<div class="eb-pagebreak"></div>
```

### 制限事項

- **縦書きへの対応は遅れています。** ページに関する新しい機能（枠の文章を次のページへ続ける機能、配置したオブジェクトを1ページ内に収める機能）は、今のところ横書きにしか対応していません。
- **同時編集は、文字単位ではなく段落単位です。** 別々の段落を編集していれば、入力内容は約1秒で互いの画面に反映されます。同じ段落の内容を1文字ずつ統合するのではなく、入力中の人がいる段落は、もう一方の人からはロックされます。ロックされるのは実際に入力している段落だけで、カーソルを置いているだけの段落はロックされません。
- 印刷は Chromium で確認しています。ファイルはどのブラウザーでも開けますが、ほかのブラウザーでのページの区切り方はまだ検証していません。

### 動作要件

Nextcloud 30〜35。外部サービス、追加の PHP 拡張機能、ブラウザーへのインストールは不要です。AI アシスタントを使う場合のみ、無料の **AI-Hub** アプリが必要です。AI サービス、API キー、利用制限は AI-Hub で一度設定すれば、サーバー上のすべてのアプリで使えます。

### インストール

Nextcloud の App Store（アプリ → オフィスとテキスト）からインストールするか、アプリを `apps/editbase` にコピーして有効にします。

```bash
sudo -u www-data php occ app:enable editbase
```

---

## Licence

AGPL-3.0-or-later
