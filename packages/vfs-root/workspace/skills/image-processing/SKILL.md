---
name: image-processing
description: |
  Use this when converting, resizing, cropping, stitching, or annotating images;
  building a filmstrip, contact sheet, or grid; correcting orientation or color;
  or applying common ImageMagick-style effects with SLICC's `convert` / `magick`
  shell command.
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

## Verify and inspect

```bash
file /tmp/grid.jpg
open --view --size high /tmp/grid.jpg
convert --help
```

Keep the output path last. Multiple inputs must be reduced with `+append` or `-append`; escape group parentheses as `\(` and `\)` so the shell passes them to `convert`.
