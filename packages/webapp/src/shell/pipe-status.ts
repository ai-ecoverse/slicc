export const PIPESTATUS_ENV = '__SLICC_PIPESTATUS';

export const PIPESTATUS_EXIT_ENV = '__SLICC_PIPESTATUS_EX';

const EXIT_CODE_RE = /^(0|[1-9]\d*)$/;

export function wrapCommandForPipeStatus(command: string): string {
  const body = closeOpenLineContinuation(command.trimEnd());
  if (!body) return command;
  return `{
${body}
}
${PIPESTATUS_EXIT_ENV}=$? ${PIPESTATUS_ENV}="\${PIPESTATUS[*]}"`;
}

function closeOpenLineContinuation(body: string): string {
  let n = 0;
  for (let i = body.length - 1; i >= 0 && body[i] === '\\'; i--) n += 1;
  if (n % 2 === 0) return body;
  return `${body}\\`;
}

export function parsePipeStatus(raw: string | undefined): number[] {
  if (!raw) return [];
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const codes: number[] = [];
  for (const part of parts) {
    if (!EXIT_CODE_RE.test(part)) return [];
    const n = Number(part);
    if (n > 255) return [];
    codes.push(n);
  }
  return codes;
}

export interface CapturedPipeStatus {
  pipeStatus: number[];
  exitCode: number | undefined;
}

export function scriptForPipeStatusCapture(command: string, capture: boolean): string {
  if (!capture) return command;
  return wrapCommandForPipeStatus(command);
}

export function applyCapturedPipeStatus<
  T extends { env?: Record<string, string>; exitCode: number },
>(result: T, capture: boolean): T & { pipeStatus?: number[] } {
  if (!capture || !result.env) return result;
  const captured = takePipeStatusFromEnv(result.env);
  const next =
    captured.exitCode === undefined ? result : { ...result, exitCode: captured.exitCode };
  if (captured.pipeStatus.length === 0) return next;
  return { ...next, pipeStatus: captured.pipeStatus };
}

export function attachPipeStatus<T extends object>(
  result: T,
  pipeStatus: number[] | undefined
): T & { pipeStatus?: number[] } {
  if (pipeStatus === undefined) return result;
  return { ...result, pipeStatus };
}

export function takePipeStatusFromEnv(env: Record<string, string>): CapturedPipeStatus {
  const raw = env[PIPESTATUS_ENV];
  const exRaw = env[PIPESTATUS_EXIT_ENV];
  delete env[PIPESTATUS_ENV];
  delete env[PIPESTATUS_EXIT_ENV];
  let exitCode: number | undefined;
  if (exRaw !== undefined && EXIT_CODE_RE.test(exRaw)) {
    const n = Number(exRaw);
    if (n <= 255) exitCode = n;
  }
  return { pipeStatus: parsePipeStatus(raw), exitCode };
}

export function formatPipelineStatus(codes: readonly number[]): string | null {
  if (codes.length < 2) return null;
  if (codes.every((code) => code === 0)) return null;
  if (!codes.every((code) => Number.isInteger(code) && code >= 0 && code <= 255)) {
    return null;
  }
  return `pipeline: ${codes.join(' ')}`;
}

export function appendPipelineStatus(output: string, codes: readonly number[] | undefined): string {
  const line = codes ? formatPipelineStatus(codes) : null;
  if (!line) return output;
  if (!output) return line;
  return output.endsWith('\n') ? `${output}${line}` : `${output}\n${line}`;
}
