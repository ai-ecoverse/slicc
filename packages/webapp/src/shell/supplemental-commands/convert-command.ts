import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import annotationFontUrl from '../../../../assets/fonts/AdobeClean-Regular.otf?url';
import { getMagick, type IpkResolutionContext } from './magick-wasm.js';
import { DEFAULT_PDF_DPI, dpiToScale, isPdfBytes, renderPdfPage } from './pdf-raster.js';

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

type OperationType =
  | 'resize'
  | 'thumbnail'
  | 'rotate'
  | 'crop'
  | 'quality'
  | 'auto-orient'
  | 'auto-gamma'
  | 'auto-level'
  | 'flip'
  | 'flop'
  | 'strip'
  | 'trim'
  | 'negate'
  | 'normalize'
  | 'background'
  | 'extent'
  | 'alpha'
  | 'colorspace'
  | 'transparent'
  | 'blur'
  | 'sharpen'
  | 'gravity'
  | 'fill'
  | 'undercolor'
  | 'pointsize'
  | 'density'
  | 'annotate';

interface ParsedOperation {
  type: OperationType;
  value: string;
  text?: string;
}

interface ExpressionBase {
  operations: ParsedOperation[];
}

interface InputExpression extends ExpressionBase {
  kind: 'input';
  path: string;
}

interface AppendExpression extends ExpressionBase {
  kind: 'append';
  direction: 'horizontal' | 'vertical';
  children: ImageExpression[];
  appendSettings: { background?: string; gravity?: string };
}

type ImageExpression = InputExpression | AppendExpression;

type CmdResult = { stdout: string; stderr: string; exitCode: number };

type MagickModule = Awaited<ReturnType<typeof getMagick>>;
type MagickImage = Parameters<Parameters<MagickModule['ImageMagick']['read']>[1]>[0];

const ANNOTATION_FONT_NAME = 'AdobeClean-Regular.otf';
const fontRegisteredModules = new WeakSet<object>();
let annotationFontData: Promise<Uint8Array> | null = null;

const HELP_TEXT = `usage: convert [input ...] [operations...] [output]

Operations:
  -resize GEOMETRY   resize; supports %, !, ^, >, and < modifiers
  -thumbnail GEOMETRY create an optimized thumbnail
  -rotate degrees    rotate image by degrees
  -crop WxH[+X+Y]    crop, optionally positioned with signed offsets
  -quality N         set output quality (0-100)
  -auto-orient       apply EXIF orientation
  -flip / -flop      mirror vertically / horizontally
  -strip / -trim     remove metadata / uniform edges
  -background COLOR  set the canvas background color
  -extent GEOMETRY   resize the canvas using background and gravity
  -alpha MODE        control alpha (set, remove, extract, off, ...)
  -colorspace TYPE   convert color space (sRGB, Gray, CMYK, ...)
  -transparent COLOR make matching pixels transparent
  -blur / -sharpen R[xS] apply a Gaussian effect
  -density DPI       rasterization DPI for PDF inputs (default ${DEFAULT_PDF_DPI})
  -auto-gamma / -auto-level / -normalize / -negate
  +append            join all images in the current sequence horizontally
  -append            join all images in the current sequence vertically
  -gravity POSITION  set annotation anchor
  -fill COLOR        set annotation text color
  -undercolor COLOR  set annotation background color
  -pointsize N       set annotation text size
  -annotate +X+Y TXT draw text with the bundled Adobe Clean font

Examples:
  convert input.jpg -resize 800x600 output.png
  convert photo.png -resize 50% smaller.png
  convert image.jpg -rotate 90 -quality 85 rotated.jpg
  convert input.png -crop 100x100+50+50 cropped.png
  convert frame1.jpg frame2.jpg +append filmstrip.jpg
  convert \\( a.jpg b.jpg +append \\) \\( c.jpg d.jpg +append \\) -append grid.jpg

PDF inputs are rasterized with pdf.js. Select a page with a bracket suffix
(0-based, as ImageMagick does); page 0 is used when none is given:
  convert -density 150 doc.pdf page0.png
  convert doc.pdf[2] -resize 800x page3.png
Use pdftoppm to rasterize a whole document in one pass.
`;

function convertHelp(): CmdResult {
  return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
}

const OP_ARG_COUNTS = new Map<string, number>([
  ['-resize', 1],
  ['-thumbnail', 1],
  ['-rotate', 1],
  ['-crop', 1],
  ['-quality', 1],
  ['-auto-orient', 0],
  ['-auto-gamma', 0],
  ['-auto-level', 0],
  ['-flip', 0],
  ['-flop', 0],
  ['-strip', 0],
  ['-trim', 0],
  ['-negate', 0],
  ['-normalize', 0],
  ['-background', 1],
  ['-extent', 1],
  ['-alpha', 1],
  ['-colorspace', 1],
  ['-transparent', 1],
  ['-blur', 1],
  ['-sharpen', 1],
  ['-gravity', 1],
  ['-fill', 1],
  ['-undercolor', 1],
  ['-pointsize', 1],
  ['-density', 1],
  ['-annotate', 2],
]);

interface ParsedConvertArgs {
  expression: ImageExpression;
  outputPath: string;
}

class ConvertArgParser {
  private index = 0;

  constructor(private readonly tokens: string[]) {}

  parse(): ImageExpression {
    return this.readSequence(false);
  }

  private readSequence(insideGroup: boolean): ImageExpression {
    const expressions: ImageExpression[] = [];
    const pending: ParsedOperation[] = [];
    let closed = false;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      if (token === ')') {
        if (!insideGroup) throw new Error('unexpected )');
        this.index++;
        closed = true;
        break;
      }
      if (token === '(') this.readGroup(expressions, pending);
      else if (token === '+append' || token === '-append') this.append(expressions, token);
      else if (OP_ARG_COUNTS.has(token)) this.readOperation(expressions, pending, token);
      else this.readInput(expressions, pending, token);
    }
    if (insideGroup && !closed) throw new Error('missing )');
    return this.finishSequence(expressions, pending);
  }

  private readGroup(expressions: ImageExpression[], pending: ParsedOperation[]): void {
    this.index++;
    const expression = this.readSequence(true);
    expression.operations.unshift(...pending.splice(0));
    expressions.push(expression);
  }

  private append(expressions: ImageExpression[], token: '+append' | '-append'): void {
    if (expressions.length < 2) throw new Error(`${token} requires at least two images`);
    const children = [...expressions];
    expressions.splice(0, expressions.length, {
      kind: 'append',
      direction: token === '+append' ? 'horizontal' : 'vertical',
      children,
      appendSettings: collectAppendSettings(children),
      operations: [],
    });
    this.index++;
  }

  private readOperation(
    expressions: ImageExpression[],
    pending: ParsedOperation[],
    token: string
  ): void {
    const argCount = OP_ARG_COUNTS.get(token)!;
    const values = this.tokens.slice(this.index + 1, this.index + 1 + argCount);
    if (values.length !== argCount || values.some((value) => isControlToken(value))) {
      throw new Error(`missing argument for ${token}`);
    }
    const operation: ParsedOperation = {
      type: token.slice(1) as ParsedOperation['type'],
      value: values[0] ?? '',
      ...(argCount === 2 ? { text: values[1] } : {}),
    };
    (expressions.at(-1)?.operations ?? pending).push(operation);
    this.index += argCount + 1;
  }

  private readInput(
    expressions: ImageExpression[],
    pending: ParsedOperation[],
    token: string
  ): void {
    if (token.startsWith('-') || token.startsWith('+')) {
      throw new Error(`unsupported option ${token}`);
    }
    expressions.push({ kind: 'input', path: token, operations: pending.splice(0) });
    this.index++;
  }

  private finishSequence(
    expressions: ImageExpression[],
    pending: ParsedOperation[]
  ): ImageExpression {
    if (pending.length > 0) throw new Error('operation requires an input image');
    if (expressions.length === 0) throw new Error('expected an input image');
    if (expressions.length > 1) throw new Error('multiple input files require +append or -append');
    return expressions[0];
  }
}

function collectAppendSettings(expressions: ImageExpression[]): AppendExpression['appendSettings'] {
  const settings: AppendExpression['appendSettings'] = {};
  for (const expression of expressions) {
    for (const operation of expression.operations) {
      if (operation.type === 'background') settings.background = operation.value;
      if (operation.type === 'gravity') settings.gravity = operation.value;
    }
  }
  return settings;
}

/**
 * Parse the convert argv into operations + positionals. Throws on
 * any user-facing error (missing flag argument, unsupported flag,
 * wrong positional count) — the caller maps the error message into
 * a `${name}: ${msg}` stderr line. Operation order is preserved.
 */
export function parseConvertArgs(args: string[]): ParsedConvertArgs {
  if (args.length < 2) throw new Error('expected exactly one input file and one output file');
  const outputPath = args.at(-1)!;
  const outputArgCount = OP_ARG_COUNTS.get(outputPath);
  if (outputArgCount !== undefined) {
    if (outputArgCount > 0) throw new Error(`missing argument for ${outputPath}`);
    throw new Error('expected an output file');
  }
  if (isControlToken(outputPath)) throw new Error('expected an output file');
  const expression = new ConvertArgParser(args.slice(0, -1)).parse();
  return { expression, outputPath };
}

function isControlToken(value: string): boolean {
  return (
    value === '(' ||
    value === ')' ||
    value === '+append' ||
    value === '-append' ||
    OP_ARG_COUNTS.has(value)
  );
}

const RESIZE_GEOMETRY = /^(?:\d+(?:x\d*)?|x\d+)(?:[%!^<>@])?$/;
const CANVAS_GEOMETRY = /^\d+x\d+(?:[+-]\d+[+-]\d+)?$/;

function parseGeometry(
  magick: MagickModule,
  value: string,
  option: string
): MagickModule['MagickGeometry']['prototype'] {
  const pattern = option === 'resize' || option === 'thumbnail' ? RESIZE_GEOMETRY : CANVAS_GEOMETRY;
  if (!pattern.test(value)) throw new Error(`Invalid ${option} geometry: ${value}`);
  return new magick.MagickGeometry(value);
}

function applyResize(magick: MagickModule, image: MagickImage, value: string): void {
  image.resize(parseGeometry(magick, value, 'resize'));
}

function applyRotate(image: MagickImage, value: string): void {
  const degrees = parseFloat(value);
  if (isNaN(degrees)) throw new Error(`Invalid rotation degrees: ${value}`);
  image.rotate(degrees);
}

function applyCrop(
  magick: MagickModule,
  image: MagickImage,
  value: string,
  gravity?: number
): void {
  const geometry = parseGeometry(magick, value, 'crop');
  if (gravity === undefined) image.crop(geometry);
  else image.crop(geometry, gravity);
}

function applyQuality(image: MagickImage, value: string): void {
  const quality = parseInt(value, 10);
  if (isNaN(quality) || quality < 0 || quality > 100) {
    throw new Error(`Invalid quality: ${value} (must be 0-100)`);
  }
  image.quality = quality;
}

interface DrawingState {
  gravity?: number;
  background?: string;
  fill?: string;
  undercolor?: string;
  pointsize?: number;
}

const GRAVITY_NAMES: Record<string, string> = {
  northwest: 'Northwest',
  north: 'North',
  northeast: 'Northeast',
  west: 'West',
  center: 'Center',
  east: 'East',
  southwest: 'Southwest',
  south: 'South',
  southeast: 'Southeast',
};

function resolveGravity(magick: MagickModule, value: string): number {
  const gravityName = GRAVITY_NAMES[value.toLowerCase()];
  const gravity = gravityName ? magick.Gravity[gravityName] : undefined;
  if (gravity === undefined) throw new Error(`Invalid gravity: ${value}`);
  return gravity;
}

const SIMPLE_OPERATIONS: Partial<Record<OperationType, (image: MagickImage) => void>> = {
  'auto-orient': (image) => image.autoOrient(),
  'auto-gamma': (image) => image.autoGamma(),
  'auto-level': (image) => image.autoLevel(),
  flip: (image) => image.flip(),
  flop: (image) => image.flop(),
  strip: (image) => image.strip(),
  trim: (image) => image.trim(),
  negate: (image) => image.negate(),
  normalize: (image) => image.normalize(),
};

function normalizeEnumName(value: string): string {
  return value.toLowerCase().replaceAll(/[-_ ]/g, '');
}

function resolveEnumValue(values: Record<string, number>, value: string, option: string): number {
  const normalized = normalizeEnumName(value);
  const entry = Object.entries(values).find(([name]) => normalizeEnumName(name) === normalized);
  if (!entry) throw new Error(`Invalid ${option}: ${value}`);
  return entry[1];
}

function applyExtent(
  magick: MagickModule,
  image: MagickImage,
  value: string,
  state: DrawingState
): void {
  const geometry = parseGeometry(magick, value, 'extent');
  const background = state.background ? new magick.MagickColor(state.background) : undefined;
  if (state.gravity !== undefined && background) image.extent(geometry, state.gravity, background);
  else if (state.gravity !== undefined) image.extent(geometry, state.gravity);
  else if (background) image.extent(geometry, background);
  else image.extent(geometry);
}

function parseRadiusSigma(value: string, option: string): [number, number] {
  const number = '(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const match = value.match(new RegExp(`^(${number})(?:x(${number}))?$`));
  if (!match) throw new Error(`Invalid ${option} radius/sigma: ${value}`);
  return [Number(match[1]), match[2] === undefined ? 1 : Number(match[2])];
}

function applyAnnotation(
  magick: MagickModule,
  image: MagickImage,
  op: ParsedOperation,
  state: DrawingState
): void {
  const offset = op.value.match(/^([+-]\d+)([+-]\d+)$/);
  if (!offset) throw new Error(`Invalid annotate offset: ${op.value} (expected +X+Y)`);
  const drawables = new magick.Drawables();
  if (state.gravity !== undefined) drawables.gravity(state.gravity);
  if (state.fill !== undefined) drawables.fillColor(new magick.MagickColor(state.fill));
  if (state.undercolor !== undefined) {
    drawables.textUnderColor(new magick.MagickColor(state.undercolor));
  }
  drawables.font(ANNOTATION_FONT_NAME);
  if (state.pointsize !== undefined) drawables.fontPointSize(state.pointsize);
  drawables.text(Number(offset[1]), Number(offset[2]), op.text ?? '').draw(image);
}

async function ensureAnnotationFont(magick: MagickModule): Promise<void> {
  if (fontRegisteredModules.has(magick.Magick)) return;
  const fontData = (annotationFontData ??= fetch(annotationFontUrl).then(async (response) => {
    if (!response.ok) throw new Error(`Failed to load annotation font (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }));
  try {
    magick.Magick.addFont(ANNOTATION_FONT_NAME, await fontData);
    fontRegisteredModules.add(magick.Magick);
  } catch (error) {
    if (annotationFontData === fontData) annotationFontData = null;
    throw error;
  }
}

function hasAnnotation(expression: ImageExpression): boolean {
  if (expression.operations.some((operation) => operation.type === 'annotate')) return true;
  return expression.kind === 'append' && expression.children.some(hasAnnotation);
}

function applyOperation(
  magick: MagickModule,
  image: MagickImage,
  op: ParsedOperation,
  state: DrawingState
): void {
  const simpleOperation = SIMPLE_OPERATIONS[op.type];
  if (simpleOperation) {
    simpleOperation(image);
    return;
  }
  switch (op.type) {
    case 'density':
      // Consumed by `loadInputData` when rasterizing a PDF input. ImageMagick
      // also treats it as a pre-input setting, so there is nothing to apply
      // to an already-decoded raster.
      return;
    case 'resize':
      applyResize(magick, image, op.value);
      return;
    case 'thumbnail':
      image.thumbnail(parseGeometry(magick, op.value, 'thumbnail'));
      return;
    case 'rotate':
      applyRotate(image, op.value);
      return;
    case 'crop':
      applyCrop(magick, image, op.value, state.gravity);
      return;
    case 'quality':
      applyQuality(image, op.value);
      return;
    case 'background':
      state.background = op.value;
      image.backgroundColor = new magick.MagickColor(op.value);
      return;
    case 'extent':
      applyExtent(magick, image, op.value, state);
      return;
    case 'alpha':
      image.alpha(resolveEnumValue(magick.AlphaAction, op.value, 'alpha mode'));
      return;
    case 'colorspace':
      image.colorSpace = resolveEnumValue(magick.ColorSpace, op.value, 'colorspace');
      return;
    case 'transparent':
      image.transparent(new magick.MagickColor(op.value));
      return;
    case 'blur':
      image.blur(...parseRadiusSigma(op.value, 'blur'));
      return;
    case 'sharpen':
      image.sharpen(...parseRadiusSigma(op.value, 'sharpen'));
      return;
    case 'gravity': {
      state.gravity = resolveGravity(magick, op.value);
      return;
    }
    case 'fill':
      state.fill = op.value;
      return;
    case 'undercolor':
      state.undercolor = op.value;
      return;
    case 'pointsize': {
      const pointsize = Number(op.value);
      if (!Number.isFinite(pointsize) || pointsize <= 0) {
        throw new Error(`Invalid point size: ${op.value}`);
      }
      state.pointsize = pointsize;
      return;
    }
    case 'annotate':
      applyAnnotation(magick, image, op, state);
      return;
  }
}

function prepareAppendImages(
  magick: MagickModule,
  expression: AppendExpression,
  images: MagickImage[]
): void {
  const { background, gravity: gravityName } = expression.appendSettings;
  if (background === undefined && gravityName === undefined) return;
  const gravity = gravityName === undefined ? undefined : resolveGravity(magick, gravityName);
  const backgroundColor = background === undefined ? undefined : new magick.MagickColor(background);
  const maxWidth = Math.max(...images.map((image) => image.width));
  const maxHeight = Math.max(...images.map((image) => image.height));
  for (const image of images) {
    const width = expression.direction === 'vertical' ? maxWidth : image.width;
    const height = expression.direction === 'horizontal' ? maxHeight : image.height;
    if (width === image.width && height === image.height) continue;
    const geometry = new magick.MagickGeometry(width, height);
    if (gravity !== undefined && backgroundColor) image.extent(geometry, gravity, backgroundColor);
    else if (gravity !== undefined) image.extent(geometry, gravity);
    else if (backgroundColor) image.extent(geometry, backgroundColor);
  }
}

function applyOperations(
  magick: MagickModule,
  image: MagickImage,
  operations: ParsedOperation[]
): void {
  const drawingState: DrawingState = {};
  for (const op of operations) applyOperation(magick, image, op, drawingState);
}

function writeImage(image: MagickImage, outputPath: string): Uint8Array | null {
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
  const outputFormat = inferFormat(outputPath);
  image.write(outputFormat, (data: Uint8Array) => {
    outputData = new Uint8Array(data);
  });
  return outputData;
}

async function renderChildren(
  magick: MagickModule,
  expression: AppendExpression,
  inputData: Map<InputExpression, Uint8Array>,
  callback: (images: MagickImage[]) => Promise<void>,
  images: MagickImage[] = [],
  childIndex = 0
): Promise<void> {
  if (childIndex === expression.children.length) return callback(images);
  await renderExpression(magick, expression.children[childIndex], inputData, async (image) => {
    images.push(image);
    await renderChildren(magick, expression, inputData, callback, images, childIndex + 1);
    images.pop();
  });
}

async function renderExpression(
  magick: MagickModule,
  expression: ImageExpression,
  inputData: Map<InputExpression, Uint8Array>,
  callback: (image: MagickImage) => Promise<void>
): Promise<void> {
  if (expression.kind === 'input') {
    await magick.ImageMagick.read(inputData.get(expression)!, async (image) => {
      applyOperations(magick, image, expression.operations);
      await callback(image);
    });
    return;
  }

  await renderChildren(magick, expression, inputData, async (images) => {
    prepareAppendImages(magick, expression, images);
    const collection = magick.MagickImageCollection.create();
    collection.push(...images);
    const append =
      expression.direction === 'horizontal'
        ? collection.appendHorizontally.bind(collection)
        : collection.appendVertically.bind(collection);
    try {
      await append(async (image) => {
        applyOperations(magick, image, expression.operations);
        await callback(image);
      });
    } finally {
      // The collection treats pushed images as owned. They are callback-scoped
      // by ImageMagick/read or a parent append, so detach them before disposal.
      collection.length = 0;
      collection.dispose();
    }
  });
}

/**
 * Split ImageMagick's `file.pdf[2]` scene-selector suffix off a path. Only
 * a bare non-negative integer is treated as a selector, so a real filename
 * like `report[final].png` still resolves as itself.
 */
export function splitSceneSelector(path: string): { path: string; scene?: number } {
  const match = path.match(/^(.*)\[(\d+)\]$/);
  if (!match) return { path };
  return { path: match[1], scene: Number(match[2]) };
}

/** Last `-density` wins, as it does in ImageMagick. */
function densityFor(expression: InputExpression): number {
  let dpi = DEFAULT_PDF_DPI;
  for (const operation of expression.operations) {
    if (operation.type !== 'density') continue;
    // ImageMagick accepts `-density 150x150`; both axes are the same here
    // because pdf.js scales uniformly, so take the first component.
    const parsed = Number(operation.value.split('x')[0]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid density: ${operation.value}`);
    }
    dpi = parsed;
  }
  return dpi;
}

async function loadInputData(
  expression: ImageExpression,
  ctx: CommandContext,
  result = new Map<InputExpression, Uint8Array>(),
  pathCache = new Map<string, Uint8Array>()
): Promise<Map<InputExpression, Uint8Array>> {
  if (expression.kind === 'input') {
    const { path: rawPath, scene } = splitSceneSelector(expression.path);
    const path = ctx.fs.resolvePath(ctx.cwd, rawPath);
    let data = pathCache.get(path);
    if (data === undefined) {
      data = await ctx.fs.readFileBuffer(path);
      pathCache.set(path, data);
    }
    // magick-wasm has no PDF delegate (real ImageMagick shells out to
    // Ghostscript). Rasterize first so `convert doc.pdf out.png` works like
    // the tool an agent expects, instead of failing on an unknown format.
    if (isPdfBytes(data)) {
      // The scene selector is 0-based; pdf.js pages are 1-based.
      const page = await renderPdfPage(data, (scene ?? 0) + 1, {
        scale: dpiToScale(densityFor(expression)),
        format: 'png',
      });
      result.set(expression, page.bytes);
      return result;
    }
    result.set(expression, data);
    return result;
  }
  for (const child of expression.children) await loadInputData(child, ctx, result, pathCache);
  return result;
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

    try {
      const inputData = await loadInputData(parsed.expression, ctx);
      // Initialize ImageMagick — pass an ipk context so the browser
      // path can find `@imagemagick/magick-wasm/dist/magick.wasm` in
      // the VFS `node_modules`. Node / extension paths ignore it.
      const magick = await getMagick({ ipk: createIpkContextFromCtx(ctx) });
      if (hasAnnotation(parsed.expression)) await ensureAnnotationFont(magick);

      let outputData: Uint8Array | null = null;
      await renderExpression(magick, parsed.expression, inputData, async (image) => {
        outputData = writeImage(image, parsed.outputPath);
      });

      // `!outputData` is `false` for a zero-byte `Uint8Array` (it's
      // still truthy), so the byte-length check is load-bearing:
      // magick-wasm can silently return an empty buffer on
      // unsupported-format quirks and we'd otherwise write a 0-byte
      // JPEG with exit 0.
      if (!outputData || (outputData as Uint8Array).byteLength === 0) {
        throw new Error('Failed to generate output image');
      }

      const resolvedOutput = ctx.fs.resolvePath(ctx.cwd, parsed.outputPath);
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
