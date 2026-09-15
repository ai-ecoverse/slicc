export interface NodePathParsed {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export interface NodePath {
  sep: '/';
  delimiter: ':';
  basename(path: string, ext?: string): string;
  dirname(path: string): string;
  extname(path: string): string;
  isAbsolute(path: string): boolean;
  join(...parts: string[]): string;
  normalize(path: string): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  parse(path: string): NodePathParsed;
  format(parsed: Partial<NodePathParsed>): string;
}

function posixNormalizeArray(parts: string[], allowAboveRoot: boolean): string[] {
  const res: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (res.length > 0 && res[res.length - 1] !== '..') res.pop();
      else if (allowAboveRoot) res.push('..');
    } else {
      res.push(part);
    }
  }
  return res;
}

function pathNormalize(path: string): string {
  if (path.length === 0) return '.';
  const isAbsolute = path.charCodeAt(0) === 47;
  const trailingSep = path.charCodeAt(path.length - 1) === 47;
  let normalized = posixNormalizeArray(path.split('/'), !isAbsolute).join('/');
  if (normalized.length === 0 && !isAbsolute) normalized = '.';
  if (normalized.length > 0 && trailingSep) normalized += '/';
  return (isAbsolute ? '/' : '') + normalized;
}

function pathJoin(...parts: string[]): string {
  const joined = parts.filter((p) => typeof p === 'string' && p.length > 0).join('/');
  if (joined.length === 0) return '.';
  return pathNormalize(joined);
}

function pathDirname(path: string): string {
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === 47;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

function pathBasename(path: string, ext?: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  const base = end === -1 ? '' : path.slice(start, end);
  if (ext && base.endsWith(ext) && base !== ext) {
    return base.slice(0, base.length - ext.length);
  }
  return base;
}

function pathExtname(path: string): string {
  const base = pathBasename(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot);
}

function defaultCwd(): string {
  const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.();
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : '/';
}

/**
 * Node: `path.resolve()` walks arguments right-to-left and, if none is
 * absolute, prepends `process.cwd()`. The previous fallback prepended `/`,
 * so `path.resolve('out.pdf')` was `/out.pdf` instead of `$cwd/out.pdf` (#3110).
 */
function pathResolve(getCwd: () => string, parts: string[]): string {
  let resolved = '';
  let isAbsolute = false;
  for (let i = parts.length - 1; i >= -1 && !isAbsolute; i--) {
    const part = i >= 0 ? parts[i] : getCwd();
    if (typeof part !== 'string' || part.length === 0) continue;
    resolved = resolved.length > 0 ? `${part}/${resolved}` : part;
    isAbsolute = part.charCodeAt(0) === 47;
  }
  const normalized = posixNormalizeArray(resolved.split('/'), !isAbsolute).join('/');
  if (isAbsolute) return normalized.length > 0 ? `/${normalized}` : '/';
  return normalized.length > 0 ? normalized : '.';
}

function pathRelative(getCwd: () => string, from: string, to: string): string {
  const fromAbs = pathResolve(getCwd, [from]);
  const toAbs = pathResolve(getCwd, [to]);
  if (fromAbs === toAbs) return '';
  const fromParts = fromAbs.split('/').filter(Boolean);
  const toParts = toAbs.split('/').filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.slice(i).map(() => '..');
  return [...up, ...toParts.slice(i)].join('/');
}

function pathParse(path: string): NodePathParsed {
  const root = path.charCodeAt(0) === 47 ? '/' : '';
  const base = pathBasename(path);
  const ext = pathExtname(path);
  const name = ext ? base.slice(0, base.length - ext.length) : base;
  let dir = pathDirname(path);
  if (dir === '.' && root === '') dir = '';
  return { root, dir, base, ext, name };
}

function pathFormat(parsed: Partial<NodePathParsed>): string {
  const dir = parsed.dir || parsed.root || '';
  const base = parsed.base || `${parsed.name || ''}${parsed.ext || ''}`;
  if (!dir) return base;
  if (dir === parsed.root) return `${dir}${base}`;
  return `${dir}/${base}`;
}

/**
 * Per-realm `path` module. `resolve()` (and therefore `relative()`) read
 * THIS realm's cwd — the same object `process.cwd()` returns — so a script
 * cannot see two working directories. Host-side callers that have no realm
 * (module-graph walks) keep the envless singleton below.
 */
export function createNodePath(getCwd: () => string = defaultCwd): NodePath {
  return {
    sep: '/',
    delimiter: ':',
    basename: pathBasename,
    dirname: pathDirname,
    extname: pathExtname,
    isAbsolute: (path) => path.length > 0 && path.charCodeAt(0) === 47,
    join: pathJoin,
    normalize: pathNormalize,
    resolve: (...parts: string[]) => pathResolve(getCwd, parts),
    relative: (from, to) => pathRelative(getCwd, from, to),
    parse: pathParse,
    format: pathFormat,
  };
}

/** Envless `path` module. A realm passes its own cwd via {@link createNodePath}. */
export const nodePath: NodePath = createNodePath();
