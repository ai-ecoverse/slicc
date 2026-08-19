import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import {
  DEFAULT_PDF_DPI,
  dpiToScale,
  isPdfBytes,
  type RasterFormat,
  renderPdfPageRange,
} from './pdf-raster.js';
import { basename } from './shared.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

export interface ParsedPdftoppmArgs {
  inputPath: string;
  outputRoot: string | undefined;
  format: RasterFormat;
  dpi: number;
  firstPage?: number;
  lastPage?: number;
  scaleTo?: number;
  scaleToX?: number;
  scaleToY?: number;
  quality?: number;
  singleFile: boolean;
}

const HELP_TEXT = `usage: pdftoppm [options] <input.pdf> [output-prefix]

Rasterize PDF pages to images. Writes <prefix>-<n>.<ext> per page, where <n>
is zero-padded to the digit width of the last page (out-1.png for a 9-page
document, out-01.png for a 12-page one).

Options:
  -png               write PNG (default)
  -jpeg              write JPEG
  -jpegopt quality=N JPEG quality, 0-100 (default 90)
  -r DPI             resolution in DPI (default ${DEFAULT_PDF_DPI})
  -f N               first page to render
  -l N               last page to render (clamped to the page count)
  -scale-to N        scale the long edge to N pixels
  -scale-to-x N      scale width to N pixels
  -scale-to-y N      scale height to N pixels
  -singlefile        write exactly <prefix>.<ext>, with no page suffix
  -h, --help         show this help

If the output prefix is omitted it defaults to the input filename without its
extension, in the current directory. (Real poppler writes to stdout instead;
binary stdout is not useful here.)

Examples:
  pdftoppm -png -r 150 doc.pdf page
  pdftoppm -jpeg -jpegopt quality=80 -f 1 -l 3 doc.pdf out
  pdftoppm -png -singlefile -scale-to 1024 doc.pdf cover
`;

function help(): CmdResult {
  return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  if (value === undefined) throw new Error(`missing argument for ${flag}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseJpegOpt(value: string | undefined): number {
  if (value === undefined) throw new Error('missing argument for -jpegopt');
  // poppler accepts a comma-separated list; `quality` is the only knob that
  // maps onto OffscreenCanvas.convertToBlob, so the rest are ignored rather
  // than rejected — an agent copying a longer -jpegopt string still works.
  for (const entry of value.split(',')) {
    const [key, raw] = entry.split('=');
    if (key?.trim() !== 'quality') continue;
    const quality = Number(raw);
    if (!Number.isFinite(quality) || quality < 0 || quality > 100) {
      throw new Error(`invalid -jpegopt quality: ${raw}`);
    }
    return quality;
  }
  throw new Error(`unsupported -jpegopt: ${value}`);
}

/**
 * Parse the poppler-style argv. Throws on any user-facing error; the caller
 * maps the message onto a `${name}: ${msg}` stderr line.
 */
export function parsePdftoppmArgs(args: string[]): ParsedPdftoppmArgs {
  let format: RasterFormat = 'png';
  let dpi = DEFAULT_PDF_DPI;
  let firstPage: number | undefined;
  let lastPage: number | undefined;
  let scaleTo: number | undefined;
  let scaleToX: number | undefined;
  let scaleToY: number | undefined;
  let quality: number | undefined;
  let singleFile = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    switch (token) {
      case '-png':
        format = 'png';
        break;
      case '-jpeg':
        format = 'jpeg';
        break;
      case '-jpegopt':
        quality = parseJpegOpt(args[++index]);
        format = 'jpeg';
        break;
      case '-r':
        dpi = parsePositiveInt(args[++index], '-r');
        break;
      case '-f':
        firstPage = parsePositiveInt(args[++index], '-f');
        break;
      case '-l':
        lastPage = parsePositiveInt(args[++index], '-l');
        break;
      case '-scale-to':
        scaleTo = parsePositiveInt(args[++index], '-scale-to');
        break;
      case '-scale-to-x':
        scaleToX = parsePositiveInt(args[++index], '-scale-to-x');
        break;
      case '-scale-to-y':
        scaleToY = parsePositiveInt(args[++index], '-scale-to-y');
        break;
      case '-singlefile':
        singleFile = true;
        break;
      default:
        if (token.startsWith('-')) throw new Error(`unsupported option ${token}`);
        positionals.push(token);
    }
  }

  if (positionals.length === 0) throw new Error('expected an input PDF');
  if (positionals.length > 2)
    throw new Error('expected at most one input PDF and one output prefix');
  if (firstPage !== undefined && lastPage !== undefined && firstPage > lastPage) {
    throw new Error(`invalid page range: ${firstPage}-${lastPage}`);
  }

  return {
    inputPath: positionals[0],
    outputRoot: positionals[1],
    format,
    dpi,
    firstPage,
    lastPage,
    scaleTo,
    scaleToX,
    scaleToY,
    quality,
    singleFile,
  };
}

/** Strip a trailing extension: `doc.pdf` -> `doc`, `doc` -> `doc`. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * poppler names pages `<root>-<n>.<ext>`, zero-padding `<n>` to the digit
 * width of the *last rendered* page — so a 9-page render yields `out-1.png`
 * and a 12-page one yields `out-01.png`.
 */
export function formatPageFileName(
  root: string,
  pageNumber: number,
  lastPage: number,
  extension: string
): string {
  const width = String(lastPage).length;
  return `${root}-${String(pageNumber).padStart(width, '0')}.${extension}`;
}

function extensionFor(format: RasterFormat): string {
  return format === 'jpeg' ? 'jpg' : 'png';
}

/**
 * `-scale-to-x`/`-y` pin one axis; `-scale-to` fits the long edge (resolved
 * per page by the rasterizer); otherwise `-r` sets the DPI.
 */
function rasterSizing(parsed: ParsedPdftoppmArgs): {
  scale?: number;
  width?: number;
  height?: number;
  longEdge?: number;
} {
  if (parsed.scaleToX !== undefined) return { width: parsed.scaleToX };
  if (parsed.scaleToY !== undefined) return { height: parsed.scaleToY };
  if (parsed.scaleTo !== undefined) return { longEdge: parsed.scaleTo };
  return { scale: dpiToScale(parsed.dpi) };
}

async function readPdf(ctx: CommandContext, inputPath: string): Promise<Uint8Array> {
  const resolved = ctx.fs.resolvePath(ctx.cwd, inputPath);
  const data = await ctx.fs.readFileBuffer(resolved);
  if (!isPdfBytes(data)) throw new Error(`${inputPath}: not a PDF file`);
  return data;
}

export function createPdftoppmCommand(name: string = 'pdftoppm'): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return help();
    }

    let parsed: ParsedPdftoppmArgs;
    try {
      parsed = parsePdftoppmArgs(args);
    } catch (err) {
      return {
        stdout: '',
        stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }

    try {
      const data = await readPdf(ctx, parsed.inputPath);
      const extension = extensionFor(parsed.format);
      const root = parsed.outputRoot ?? stripExtension(basename(parsed.inputPath));

      const { pages } = await renderPdfPageRange(data, {
        firstPage: parsed.firstPage,
        // -singlefile renders exactly one page: the first requested one.
        lastPage: parsed.singleFile ? (parsed.firstPage ?? 1) : parsed.lastPage,
        format: parsed.format,
        quality: parsed.quality,
        ...rasterSizing(parsed),
      });

      if (pages.length === 0) {
        return { stdout: '', stderr: `${name}: no pages to render\n`, exitCode: 1 };
      }

      const lastRendered = pages[pages.length - 1].pageNumber;
      const written: string[] = [];
      for (const page of pages) {
        const fileName = parsed.singleFile
          ? `${root}.${extension}`
          : formatPageFileName(root, page.pageNumber, lastRendered, extension);
        const outputPath = ctx.fs.resolvePath(ctx.cwd, fileName);
        await ctx.fs.writeFile(outputPath, page.bytes);
        written.push(fileName);
      }

      // poppler is silent on success. Naming the files anyway is the one
      // deliberate divergence: an agent that guessed the prefix wrong
      // otherwise has to `ls` to find out what it produced.
      return { stdout: `${written.join('\n')}\n`, stderr: '', exitCode: 0 };
    } catch (err) {
      return {
        stdout: '',
        stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}
