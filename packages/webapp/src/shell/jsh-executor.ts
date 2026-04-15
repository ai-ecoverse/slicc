import type { CommandContext } from 'just-bash';
import {
  NodeExitError,
  formatConsoleArg,
  hasESMImports,
  nodeRuntimeState,
} from './supplemental-commands/shared.js';
import { rewriteImportSpecifiers } from './esm-import-map.js';

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

/** Extract all require('...') specifiers from code via regex pre-scan. */
function extractRequireSpecifiers(code: string): string[] {
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const specifiers: string[] = [];
  let match;
  while ((match = re.exec(code)) !== null) {
    specifiers.push(match[1]);
  }
  return [...new Set(specifiers)]; // deduplicate
}

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
  ctx: CommandContext
): Promise<JshResult> {
  if (!(await ctx.fs.exists(scriptPath))) {
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
  ctx: CommandContext
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
    stat: async (
      path: string
    ): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> => {
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

  // Shell command bridge — lets JSH scripts run shell commands via `exec('ls -la')`
  // This delegates to just-bash's WASM interpreter, NOT Node's child_process.
  const execBridge = async (
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    if (!ctx.exec) throw new Error('exec is not available in this runtime');
    const result = await ctx.exec(command, { cwd: ctx.cwd });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  };

  const isExtensionMode = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

  if (!isExtensionMode) {
    // Pre-scan code for require() calls and pre-fetch all modules before execution
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
          const mod = await import('https://esm.sh/' + id);
          return { id, value: mod.default !== undefined ? mod.default : mod };
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          cache[r.value.id] = r.value.value;
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
    const reqCache = nodeRuntimeState.__requireCache as Record<string, unknown> | undefined;
    if (reqCache && id in reqCache) return reqCache[id];
    throw new Error(
      `require('${id}'): module not pre-loaded. Use a string literal so it can be pre-fetched, or use \`await import('https://esm.sh/${id}')\` directly.`
    );
  };

  const moduleShim = { exports: {} as Record<string, unknown>, filename: argv[1] || '<script>' };

  // ── ESM execution path ──────────────────────────────────────────────
  if (hasESMImports(code)) {
    return executeEsmModule(code, argv, fsBridge, processShim, nodeConsole, execBridge);
  }

  try {
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
        const __requireSpecifiers = (function() {
          const re = /require\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)/g;
          const code = ${JSON.stringify(code)};
          const specs = [];
          let m;
          while ((m = re.exec(code)) !== null) specs.push(m[1]);
          return [...new Set(specs)]
            .map(s => s.startsWith('node:') ? s.slice(5) : s)
            .filter(s => !__builtinsLocal.has(s) && !__NODE_BUILTINS_UNAVAILABLE.has(s));
        })();
        const __requireCache = Object.create(null);
        async function __loadModule(id) {
          const url = 'https://esm.sh/' + id;
          try {
            return await import(url);
          } catch(e) {
            // Fallback for sandbox/extension mode: fetch + blob URL
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching ' + url);
            const text = await resp.text();
            const blob = new Blob([text], { type: 'text/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            try {
              return await import(blobUrl);
            } finally {
              URL.revokeObjectURL(blobUrl);
            }
          }
        }
        await Promise.allSettled(__requireSpecifiers.map(async (id) => {
          try {
            const mod = await __loadModule(id);
            __requireCache[id] = mod.default !== undefined ? mod.default : mod;
          } catch(e) { /* will throw when require() is called */ }
        }));
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

      const execId = `jsh-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Register a temporary VFS message listener so fs.* calls from the sandbox
      // are handled against the real VFS via ctx.fs (same pattern as javascript-tool.ts).
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
            sandbox!.contentWindow!.postMessage({ type: 'vfs_response', id: msg.id, result }, '*');
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

      // Register a shell exec handler so `exec()` calls from the sandbox
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
          reject(new Error('jsh eval timed out (30s)'));
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

    // CLI mode: use AsyncFunction constructor
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
}

// ── ESM module execution ──────────────────────────────────────────────

/**
 * Execute code that contains static ESM `import` statements.
 *
 * **CLI mode (document exists):**
 * 1. Set up `globalThis.__slicc_*` shim objects so that synthetic `/__shims/*`
 *    modules resolved by the preview service worker can re-export them.
 * 2. Inject a `<script type="importmap">` into the document so the browser
 *    knows where to fetch each bare specifier.
 * 3. Write the code to a temporary VFS file and `await import()` via the
 *    preview URL so the browser treats it as a real ES module.
 * 4. Clean up the temp file, import map element, and globalThis shims.
 *
 * **Extension mode:**
 * Posts an `esm_exec` message to the sandbox iframe (handler TBD in a later
 * task). Falls back gracefully with a descriptive error until that handler
 * is wired up.
 *
 * **Test / Node environment (no document, no preview SW):**
 * Returns a clear error instead of falling through to the AsyncFunction
 * path which would throw a SyntaxError on static `import` statements.
 */
async function executeEsmModule(
  code: string,
  argv: string[],
  fsBridge: {
    readFile: (path: string) => Promise<string>;
    readFileBinary: (path: string) => Promise<Uint8Array>;
    writeFile: (path: string, content: string) => Promise<void>;
    writeFileBinary: (path: string, bytes: Uint8Array) => Promise<void>;
    readDir: (path: string) => Promise<string[]>;
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<{ isDirectory: boolean; isFile: boolean; size: number }>;
    mkdir: (path: string) => Promise<void>;
    rm: (path: string) => Promise<void>;
    fetchToFile: (url: string, path: string) => Promise<number>;
  },
  processShim: {
    argv: string[];
    env: Record<string, string>;
    cwd: () => string;
    exit: (code?: number) => never;
    stdout: { write: (value: unknown) => void };
    stderr: { write: (value: unknown) => void };
  },
  nodeConsole: {
    log: (...parts: unknown[]) => void;
    info: (...parts: unknown[]) => void;
    warn: (...parts: unknown[]) => void;
    error: (...parts: unknown[]) => void;
  },
  execBridge: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
): Promise<JshResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const writeStdout = (value: unknown): void => {
    stdoutChunks.push(typeof value === 'string' ? value : String(value));
  };
  const writeStderr = (value: unknown): void => {
    stderrChunks.push(typeof value === 'string' ? value : String(value));
  };

  // Rebuild local console capturer so ESM path has its own stdout/stderr buffers
  const esmConsole = {
    log: (...parts: unknown[]) => writeStdout(`${parts.map(formatConsoleArg).join(' ')}\n`),
    info: (...parts: unknown[]) => writeStdout(`${parts.map(formatConsoleArg).join(' ')}\n`),
    warn: (...parts: unknown[]) => writeStderr(`${parts.map(formatConsoleArg).join(' ')}\n`),
    error: (...parts: unknown[]) => writeStderr(`${parts.map(formatConsoleArg).join(' ')}\n`),
  };

  const isExtensionMode = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

  // ── Extension mode: post esm_exec to sandbox ──────────────────────
  if (isExtensionMode) {
    // The sandbox handler for esm_exec will be added in a later task.
    // For now, return a descriptive error.
    return {
      stdout: '',
      stderr: 'ESM import execution in extension mode is not yet supported.\n',
      exitCode: 1,
    };
  }

  // ── CLI mode: import via preview SW ───────────────────────────────
  if (typeof document === 'undefined') {
    // Test / Node environment — no document or preview SW available.
    return {
      stdout: '',
      stderr:
        'ESM imports detected but no browser document is available for module execution.\n' +
        'ESM execution requires the preview service worker (CLI/browser mode).\n',
      exitCode: 1,
    };
  }

  // Rewrite all import specifiers to absolute URLs so the code can run from
  // a blob URL without relying on import maps or a SW intercepting blob fetches.
  // - bare specifiers (npm, builtins) → absolute URLs (esm.sh or /preview/__shims/...)
  // - relative imports (./foo.js)     → absolute preview SW URLs
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5710';
  const scriptVfsDir = argv[1]
    ? argv[1].substring(0, argv[1].lastIndexOf('/')) || '/workspace'
    : '/workspace';
  const rewritten = rewriteImportSpecifiers(code, scriptVfsDir, origin);

  // Save/restore originals for console monkey-patching
  const origConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  let blobUrl: string | null = null;

  try {
    // 1. Set globalThis shims so /preview/__shims/* modules can re-export them
    (globalThis as Record<string, unknown>).__slicc_fs = fsBridge;
    (globalThis as Record<string, unknown>).__slicc_process = processShim;
    (globalThis as Record<string, unknown>).__slicc_exec = execBridge;

    // 2. Monkey-patch console to capture stdout/stderr
    console.log = esmConsole.log;
    console.info = esmConsole.info;
    console.warn = esmConsole.warn;
    console.error = esmConsole.error;

    // 3. Execute as a real ES module via blob URL.
    //    Blob's internal imports use absolute URLs → no SW interception needed.
    const blob = new Blob([rewritten], { type: 'text/javascript' });
    blobUrl = URL.createObjectURL(blob);
    await import(/* @vite-ignore */ blobUrl);

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
  } finally {
    // Restore console
    console.log = origConsole.log;
    console.info = origConsole.info;
    console.warn = origConsole.warn;
    console.error = origConsole.error;

    // Remove globalThis shims
    delete (globalThis as Record<string, unknown>).__slicc_fs;
    delete (globalThis as Record<string, unknown>).__slicc_process;
    delete (globalThis as Record<string, unknown>).__slicc_exec;

    // Revoke blob URL
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}
