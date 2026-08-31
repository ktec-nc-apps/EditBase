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
- **Shared with other accounts** on the same server, to read or to write —
  Nextcloud's own sharing, undone from either place
- **Two people can write in one document at once**: each copy asks how the file
  stands every couple of seconds and folds in what the other has written, block by
  block. What you are typing is never overwritten
- Autosave, renaming, download

**Paper and pages**

- Paper setup in millimetres — A3, A4, A5, B4, B5, Letter and Legal, portrait or
  landscape, four margins, body typeface and size
- Page guides on screen, a ruler, a five-millimetre grid
- Explicit page breaks, and a blank page put in above or below any page
- A running header and footer that repeat on every printed page, each in a band of
  its own; they can carry `{title}`, `{name}`, `{date}` and `{time}`
- Columns, and vertical writing (縦書き) for Japanese

**Writing**

- Headings, quotations, preformatted text, bulleted and numbered lists, alignment
  and indentation
- Readings over words (ruby) at half size, emphasis dots, five highlight colours,
  free text colour, superscript, subscript, inline code
- Footnotes gathered at the end, a table of contents built from the headings
- Find and replace, recorded changes, mail merge from a list of records

**Things on the page**

- Pictures pasted or dragged in, cropped, with the caption above, below, inside or
  nowhere
- Tables, callout boxes, shapes, rules, embedded pages, and formulas as native
  MathML — drawn by the browser, so a formula stays selectable text
- Anything can be placed by hand and dragged about the page, nudged with the arrow
  keys, stacked, and told what the words should do when they meet it: keep above
  and below, keep to its left, keep to its right, or run underneath
- A frame too tall for its page carries its writing on into a frame of the same
  shape inside the next page, cut at the line rather than at the edge of the paper
- Anything placed by hand keeps to one sheet: dragged over the edge of the paper it
  moves on to the next page, and comes back when the page has room again
- A layer bar and a page bar, both of which can be dragged to rearrange the page

**How it looks**

- Styles for each kind of block — typeface, size, colour, alignment, line height,
  space above and below — written into the file as rules, not on each paragraph
- The document's own stylesheet, written by hand, for anything those fields cannot
  say
- Light and dark themes per user; English and Japanese

**Looking after a document**

- A check over the document: a thing drawn across the edge of the paper, words
  running under something that was told to part them, a frame holding more than it
  can show, a photograph heavy enough to make the file slow, a page with nothing
  written on it
- Photographs made lighter in place
- An undo history of the editor's own, because an editor that rewrites the document
  tree cannot rely on the browser's

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

- **Page numbers cannot be printed from the file.** A browser has no count of
  printed pages to give a document, and the margins of a printed page cannot be
  reached from the page itself. Your print dialogue's own "Headers and footers"
  will add them.
- **Vertical writing is behind.** The newest page-fitting work — frames that carry
  their writing on, and keeping placed things on one sheet — is written for
  horizontal text so far.
- **Writing together is settled by the paragraph, not by the letter.** Two people
  in different paragraphs merge cleanly and see each other's work within a couple
  of seconds. Two people in the *same* paragraph: the one who saves last keeps it,
  and the other is told so and can undo. There is no character-by-character
  merging.
- Printing has been checked in Chromium. The files open anywhere; how other
  browsers break them into pages has not been measured yet.

### Requirements

Nextcloud 30–34. No external service, no additional PHP extension, and nothing to
install in the browser.

### Installation

Copy the app into `apps/editbase` and enable it:

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

### 主な機能

**文書**

- 自分の Files の中の素の HTML ファイル ― 共有・検索・版管理は他のファイルと同じ
- 文書を右クリックすると、開く・複製・共有・移動・削除・プロパティ（ファイル名、
  大きさ、用紙、文字数など）
- **カテゴリ** ― 色を選べる枠で表示し、開けるのは一度に一つ。ドラッグで文書を
  他のカテゴリへ移せます。カテゴリは保存フォルダの中のふつうのフォルダなので、
  Files でも同じように整理されています
- **同じサーバーの他のアカウントと共有**（読むだけ／書き込める）。Nextcloud 本体の
  共有機能そのものなので、どちらからでも解除できます
- **一つの文書を二人で同時に編集できます。** 各自の画面が数秒ごとにファイルの状態を
  問い合わせ、相手が書いた段落を取り込みます。自分が入力中の段落が上書きされることは
  ありません
- 自動保存・名前の変更・ダウンロード

**用紙とページ**

- ミリメートル単位の用紙設定 ― A3・A4・A5・B4・B5・Letter・Legal、縦置き／横置き、
  上下左右の余白、本文の書体とサイズ
- 画面上のページガイド、ルーラー、5mm グリッド
- 明示的な改ページと、任意のページの上／下への白紙の挿入
- すべての印刷ページに繰り返し入るヘッダーとフッター（それぞれ専用の帯に入ります）。
  `{title}` `{name}` `{date}` `{time}` を差し込めます
- 段組み、縦書き

**文章**

- 見出し・引用・整形済みテキスト・箇条書き・番号付きリスト・行揃え・インデント
- ルビ（半分の大きさ・上の行に触れないよう行間を確保）、圏点、5色のハイライト、
  任意の文字色、上付き・下付き、インラインコード
- 文末にまとめる脚注、見出しから作る目次
- 検索と置換、変更履歴の記録、差し込み印刷

**ページに置くもの**

- 貼り付け・ドラッグで入る画像（トリミング可、説明文は下・上・中・なしから選択）
- 表・囲み記事・図形・罫線・埋め込みページ、そしてネイティブ MathML の数式
  （ブラウザが描画するので、数式は文字のまま残ります）
- どれも自由に配置してページ上を動かせます。矢印キーで微調整、重ね順の指定、
  本文の回り込み（上下に配置・左に回り込む・右に回り込む・下を通す）
- ページに入りきらない枠は、次ページの同じ形の枠に文章を続けます。用紙の端では
  なく、行の切れ目で分けます
- 自由に配置したものは必ず1枚の紙に収まります。用紙の端にかかると次のページへ移り、
  余裕ができると元の場所へ戻ります
- レイヤーバーとページバー。どちらもドラッグで並べ替えられます

**見た目**

- 種類ごとのスタイル（書体・サイズ・色・行揃え・行間・前後の間隔）。段落ごとでは
  なく、ファイル内の規則として書き込まれます
- それでは書けないものは、文書自身のスタイルシートに CSS で直接書けます
- 利用者ごとのライト／ダークテーマ、日本語・英語

**文書の手入れ**

- 文書の点検 ― 用紙の端にかかっているもの、回り込みを設定したのに重なっている本文、
  入りきらない文章を抱えた枠、重すぎる画像、何も書かれていないページ
- 画像をその場で軽くする
- エディタ自身が持つ取り消し履歴（文書ツリーを書き換えるエディタは、ブラウザ標準の
  取り消しに頼れないため）

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

- **ファイル自身でページ番号を印刷することはできません。** ブラウザには印刷ページの
  通し番号を文書に渡す仕組みがなく、ページの余白にはページ自身から手が届きません。
  印刷ダイアログの「ヘッダーとフッター」を有効にすると、ブラウザが付けます。
- **縦書きは遅れています。** 新しいページ調整（枠が次ページへ続く、自由配置物を
  1枚の紙に収める）は、いまのところ横書き向けに書かれています。
- **同時編集は段落単位です。** 別々の段落なら数秒で互いに反映されます。同じ段落を
  二人が同時に書いた場合は、後から保存した側が残り、もう一方には「書き換えられた」と
  通知します（Ctrl+Z で戻せます）。一文字単位の併合は行いません。
- 印刷の確認は Chromium で行っています。ファイル自体はどこでも開けますが、他の
  ブラウザがどうページを割るかはまだ測っていません。

### 動作要件

Nextcloud 30〜34。外部サービスも、追加の PHP 拡張も、ブラウザに入れるものも
必要ありません。

### 導入

`apps/editbase` に配置して有効化します。

```bash
sudo -u www-data php occ app:enable editbase
```

---

## Licence

AGPL-3.0-or-later
