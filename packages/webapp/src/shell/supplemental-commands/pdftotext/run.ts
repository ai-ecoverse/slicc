/**
 * `pdftotext` implementation, loaded on first use by
 * `../pdftotext-command.ts`.
 */

import type { CommandContext, ResolvedCommandContext } from 'just-bash';
import { isPdfBytes } from '../pdf-raster.js';
import { extractPdfText, type PdfTextMode } from '../pdf-text.js';
import { isHelpRequest } from '../subcommand-help.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

type EolStyle = 'unix' | 'dos' | 'mac';

/** Flags that consume the next token, so a `--help` there stays a value. */
const VALUE_FLAGS = ['-f', '-l', '-enc', '-eol'] as const;

export interface ParsedPdftotextArgs {
  inputPath: string;
  /** Output file, `-` for stdout, or undefined for poppler's `<input>.txt` default. */
  outputPath: string | undefined;
  mode: PdfTextMode;
  firstPage?: number;
  lastPage?: number;
  /** Suppress the page-break form feeds between pages. */
  noPageBreaks: boolean;
  eol: EolStyle;
  quiet: boolean;
}

const HELP_TEXT = `usage: pdftotext [options] <input.pdf> [output.txt]

Extract text from a PDF via pdf.js. Writes <input>.txt next to the input when
no output file is given; pass "-" to write to stdout instead.

Options:
  -f N         first page to extract
  -l N         last page to extract (clamped to the page count)
  -layout      preserve the page's column layout by padding with spaces
  -raw         content-stream order (the default here; accepted for parity)
  -nopgbrk     do not emit a form feed (\\f) between pages
  -enc NAME    text encoding; only UTF-8 is supported
  -eol STYLE   line endings: unix (default), dos, or mac
  -q           do not print the output filename on success
  -h, --help   show this help

Examples:
  pdftotext report.pdf -            # text to stdout
  pdftotext -layout invoice.pdf -   # keep table columns aligned
  pdftotext -f 2 -l 5 book.pdf part.txt

Notes:
  Scanned PDFs carry no text layer. Rasterize with \`pdftoppm -png\` and read
  the pages as images instead — this command cannot OCR them.
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

function parseEncoding(value: string | undefined): void {
  if (value === undefined) throw new Error('missing argument for -enc');
  const normalized = value.toLowerCase().replace(/-/g, '');
  if (normalized !== 'utf8') throw new Error(`unsupported -enc value: ${value} (only UTF-8)`);
}

function parseEol(value: string | undefined): EolStyle {
  if (value === undefined) throw new Error('missing argument for -eol');
  if (value === 'unix' || value === 'dos' || value === 'mac') return value;
  throw new Error(`invalid -eol value: ${value}`);
}

/** Parse the poppler-style argv. Throws with a user-facing message. */
export function parsePdftotextArgs(args: string[]): ParsedPdftotextArgs {
  let mode: PdfTextMode = 'reading';
  let firstPage: number | undefined;
  let lastPage: number | undefined;
  let noPageBreaks = false;
  let eol: EolStyle = 'unix';
  let quiet = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    switch (token) {
      case '-f':
        firstPage = parsePositiveInt(args[++index], '-f');
        break;
      case '-l':
        lastPage = parsePositiveInt(args[++index], '-l');
        break;
      case '-layout':
        mode = 'layout';
        break;
      case '-raw':
        mode = 'reading';
        break;
      case '-nopgbrk':
        noPageBreaks = true;
        break;
      case '-enc':
        parseEncoding(args[++index]);
        break;
      case '-eol':
        eol = parseEol(args[++index]);
        break;
      case '-q':
        quiet = true;
        break;
      default:
        // A lone "-" is poppler's stdout sentinel, not a flag.
        if (token.startsWith('-') && token !== '-') throw new Error(`unsupported option ${token}`);
        positionals.push(token);
    }
  }

  if (positionals.length === 0) throw new Error('expected an input PDF');
  if (positionals.length > 2) throw new Error('expected at most one input PDF and one output file');
  if (firstPage !== undefined && lastPage !== undefined && firstPage > lastPage) {
    throw new Error(`invalid page range: ${firstPage}-${lastPage}`);
  }

  return {
    inputPath: positionals[0],
    outputPath: positionals[1],
    mode,
    firstPage,
    lastPage,
    noPageBreaks,
    eol,
    quiet,
  };
}

/** poppler replaces a `.pdf` extension with `.txt`; anything else gains one. */
export function defaultTextPath(inputPath: string): string {
  return inputPath.replace(/\.pdf$/i, '') + '.txt';
}

function applyEol(text: string, eol: EolStyle): string {
  if (eol === 'unix') return text;
  return text.replace(/\n/g, eol === 'dos' ? '\r\n' : '\r');
}

/**
 * poppler terminates every page with a form feed. Each page keeps a trailing
 * newline so `wc -l` and line-oriented tools see whole lines either way.
 */
export function joinPages(pages: string[], noPageBreaks: boolean): string {
  const bodies = pages.map((page) => (page.endsWith('\n') ? page : `${page}\n`));
  return bodies.join(noPageBreaks ? '' : '\f');
}

async function readPdf(ctx: CommandContext, inputPath: string): Promise<Uint8Array> {
  const data = await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, inputPath));
  if (!isPdfBytes(data)) throw new Error(`${inputPath}: not a PDF file`);
  return data;
}

/** Entry point for the `pdftotext` registration stub. */
export async function runPdftotext(
  name: string,
  args: string[],
  ctx: ResolvedCommandContext
): Promise<CmdResult> {
  // `isHelpRequest` rather than a scan for the token: `-enc --help` is an
  // invalid encoding, not a help request (docs/shell-reference.md's
  // value-shadowing contract).
  if (args.length === 0 || isHelpRequest(args, { valueFlags: VALUE_FLAGS })) {
    return help();
  }

  let parsed: ParsedPdftotextArgs;
  try {
    parsed = parsePdftotextArgs(args);
  } catch (err) {
    return {
      stdout: '',
      stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  try {
    const data = await readPdf(ctx, parsed.inputPath);
    const { pages } = await extractPdfText(data, {
      mode: parsed.mode,
      firstPage: parsed.firstPage,
      lastPage: parsed.lastPage,
    });
    const text = applyEol(joinPages(pages, parsed.noPageBreaks), parsed.eol);

    if (parsed.outputPath === '-') {
      return { stdout: text, stderr: '', exitCode: 0 };
    }

    const outputPath = parsed.outputPath ?? defaultTextPath(parsed.inputPath);
    await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, outputPath), text);
    // poppler is silent on success. Naming the file is the same deliberate
    // divergence `pdftoppm` makes: an agent that let the name default
    // otherwise has to `ls` to find out what it produced.
    return { stdout: parsed.quiet ? '' : `${outputPath}\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: '',
      stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}
