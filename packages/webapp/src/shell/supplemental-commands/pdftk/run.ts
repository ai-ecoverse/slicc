/**
 * `pdftk` / `pdf` implementation, loaded on first use by
 * `../pdftk-command.ts`.
 */

import type { PDFDocument } from '@cantoo/pdf-lib';
import type { ResolvedCommandContext } from 'just-bash';
import { applyPdfStreamMode, type PdfStreamMode, saveOptionsFor } from '../pdf-streams.js';
import { extractPdfText } from '../pdf-text.js';

type PdfLib = typeof import('@cantoo/pdf-lib');
type CmdResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutKind?: 'text' | 'bytes';
  stdoutEncoding?: 'binary';
};

// Lazy-loaded dependency: pdf-lib is ~400 kB and most shells never touch a PDF.
let pdfLibPromise: Promise<PdfLib> | null = null;

async function getPdfLib(): Promise<PdfLib> {
  if (!pdfLibPromise) {
    pdfLibPromise = import('@cantoo/pdf-lib');
  }
  return pdfLibPromise;
}

interface PageRange {
  start: number;
  end: number | 'end';
  rotation?: 90 | 270 | 180;
}

interface InputHandle {
  handle: string;
  path: string;
}

const OPERATIONS = ['dump_data', 'dump_data_utf8', 'cat', 'rotate', 'burst'] as const;
type PdftkOperation = (typeof OPERATIONS)[number];
/** No operation keyword at all: `pdftk in.pdf output out.pdf [uncompress]`. */
type PdftkVerb = PdftkOperation | 'identity';

/** Trailing output options, which real pdftk accepts after `output <file>`. */
const OUTPUT_OPTIONS = new Set<PdfStreamMode>(['uncompress', 'compress']);

/**
 * Real pdftk operations SLICC does not implement. Listing them explicitly is
 * the point: an unrecognized keyword would otherwise be swallowed as another
 * input filename, and the run would die with a misleading "no operation
 * specified" after writing nothing at all.
 */
const UNSUPPORTED_OPERATIONS = new Set([
  'attach_files',
  'background',
  'dump_data_annots',
  'dump_data_fields',
  'dump_data_fields_utf8',
  'fill_form',
  'generate_fdf',
  'multibackground',
  'multistamp',
  'shuffle',
  'stamp',
  'unpack_files',
  'update_info',
  'update_info_utf8',
]);

/** Operations that take no arguments of their own. */
const ARGLESS_OPERATIONS = new Set<PdftkVerb>(['identity', 'dump_data', 'dump_data_utf8', 'burst']);

export interface PdftkInvocation {
  inputs: InputHandle[];
  operation: PdftkVerb;
  /** Arguments between the operation keyword and `output` (cat/rotate ranges). */
  operationArgs: string[];
  /** `output <path>`; `-` means stdout. Undefined when the form takes no output. */
  outputPath?: string;
  streamMode?: PdfStreamMode;
}

function isOperation(token: string): token is PdftkOperation {
  return (OPERATIONS as readonly string[]).includes(token);
}

function isOutputOption(token: string): token is PdfStreamMode {
  return OUTPUT_OPTIONS.has(token as PdfStreamMode);
}

function parseRotationSuffix(range: string): { range: string; rotation?: 90 | 270 | 180 } {
  if (range.endsWith('right')) {
    return { range: range.slice(0, -5), rotation: 90 };
  }
  if (range.endsWith('left')) {
    return { range: range.slice(0, -4), rotation: 270 };
  }
  if (range.endsWith('down')) {
    return { range: range.slice(0, -4), rotation: 180 };
  }
  return { range };
}

function parsePageRange(rangeStr: string): PageRange {
  const { range, rotation } = parseRotationSuffix(rangeStr);

  // Single page
  if (/^\d+$/.test(range)) {
    const page = parseInt(range, 10);
    return { start: page, end: page, rotation };
  }

  // Range
  const match = range.match(/^(\d+)-(\d+|end)$/);
  if (match) {
    const start = parseInt(match[1], 10);
    const end = match[2] === 'end' ? 'end' : parseInt(match[2], 10);
    return { start, end, rotation };
  }

  throw new Error(`Invalid page range: ${rangeStr}`);
}

function expandPageRange(range: PageRange, totalPages: number): number[] {
  const start = range.start;
  const endValue = range.end;

  if (start < 1 || start > totalPages) {
    throw new Error(`Page ${start} out of range (1-${totalPages})`);
  }

  const endNum: number = endValue === 'end' ? totalPages : endValue;

  if (endNum < 1 || endNum > totalPages) {
    throw new Error(`Page ${endNum} out of range (1-${totalPages})`);
  }
  if (endNum < start) {
    throw new Error(`Invalid range: ${start}-${endNum}`);
  }

  const pages: number[] = [];
  for (let i = start; i <= endNum; i++) {
    pages.push(i);
  }
  return pages;
}

const HELP_TEXT = `usage: pdftk <input.pdf> [<operation> [args...]] [output <output.pdf>] [options]

Operations:
  dump_data              Print metadata (page count, title, author, etc.)
  dump_data_utf8         Extract text content per page
                        (\`pdftotext\` is the better tool for text: it has
                         -layout, page ranges, and writes a .txt file)
  cat <ranges...> output <output.pdf>
                        Extract/rearrange pages; no ranges concatenates
                        every input in order
                        Examples:
                          pdftk in.pdf cat 1-3 output out.pdf
                          pdftk in.pdf cat 1 3-end output out.pdf
  rotate <ranges...> output <output.pdf>
                        Rotate pages (right=90°, left=270°, down=180°)
                        Example: pdftk in.pdf rotate 1-endright output out.pdf
  burst [output <pattern>]
                        Split into one file per page (default pg_%04d.pdf)
                        plus doc_data.txt

Merge operation:
  pdftk A=one.pdf B=two.pdf cat A B output merged.pdf

Output options (after \`output\`):
  uncompress            Inflate every stream and write a plain xref table,
                        so grep/sed can read the page operators
  compress              Deflate the streams again

Page ranges:
  3              Single page
  1-5            Range of pages
  3-end          From page 3 to end
  1-endright     Pages 1 to end, rotated 90° clockwise
  3left          Page 3 rotated 270° (counterclockwise)
  1-5down        Pages 1-5 rotated 180°

Pass \`output -\` to write the PDF to stdout.
`;

function help(): CmdResult {
  return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
}

function parseInputs(args: string[], state: { index: number }): InputHandle[] {
  const inputs: InputHandle[] = [];
  while (state.index < args.length) {
    const arg = args[state.index];
    const handleMatch = arg.match(/^([A-Z])=(.+)$/);
    if (handleMatch) {
      inputs.push({ handle: handleMatch[1], path: handleMatch[2] });
      state.index++;
      continue;
    }
    if (isOperation(arg) || arg === 'output' || isOutputOption(arg)) break;
    if (UNSUPPORTED_OPERATIONS.has(arg)) {
      throw new Error(`unsupported operation '${arg}'`);
    }
    if (arg.startsWith('-')) break;
    inputs.push({ handle: '', path: arg });
    state.index++;
  }
  return inputs;
}

/**
 * Parse pdftk's positional grammar. Throws with a user-facing message.
 *
 * Divergence from real pdftk: `uncompress`/`compress` are accepted wherever
 * they appear after the inputs, not only after `output <file>`. Agents write
 * both orders, and the alternative — treating the misplaced keyword as a
 * filename — is exactly the silent-no-op this parser exists to prevent.
 */
export function parsePdftkArgs(args: string[]): PdftkInvocation {
  const state = { index: 0 };
  const inputs = parseInputs(args, state);
  if (inputs.length === 0) {
    throw new Error('no input PDF specified');
  }

  let operation: PdftkVerb = 'identity';
  const verb = args[state.index];
  if (verb !== undefined && isOperation(verb)) {
    operation = verb;
    state.index++;
  }

  const operationArgs: string[] = [];
  let streamMode: PdfStreamMode | undefined;
  while (state.index < args.length && args[state.index] !== 'output') {
    const token = args[state.index];
    if (isOutputOption(token)) streamMode = token;
    // pdftk's grammar is positional: it has no dash flags beyond `--help`.
    // Rejecting one here keeps an unrecognised flag from being read as a page
    // range ("Invalid page range: -x") or, worse, ignored.
    else if (token.startsWith('-') && token !== '-') {
      throw new Error(`unsupported option '${token}'`);
    } else operationArgs.push(token);
    state.index++;
  }

  let outputPath: string | undefined;
  if (args[state.index] === 'output') {
    state.index++;
    outputPath = args[state.index];
    if (!outputPath) throw new Error('output filename not specified');
    state.index++;
  }

  for (; state.index < args.length; state.index++) {
    const option = args[state.index];
    if (isOutputOption(option)) streamMode = option;
    else throw new Error(`unsupported option '${option}'`);
  }

  validateInvocation(operation, operationArgs, outputPath);
  return { inputs, operation, operationArgs, outputPath, streamMode };
}

function validateInvocation(
  operation: PdftkVerb,
  operationArgs: string[],
  outputPath: string | undefined
): void {
  if (ARGLESS_OPERATIONS.has(operation) && operationArgs.length > 0) {
    throw new Error(`unexpected argument '${operationArgs[0]}'`);
  }
  if (operation === 'rotate' && operationArgs.length === 0) {
    throw new Error('rotate requires at least one page range');
  }
  if ((operation === 'cat' || operation === 'rotate') && !outputPath) {
    throw new Error(`${operation} operation requires 'output <filename>'`);
  }
  if (operation === 'identity' && !outputPath) {
    throw new Error('no operation specified');
  }
}

interface LoadedInput {
  handle: string;
  doc: PDFDocument;
}

async function loadInputs(
  pdfLib: PdfLib,
  ctx: ResolvedCommandContext,
  inputs: InputHandle[]
): Promise<LoadedInput[]> {
  const loaded: LoadedInput[] = [];
  for (const input of inputs) {
    const bytes = await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, input.path));
    loaded.push({ handle: input.handle, doc: await pdfLib.PDFDocument.load(bytes) });
  }
  return loaded;
}

function requireSingleInput(inputs: InputHandle[], operation: string): InputHandle {
  if (inputs.length > 1) {
    throw new Error(`${operation} only supports a single input file`);
  }
  return inputs[0];
}

/** Serialize `doc`, applying the requested `uncompress`/`compress` first. */
async function saveDocument(
  pdfLib: PdfLib,
  doc: PDFDocument,
  streamMode: PdfStreamMode | undefined
): Promise<Uint8Array> {
  if (streamMode) await applyPdfStreamMode(pdfLib, doc, streamMode);
  return doc.save(saveOptionsFor(streamMode));
}

/** Latin1 view of `bytes`, chunked to stay under the argument-count limit. */
function latin1From(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return out;
}

/**
 * `output -` streams the PDF to stdout as bytes; anything else hits the VFS.
 *
 * The byte-shaped result is built by hand rather than with just-bash's
 * `bytesOutput()` helper: that helper lives in the Node entry only, and the
 * webapp resolves just-bash's browser bundle, which does not re-export it.
 * `stdoutKind` + the legacy `stdoutEncoding` alias are what the helper sets,
 * and the browser bundle's own byte-producing commands set exactly this pair.
 */
async function emitPdf(
  ctx: ResolvedCommandContext,
  outputPath: string,
  bytes: Uint8Array
): Promise<CmdResult> {
  if (outputPath === '-') {
    return {
      stdout: latin1From(bytes),
      stdoutKind: 'bytes',
      stdoutEncoding: 'binary',
      stderr: '',
      exitCode: 0,
    };
  }
  await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, outputPath), bytes);
  return { stdout: `Created ${outputPath}\n`, stderr: '', exitCode: 0 };
}

/** Text-producing operations honour `output <file>` too, like real pdftk. */
async function emitText(
  ctx: ResolvedCommandContext,
  outputPath: string | undefined,
  text: string
): Promise<CmdResult> {
  if (outputPath === undefined || outputPath === '-') {
    return { stdout: text, stderr: '', exitCode: 0 };
  }
  await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, outputPath), text);
  return { stdout: `Created ${outputPath}\n`, stderr: '', exitCode: 0 };
}

function dumpDataText(doc: PDFDocument): string {
  const lines: string[] = [`NumberOfPages: ${doc.getPageCount()}`];
  const fields: Array<[string, string | undefined]> = [
    ['Title', doc.getTitle()],
    ['Author', doc.getAuthor()],
    ['Creator', doc.getCreator()],
    ['Producer', doc.getProducer()],
  ];
  for (const [key, value] of fields) {
    if (!value) continue;
    lines.push('InfoBegin', `InfoKey: ${key}`, `InfoValue: ${value}`);
  }
  return lines.join('\n') + '\n';
}

async function runDumpData(
  pdfLib: PdfLib,
  ctx: ResolvedCommandContext,
  inv: PdftkInvocation
): Promise<CmdResult> {
  const input = requireSingleInput(inv.inputs, 'dump_data');
  const bytes = await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, input.path));
  const doc = await pdfLib.PDFDocument.load(bytes);
  return emitText(ctx, inv.outputPath, dumpDataText(doc));
}

async function runDumpDataUtf8(
  ctx: ResolvedCommandContext,
  inv: PdftkInvocation
): Promise<CmdResult> {
  const input = requireSingleInput(inv.inputs, 'dump_data_utf8');
  const bytes = await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, input.path));
  const { pages } = await extractPdfText(bytes);
  // One page per line-block. Joining the array with its default `,` (what this
  // used to do) glued the last word of each page to the first of the next.
  return emitText(ctx, inv.outputPath, pages.map((page) => page.trimEnd()).join('\n') + '\n');
}

/** Append every page of `source` to `outputDoc`. */
async function copyWholeDocument(outputDoc: PDFDocument, source: PDFDocument): Promise<void> {
  const indices = Array.from({ length: source.getPageCount() }, (_, index) => index);
  for (const page of await outputDoc.copyPages(source, indices)) outputDoc.addPage(page);
}

async function copyRanges(
  pdfLib: PdfLib,
  outputDoc: PDFDocument,
  loaded: LoadedInput[],
  rangeSpecs: string[]
): Promise<void> {
  // No ranges: concatenate every input in the order it was given, which is how
  // `pdftk A=a.pdf B=b.pdf cat output merged.pdf` merges documents.
  if (rangeSpecs.length === 0) {
    for (const input of loaded) await copyWholeDocument(outputDoc, input.doc);
    return;
  }

  const byHandle = new Map(loaded.filter((i) => i.handle).map((i) => [i.handle, i.doc]));
  const defaultDoc = loaded[0].doc;

  for (const spec of rangeSpecs) {
    if (/^[A-Z]$/.test(spec)) {
      const source = byHandle.get(spec);
      if (!source) throw new Error(`unknown handle '${spec}'`);
      await copyWholeDocument(outputDoc, source);
      continue;
    }

    const range = parsePageRange(spec);
    const indices = expandPageRange(range, defaultDoc.getPageCount()).map((page) => page - 1);
    for (const page of await outputDoc.copyPages(defaultDoc, indices)) {
      if (range.rotation) page.setRotation(pdfLib.degrees(range.rotation));
      outputDoc.addPage(page);
    }
  }
}

async function runCat(
  pdfLib: PdfLib,
  ctx: ResolvedCommandContext,
  inv: PdftkInvocation
): Promise<CmdResult> {
  const loaded = await loadInputs(pdfLib, ctx, inv.inputs);
  const outputDoc = await pdfLib.PDFDocument.create();
  await copyRanges(pdfLib, outputDoc, loaded, inv.operationArgs);
  const bytes = await saveDocument(pdfLib, outputDoc, inv.streamMode);
  // `output` is required for cat, so the path is present here.
  return emitPdf(ctx, inv.outputPath as string, bytes);
}

async function runRotate(
  pdfLib: PdfLib,
  ctx: ResolvedCommandContext,
  inv: PdftkInvocation
): Promise<CmdResult> {
  const input = requireSingleInput(inv.inputs, 'rotate');
  const bytes = await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, input.path));
  const doc = await pdfLib.PDFDocument.load(bytes);
  const totalPages = doc.getPageCount();

  const rotations = new Map<number, number>();
  for (const spec of inv.operationArgs) {
    const range = parsePageRange(spec);
    if (!range.rotation) {
      throw new Error(`rotation suffix required (right/left/down) for range '${spec}'`);
    }
    for (const pageNum of expandPageRange(range, totalPages)) {
      rotations.set(pageNum - 1, range.rotation);
    }
  }

  const pages = doc.getPages();
  for (const [index, rotation] of rotations.entries()) {
    const page = pages[index];
    page.setRotation(pdfLib.degrees((page.getRotation().angle + rotation) % 360));
  }

  return emitPdf(ctx, inv.outputPath as string, await saveDocument(pdfLib, doc, inv.streamMode));
}

/** Expand pdftk's `%d` / `%0Nd` burst pattern for a 1-based page number. */
export function formatBurstName(pattern: string, pageNumber: number): string {
  const match = pattern.match(/%(0(\d+))?d/);
  if (!match) throw new Error(`burst pattern must contain %d: ${pattern}`);
  const width = match[2] ? parseInt(match[2], 10) : 1;
  return pattern.replace(match[0], String(pageNumber).padStart(width, '0'));
}

async function runBurst(
  pdfLib: PdfLib,
  ctx: ResolvedCommandContext,
  inv: PdftkInvocation
): Promise<CmdResult> {
  const input = requireSingleInput(inv.inputs, 'burst');
  const bytes = await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, input.path));
  const doc = await pdfLib.PDFDocument.load(bytes);
  const pattern = inv.outputPath && inv.outputPath !== '-' ? inv.outputPath : 'pg_%04d.pdf';

  const written: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.getPageCount(); pageNumber++) {
    const pageDoc = await pdfLib.PDFDocument.create();
    const [page] = await pageDoc.copyPages(doc, [pageNumber - 1]);
    pageDoc.addPage(page);
    const name = formatBurstName(pattern, pageNumber);
    await ctx.fs.writeFile(
      ctx.fs.resolvePath(ctx.cwd, name),
      await saveDocument(pdfLib, pageDoc, inv.streamMode)
    );
    written.push(name);
  }

  // Real pdftk drops the source metadata next to the pages.
  await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, 'doc_data.txt'), dumpDataText(doc));
  written.push('doc_data.txt');
  return { stdout: `${written.join('\n')}\n`, stderr: '', exitCode: 0 };
}

async function runIdentity(
  pdfLib: PdfLib,
  ctx: ResolvedCommandContext,
  inv: PdftkInvocation
): Promise<CmdResult> {
  const loaded = await loadInputs(pdfLib, ctx, inv.inputs);
  // A single input passes straight through (that is where `uncompress` lands);
  // several inputs concatenate, matching pdftk's implicit cat.
  const doc = loaded.length === 1 ? loaded[0].doc : await pdfLib.PDFDocument.create();
  if (loaded.length > 1) await copyRanges(pdfLib, doc, loaded, []);
  return emitPdf(ctx, inv.outputPath as string, await saveDocument(pdfLib, doc, inv.streamMode));
}

async function runInvocation(
  ctx: ResolvedCommandContext,
  inv: PdftkInvocation
): Promise<CmdResult> {
  if (inv.operation === 'dump_data_utf8') return runDumpDataUtf8(ctx, inv);
  const pdfLib = await getPdfLib();
  switch (inv.operation) {
    case 'dump_data':
      return runDumpData(pdfLib, ctx, inv);
    case 'cat':
      return runCat(pdfLib, ctx, inv);
    case 'rotate':
      return runRotate(pdfLib, ctx, inv);
    case 'burst':
      return runBurst(pdfLib, ctx, inv);
    default:
      return runIdentity(pdfLib, ctx, inv);
  }
}

/** Entry point for the `pdftk` / `pdf` registration stub. */
export async function runPdftk(
  name: string,
  args: string[],
  ctx: ResolvedCommandContext
): Promise<CmdResult> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return help();
  }

  try {
    return await runInvocation(ctx, parsePdftkArgs(args));
  } catch (err) {
    return {
      stdout: '',
      stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}
