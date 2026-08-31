# Changelog

All notable changes to EditBase are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — unreleased

The first version. Everything below is new, because there was nothing before it.

### Added
- Documents are ordinary `.html` files in the user's own Nextcloud Files, saved
  complete with their stylesheet — no proprietary format, no import or export step.
- Editing surface built on `contenteditable` with an editing engine of its own
  (Selection/Range), so the markup it writes stays clean: `<strong>`, `<em>`,
  `<mark class="…">` and classes rather than editor litter.
- Paper setup in millimetres: A3/A4/A5/B4/B5/Letter/Legal, portrait or landscape,
  four margins, serif or sans body, body size in points — written into the file as
  an `@page` rule.
- Page guides on screen showing where each printed page ends.
- Headings, quotations, preformatted text, bulleted and numbered lists, alignment
  and indentation, tables (three border styles, optional header row), callout boxes
  (rounded, square, dashed, tinted, side-bar note), horizontal rules and page breaks.
- Highlighting in five colours, free text colour, emphasis dots, superscript,
  subscript and inline code.
- Formulas as native MathML, with a starter palette and a live preview.
- Undo and redo kept by the editor itself, with keyboard shortcuts.
- Printing and PDF export through the browser, from an isolated copy of the file
  itself, so what prints is exactly what is stored.
- Autosave, document duplication, renaming, deletion and download.
- Readings over words (ruby), at half size, with room kept for them so they never
  sit on the line above, and brackets in the file for browsers that cannot draw
  them — 滅多(めった).
- A frame too tall for the page it stands on carries its writing on into a frame
  of the same shape inside the next page, cut at the line rather than at the edge
  of the paper. The carried-on frame is ordinary markup, so the saved file prints
  the same way in any browser.
- A frame placed by hand carries its writing on the same way, into a frame of its
  own inside the next page; and anything placed by hand keeps to one sheet, moving
  down to the next page rather than being printed cut in two by the edge of the
  paper. Where the writer put it is remembered, so it goes back as soon as the page
  has room for it again.
- A blank page can be put in above or below any page, from the right button in the
  page bar.
- The document's own stylesheet, written by hand: a CSS box in the styles dialogue
  for anything the boxes above it cannot say — the look of headings, lists,
  quotations and the rest. It goes into the file itself, so the page prints that
  way anywhere, and the editor shows it as it is typed.
- The right button on a document in the list opens it, copies it, throws it away,
  or tells what it is: the file's name and where it is, its size, when it was last
  saved, the paper it is set on, and how much is written in it.
- A running header and footer that really do repeat on every printed page: the
  writing is put in a table of one cell, which is the one thing a browser repeats
  across a page break, and each of them stands in a band of its own that the
  writing never runs into. What they say can carry the title of the document, its
  file name and the date and time it was saved, written in braces and filled in as
  the file is written.
- A check over the document: what is wrong with the page that a writer cannot see
  by looking at it -- a thing drawn across the edge of the paper, words running
  under something that was told to part them, a frame holding more than it can
  show, a photograph heavy enough to make the file slow, a page with nothing on
  it. Each one says which page it is on and takes you there.
- A view of the raw HTML of the current document.
- A layer bar and a page bar down the right. Every row of the layer bar can be
  dragged: two things standing on the paper change places in the pile, and anything
  else moves through the document.
- Categories down the left: a document can be filed in a folder inside the save
  folder, and the list shows one box per category — coloured as the writer likes,
  opening one at a time, with documents carried between them by dragging a row on
  to another box. A category is an ordinary folder, so the same filing is there in
  Files.
- Sharing with other accounts on this server, from the right button on a document
  or on a category: Nextcloud's own sharing, to read or to write, taken back from
  either place. A shared category hands over everything filed in it, and everything
  filed in it afterwards; somebody who may write in one can put new documents in it
  as well. What others have shared arrives under their own name in the list.
- Writing in one document at the same time as somebody else, in a shared mode that
  begins the moment a second person opens it. Every block of the document carries a
  name of its own; what is typed goes to the others in about a second without
  waiting for a save, through a fast lane held in Nextcloud's own cache and never
  written to disk. Their caret is drawn with their name on it, and the paragraph
  somebody is writing in is held against the other person -- the one case that
  cannot be merged is prevented rather than lost. The file is still saved the
  ordinary way, and a save that would land on top of somebody else's is merged
  instead of winning. No service of its own and nothing to install; a document
  nobody else has open does none of this.
- Light and dark themes, chosen per user, and English and Japanese translations.

### Known limits

- A page number cannot be printed from the file itself: a browser has no count of
  printed pages to give a document, and the margins of a printed page cannot be
  reached from the page. The print dialogue's own headers and footers add them.
- Vertical writing does not yet have the newest page fitting: frames that carry
  their writing on to the next page, and keeping a thing placed by hand on one
  sheet, are written for horizontal text so far.
- Printing has been checked in Chromium only.
- Writing together is by the paragraph, not by the letter: the paragraph somebody
  is writing in is held against the other person rather than the two being merged
  character by character.
