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
produces the result.

### Features

- **Plain HTML documents** in your Files — shareable, searchable and versioned by
  Nextcloud like any other file
- **Paper setup in millimetres** — A3, A4, A5, B4, B5, Letter and Legal, portrait
  or landscape, four margins, serif or sans body text, body size in points
- **Page guides** showing on screen where each printed page will end
- **Structure** — headings, quotations, preformatted text, bulleted and numbered
  lists, alignment and indentation
- **Tables** with three border styles and an optional header row, kept whole
  across a page break
- **Callout boxes** — rounded, square, dashed, tinted and side-bar notes
- **Decoration** — five highlight colours, free text colour, emphasis dots,
  superscript, subscript, inline code
- **Mathematics as native MathML** — drawn by the browser, so a formula stays
  searchable, selectable text and never becomes a picture
- **Its own undo history**, because an editor that rewrites the document tree
  cannot rely on the browser's
- **Printing from the file itself**, in an isolated frame, so nothing in the
  application's own styling can reach the page
- Light and dark themes per user; English and Japanese

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
得られます。

### 主な機能

- **素の HTML 文書** ― 共有・検索・バージョン管理は Nextcloud の他のファイルと同じ
- **ミリメートル単位の用紙設定** ― A3・A4・A5・B4・B5・Letter・Legal、縦置き／横置き、
  上下左右の余白、明朝／ゴシック、本文サイズ（pt）
- **ページガイド** ― 印刷したときのページの区切りを画面上に表示
- **文書構造** ― 見出し・引用・整形済みテキスト・箇条書き・番号付きリスト・
  行揃え・インデント
- **表** ― 3種類の罫線体裁と見出し行、改ページで分断しない指定つき
- **囲み記事** ― 角丸・角あり・破線・地色つき・左線つきの注記
- **文字装飾** ― 5色のハイライト、任意の文字色、圏点、上付き・下付き、
  インラインコード
- **数式はネイティブ MathML** ― ブラウザ自身が描画するため、数式は文字のまま残り、
  検索も選択もでき、画像になりません
- **独自の取り消し履歴** ― 文書ツリーを書き換えるエディタは、ブラウザ標準の
  取り消しに頼れないため
- **ファイル自体からの印刷** ― 隔離したフレームで印刷するので、アプリ側の
  スタイルは一切入り込みません
- 利用者ごとのライト／ダークテーマ、日本語・英語対応

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
