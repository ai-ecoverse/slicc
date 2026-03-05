/**
 * Supplemental shell commands for browser parity with common agent workflows.
 */

import { defineCommand } from 'just-bash';
import type { Command, CommandContext } from 'just-bash';
import { unzipSync, zipSync } from 'fflate';
import { loadPyodide } from 'pyodide';
import type { PyodideInterface } from 'pyodide';

interface SqlJsResultSet {
  columns: string[];
  values: unknown[][];
}

interface SqlJsDatabase {
  exec(sql: string): SqlJsResultSet[];
  export(): Uint8Array;
  close(): void;
}

interface SqlJsModule {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}

type InitSqlJs = (options?: { locateFile?: (file: string) => string }) => Promise<SqlJsModule>;

const SQLJS_WASM_CDN = 'https://sql.js.org/dist/';
const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';

const PYTHON_RUNNER = `
import sys
import traceback

__slicc_exit_code = 0
try:
    sys.argv = __slicc_argv
    exec(compile(__slicc_code, __slicc_filename, "exec"), {"__name__": "__main__", "__file__": __slicc_filename})
except SystemExit as exc:
    code = exc.code
    if code is None:
        __slicc_exit_code = 0
    elif isinstance(code, int):
        __slicc_exit_code = code
    else:
        print(code, file=sys.stderr)
        __slicc_exit_code = 1
except BaseException:
    traceback.print_exc()
    __slicc_exit_code = 1
`;

let sqlJsPromise: Promise<SqlJsModule> | null = null;
let pyodidePromise: Promise<PyodideInterface> | null = null;

function basename(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return '/';
  return path.slice(0, slash);
}

function joinPath(base: string, child: string): string {
  if (base === '/') return `/${child}`;
  return `${base}/${child}`;
}

function isLikelyUrl(value: string): boolean {
  if (/^(https?:\/\/|about:|file:|chrome:)/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 0;
  } catch {
    return false;
  }
}

function ensureWithinRoot(root: string, path: string): boolean {
  if (root === '/') return path.startsWith('/');
  return path === root || path.startsWith(`${root}/`);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function formatSqlValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return `x'${toHex(value)}'`;
  return String(value);
}

function detectMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log')) return 'text/plain';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

async function getSqlJs(): Promise<SqlJsModule> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const sqlModule = await import('sql.js/dist/sql-wasm.js');
      const initSqlJs = (sqlModule as { default: InitSqlJs }).default;
      const wasmBase = typeof window === 'undefined'
        ? new URL('../../node_modules/sql.js/dist/', import.meta.url).toString()
        : SQLJS_WASM_CDN;
      return initSqlJs({ locateFile: (file) => `${wasmBase}${file}` });
    })();
  }
  return sqlJsPromise;
}

async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const indexURL = typeof window === 'undefined'
        ? decodeURIComponent(new URL('../../node_modules/pyodide/', import.meta.url).pathname)
        : PYODIDE_CDN;
      return loadPyodide({
        indexURL,
        fullStdLib: false,
      });
    })();
  }
  return pyodidePromise;
}

async function addPathToZip(
  ctx: CommandContext,
  fsPath: string,
  zipPath: string,
  out: Record<string, Uint8Array>,
): Promise<number> {
  const stat = await ctx.fs.stat(fsPath);
  if (stat.isFile) {
    out[zipPath] = await ctx.fs.readFileBuffer(fsPath);
    return 1;
  }
  const entries = await ctx.fs.readdir(fsPath);
  let added = 0;
  for (const name of entries) {
    const childFsPath = joinPath(fsPath, name);
    const childZipPath = zipPath ? `${zipPath}/${name}` : name;
    added += await addPathToZip(ctx, childFsPath, childZipPath, out);
  }
  return added;
}

function openHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: open <url|path> [url|path...]\n',
    stderr: '',
    exitCode: 0,
  };
}

function zipHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: zip [-r] <archive.zip> <path> [path...]\n',
    stderr: '',
    exitCode: 0,
  };
}

function unzipHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: unzip <archive.zip> [-d <destination>]\n',
    stderr: '',
    exitCode: 0,
  };
}

function sqliteHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: sqlite3 [database] [sql]\n',
    stderr: '',
    exitCode: 0,
  };
}

function pythonHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: python3 [-c code | script.py] [args...]\n',
    stderr: '',
    exitCode: 0,
  };
}

function pythonVersion(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'Python 3.12 (Pyodide)\n',
    stderr: '',
    exitCode: 0,
  };
}

function createOpenCommand(): Command {
  return defineCommand('open', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return openHelp();
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return {
        stdout: '',
        stderr: 'open: browser APIs are unavailable in this environment\n',
        exitCode: 1,
      };
    }

    let openedTabs = 0;
    let downloadedFiles = 0;

    for (const target of args) {
      if (isLikelyUrl(target)) {
        const tab = window.open(target, '_blank', 'noopener,noreferrer');
        if (!tab) {
          return {
            stdout: '',
            stderr: `open: failed to open URL: ${target}\n`,
            exitCode: 1,
          };
        }
        openedTabs++;
        continue;
      }

      const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
      const stat = await ctx.fs.stat(fullPath);
      if (!stat.isFile) {
        return {
          stdout: '',
          stderr: `open: not a file: ${target}\n`,
          exitCode: 1,
        };
      }

      const bytes = await ctx.fs.readFileBuffer(fullPath);
      const safeBytes = new Uint8Array(bytes.byteLength);
      safeBytes.set(bytes);
      const blob = new Blob([safeBytes.buffer], { type: detectMimeType(fullPath) });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = basename(fullPath) || 'download';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
      downloadedFiles++;
    }

    return {
      stdout: `opened ${openedTabs} tab(s), downloaded ${downloadedFiles} file(s)\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}

function createZipCommand(): Command {
  return defineCommand('zip', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return zipHelp();
    }

    let recursive = false;
    const positional: string[] = [];
    for (const arg of args) {
      if (arg === '-r') {
        recursive = true;
        continue;
      }
      if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `zip: unsupported option ${arg}\n`,
          exitCode: 1,
        };
      }
      positional.push(arg);
    }

    if (positional.length < 2) {
      return {
        stdout: '',
        stderr: 'zip: expected archive path and at least one input path\n',
        exitCode: 1,
      };
    }

    const archivePath = ctx.fs.resolvePath(ctx.cwd, positional[0]);
    const inputs = positional.slice(1);
    const archiveEntries: Record<string, Uint8Array> = {};
    let fileCount = 0;

    for (const input of inputs) {
      const resolved = ctx.fs.resolvePath(ctx.cwd, input);
      const stat = await ctx.fs.stat(resolved);
      const entryRoot = input.startsWith('/') ? input.slice(1) : input.replace(/^\.\//, '');
      const entryPath = entryRoot || basename(resolved);
      if (stat.isDirectory && !recursive) {
        return {
          stdout: '',
          stderr: `zip: ${input} is a directory (use -r)\n`,
          exitCode: 1,
        };
      }
      fileCount += await addPathToZip(ctx, resolved, entryPath, archiveEntries);
    }

    if (fileCount === 0) {
      return {
        stdout: '',
        stderr: 'zip: nothing to do\n',
        exitCode: 1,
      };
    }

    const zipped = zipSync(archiveEntries);
    await ctx.fs.writeFile(archivePath, zipped);

    return {
      stdout: `created ${archivePath} (${fileCount} file(s))\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}

function createUnzipCommand(): Command {
  return defineCommand('unzip', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return unzipHelp();
    }

    let destination = '.';
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-d') {
        destination = args[i + 1] ?? '';
        i++;
        continue;
      }
      if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `unzip: unsupported option ${arg}\n`,
          exitCode: 1,
        };
      }
      positional.push(arg);
    }

    if (positional.length < 1) {
      return {
        stdout: '',
        stderr: 'unzip: expected archive path\n',
        exitCode: 1,
      };
    }

    const archivePath = ctx.fs.resolvePath(ctx.cwd, positional[0]);
    const outputRoot = ctx.fs.resolvePath(ctx.cwd, destination || '.');
    await ctx.fs.mkdir(outputRoot, { recursive: true });

    const archiveBytes = await ctx.fs.readFileBuffer(archivePath);
    const files = unzipSync(archiveBytes);

    let extracted = 0;
    for (const [entry, content] of Object.entries(files)) {
      const normalized = entry.replace(/\\/g, '/');
      if (!normalized || normalized.endsWith('/')) continue;

      const outputPath = ctx.fs.resolvePath(outputRoot, normalized);
      if (!ensureWithinRoot(outputRoot, outputPath)) {
        return {
          stdout: '',
          stderr: `unzip: blocked suspicious path ${entry}\n`,
          exitCode: 1,
        };
      }

      const parent = dirname(outputPath);
      if (parent !== '/') await ctx.fs.mkdir(parent, { recursive: true });
      await ctx.fs.writeFile(outputPath, content);
      extracted++;
    }

    return {
      stdout: `extracted ${extracted} file(s) to ${outputRoot}\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}

function createSqliteCommand(name: 'sqlite3' | 'sqllite' = 'sqlite3'): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) return sqliteHelp();

    let dbArg = ':memory:';
    let sqlArgv = args;
    if (args.length > 0 && !args[0].startsWith('-')) {
      dbArg = args[0];
      sqlArgv = args.slice(1);
    }

    const sql = sqlArgv.join(' ').trim() || ctx.stdin.trim();
    if (!sql) {
      return {
        stdout: '',
        stderr: `${name}: interactive mode is not supported; provide SQL as argument or stdin\n`,
        exitCode: 1,
      };
    }

    try {
      const SQL = await getSqlJs();
      const isMemory = dbArg === ':memory:';
      const dbPath = isMemory ? ':memory:' : ctx.fs.resolvePath(ctx.cwd, dbArg);

      let dbBytes: Uint8Array | undefined;
      if (!isMemory && await ctx.fs.exists(dbPath)) {
        dbBytes = await ctx.fs.readFileBuffer(dbPath);
      }

      const db = dbBytes ? new SQL.Database(dbBytes) : new SQL.Database();
      const resultSets = db.exec(sql);

      if (!isMemory) {
        await ctx.fs.writeFile(dbPath, db.export());
      }
      db.close();

      const lines: string[] = [];
      for (const set of resultSets) {
        for (const row of set.values) {
          lines.push(row.map(formatSqlValue).join('|'));
        }
      }

      return {
        stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
        stderr: '',
        exitCode: 0,
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

function createPython3LikeCommand(name: 'python3' | 'python'): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) return pythonHelp();
    if (args.includes('--version') || args.includes('-V')) return pythonVersion();

    let code = '';
    let filename = '<stdin>';
    let argv: string[] = ['python3'];

    if (args[0] === '-c') {
      if (!args[1]) {
        return {
          stdout: '',
          stderr: `${name}: option requires an argument -- 'c'\n`,
          exitCode: 2,
        };
      }
      code = args[1];
      filename = '-c';
      argv = ['-c', ...args.slice(2)];
    } else if (args.length > 0 && !args[0].startsWith('-')) {
      const scriptArg = args[0];
      const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptArg);
      if (!await ctx.fs.exists(scriptPath)) {
        return {
          stdout: '',
          stderr: `${name}: can't open file '${scriptArg}': [Errno 2] No such file or directory\n`,
          exitCode: 2,
        };
      }
      code = await ctx.fs.readFile(scriptPath);
      filename = scriptArg;
      argv = [scriptArg, ...args.slice(1)];
    } else if (ctx.stdin.trim().length > 0) {
      code = ctx.stdin;
      filename = '<stdin>';
      argv = ['<stdin>'];
    } else if (args.length > 0) {
      return {
        stdout: '',
        stderr: `${name}: unsupported option '${args[0]}'\n`,
        exitCode: 2,
      };
    } else {
      return {
        stdout: '',
        stderr: `${name}: no input provided (use -c CODE, script path, or stdin)\n`,
        exitCode: 2,
      };
    }

    try {
      const pyodide = await getPyodide();
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      pyodide.setStdout({ batched: (msg) => stdoutChunks.push(msg) });
      pyodide.setStderr({ batched: (msg) => stderrChunks.push(msg) });
      pyodide.globals.set('__slicc_code', code);
      pyodide.globals.set('__slicc_filename', filename);
      pyodide.globals.set('__slicc_argv', argv);

      await pyodide.runPythonAsync(PYTHON_RUNNER);
      const exitCodeRaw = pyodide.globals.get('__slicc_exit_code');
      const exitCode = typeof exitCodeRaw === 'number' ? exitCodeRaw : Number(exitCodeRaw ?? 1);

      try {
        pyodide.runPython('del __slicc_code, __slicc_filename, __slicc_argv, __slicc_exit_code');
      } catch {
        // Best-effort cleanup only.
      }

      return {
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode,
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

export function createSupplementalCommands(): Command[] {
  return [
    createOpenCommand(),
    createZipCommand(),
    createUnzipCommand(),
    createSqliteCommand('sqlite3'),
    createSqliteCommand('sqllite'),
    createPython3LikeCommand('python3'),
    createPython3LikeCommand('python'),
  ];
}
