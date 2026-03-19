import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

// Lazy-loaded dependencies
let pdfLibPromise: Promise<typeof import('@cantoo/pdf-lib')> | null = null;
let unpdfPromise: Promise<typeof import('unpdf')> | null = null;

async function getPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import('@cantoo/pdf-lib');
  }
  return pdfLibPromise;
}

async function getUnpdf() {
  if (!unpdfPromise) {
    unpdfPromise = import('unpdf');
  }
  return unpdfPromise;
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

function pdftkHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: pdftk <input.pdf> <operation> [args...]

Operations:
  dump_data              Print metadata (page count, title, author, etc.)
  dump_data_utf8         Extract text content per page
  cat <ranges...> output <output.pdf>
                        Extract/rearrange pages
                        Examples:
                          pdftk in.pdf cat 1-3 output out.pdf
                          pdftk in.pdf cat 1 3-end output out.pdf
  rotate <ranges...> output <output.pdf>
                        Rotate pages (right=90°, left=270°, down=180°)
                        Example: pdftk in.pdf rotate 1-endright output out.pdf

Merge operation:
  pdftk A=one.pdf B=two.pdf cat A B output merged.pdf

Page ranges:
  3              Single page
  1-5            Range of pages
  3-end          From page 3 to end
  1-endright     Pages 1 to end, rotated 90° clockwise
  3left          Page 3 rotated 270° (counterclockwise)
  1-5down        Pages 1-5 rotated 180°
`,
    stderr: '',
    exitCode: 0,
  };
}

export function createPdftkCommand(name: string = 'pdftk'): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return pdftkHelp();
    }

    try {
      // Parse input handles (A=file.pdf B=file2.pdf) or simple input.pdf
      const inputHandles: InputHandle[] = [];
      let argIdx = 0;

      // First, parse all input file specifications
      while (argIdx < args.length) {
        const arg = args[argIdx];

        // Check for handle syntax: A=file.pdf
        const handleMatch = arg.match(/^([A-Z])=(.+)$/);
        if (handleMatch) {
          const handle = handleMatch[1];
          const path = ctx.fs.resolvePath(ctx.cwd, handleMatch[2]);
          inputHandles.push({ handle, path });
          argIdx++;
          continue;
        }

        // Check if this is an operation keyword
        if (['dump_data', 'dump_data_utf8', 'cat', 'rotate'].includes(arg)) {
          break;
        }

        // Otherwise, treat as simple input file (no handle)
        if (!arg.startsWith('-')) {
          const path = ctx.fs.resolvePath(ctx.cwd, arg);
          inputHandles.push({ handle: '', path });
          argIdx++;
          continue;
        }

        break;
      }

      if (inputHandles.length === 0) {
        return {
          stdout: '',
          stderr: `${name}: no input PDF specified\n`,
          exitCode: 1,
        };
      }

      const operation = args[argIdx];
      argIdx++;

      if (!operation) {
        return {
          stdout: '',
          stderr: `${name}: no operation specified\n`,
          exitCode: 1,
        };
      }

      // dump_data operation
      if (operation === 'dump_data') {
        if (inputHandles.length > 1) {
          return {
            stdout: '',
            stderr: `${name}: dump_data only supports a single input file\n`,
            exitCode: 1,
          };
        }

        const pdfLib = await getPdfLib();
        const inputBytes = await ctx.fs.readFileBuffer(inputHandles[0].path);
        const pdfDoc = await pdfLib.PDFDocument.load(inputBytes);

        const lines: string[] = [];
        lines.push(`NumberOfPages: ${pdfDoc.getPageCount()}`);

        const title = pdfDoc.getTitle();
        if (title) lines.push(`InfoBegin`);
        if (title) lines.push(`InfoKey: Title`);
        if (title) lines.push(`InfoValue: ${title}`);

        const author = pdfDoc.getAuthor();
        if (author) lines.push(`InfoBegin`);
        if (author) lines.push(`InfoKey: Author`);
        if (author) lines.push(`InfoValue: ${author}`);

        const creator = pdfDoc.getCreator();
        if (creator) lines.push(`InfoBegin`);
        if (creator) lines.push(`InfoKey: Creator`);
        if (creator) lines.push(`InfoValue: ${creator}`);

        const producer = pdfDoc.getProducer();
        if (producer) lines.push(`InfoBegin`);
        if (producer) lines.push(`InfoKey: Producer`);
        if (producer) lines.push(`InfoValue: ${producer}`);

        return {
          stdout: lines.join('\n') + '\n',
          stderr: '',
          exitCode: 0,
        };
      }

      // dump_data_utf8 operation (text extraction)
      if (operation === 'dump_data_utf8') {
        if (inputHandles.length > 1) {
          return {
            stdout: '',
            stderr: `${name}: dump_data_utf8 only supports a single input file\n`,
            exitCode: 1,
          };
        }

        const unpdf = await getUnpdf();
        const inputBytes = await ctx.fs.readFileBuffer(inputHandles[0].path);
        const result = await unpdf.extractText(inputBytes);

        return {
          stdout: result.text + '\n',
          stderr: '',
          exitCode: 0,
        };
      }

      // cat operation (extract/merge pages)
      if (operation === 'cat') {
        const pdfLib = await getPdfLib();
        const outputDoc = await pdfLib.PDFDocument.create();

        // Parse the cat arguments
        const catArgs = args.slice(argIdx);
        const outputIdx = catArgs.indexOf('output');

        if (outputIdx === -1) {
          return {
            stdout: '',
            stderr: `${name}: cat operation requires 'output <filename>'\n`,
            exitCode: 1,
          };
        }

        const rangeSpecs = catArgs.slice(0, outputIdx);
        const outputPath = catArgs[outputIdx + 1];

        if (!outputPath) {
          return {
            stdout: '',
            stderr: `${name}: output filename not specified\n`,
            exitCode: 1,
          };
        }

        const resolvedOutputPath = ctx.fs.resolvePath(ctx.cwd, outputPath);

        // Load all input PDFs
        const inputDocs = new Map<string, typeof pdfLib.PDFDocument.prototype>();
        for (const input of inputHandles) {
          const inputBytes = await ctx.fs.readFileBuffer(input.path);
          const doc = await pdfLib.PDFDocument.load(inputBytes);
          const key = input.handle || 'default';
          inputDocs.set(key, doc);
        }

        // Process each range specification
        for (const spec of rangeSpecs) {
          // Check if it's a handle reference (A, B, etc.)
          if (/^[A-Z]$/.test(spec)) {
            const doc = inputDocs.get(spec);
            if (!doc) {
              return {
                stdout: '',
                stderr: `${name}: unknown handle '${spec}'\n`,
                exitCode: 1,
              };
            }
            // Copy all pages from this document
            const totalPages = doc.getPageCount();
            const indices = Array.from({ length: totalPages }, (_, i) => i);
            const copiedPages = await outputDoc.copyPages(doc, indices);
            copiedPages.forEach((page: Awaited<ReturnType<typeof outputDoc.copyPages>>[number]) =>
              outputDoc.addPage(page)
            );
            continue;
          }

          // Otherwise, it's a page range for the default (first) input
          const defaultDoc = inputDocs.get(inputHandles[0].handle || 'default');
          if (!defaultDoc) {
            return {
              stdout: '',
              stderr: `${name}: no default input document\n`,
              exitCode: 1,
            };
          }

          const totalPages = defaultDoc.getPageCount();
          const range = parsePageRange(spec);
          const pageNumbers = expandPageRange(range, totalPages);

          // Convert to 0-based indices
          const indices = pageNumbers.map((p) => p - 1);
          const copiedPages = await outputDoc.copyPages(defaultDoc, indices);

          for (const page of copiedPages) {
            if (range.rotation) {
              page.setRotation(pdfLib.degrees(range.rotation));
            }
            outputDoc.addPage(page);
          }
        }

        const outputBytes = await outputDoc.save();
        await ctx.fs.writeFile(resolvedOutputPath, outputBytes);

        return {
          stdout: `Created ${outputPath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }

      // rotate operation
      if (operation === 'rotate') {
        if (inputHandles.length > 1) {
          return {
            stdout: '',
            stderr: `${name}: rotate only supports a single input file\n`,
            exitCode: 1,
          };
        }

        const pdfLib = await getPdfLib();
        const inputBytes = await ctx.fs.readFileBuffer(inputHandles[0].path);
        const pdfDoc = await pdfLib.PDFDocument.load(inputBytes);

        const rotateArgs = args.slice(argIdx);
        const outputIdx = rotateArgs.indexOf('output');

        if (outputIdx === -1) {
          return {
            stdout: '',
            stderr: `${name}: rotate operation requires 'output <filename>'\n`,
            exitCode: 1,
          };
        }

        const rangeSpecs = rotateArgs.slice(0, outputIdx);
        const outputPath = rotateArgs[outputIdx + 1];

        if (!outputPath) {
          return {
            stdout: '',
            stderr: `${name}: output filename not specified\n`,
            exitCode: 1,
          };
        }

        const resolvedOutputPath = ctx.fs.resolvePath(ctx.cwd, outputPath);
        const totalPages = pdfDoc.getPageCount();

        // Track which pages to rotate
        const rotations = new Map<number, number>();

        for (const spec of rangeSpecs) {
          const range = parsePageRange(spec);
          if (!range.rotation) {
            return {
              stdout: '',
              stderr: `${name}: rotation suffix required (right/left/down) for range '${spec}'\n`,
              exitCode: 1,
            };
          }

          const pageNumbers = expandPageRange(range, totalPages);
          for (const pageNum of pageNumbers) {
            rotations.set(pageNum - 1, range.rotation);
          }
        }

        // Apply rotations
        const pages = pdfDoc.getPages();
        for (const [index, rotation] of rotations.entries()) {
          const page = pages[index];
          const currentRotation = page.getRotation().angle;
          const newRotation = (currentRotation + rotation) % 360;
          page.setRotation(pdfLib.degrees(newRotation));
        }

        const outputBytes = await pdfDoc.save();
        await ctx.fs.writeFile(resolvedOutputPath, outputBytes);

        return {
          stdout: `Created ${outputPath}\n`,
          stderr: '',
          exitCode: 0,
        };
      }

      return {
        stdout: '',
        stderr: `${name}: unknown operation '${operation}'\n`,
        exitCode: 1,
      };
    } catch (err) {
      return {
        stdout: '',
        stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}
