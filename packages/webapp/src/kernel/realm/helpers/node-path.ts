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

function pathResolve(...parts: string[]): string {
  let resolved = '';
  let isAbsolute = false;
  for (let i = parts.length - 1; i >= 0 && !isAbsolute; i--) {
    const part = parts[i];
    if (typeof part !== 'string' || part.length === 0) continue;
    resolved = resolved.length > 0 ? `${part}/${resolved}` : part;
    isAbsolute = part.charCodeAt(0) === 47;
  }
  if (!isAbsolute) resolved = resolved.length > 0 ? `/${resolved}` : '/';
  const normalized = posixNormalizeArray(resolved.split('/'), false).join('/');
  return normalized.length > 0 ? `/${normalized}` : '/';
}

function pathRelative(from: string, to: string): string {
  const fromAbs = pathResolve(from);
  const toAbs = pathResolve(to);
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

export const nodePath: NodePath = {
  sep: '/',
  delimiter: ':',
  basename: pathBasename,
  dirname: pathDirname,
  extname: pathExtname,
  isAbsolute: (path) => path.length > 0 && path.charCodeAt(0) === 47,
  join: pathJoin,
  normalize: pathNormalize,
  resolve: pathResolve,
  relative: pathRelative,
  parse: pathParse,
  format: pathFormat,
};
