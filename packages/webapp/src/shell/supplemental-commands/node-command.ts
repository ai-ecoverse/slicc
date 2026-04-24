import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { NODE_VERSION, NodeExitError, formatConsoleArg, nodeRuntimeState } from './shared.js';

const NODE_BUILTINS_UNAVAILABLE = new Set([
  'http',
  'https',
  'net',
  'tls',
  'dgram',
  'dns',
  'cluster',
  'worker_threads',
  'child_process',
  'crypto',
  'os',
  'stream',
  'zlib',
  'vm',
  'v8',
  'perf_hooks',
  'readline',
  'repl',
  'tty',
  'inspector',
]);

/**
 * Extract require('...') specifiers from source code via regex.
 * Matches require("foo"), require('foo'), and require(`foo`) with static string literals.
 */
function extractRequireSpecifiers(code: string): string[] {
  const re = /\brequire\s*\(\s*(['"`])([^'"`\s]+)\1\s*\)/g;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    ids.add(m[2]);
  }
  return [...ids];
}

function nodeHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: node -e <code> [args...]\n',
    stderr: '',
    exitCode: 0,
  };
}

function nodeVersion(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `${NODE_VERSION}\n`,
    stderr: '',
    exitCode: 0,
  };
}

export function createNodeCommand(): Command {
  return defineCommand('node', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) return nodeHelp();
    if (args.includes('--version') || args.includes('-v')) return nodeVersion();

    let code = '';
    let filename = '<stdin>';
    let argv: string[] = ['node'];

    if (args.length > 0 && (args[0] === '-e' || args[0] === '--eval')) {
      if (!args[1]) {
        return {
          stdout: '',
          stderr: 'node: option requires an argument -- eval\n',
          exitCode: 9,
        };
      }
      code = args[1];
      filename = '[eval]';
      argv = ['node', ...args.slice(2)];
    } else if (args.length > 0 && !args[0].startsWith('-')) {
      const scriptArg = args[0];
      const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptArg);
      if (!(await ctx.fs.exists(scriptPath))) {
        return {
          stdout: '',
          stderr: `node: cannot find module '${scriptArg}'\n`,
          exitCode: 1,
        };
      }
      code = await ctx.fs.readFile(scriptPath);
      filename = scriptArg;
      argv = ['node', scriptArg, ...args.slice(1)];
    } else if (ctx.stdin.trim().length > 0) {
      code = ctx.stdin;
      filename = '<stdin>';
      argv = ['node'];
    } else if (args.length > 0) {
      return {
        stdout: '',
        stderr: `node: unsupported option '${args[0]}'\n`,
        exitCode: 9,
      };
    } else {
      return {
        stdout: '',
        stderr: 'node: REPL mode is not supported in this environment; use node -e "code"\n',
        exitCode: 9,
      };
    }

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

    // Shell command bridge — lets node -e scripts run shell commands via exec('ls -la')
    // Delegates to just-bash's WASM interpreter, NOT Node's child_process.
    const execBridge = async (
      command: string
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (!ctx.exec) throw new Error('exec is not available in this runtime');
      const result = await ctx.exec(command, { cwd: ctx.cwd });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    };

    const isExtensionMode = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

    if (!isExtensionMode) {
      // Pre-scan code for require('...') specifiers and fetch them into the cache
      // so that requireShim can return synchronously.
      // (extension mode handles this inside the sandbox)
      const specifiers = extractRequireSpecifiers(code);
      // Filter out Node built-ins we handle locally
      const builtinsLocal = new Set(['fs', 'process', 'buffer']);
      const filteredSpecifiers = specifiers
        .map((s) => (s.startsWith('node:') ? s.slice(5) : s))
        .filter((s) => !builtinsLocal.has(s) && !NODE_BUILTINS_UNAVAILABLE.has(s));
      const cache = (nodeRuntimeState.__requireCache ??
        (nodeRuntimeState.__requireCache = Object.create(null))) as Record<string, unknown>;
      const uncached = filteredSpecifiers.filter((id) => !(id in cache));
      if (uncached.length > 0) {
        const results = await Promise.allSettled(
          uncached.map(async (id) => {
            const mod = await import(/* @vite-ignore */ 'https://esm.sh/' + id);
            const val = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
            cache[id] = val;
          })
        );
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === 'rejected') {
            const err = (results[i] as PromiseRejectedResult).reason;
            writeStderr(
              `Warning: failed to pre-load require('${uncached[i]}'): ${err instanceof Error ? err.message : String(err)}\n`
            );
          }
        }
      }
    }

    const requireShim = (id: string): unknown => {
      const bareId = id.startsWith('node:') ? id.slice(5) : id;
      // Node built-in interception
      if (bareId === 'fs') return fsBridge;
      if (bareId === 'process') return processShim;
      if (bareId === 'buffer') return { Buffer: globalThis.Buffer };
      if (bareId === 'path') {
        // Check cache first (path-browserify may have been pre-fetched)
        const cache = nodeRuntimeState.__requireCache as Record<string, unknown> | undefined;
        if (cache && 'path' in cache) return cache['path'];
        if (cache && id in cache) return cache[id];
        // Will be handled by esm.sh pre-fetch if statically referenced
        throw new Error(
          `require('${id}'): path module not pre-loaded. Add require('path') as a static import.`
        );
      }
      if (NODE_BUILTINS_UNAVAILABLE.has(bareId)) {
        const hints: Record<string, string> = {
          http: ' Use fetch() instead.',
          https: ' Use fetch() instead.',
          child_process: ' Use exec() which is available as a shell bridge.',
          crypto: ' Use globalThis.crypto (Web Crypto API) instead.',
        };
        throw new Error(
          `require('${id}'): Node built-in '${bareId}' is not available in the browser environment.${hints[bareId] || ''}`
        );
      }
      // Regular npm package cache lookup
      const cache = nodeRuntimeState.__requireCache as Record<string, unknown> | undefined;
      if (cache && id in cache) return cache[id];
      throw new Error(
        `require('${id}'): module not pre-loaded. Use a string literal or await import('https://esm.sh/${id}') directly.`
      );
    };

    const moduleShim = { exports: {} as Record<string, unknown>, filename };

    try {
      // In extension mode, AsyncFunction constructor is blocked by CSP.
      // Route through the JavaScript tool's sandbox iframe which has full VFS bridge.
      if (isExtensionMode) {
        // Wrap the user code with node-like shims.
        // The sandbox already provides `fs` (with readFile, writeFile, readDir, exists, etc.)
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
          const exec = (command) => new Promise((resolve, reject) => {
            const id = 'shell_exec_' + Math.random().toString(36).slice(2);
            const handler = (event) => {
              if (event.data?.type === 'shell_exec_response' && event.data.id === id) {
                self.removeEventListener('message', handler);
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.result);
              }
            };
            self.addEventListener('message', handler);
            parent.postMessage({ type: 'shell_exec', id, command }, '*');
          });
          const __builtinsLocal = new Set(['fs', 'process', 'buffer']);
          const __NODE_BUILTINS_UNAVAILABLE = new Set([
            'http', 'https', 'net', 'tls', 'dgram', 'dns', 'cluster',
            'worker_threads', 'child_process', 'crypto', 'os', 'stream',
            'zlib', 'vm', 'v8', 'perf_hooks', 'readline', 'repl', 'tty', 'inspector'
          ]);
          const __requireCache = Object.create(null);
          async function __loadModule(id) {
            var parsedUrl = new URL('https://esm.sh/' + id);
            parsedUrl.searchParams.set('bundle', '');
            var url = parsedUrl.toString();
            try {
              return await import(url);
            } catch(e) {
              var resp = await fetch(url);
              if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching ' + url);
              var text = await resp.text();
              var __mod = { exports: {} };
              (0, Function)('module', 'exports', text)(__mod, __mod.exports);
              return __mod.exports;
            }
          }
          {
            const __code = ${JSON.stringify(code)};
            const __re = /\\brequire\\s*\\(\\s*(['"\`])([^'"\`\\s]+)\\1\\s*\\)/g;
            const __ids = new Set();
            let __m;
            while ((__m = __re.exec(__code)) !== null) __ids.add(__m[2]);
            const __uncached = [...__ids]
              .map(s => s.startsWith('node:') ? s.slice(5) : s)
              .filter(s => !__builtinsLocal.has(s) && !__NODE_BUILTINS_UNAVAILABLE.has(s))
              .filter((id) => !(id in __requireCache));
            if (__uncached.length > 0) {
              const __results = await Promise.allSettled(
                __uncached.map(async (id) => {
                  const mod = await __loadModule(id);
                  const val = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
                  __requireCache[id] = val;
                })
              );
              for (let __i = 0; __i < __results.length; __i++) {
                if (__results[__i].status === 'rejected') {
                  __stderr.push("Warning: failed to pre-load require('" + __uncached[__i] + "'): " + __results[__i].reason + "\\n");
                }
              }
            }
          }
          const require = (id) => {
            const bareId = id.startsWith('node:') ? id.slice(5) : id;
            if (bareId === 'fs') return fs;
            if (bareId === 'process') return process;
            if (bareId === 'buffer') return { Buffer: globalThis.Buffer || (typeof Buffer !== 'undefined' ? Buffer : undefined) };
            if (__NODE_BUILTINS_UNAVAILABLE.has(bareId)) {
              const __hints = { http: ' Use fetch() instead.', https: ' Use fetch() instead.', child_process: ' Use exec() which is available as a shell bridge.', crypto: ' Use globalThis.crypto (Web Crypto API) instead.' };
              throw new Error("require('" + id + "'): Node built-in '" + bareId + "' is not available in the browser environment." + (__hints[bareId] || ''));
            }
            if (bareId in __requireCache) return __requireCache[bareId];
            if (id in __requireCache) return __requireCache[id];
            throw new Error("require('" + id + "'): module not pre-loaded. Use a string literal or await import('https://esm.sh/" + id + "') directly.");
          };
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

        // Find or create the sandbox iframe (shared with the JavaScript tool)
        let sandbox = document.querySelector('iframe[data-js-tool]') as HTMLIFrameElement | null;
        if (!sandbox) {
          sandbox = document.createElement('iframe');
          sandbox.style.display = 'none';
          sandbox.dataset.jsTool = 'true';
          sandbox.src = chrome.runtime.getURL('sandbox.html');
          document.body.appendChild(sandbox);
          await new Promise<void>((resolve) => {
            sandbox!.addEventListener('load', () => resolve(), { once: true });
          });
        }

        const execId = `node-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Register a temporary VFS handler so fs.* calls from the sandbox
        // are handled against the real VFS via ctx.fs (same pattern as jsh-executor.ts).
        const vfsHandler = (event: MessageEvent) => {
          const msg = event.data;
          if (!msg || msg.type !== 'vfs') return;
          (async () => {
            try {
              let result: unknown;
              const resolved = msg.args?.[0]
                ? ctx.fs.resolvePath(ctx.cwd, msg.args[0])
                : msg.args?.[0];
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
              sandbox!.contentWindow!.postMessage(
                { type: 'vfs_response', id: msg.id, result },
                '*'
              );
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              sandbox!.contentWindow!.postMessage(
                { type: 'vfs_response', id: msg.id, error: errMsg },
                '*'
              );
            }
          })();
        };
        window.addEventListener('message', vfsHandler);

        // Register a shell exec handler so exec() calls from the sandbox
        // are routed to the host's just-bash interpreter via ctx.exec.
        const shellExecHandler = (event: MessageEvent) => {
          const msg = event.data;
          if (!msg || msg.type !== 'shell_exec') return;
          (async () => {
            try {
              const result = await execBridge(msg.command);
              sandbox!.contentWindow!.postMessage(
                { type: 'shell_exec_response', id: msg.id, result },
                '*'
              );
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              sandbox!.contentWindow!.postMessage(
                { type: 'shell_exec_response', id: msg.id, error: errMsg },
                '*'
              );
            }
          })();
        };
        window.addEventListener('message', shellExecHandler);

        // Register a fetch proxy handler so cross-origin fetch() calls from the
        // sandbox are routed through the host page (which has host_permissions).
        // NOTE: In extension mode, the parent handler calls fetch() directly
        // (not through /api/fetch-proxy), so there is no server-side decoder.
        // Cookie headers will still be stripped by the browser's fetch() API.
        // Cookie-based auth in extension mode requires playwright-cli eval.
        const fetchProxyHandler = (event: MessageEvent) => {
          const msg = event.data;
          if (!msg || msg.type !== 'fetch_proxy') return;
          (async () => {
            try {
              const init: RequestInit = { method: msg.init?.method ?? 'GET', cache: 'no-store' };
              if (msg.init?.headers) init.headers = msg.init.headers;
              if (msg.init?.body && !['GET', 'HEAD'].includes(init.method as string)) {
                init.body = msg.init.body;
              }
              const resp = await fetch(msg.url, init);
              const buf = await resp.arrayBuffer();
              const headers: Record<string, string> = {};
              resp.headers.forEach((v, k) => {
                headers[k] = v;
              });
              sandbox!.contentWindow!.postMessage(
                {
                  type: 'fetch_proxy_response',
                  id: msg.id,
                  status: resp.status,
                  statusText: resp.statusText,
                  headers,
                  body: new Uint8Array(buf),
                },
                '*'
              );
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              sandbox!.contentWindow!.postMessage(
                { type: 'fetch_proxy_response', id: msg.id, error: errMsg },
                '*'
              );
            }
          })();
        };
        window.addEventListener('message', fetchProxyHandler);

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
            reject(new Error('node eval timed out (30s)'));
          }, 30000);
          window.addEventListener('message', handler);
          sandbox!.contentWindow!.postMessage({ type: 'exec', id: execId, code: wrappedCode }, '*');
        });

        // Clean up listeners after execution completes
        window.removeEventListener('message', vfsHandler);
        window.removeEventListener('message', shellExecHandler);
        window.removeEventListener('message', fetchProxyHandler);

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.stderr ? 1 : 0,
        };
      }

      const AsyncFunction = Object.getPrototypeOf(async function () {
        /* noop */
      }).constructor as new (
        ...args: string[]
      ) => (
        fs: typeof fsBridge,
        process: typeof processShim,
        console: typeof nodeConsole,
        require: (id: string) => unknown,
        module: typeof moduleShim,
        exports: Record<string, unknown>,
        __state: Record<string, unknown>,
        exec: typeof execBridge
      ) => Promise<unknown>;
      const fn = new AsyncFunction(
        'fs',
        'process',
        'console',
        'require',
        'module',
        'exports',
        '__state',
        'exec',
        `"use strict";\nconst globalThis = __state;\nconst global = __state;\n${code}`
      );
      await fn(
        fsBridge,
        processShim,
        nodeConsole,
        requireShim,
        moduleShim,
        moduleShim.exports,
        nodeRuntimeState,
        execBridge
      );
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
  });
}
