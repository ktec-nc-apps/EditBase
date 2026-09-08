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
- Versions kept beside the document: the state before each save is written to a
  file of its own in the same folder, named after the document with its extension
  replaced by a number -- 報告書.html keeps 報告書.#01, the newest, with the older
  ones shifting down as far as the writer allows (up to 99, ten by default, nought
  for none). They are plain HTML like everything else, so a version opens in any
  browser. A version is taken when the writer saves; the autosave can be made to
  take one too. They follow the document when it is renamed or moved to another
  category, and go with it when it is deleted. Putting one back keeps what was
  there as a version of its own, so that can be undone in turn.
- A view of the raw HTML of the current document.
- A layer bar and a page bar down the right. Every row of the layer bar can be
  dragged with the mouse: dropped on another row it joins that thing's layer, on a
  layer's heading it moves to that layer, and above or below them all it gets a
  layer of its own. Anything that is not standing on the paper moves through the
  document instead. The levels are renumbered from the bottom after every change,
  so they stay one apart with nothing empty in between. The two places to drop for
  a layer of one's own stay pinned at the top and the bottom of the bar, and the
  list scrolls itself when a row is held near either end, so they can be reached
  however long the list is. A dragged row travels with the pointer, and a place
  that would do nothing is greyed out with the reason written in it rather than
  quietly ignoring the drop. The numbers shown in the bar close up after a
  deletion, but only in what is shown: looking at the bar never rewrites the
  levels in the document, which would move things in the pile and change which of
  two overlapping things the writing flows around. A layer itself is dragged by
  its heading and everything on it moves together, and a new empty layer is made
  with the button in the bar's head and becomes real when the first thing is
  dropped into it. A thing drawn on the page has no level of its own; the bar
  shows it at the level the browser actually paints it, and writes the levels
  down the moment the writer moves something through the pile.
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
- A styles designer: the look of every heading, list, quotation, table cell and
  caption in the document set by hand rather than by writing CSS -- typeface,
  size, colour, letter spacing, weight, alignment, line height, indent, the space
  above and below, a fill, a border on any side and the mark in front of a list
  item -- with a sample of the writing above the controls that changes as they are
  moved. The CSS is still there, folded away at the foot of the dialogue, for
  anyone who would rather write it.
- Emoji: the whole Unicode set in nine groups, searchable by name in the user's own
  language, put in at the caret. The character is what goes into the file, so it is
  drawn by whatever emoji font the reader's machine has.
- Light and dark themes, chosen per user, and English and Japanese translations.

### Fixed

- The editor no longer draws a sheet the printer does not make. It counted sheets
  from the height of the whole column of writing; the printer counts by what fits
  in each page's own text area. When the writing ended a little past a fold -- one
  empty paragraph was enough -- the editor showed a blank last page that never
  printed. The count now follows the writing page by page, and a blank page put in
  on purpose still counts as a page.
- Anything standing on the page shows its own box when it is clicked, wherever in
  the box the click lands. A list, a quotation or a heading placed by hand was not
  counted as an object at all, so clicking one gave the box of whatever paragraph
  lay behind it; and a click on the transparent part of any object -- a picture's
  corner, the empty half of a list -- fell through in the same way. What stands
  under the pointer is now what is taken hold of, the innermost first and the one
  drawn on top before the one drawn under.
- A running header and footer that stand where they were asked to stand: in the
  paper's own margin, three millimetres clear of the writing, as deep as the
  writer chooses up to the margin less those three. They are written into the
  page's own margin boxes, so the printer repeats them on every page and counts
  the pages itself -- {page} and {pages} are the printer's counters, not words.
  They can be typed straight into the band on the first sheet, and shown on every
  page or on the first alone. The writing does not move by a hair for them: it
  begins where the margin says it does.
- Words no longer run through an object that stands beside another. A real float
  in the same paragraph was counted as taking room from every line of it, so a
  second object further down was left with no room to be kept clear of, and the
  words walked straight through it. What a float takes is now counted only on the
  lines it actually stands on.
- Setting a size on the words chosen inside a 文字枠 no longer changes the whole
  frame. Clicking the size box on the toolbar takes the selection away before the
  value is read; the last run of words chosen is now remembered and put back.
- A 文字枠 asked to hold a list, a table or a picture becomes a frame that can
  hold blocks, keeping its place and its size. It used to be thrown away and its
  words left standing loose on the page.
- Styling a word inside a block that carries that style no longer takes the block
  apart: a 文字枠 with a size of its own was pulled out of the document when the
  size of a few words in it was changed.
- Opening a document no longer counts as writing it. Setting the paper of the
  document being opened was taken for a change made by the writer, so the file
  was saved a couple of seconds later and a version kept of it: a document nobody
  had touched grew a snapshot every time it was looked at.
- A long document opens in seconds rather than in half a minute, and the keyboard
  is free while it does. A frame carried over page by page was laid out again by
  the browser after every cut -- the whole document, every time -- so a story of a
  hundred and twenty pages was laid out a hundred and twenty times. What is far
  below the page being cut is now lifted out while that page is measured and put
  back afterwards, the pages are counted from one reading instead of one for every
  page, and a frame that cannot be made to fit is not laid out again and again in
  the hope of a different answer. Opening 銀河鉄道の夜 (35 pages) went from 39
  seconds to 2.5, and こころ (127 pages) from 38 seconds to 6.
- A table taller than the page is now carried on to the next page, cut between
  its rows -- and where a single row is taller than the page, cell by cell, the
  lists and the tables inside it cut in the same way. It used to stay whole in
  one frame and run off the paper: the editor drew eight sheets where the printer
  made thirteen pages. A head row is repeated on the next page as the printer
  repeats it, unless it is a banner deep enough to cost a third of the page.
- A document with a frame carried on to another page could come back twice as
  long. The carried-on frame wore the same name as the frame it carries on from,
  so the machinery that folds in another person's writing took it for that frame
  and wrote the whole of it over the last link of the chain. Every carried-on
  frame now has a name of its own.
- A block cut across three pages or more is put back as the one block it was.
  The mark saying "this was cut" was taken off as soon as the second piece was
  joined, so the third stood on as a block of its own -- which is how a table
  grew a repeated head row at every pass.
- A frame that stops short because the next row will not fit is left alone. It
  was read as half empty and laid out again, over and over, without ever settling.
- A table standing in another table's cell kept being taken apart. Its header row
  was read as the outer table's, so at every opening one more row was lifted out
  of the inner table and put at the top of the outer one: a Wikipedia article
  came back in a different order every time it was read, for ever. The head is
  now looked for in the table itself and nowhere else.
- A document no longer grows every time it is saved. Cutting a paragraph at the
  very edge of a link left the link behind with nothing in it; the next pass cut
  at the same place and left another beside it. Those empty shells are taken off
  as the cut is made.
- The screen and the printout now agree, measured page by page against Chrome's
  own printing: a frame carried on to the next page kept a top margin on paper
  that the editor did not draw, and a thing placed by hand was allowed to hang
  into the bottom margin, where the printer cut it in two and put the lower part
  on a sheet of its own.
- Objects that keep the words clear no longer fight when they stand together. The
  room an object holds is a float, and floats wider than the column together do
  not sit side by side -- the second drops below the first, where it holds nothing
  off anything. So the room is now cut to what the other things on that line
  leave: what another band wants, and what a floated object has already taken,
  measured to the edge of the writing rather than from its own width. Three and a
  half millimetres of that difference was enough to send a band below a floated
  arrow and let two lines run straight through the list beside it.
- A thing put down by hand now stays where it was dropped. Its place is kept as a
  distance from the line it hangs on, measured down a column with no page gaps in
  it, while the editor draws a column with a gap at every fold; the conversion
  between the two was wrong for a thing whose page was not its line's page, so a
  formula dragged thirty millimetres up the page came to rest forty down. The
  answer is now measured after the fact and the difference taken out.
- Room can be made for a thing that stands below the last line of its frame: it
  had nothing to hang from, kept the far end of the frame as its line, and room is
  only ever made below that line -- so the words simply ran through it.
- Anything with no writing in it -- a formula, a picture, a rule, an empty shape --
  is now picked up anywhere on it. Only the eight pixels of its edge would take
  hold before, which on a formula four millimetres tall meant it could not be
  moved at all. Things that hold words still keep to their edge, because a click
  in the middle of those has to put the caret in the writing.
- A thing placed inside a frame stays in that frame when the page has to give it
  room, instead of being stood on the foot of the page outside the box.

- An item of a list is put in one level with Tab and taken out again with
  Shift+Tab, and what that makes is a list inside a list -- the markers change
  with the level (a ring under a dot, a square under that), a numbered list
  counts in letters inside and in small roman numerals inside that, and the file
  written is an ordinary nested list that reads correctly anywhere. It used to
  add an indent to the item and leave the list flat.
- The little pages in the preview bar are the pages themselves, made small,
  rather than a plan of grey boxes.
- A frame that carries its writing on to the next page now makes the editor draw
  that page. It was drawn below the last sheet while the printer duly made a
  second page.

- Deleting everything in a document leaves a plain paragraph to type on. What
  was left before was the first block's tag, so a document that began with a
  heading was wiped to an empty heading and everything typed next came out as a
  heading too.

- What is written to a file is cleaned on the way out as well as on the way in.
  Everything arriving is checked -- what is opened, what is pasted, what somebody
  else writing in the document sends -- but a saved file is opened by a browser
  with nothing else around it, so a script or a handler that ever found its way
  into the writing would have been written into a page and run when it was
  opened.

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
