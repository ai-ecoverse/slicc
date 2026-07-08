import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { stdinAsLatin1 } from '../just-bash-compat.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

const HELP = `usage: xxd [options] [infile [outfile]]
  -c cols   number of octets per line (default 16; 30 for -p; 12 for -i)
  -g bytes  number of octets per group (default 2; 0 disables grouping)
  -l len    stop after len octets
  -s seek   start at seek offset (negative counts from end)
  -u        use uppercase hex letters
  -p        output in plain postscript style
  -i        output in C include style
  -r        reverse: convert a hex dump back to binary (-r -p for plain)
  -h        show this help
`;

function fail(msg: string): CmdResult {
  return { stdout: '', stderr: `xxd: ${msg}\n`, exitCode: 1 };
}

function parseNum(s: string | undefined): number {
  if (s == null) throw new Error('missing option value');
  const neg = s.startsWith('-');
  const body = neg || s.startsWith('+') ? s.slice(1) : s;
  let n: number;
  if (/^0x[0-9a-fA-F]+$/.test(body)) n = parseInt(body.slice(2), 16);
  else if (/^[0-9]+$/.test(body)) n = parseInt(body, 10);
  else throw new Error(`invalid number: ${s}`);
  return neg ? -n : n;
}

function hx(b: number, upper: boolean): string {
  const h = b.toString(16).padStart(2, '0');
  return upper ? h.toUpperCase() : h;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function varNameFromPath(p: string): string {
  return p.replace(/[^0-9a-zA-Z]/g, '_');
}

function dumpCanonical(
  b: Uint8Array,
  cols: number,
  group: number,
  upper: boolean,
  base: number
): string {
  const lines: string[] = [];
  for (let off = 0; off < b.length; off += cols) {
    const end = Math.min(off + cols, b.length);
    const addr = (base + off).toString(16).padStart(8, '0');
    let hex = '';
    for (let c = 0; c < cols; c++) {
      if (group > 0 && c > 0 && c % group === 0) hex += ' ';
      hex += off + c < end ? hx(b[off + c], upper) : '  ';
    }
    let ascii = '';
    for (let c = off; c < end; c++) {
      ascii += b[c] >= 0x20 && b[c] <= 0x7e ? String.fromCharCode(b[c]) : '.';
    }
    lines.push(`${addr}: ${hex}  ${ascii}`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

function dumpPlain(b: Uint8Array, cols: number, upper: boolean): string {
  let out = '';
  for (let off = 0; off < b.length; off += cols) {
    let line = '';
    for (let c = 0; c < cols && off + c < b.length; c++) line += hx(b[off + c], upper);
    out += line + '\n';
  }
  return out;
}

function dumpInclude(b: Uint8Array, cols: number, upper: boolean, varName: string | null): string {
  const items = Array.from(b, (x) => `0x${hx(x, upper)}`);
  const bodyLines: string[] = [];
  for (let i = 0; i < items.length; i += cols) {
    bodyLines.push('  ' + items.slice(i, i + cols).join(', '));
  }
  const body = bodyLines.join(',\n');
  if (varName === null) return items.length ? body + '\n' : '';
  return `unsigned char ${varName}[] = {\n${body}\n};\nunsigned int ${varName}_len = ${b.length};\n`;
}

function revertPlain(text: string): Uint8Array {
  const hex = text.replace(/[^0-9a-fA-F]/g, '');
  const n = Math.floor(hex.length / 2);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function revertCanonical(text: string): Uint8Array {
  const chunks: { offset: number; bytes: number[] }[] = [];
  let maxEnd = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const offset = parseInt(line.slice(0, colon).trim(), 16);
    if (Number.isNaN(offset)) continue;
    let rest = line.slice(colon + 1);
    const dbl = rest.indexOf('  ');
    if (dbl >= 0) rest = rest.slice(0, dbl);
    const hex = rest.replace(/[^0-9a-fA-F]/g, '');
    const bytes: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
    if (!bytes.length) continue;
    chunks.push({ offset, bytes });
    maxEnd = Math.max(maxEnd, offset + bytes.length);
  }
  if (!chunks.length) return new Uint8Array(0);
  const base = Math.min(...chunks.map((c) => c.offset));
  const out = new Uint8Array(maxEnd - base);
  for (const c of chunks) {
    for (let i = 0; i < c.bytes.length; i++) out[c.offset - base + i] = c.bytes[i];
  }
  return out;
}

interface Opts {
  cols?: number;
  group?: number;
  length?: number;
  seek?: number;
  upper: boolean;
  plain: boolean;
  include: boolean;
  revert: boolean;
  positional: string[];
}

const BOOL_FLAGS: Record<string, 'upper' | 'plain' | 'include' | 'revert'> = {
  '-u': 'upper',
  '-p': 'plain',
  '-ps': 'plain',
  '-postscript': 'plain',
  '-i': 'include',
  '-include': 'include',
  '-r': 'revert',
  '-revert': 'revert',
};

const VALUE_FLAGS: {
  key: 'cols' | 'group' | 'length' | 'seek';
  exact: string[];
  attached: RegExp;
}[] = [
  { key: 'cols', exact: ['-c', '-cols'], attached: /^-c(0x)?[0-9]/ },
  { key: 'group', exact: ['-g', '-groupsize'], attached: /^-g(0x)?[0-9]/ },
  { key: 'length', exact: ['-l', '-len'], attached: /^-l(0x)?[0-9]/ },
  { key: 'seek', exact: ['-s', '-seek'], attached: /^-s[+-]?(0x)?[0-9]/ },
];

function parseArgs(args: string[]): Opts {
  const o: Opts = { upper: false, plain: false, include: false, revert: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const boolKey = BOOL_FLAGS[a];
    if (boolKey) {
      o[boolKey] = true;
      continue;
    }
    const vf = VALUE_FLAGS.find((v) => v.exact.includes(a) || v.attached.test(a));
    if (vf) {
      o[vf.key] = parseNum(vf.exact.includes(a) ? args[++i] : a.slice(2));
      continue;
    }
    if (a !== '-' && a.startsWith('-') && a.length > 1) throw new Error(`invalid option ${a}`);
    o.positional.push(a);
  }
  return o;
}

function isHelp(args: string[]): boolean {
  return args.includes('-h') || args.includes('--help') || args.includes('-help');
}

async function readInput(
  ctx: CommandContext,
  infile: string | undefined,
  useStdin: boolean
): Promise<Uint8Array> {
  if (!useStdin && infile) {
    return ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, infile));
  }
  const latin1 = stdinAsLatin1(ctx.stdin);
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i) & 0xff;
  return bytes;
}

function renderDump(
  o: Opts,
  data: Uint8Array,
  base: number,
  infile: string | undefined,
  useStdin: boolean
): string {
  const cols = o.cols && o.cols > 0 ? o.cols : o.plain ? 30 : o.include ? 12 : 16;
  if (o.plain) return dumpPlain(data, cols, o.upper);
  if (o.include)
    return dumpInclude(data, cols, o.upper, useStdin ? null : varNameFromPath(infile ?? ''));
  const group = o.group != null && o.group >= 0 ? o.group : 2;
  return dumpCanonical(data, cols, group, o.upper, base);
}

function sliceData(o: Opts, allBytes: Uint8Array): { data: Uint8Array; base: number } {
  let base = 0;
  let data = allBytes;
  if (o.seek !== undefined) {
    base = o.seek < 0 ? Math.max(0, data.length + o.seek) : Math.min(o.seek, data.length);
    data = data.subarray(base);
  }
  if (o.length !== undefined) data = data.subarray(0, Math.max(0, o.length));
  return { data, base };
}

export function createXxdCommand(): Command {
  return defineCommand('xxd', async (args, ctx: CommandContext) => {
    if (isHelp(args)) return { stdout: HELP, stderr: '', exitCode: 0 };
    let o: Opts;
    try {
      o = parseArgs(args);
    } catch (e) {
      return fail((e as Error).message);
    }

    const infile = o.positional[0];
    const outfile = o.positional[1];
    const useStdin = !infile || infile === '-';

    let allBytes: Uint8Array;
    try {
      allBytes = await readInput(ctx, infile, useStdin);
    } catch {
      return fail(`${infile}: No such file or directory`);
    }

    if (o.revert) {
      const src = bytesToLatin1(allBytes);
      const out = o.plain ? revertPlain(src) : revertCanonical(src);
      if (outfile) {
        await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, outfile), out);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: bytesToLatin1(out), stderr: '', exitCode: 0 };
    }

    const { data, base } = sliceData(o, allBytes);
    const text = renderDump(o, data, base, infile, useStdin);
    if (outfile) {
      await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, outfile), text);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: text, stderr: '', exitCode: 0 };
  });
}
