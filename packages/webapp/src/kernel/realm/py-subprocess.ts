import type { PyodideInterface } from 'pyodide';
import type { SyncExecXhrBridge } from './sync-exec-xhr-bridge.js';

interface PySubprocessRequest {
  command: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

interface PySubprocessReply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  message?: string;
}

export interface PySubprocessHooks {
  exec: SyncExecXhrBridge;

  beforeExec(): void;

  afterExec(): void;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function parseRequest(json: string): PySubprocessRequest | null {
  let raw: {
    command?: unknown;
    cwd?: unknown;
    env?: unknown;
    input?: unknown;
    timeoutMs?: unknown;
  } | null;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || !(typeof raw.command === 'string' || isStringArray(raw.command))) return null;
  const env =
    raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
      ? Object.fromEntries(
          Object.entries(raw.env).filter((e): e is [string, string] => typeof e[1] === 'string')
        )
      : undefined;
  return {
    command: raw.command,
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...(env ? { env } : {}),
    ...(typeof raw.input === 'string' ? { input: raw.input } : {}),
    ...(typeof raw.timeoutMs === 'number' ? { timeoutMs: raw.timeoutMs } : {}),
  };
}

export function createPySubprocessModule(hooks: PySubprocessHooks): {
  run(requestJson: string): string;
} {
  return {
    run(requestJson: string): string {
      const req = parseRequest(requestJson);
      if (!req) {
        const bad: PySubprocessReply = { error: 'EINVAL', message: 'malformed request' };
        return JSON.stringify(bad);
      }
      let reply: PySubprocessReply;
      hooks.beforeExec();
      try {
        const result = hooks.exec.run(req.command, {
          ...(req.input !== undefined ? { input: req.input } : {}),
          ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
          ...(req.env !== undefined ? { env: req.env } : {}),
          ...(req.timeoutMs !== undefined ? { timeout: req.timeoutMs } : {}),
        });
        reply = result;
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        reply = {
          error: typeof code === 'string' ? code : 'EIO',
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        hooks.afterExec();
      }
      return JSON.stringify(reply);
    },
  };
}

export const PYTHON_SUBPROCESS_SHIM = String.raw`
def __slicc_install_subprocess():
    import errno, io, itertools, json, os, subprocess, sys
    import _slicc_proc

    PIPE, STDOUT, DEVNULL = subprocess.PIPE, subprocess.STDOUT, subprocess.DEVNULL
    pids = itertools.count(1000)

    def to_str(a):
        a = os.fspath(a)
        return a.decode('utf-8', 'surrogateescape') if isinstance(a, bytes) else a

    class _StdinPipe(io.BytesIO):
        def __init__(self, proc):
            super().__init__()
            self._proc = proc
        def close(self):
            if not self.closed:
                data = self.getvalue()
                super().close()
                self._proc._start(data)

    class SliccPopen:
        def __init__(self, args, bufsize=-1, executable=None, stdin=None, stdout=None,
                     stderr=None, preexec_fn=None, close_fds=True, shell=False, cwd=None,
                     env=None, universal_newlines=None, startupinfo=None, creationflags=0,
                     restore_signals=True, start_new_session=False, pass_fds=(), *,
                     user=None, group=None, extra_groups=None, encoding=None, errors=None,
                     text=None, umask=-1, pipesize=-1, process_group=None):
            self.args = args
            self.pid = next(pids)
            self.returncode = None
            self.text_mode = bool(text or universal_newlines or encoding or errors)
            self._encoding = encoding or 'utf-8'
            self._errors = errors or 'strict'
            if shell:
                command = to_str(args if isinstance(args, (str, bytes)) else args[0])
            else:
                argv = [args] if isinstance(args, (str, bytes, os.PathLike)) else list(args)
                command = [to_str(a) for a in argv]
                if executable is not None:
                    command[0] = to_str(executable)
            self._shell = bool(shell)
            self._command = command
            self._cwd = to_str(cwd) if cwd is not None else os.getcwd()
            self._env = {to_str(k): to_str(v) for k, v in (os.environ if env is None else env).items()}
            self._stdout_to, self._stderr_to = stdout, stderr
            self.stdout = self.stderr = None
            self._out = self._err = b''
            self.stdin = None
            if stdin == PIPE:
                self.stdin = _StdinPipe(self)
                if self.text_mode:
                    self.stdin = io.TextIOWrapper(self.stdin, encoding=self._encoding,
                                                  errors=self._errors, write_through=True)
                return
            data = None
            if stdin not in (None, DEVNULL):
                data = os.read(stdin, 1 << 30) if isinstance(stdin, int) else stdin.read()
                if isinstance(data, str):
                    data = data.encode(self._encoding, self._errors)
            self._start(data)

        def _start(self, data, timeout=None):
            if self.returncode is not None:
                return
            req = {'command': self._command, 'cwd': self._cwd, 'env': self._env}
            if data:
                req['input'] = data.decode('utf-8', 'surrogateescape')
            if timeout is not None:
                req['timeoutMs'] = int(timeout * 1000)
            reply = json.loads(_slicc_proc.run(json.dumps(req)))
            if 'error' in reply:
                code = getattr(errno, reply['error'], errno.EIO)
                raise OSError(code, reply.get('message') or os.strerror(code))
            out = reply['stdout'].encode('utf-8', 'surrogateescape')
            err = reply['stderr'].encode('utf-8', 'surrogateescape')
            code = reply['exitCode']
            if (not self._shell and code == 127 and b'command not found' in err):
                raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), self._command[0])
            if self._stderr_to == STDOUT:
                out, err = out + err, b''
            self._out = self._route(out, self._stdout_to, sys.stdout)
            self._err = self._route(err, self._stderr_to, sys.stderr)
            if self._stdout_to == PIPE:
                self.stdout = self._pipe(self._out)
            if self._stderr_to == PIPE:
                self.stderr = self._pipe(self._err)
            self.returncode = code

        def _route(self, data, target, inherit):
            if target == PIPE:
                return data
            if target is None:
                if data:
                    inherit.write(data.decode('utf-8', 'replace'))
                    inherit.flush()
            elif target not in (DEVNULL, STDOUT):
                if isinstance(target, int):
                    os.write(target, data)
                elif isinstance(target, io.TextIOBase):
                    target.write(data.decode('utf-8', 'replace'))
                else:
                    target.write(data)
            return b''

        def _pipe(self, data):
            if self.text_mode:
                return io.StringIO(data.decode(self._encoding, self._errors))
            return io.BytesIO(data)

        def communicate(self, input=None, timeout=None):
            if self.returncode is None:
                if isinstance(input, str):
                    input = input.encode(self._encoding, self._errors)
                if self.stdin is not None and not self.stdin.closed:
                    raw = self.stdin.buffer if isinstance(self.stdin, io.TextIOWrapper) else self.stdin
                    if input:
                        raw.write(input)
                    input = raw.getvalue()
                    io.BytesIO.close(raw)
                self._start(input, timeout)
            out = self.stdout.read() if self.stdout is not None else None
            err = self.stderr.read() if self.stderr is not None else None
            return out, err

        def wait(self, timeout=None):
            if self.returncode is None:
                self.communicate(timeout=timeout)
            return self.returncode

        def poll(self):
            # Never starts work, like CPython: a child still waiting for its
            # stdin=PIPE input has not run yet, so it is "still running".
            # A started child always ran to completion.
            return self.returncode

        def send_signal(self, sig):
            pass

        def terminate(self):
            pass

        def kill(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            for f in (self.stdout, self.stderr, self.stdin):
                if f is not None and not f.closed:
                    f.close()
            self.wait()

        def __repr__(self):
            return f'<SliccPopen: returncode: {self.returncode} args: {self.args!r}>'

    def system(command):
        code = SliccPopen(command, shell=True).wait()
        return (code & 0xff) << 8

    def execute(file, args, env=None):
        argv = [to_str(a) for a in args]
        if not argv:
            raise ValueError('exec: argv must not be empty')
        sys.stdout.flush()
        sys.stderr.flush()
        # Never returns, like a real exec: SystemExit skips except Exception.
        raise SystemExit(SliccPopen([to_str(file)] + argv[1:], env=env).wait())

    subprocess.Popen = SliccPopen
    os.system = system
    # os.execl* call these through the os module, so they follow.
    os.execv = os.execvp = lambda file, args: execute(file, args)
    os.execve = os.execvpe = lambda file, args, env: execute(file, args, env)

__slicc_install_subprocess()
del __slicc_install_subprocess
`;

export function installPySubprocess(pyodide: PyodideInterface, hooks: PySubprocessHooks): void {
  pyodide.registerJsModule('_slicc_proc', createPySubprocessModule(hooks));
  pyodide.runPython(PYTHON_SUBPROCESS_SHIM);
}
