import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getMagick, type IpkResolutionContext } from './magick-wasm.js';

/**
 * Build an {@link IpkResolutionContext} from a command's `ctx` so
 * `getMagick` can locate the ipk-installed `@imagemagick/magick-wasm`
 * in the VFS `node_modules`. Mirrors `createIpkContextFromCtx` in
 * `esbuild-command.ts` / `tsc-command.ts` so every float wires the
 * loader the same way.
 */
export function createIpkContextFromCtx(ctx: CommandContext): IpkResolutionContext {
  return {
    reader: {
      exists: (path) => ctx.fs.exists(path),
      isDirectory: async (path) => {
        try {
          return (await ctx.fs.stat(path)).isDirectory;
        } catch {
          return false;
        }
      },
      readFile: (path) => ctx.fs.readFile(path),
    },
    readBytes: (path) => ctx.fs.readFileBuffer(path),
    fromDir: ctx.cwd,
  };
}

function inferFormat(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'JPEG';
  if (lower.endsWith('.png')) return 'PNG';
  if (lower.endsWith('.gif')) return 'GIF';
  if (lower.endsWith('.webp')) return 'WEBP';
  if (lower.endsWith('.bmp')) return 'BMP';
  if (lower.endsWith('.tiff') || lower.endsWith('.tif')) return 'TIFF';
  if (lower.endsWith('.avif')) return 'AVIF';
  return 'PNG'; // default
}

interface ParsedOperation {
  type: 'resize' | 'rotate' | 'crop' | 'quality';
  value: string;
}

type CmdResult = { stdout: string; stderr: string; exitCode: number };

type MagickModule = Awaited<ReturnType<typeof getMagick>>;
type MagickImage = Parameters<Parameters<MagickModule['ImageMagick']['read']>[1]>[0];

const HELP_TEXT = `usage: convert [input] [operations...] [output]

Operations:
  -resize WxH        resize to width x height
  -resize WxH!       resize to exact dimensions (ignore aspect ratio)
  -resize N%         resize by percentage
  -rotate degrees    rotate image by degrees
  -crop WxH+X+Y      crop to width x height at position X,Y
  -quality N         set output quality (0-100)

Examples:
  convert input.jpg -resize 800x600 output.png
  convert photo.png -resize 50% smaller.png
  convert image.jpg -rotate 90 -quality 85 rotated.jpg
  convert input.png -crop 100x100+50+50 cropped.png
`;

function convertHelp(): CmdResult {
  return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
}

const OP_FLAGS = new Set(['-resize', '-rotate', '-crop', '-quality']);

interface ParsedConvertArgs {
  operations: ParsedOperation[];
  positional: string[];
}

/**
 * Parse the convert argv into operations + positionals. Throws on
 * any user-facing error (missing flag argument, unsupported flag,
 * wrong positional count) — the caller maps the error message into
 * a `${name}: ${msg}` stderr line. Operation order is preserved.
 */
export function parseConvertArgs(args: string[]): ParsedConvertArgs {
  const positional: string[] = [];
  const operations: ParsedOperation[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (OP_FLAGS.has(arg)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        throw new Error(`missing argument for ${arg}`);
      }
      const type = arg.slice(1) as ParsedOperation['type'];
      operations.push({ type, value: args[i + 1] });
      i += 2;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unsupported option ${arg}`);
    }
    positional.push(arg);
    i += 1;
  }
  if (positional.length !== 2) {
    throw new Error('expected exactly one input file and one output file');
  }
  return { operations, positional };
}

function applyResize(magick: MagickModule, image: MagickImage, value: string): void {
  const resizeMatch = value.match(/^(\d+)%$/);
  if (resizeMatch) {
    const percent = parseInt(resizeMatch[1], 10);
    const newWidth = Math.round((image.width * percent) / 100);
    const newHeight = Math.round((image.height * percent) / 100);
    image.resize(newWidth, newHeight);
    return;
  }
  const ignoreAspect = value.endsWith('!');
  const sizeStr = ignoreAspect ? value.slice(0, -1) : value;
  const parts = sizeStr.split('x');
  if (parts.length !== 2) {
    throw new Error(`Invalid resize format: ${value}`);
  }
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);
  if (ignoreAspect) {
    // Create geometry with ignoreAspectRatio flag
    const geo = new magick.MagickGeometry(width, height);
    geo.ignoreAspectRatio = true;
    image.resize(geo);
  } else {
    image.resize(width, height);
  }
}

function applyRotate(image: MagickImage, value: string): void {
  const degrees = parseFloat(value);
  if (isNaN(degrees)) throw new Error(`Invalid rotation degrees: ${value}`);
  image.rotate(degrees);
}

function applyCrop(magick: MagickModule, image: MagickImage, value: string): void {
  // Parse WxH+X+Y format
  const cropMatch = value.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
  if (!cropMatch) throw new Error(`Invalid crop format: ${value} (expected WxH+X+Y)`);
  // Use string constructor which accepts ImageMagick geometry format
  const geo = new magick.MagickGeometry(value);
  image.crop(geo);
}

function applyQuality(image: MagickImage, value: string): void {
  const quality = parseInt(value, 10);
  if (isNaN(quality) || quality < 0 || quality > 100) {
    throw new Error(`Invalid quality: ${value} (must be 0-100)`);
  }
  image.quality = quality;
}

function applyOperation(magick: MagickModule, image: MagickImage, op: ParsedOperation): void {
  switch (op.type) {
    case 'resize':
      applyResize(magick, image, op.value);
      return;
    case 'rotate':
      applyRotate(image, op.value);
      return;
    case 'crop':
      applyCrop(magick, image, op.value);
      return;
    case 'quality':
      applyQuality(image, op.value);
      return;
  }
}

/**
 * Apply every operation to the supplied image and snapshot the
 * encoded output bytes synchronously inside the `image.write`
 * callback (see the long-form comment below for the heap-clobber
 * rationale).
 */
async function processImage(
  magick: MagickModule,
  image: MagickImage,
  operations: ParsedOperation[],
  outputPath: string
): Promise<Uint8Array | null> {
  for (const op of operations) applyOperation(magick, image, op);

  let outputData: Uint8Array | null = null;
  // Write output. Copy the bytes synchronously out of the
  // WASM heap — magick-wasm hands us a Uint8Array view into
  // its linear memory, which gets reused for other
  // allocations after the callback returns. Holding the raw
  // view across `await ctx.fs.writeFile(...)` lets later
  // emscripten work clobber the region; the file then lands
  // as whatever happens to sit at that slot (commonly
  // null-terminated strings emscripten writes for format
  // names, producing a "UTF-8 text with CRLF terminators"
  // garbage file). Symptom only surfaces in extension/
  // offscreen mode because of allocator timing differences.
  const outputFormat = inferFormat(outputPath) as any; // MagickFormat type
  image.write(outputFormat, (data: Uint8Array) => {
    outputData = new Uint8Array(data);
  });
  return outputData;
}

export function createConvertCommand(name: string = 'convert'): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return convertHelp();
    }

    let parsed: ParsedConvertArgs;
    try {
      parsed = parseConvertArgs(args);
    } catch (err) {
      return {
        stdout: '',
        stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }

    const [inputPath, outputPath] = parsed.positional;
    try {
      const resolvedInput = ctx.fs.resolvePath(ctx.cwd, inputPath);
      const inputData = await ctx.fs.readFileBuffer(resolvedInput);

      // Initialize ImageMagick — pass an ipk context so the browser
      // path can find `@imagemagick/magick-wasm/dist/magick.wasm` in
      // the VFS `node_modules`. Node / extension paths ignore it.
      const magick = await getMagick({ ipk: createIpkContextFromCtx(ctx) });

      let outputData: Uint8Array | null = null;
      await magick.ImageMagick.read(inputData, async (image) => {
        outputData = await processImage(magick, image, parsed.operations, outputPath);
      });

      // `!outputData` is `false` for a zero-byte `Uint8Array` (it's
      // still truthy), so the byte-length check is load-bearing:
      // magick-wasm can silently return an empty buffer on
      // unsupported-format quirks and we'd otherwise write a 0-byte
      // JPEG with exit 0.
      if (!outputData || (outputData as Uint8Array).byteLength === 0) {
        throw new Error('Failed to generate output image');
      }

      const resolvedOutput = ctx.fs.resolvePath(ctx.cwd, outputPath);
      await ctx.fs.writeFile(resolvedOutput, outputData);

      return { stdout: '', stderr: '', exitCode: 0 };
    } catch (err) {
      return {
        stdout: '',
        stderr: `${name}: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}
