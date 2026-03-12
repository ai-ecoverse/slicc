import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { NODE_VERSION, NodeExitError, formatConsoleArg, nodeRuntimeState } from './shared.js';

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
      if (!await ctx.fs.exists(scriptPath)) {
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
    const execBridge = async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (!ctx.exec) throw new Error('exec is not available in this runtime');
      const result = await ctx.exec(command, { cwd: ctx.cwd });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    };

    const requireShim = (id: string): never => {
      throw new Error(`require('${id}') is not supported in node shim`);
    };

    const moduleShim = { exports: {} as Record<string, unknown>, filename };

    try {
      // In extension mode, AsyncFunction constructor is blocked by CSP.
      // Route through the JavaScript tool's sandbox iframe which has full VFS bridge.
      const isExtensionMode = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
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

        // Find or create the sandbox iframe (shared with the JavaScript tool)
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

        const execId = `node-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Register a temporary VFS handler so fs.* calls from the sandbox
        // are handled against the real VFS via ctx.fs (same pattern as jsh-executor.ts).
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

        // Register a shell exec handler so exec() calls from the sandbox
        // are routed to the host's just-bash interpreter via ctx.exec.
        const shellExecHandler = (event: MessageEvent) => {
          const msg = event.data;
          if (!msg || msg.type !== 'shell_exec') return;
          (async () => {
            try {
              const result = await execBridge(msg.command);
              sandbox!.contentWindow!.postMessage({ type: 'shell_exec_response', id: msg.id, result }, '*');
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              sandbox!.contentWindow!.postMessage({ type: 'shell_exec_response', id: msg.id, error: errMsg }, '*');
            }
          })();
        };
        window.addEventListener('message', shellExecHandler);

        // Register a fetch proxy handler so cross-origin fetch() calls from the
        // sandbox are routed through the host page (which has host_permissions).
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
              resp.headers.forEach((v, k) => { headers[k] = v; });
              sandbox!.contentWindow!.postMessage({
                type: 'fetch_proxy_response', id: msg.id,
                status: resp.status, statusText: resp.statusText,
                headers, body: new Uint8Array(buf),
              }, '*');
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              sandbox!.contentWindow!.postMessage(
                { type: 'fetch_proxy_response', id: msg.id, error: errMsg }, '*',
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

      const AsyncFunction = Object.getPrototypeOf(async function () { /* noop */ }).constructor as (
        new (...args: string[]) => (
          fs: typeof fsBridge,
          process: typeof processShim,
          console: typeof nodeConsole,
          require: (id: string) => never,
          module: typeof moduleShim,
          exports: Record<string, unknown>,
          __state: Record<string, unknown>,
          exec: typeof execBridge,
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
        'exec',
        `"use strict";\nconst globalThis = __state;\nconst global = __state;\n${code}`,
      );
      await fn(fsBridge, processShim, nodeConsole, requireShim, moduleShim, moduleShim.exports, nodeRuntimeState, execBridge);
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
