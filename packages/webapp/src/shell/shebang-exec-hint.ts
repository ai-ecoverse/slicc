/**
 * When `./script` fails with a bare Permission denied, the VFS has no
 * executable bit — not a missing chmod, not a special `/tmp`. Append the
 * interpreter hint so the next attempt is `bash file` instead of another
 * `chmod +x` (#3109).
 */

export interface ShebangExecHintFs {
  resolvePath: (base: string, path: string) => string;
  readFile: (path: string) => Promise<string>;
}

export interface ExecResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const PERM_DENIED = /(?:^|\n)(?:bash: )?((?:\.\.?\/|\/)[^:\s]+): Permission denied/;

const HINT_ALREADY = 'run it with the interpreter';

function interpreterFromShebang(content: string): string {
  const line = content.split(/\r?\n/, 1)[0] ?? '';
  if (!line.startsWith('#!')) return 'bash';
  const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 'bash';
  const bin = tokens[0].split('/').pop() ?? 'bash';
  if (bin === 'env' && tokens[1]) return tokens[1];
  return bin || 'bash';
}

/**
 * If `result` is an EACCES-style execution failure on a shebang file, append
 * a one-line interpreter hint. Otherwise return `result` unchanged.
 */
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
    content = await fs.readFile(path);
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
