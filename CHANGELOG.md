# Changelog

All notable changes to EditBase are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-08-23

First working version.

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
- A view of the raw HTML of the current document.
- Light and dark themes, chosen per user, and English and Japanese translations.
