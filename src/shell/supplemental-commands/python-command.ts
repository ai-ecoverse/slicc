import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { PYTHON_RUNNER, getPyodide } from './shared.js';

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

export function createPython3LikeCommand(name: 'python3' | 'python'): Command {
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

      pyodide.setStdout({ batched: (msg) => stdoutChunks.push(msg + '\n') });
      pyodide.setStderr({ batched: (msg) => stderrChunks.push(msg + '\n') });
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
