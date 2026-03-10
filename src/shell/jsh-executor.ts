import type { CommandContext } from 'just-bash';
import { NodeExitError, formatConsoleArg, nodeRuntimeState } from './supplemental-commands/shared.js';

export interface JshResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a .jsh file with Node-like globals.
 * Reuses the same dual-mode strategy as `node -e`:
 * - CLI/standalone: AsyncFunction constructor
 * - Extension: sandbox iframe via postMessage
 */
export async function executeJshFile(
  scriptPath: string,
  args: string[],
  ctx: CommandContext,
): Promise<JshResult> {
  if (!await ctx.fs.exists(scriptPath)) {
    return {
      stdout: '',
      stderr: `jsh: cannot find script '${scriptPath}'\n`,
      exitCode: 127,
    };
  }

  const code = await ctx.fs.readFile(scriptPath);
  const argv = ['node', scriptPath, ...args];

  return executeJsCode(code, argv, ctx);
}

/**
 * Core JS execution engine shared between `node -e` and `.jsh` files.
 * Handles both CLI mode (AsyncFunction) and extension mode (sandbox iframe).
 */
export async function executeJsCode(
  code: string,
  argv: string[],
  ctx: CommandContext,
): Promise<JshResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const writeStdout = (value: unknown): void => {
    stdoutChunks.push(typeof value === 'string' ? value : String(value));
  };
  const writeStderr = (value: unknown): void => {
    stderrChunks.push(typeof value === 'string' ? value : String(value));
  };

  const nodeConsole = {
    log: (...parts: unknown[]) => writeStdout(`${parts.map(formatConsoleArg).join(' ')}\n`),
    info: (...parts: unknown[]) => writeStdout(`${parts.map(formatConsoleArg).join(' ')}\n`),
    warn: (...parts: unknown[]) => writeStderr(`${parts.map(formatConsoleArg).join(' ')}\n`),
    error: (...parts: unknown[]) => writeStderr(`${parts.map(formatConsoleArg).join(' ')}\n`),
  };

  const processShim = {
    argv,
    env: Object.fromEntries(ctx.env.entries()),
    cwd: () => ctx.cwd,
    exit: (codeValue?: number) => {
      const normalized = Number.isFinite(codeValue) ? Number(codeValue) : 0;
      throw new NodeExitError(normalized);
    },
    stdout: { write: writeStdout },
    stderr: { write: writeStderr },
  };

  const fsBridge = {
    readFile: async (path: string): Promise<string> => {
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      return ctx.fs.readFile(resolved);
    },
    readFileBinary: async (path: string): Promise<Uint8Array> => {
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      return ctx.fs.readFileBuffer(resolved);
    },
    writeFile: async (path: string, content: string): Promise<void> => {
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      await ctx.fs.writeFile(resolved, content);
    },
    writeFileBinary: async (path: string, bytes: Uint8Array): Promise<void> => {
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      await ctx.fs.writeFile(resolved, copy);
    },
    readDir: async (path: string): Promise<string[]> => {
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      return ctx.fs.readdir(resolved);
    },
    exists: async (path: string): Promise<boolean> => {
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      return ctx.fs.exists(resolved);
    },
    stat: async (path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> => {
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      const st = await ctx.fs.stat(resolved);
      return { isDirectory: st.isDirectory, isFile: st.isFile, size: st.size };
    },
    mkdir: async (path: string): Promise<void> => {
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      await ctx.fs.mkdir(resolved, { recursive: true });
    },
    rm: async (path: string): Promise<void> => {
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      await ctx.fs.rm(resolved, { recursive: true });
    },
    fetchToFile: async (url: string, path: string): Promise<number> => {
      if (typeof fetch === 'undefined') throw new Error('fetch is not available in this runtime');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`fetch ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      await ctx.fs.writeFile(resolved, bytes);
      return bytes.byteLength;
    },
  };

  const requireShim = (id: string): never => {
    throw new Error(`require('${id}') is not supported in node shim`);
  };

  const moduleShim = { exports: {} as Record<string, unknown>, filename: argv[1] || '<script>' };

  try {
    const isExtensionMode = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
    if (isExtensionMode) {
      const wrappedCode = `
        const __stdout = [];
        const __stderr = [];
        const __origConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info };
        console.log = (...a) => __stdout.push(a.map(String).join(' ') + '\\n');
        console.error = (...a) => __stderr.push(a.map(String).join(' ') + '\\n');
        console.warn = (...a) => __stderr.push(a.map(String).join(' ') + '\\n');
        console.info = (...a) => __stdout.push(a.map(String).join(' ') + '\\n');
        const process = {
          argv: ${JSON.stringify(argv)},
          env: ${JSON.stringify(processShim.env)},
          exit: (c) => { throw { __nodeExitCode: c || 0 }; },
          stdout: { write: (s) => { __stdout.push(String(s)); return true; } },
          stderr: { write: (s) => { __stderr.push(String(s)); return true; } },
          cwd: () => ${JSON.stringify(processShim.cwd())},
        };
        const require = (id) => { throw new Error("require('" + id + "') is not supported"); };
        const module = { exports: {} };
        const exports = module.exports;
        try {
          ${code}
        } catch(e) {
          if (e && e.__nodeExitCode !== undefined) { /* process.exit() */ }
          else __stderr.push(String(e.stack || e) + '\\n');
        }
        console.log = __origConsole.log;
        console.error = __origConsole.error;
        console.warn = __origConsole.warn;
        console.info = __origConsole.info;
        return { stdout: __stdout.join(''), stderr: __stderr.join('') };
      `;

      let sandbox = document.querySelector('iframe[data-js-tool]') as HTMLIFrameElement | null;
      if (!sandbox) {
        sandbox = document.createElement('iframe');
        sandbox.style.display = 'none';
        sandbox.dataset.jsTool = 'true';
        sandbox.src = chrome.runtime.getURL('sandbox.html');
        document.body.appendChild(sandbox);
        await new Promise<void>(resolve => {
          sandbox!.addEventListener('load', () => resolve(), { once: true });
        });
      }

      const execId = `jsh-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Register a temporary VFS message listener so fs.* calls from the sandbox
      // are handled against the real VFS via ctx.fs (same pattern as javascript-tool.ts).
      const vfsHandler = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || msg.type !== 'vfs') return;
        (async () => {
          try {
            let result: unknown;
            const resolved = msg.args?.[0] ? ctx.fs.resolvePath(ctx.cwd, msg.args[0]) : msg.args?.[0];
            switch (msg.op) {
              case 'readFile':
                result = await ctx.fs.readFile(resolved);
                break;
              case 'readFileBinary':
                result = await ctx.fs.readFileBuffer(resolved);
                break;
              case 'writeFile':
                await ctx.fs.writeFile(resolved, msg.args[1]);
                result = true;
                break;
              case 'writeFileBinary':
                await ctx.fs.writeFile(resolved, msg.binaryData ?? new Uint8Array());
                result = true;
                break;
              case 'readDir':
                result = await ctx.fs.readdir(resolved);
                break;
              case 'exists':
                result = await ctx.fs.exists(resolved);
                break;
              case 'stat': {
                const st = await ctx.fs.stat(resolved);
                result = { isDirectory: st.isDirectory, isFile: st.isFile, size: st.size };
                break;
              }
              case 'mkdir':
                await ctx.fs.mkdir(resolved, { recursive: true });
                result = true;
                break;
              case 'rm':
                await ctx.fs.rm(resolved, { recursive: true });
                result = true;
                break;
            }
            sandbox!.contentWindow!.postMessage({ type: 'vfs_response', id: msg.id, result }, '*');
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            sandbox!.contentWindow!.postMessage({ type: 'vfs_response', id: msg.id, error: errMsg }, '*');
          }
        })();
      };
      window.addEventListener('message', vfsHandler);

      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;
        const handler = (event: MessageEvent) => {
          if (event.data?.type === 'exec_result' && event.data.id === execId) {
            window.removeEventListener('message', handler);
            clearTimeout(timeout);
            if (event.data.error) {
              resolve({ stdout: '', stderr: event.data.error + '\n' });
            } else {
              try {
                const parsed = JSON.parse(event.data.result);
                resolve({ stdout: parsed.stdout || '', stderr: parsed.stderr || '' });
              } catch {
                resolve({ stdout: event.data.result || '', stderr: '' });
              }
            }
          }
        };
        timeout = setTimeout(() => {
          window.removeEventListener('message', handler);
          reject(new Error('jsh eval timed out (30s)'));
        }, 30000);
        window.addEventListener('message', handler);
        sandbox!.contentWindow!.postMessage({ type: 'exec', id: execId, code: wrappedCode }, '*');
      });

      // Clean up VFS listener after execution completes
      window.removeEventListener('message', vfsHandler);

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.stderr ? 1 : 0,
      };
    }

    // CLI mode: use AsyncFunction constructor
    const AsyncFunction = Object.getPrototypeOf(async function () { /* noop */ }).constructor as (
      new (...args: string[]) => (
        fs: typeof fsBridge,
        process: typeof processShim,
        console: typeof nodeConsole,
        require: (id: string) => never,
        module: typeof moduleShim,
        exports: Record<string, unknown>,
        __state: Record<string, unknown>,
      ) => Promise<unknown>
    );
    const fn = new AsyncFunction(
      'fs',
      'process',
      'console',
      'require',
      'module',
      'exports',
      '__state',
      `"use strict";\nconst globalThis = __state;\nconst global = __state;\n${code}`,
    );
    await fn(fsBridge, processShim, nodeConsole, requireShim, moduleShim, moduleShim.exports, nodeRuntimeState);
    return {
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
      exitCode: 0,
    };
  } catch (err) {
    if (err instanceof NodeExitError) {
      return {
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode: err.code,
      };
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return {
      stdout: stdoutChunks.join(''),
      stderr: `${stderrChunks.join('')}${message}\n`,
      exitCode: 1,
    };
  }
}
