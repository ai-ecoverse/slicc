export interface ShebangExecHintFs {
  resolvePath: (base: string, path: string) => string;
  readFile: (path: string) => Promise<string>;

  readFileRange?: (path: string, start: number, end: number) => Promise<Uint8Array>;
}

export interface ExecResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const PERM_DENIED = /(?:^|\n)(?:bash: )?((?:\.\.?\/|\/)[^:\s]+): Permission denied/;

const HINT_ALREADY = 'run it with the interpreter';

const SHEBANG_PREFIX = 256;

const ENV_ARG_FLAGS = new Set([
  '-u',
  '-C',
  '-S',
  '--unset',
  '--chdir',
  '--split-string',
  '--block-signal',
  '--default-signal',
  '--ignore-signal',
]);

function basename(path: string): string {
  return path.split('/').pop() || path;
}

function decodePrefix(bytes: Uint8Array): string {
  let out = '';
  const n = Math.min(bytes.length, SHEBANG_PREFIX);
  for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

function envFlagWidth(token: string): number {
  const eq = token.indexOf('=');
  const flag = eq === -1 ? token : token.slice(0, eq);
  if (eq !== -1) return 1;
  return ENV_ARG_FLAGS.has(flag) ? 2 : 1;
}

function splitStringPayload(token: string, next: string | undefined): string[] {
  const eq = token.indexOf('=');
  const payload = eq === -1 ? next : token.slice(eq + 1);
  return payload ? payload.split(/\s+/).filter(Boolean) : [];
}

function envInterpreter(tokens: string[]): string {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '--') {
      const cmd = tokens[i + 1];
      return cmd ? basename(cmd) : 'bash';
    }
    if (token.startsWith('-')) {
      const flag = token.split('=', 1)[0];
      if (flag === '-S' || flag === '--split-string') {
        return envInterpreter(splitStringPayload(token, tokens[i + 1]));
      }
      i += envFlagWidth(token);
      continue;
    }
    if (token.includes('=')) {
      i += 1;
      continue;
    }
    return basename(token);
  }
  return 'bash';
}

function interpreterFromShebang(content: string): string {
  const line = content.split(/\r?\n/, 1)[0] ?? '';
  if (!line.startsWith('#!')) return 'bash';
  const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 'bash';
  const bin = basename(tokens[0]);
  if (bin === 'env') return envInterpreter(tokens.slice(1));
  return bin || 'bash';
}

async function readShebangPrefix(fs: ShebangExecHintFs, path: string): Promise<string> {
  if (fs.readFileRange) {
    const bytes = await fs.readFileRange(path, 0, SHEBANG_PREFIX);
    return decodePrefix(bytes);
  }
  const content = await fs.readFile(path);
  return content.slice(0, SHEBANG_PREFIX);
}

export async function withShebangExecHint<T extends ExecResultLike>(
  result: T,
  cwd: string,
  fs: ShebangExecHintFs
): Promise<T> {
  if (result.exitCode === 0) return result;
  if (result.stderr.includes(HINT_ALREADY)) return result;
  const match = result.stderr.match(PERM_DENIED);
  if (!match) return result;
  const operand = match[1];
  const path = fs.resolvePath(cwd, operand);
  let content: string;
  try {
    content = await readShebangPrefix(fs, path);
  } catch {
    return result;
  }
  if (!content.startsWith('#!')) return result;
  const interpreter = interpreterFromShebang(content);
  const hint = `run it with the interpreter, e.g. ${interpreter} ${operand}\n`;
  const stderr = result.stderr.endsWith('\n')
    ? `${result.stderr}${hint}`
    : `${result.stderr}\n${hint}`;
  return { ...result, stderr };
}
