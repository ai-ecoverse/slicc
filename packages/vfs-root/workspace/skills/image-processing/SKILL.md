---
name: image-processing
description: |
  Use this when converting, resizing, cropping, stitching, or annotating images;
  building a filmstrip, contact sheet, or grid; correcting orientation or color;
  turning a PDF into PNG or JPEG images; reading a PDF's text layer; or applying
  common ImageMagick-style effects with SLICC's `convert` / `magick`,
  `pdftoppm`, and `pdftotext` shell commands.
allowed-tools: bash
---

# Image processing with `convert`

ImageMagick WASM locally. `magick` aliases `convert`.

## Filmstrips and grids

```bash
convert f00.jpg f01.jpg f02.jpg f03.jpg +append "$TMPDIR/filmstrip.jpg"
convert top.png middle.png bottom.png -append "$TMPDIR/column.png"
convert \( f00.jpg f01.jpg f02.jpg f03.jpg +append \) \
  \( f04.jpg f05.jpg f06.jpg f07.jpg +append \) -append "$TMPDIR/grid.jpg"
```

## Transforms

Left-to-right on preceding image:

```bash
convert photo.jpg -auto-orient -thumbnail '320x320>' -strip thumb.jpg
convert input.png -gravity center -crop 800x600+0+0 output.png
convert input.png -background white -gravity center -extent 1200x630 output.png
convert input.png -colorspace Gray -normalize -sharpen 0x1 output.png
```

Ops: geometry (`-resize`, `-crop`, `-extent`, `-rotate`), orientation (`-auto-orient`, `-flip`, `-flop`), cleanup (`-strip`, `-trim`, `-normalize`), color/effects (`-blur`, `-sharpen`, `-quality`). Modifiers `%` `!` `^` `>` `<` — quote metacharacters.

## Labels

```bash
convert frame.jpg -gravity south -fill white -undercolor '#000000aa' \
  -pointsize 24 -annotate +0+10 'Frame 07 — 00:03.5' labeled.jpg
```

Bundled Adobe Clean only (no custom `-font`). `-gravity`: `northwest`…`southeast`. Quote `#` colors.

## PDF → images

`pdftoppm` (`pdftocairo` alias):

```bash
pdftoppm -png -r 150 doc.pdf page           # page-1.png, page-2.png, …
pdftoppm -jpeg -jpegopt quality=80 doc.pdf page
pdftoppm -png -f 2 -l 4 doc.pdf page
pdftoppm -png -singlefile doc.pdf cover     # cover.png only
pdftoppm -png -scale-to 1024 doc.pdf thumb
```

Page suffix zero-pads to last-page digit width. Single page via `convert`:

```bash
convert -density 150 doc.pdf cover.png
convert doc.pdf[2] -resize 800x page3.jpg   # 0-based page index
```

Prefer `pdftoppm` for whole documents (one parse).

## PDF text

```bash
pdftotext report.pdf -
pdftotext -layout invoice.pdf -
pdftotext -f 2 -l 5 book.pdf part.txt
```

Empty output → scanned PDF, no OCR; use `pdftoppm -png`. `pdftk` for merge/split/rotate/burst; `pdftk in.pdf output plain.pdf uncompress` to grep operators.

Output path last. Escape `\(` `\)` for groups. Multiple inputs need `+append` / `-append`. `convert --help`, `pdftoppm --help`, `pdftotext --help`.
