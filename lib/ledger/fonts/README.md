# Fonts

Packed one-bit glyph maps, used only when dense PNG ingress is enabled.

- `font8x13.bin` — X.org `misc-fixed` 8×13 (X11 / MIT-style): 3676 glyphs covering
  ASCII, Latin-1, Latin Extended, Greek, Cyrillic, Hebrew, Thai, box drawing,
  arrows and geometric shapes. This is the shipped ASCII/Latin face.
- `snapcjk.bin` — 16×16 CJK map (`SNAPCJK1`), one blob per codepoint.

## Atlas format

`font8x13.bin` is an `FGATLAS1` atlas:

    magic   "FGATLAS1"            8 bytes
    width   u8                    glyph box width  (8, 9, 10, ...)
    height  u8                    glyph box height (13, 15, 16, 20, ...)
    pad     u16
    count   u32le
    cps     u32le × count         codepoints, ascending
    bits    count × ceil(w/8)*h   one-bit rows, top to bottom, MSB = leftmost

The box in the header is the one thing the renderer obeys: `blitGlyph` centres it in
the layout cell, and `resolveShape` grows the cell to hold it and re-derives the column
count from the request pixel budget. Swapping the atlas for a taller or wider one is
therefore a data change — nothing silently overflows the cell or the budget.

## Regenerating

    tools/make-atlas.py /usr/share/fonts/X11/misc/8x13.pcf.gz lib/fonts/font8x13.bin \
        --size 13 --cell 8x13 --cps-from lib/fonts/font8x13.bin

`--check-legacy` re-derives an old `F8X13` atlas glyph for glyph (3385/3385
non-combining glyphs match the shipped 8×13; the only differences are zero-width
combining marks, which FreeType repositions); `--upgrade` rewrites one in place
without re-rendering.

## Licence

`font8x13.bin` is derived from the X.org `misc-fixed` faces (X11 / MIT-style, © the
XFree86 Project); the repository LICENSE is plain MIT and does not reproduce that notice.
Any differently licensed face rendered by `tools/make-atlas.py` (say an OFL outline
font) needs its own notice shipped beside it.
