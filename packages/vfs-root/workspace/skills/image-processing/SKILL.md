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

SLICC's local ImageMagick WASM command handles common image transforms, multi-image composition, and labels without network access. `magick` is an alias for `convert`.

## Compose filmstrips and grids

Join images horizontally with `+append` or vertically with `-append`:

```bash
convert f00.jpg f01.jpg f02.jpg f03.jpg +append /tmp/filmstrip.jpg
convert top.png middle.png bottom.png -append /tmp/column.png
```

Build grids with escaped parenthesized groups. Each group produces one intermediate image:

```bash
convert \( f00.jpg f01.jpg f02.jpg f03.jpg +append \) \
  \( f04.jpg f05.jpg f06.jpg f07.jpg +append \) \
  -append /tmp/grid.jpg
```

## Transform images

Operations run from left to right on the preceding image or group:

```bash
convert photo.jpg -auto-orient -thumbnail '320x320>' -strip thumb.jpg
convert input.png -gravity center -crop 800x600+0+0 output.png
convert input.png -background white -gravity center -extent 1200x630 output.png
convert input.png -colorspace Gray -normalize -sharpen 0x1 output.png
```

Common operations:

- Geometry: `-resize`, `-thumbnail`, `-crop`, `-extent`, `-rotate`
- Orientation: `-auto-orient`, `-flip`, `-flop`
- Cleanup: `-strip`, `-trim`, `-auto-gamma`, `-auto-level`, `-normalize`
- Color/alpha: `-background`, `-alpha`, `-colorspace`, `-transparent`, `-negate`
- Effects: `-blur R[xS]`, `-sharpen R[xS]`
- Output: `-quality 0-100`

Resize geometry accepts ImageMagick modifiers such as `%`, `!`, `^`, `>`, and `<`. Quote geometry containing shell metacharacters.

## Add labels

Configure the drawing state before `-annotate`:

```bash
convert frame.jpg -gravity south -fill white -undercolor '#000000aa' \
  -pointsize 24 -annotate +0+10 'Frame 07 — 00:03.5' labeled.jpg
```

Annotation uses the bundled Adobe Clean font; custom `-font` selection is not supported yet.

Use `-gravity` with `northwest`, `north`, `northeast`, `west`, `center`, `east`, `southwest`, `south`, or `southeast`. Quote label text and colors containing `#`.

## Rasterize a PDF

`pdftoppm` turns PDF pages into images. `pdftocairo` is an alias.

```bash
pdftoppm -png -r 150 doc.pdf page      # page-1.png, page-2.png, ...
pdftoppm -jpeg -jpegopt quality=80 doc.pdf page
pdftoppm -png -f 2 -l 4 doc.pdf page   # pages 2-4 only
pdftoppm -png -singlefile doc.pdf cover  # exactly cover.png, no page suffix
pdftoppm -png -scale-to 1024 doc.pdf thumb
```

Page files are numbered `<prefix>-<n>.<ext>`, zero-padded to the digit width of
the last page — `page-1.png` for a 9-page document, `page-01.png` for a 12-page
one. `pdftoppm` prints the filenames it wrote.

For a single page you can also feed the PDF straight to `convert`, which
rasterizes it first and accepts ImageMagick's 0-based bracket page selector:

```bash
convert -density 150 doc.pdf cover.png     # first page
convert doc.pdf[2] -resize 800x page3.jpg  # third page, resized
```

Prefer `pdftoppm` for whole documents: it parses the PDF once, while repeated
`convert` calls re-parse it per page.

## Read a PDF's text

When you need the words rather than the picture, skip rasterizing: `pdftotext`
reads the text layer directly, with no image and no vision tokens.

```bash
pdftotext report.pdf -            # text to stdout
pdftotext -layout invoice.pdf -   # keep table columns aligned
pdftotext -f 2 -l 5 book.pdf part.txt
```

Near-empty output means a scanned PDF with no text layer: rasterize with
`pdftoppm -png` and read the pages as images instead. There is no OCR.

`pdftk` handles the rest of the page-level work (merge, split, rotate, burst)
without rendering, and `pdftk in.pdf output plain.pdf uncompress` inflates the
streams when you need to grep the raw page operators.

## Verify and inspect

```bash
file /tmp/grid.jpg
open --view --size high /tmp/grid.jpg
convert --help
pdftoppm --help
pdftotext --help
```

Keep the output path last. Multiple inputs must be reduced with `+append` or `-append`; escape group parentheses as `\(` and `\)` so the shell passes them to `convert`.
