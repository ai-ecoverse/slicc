export const SIG = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  ILL: 4,
  TRAP: 5,
  ABRT: 6,
  BUS: 7,
  FPE: 8,
  KILL: 9,
  USR1: 10,
  SEGV: 11,
  USR2: 12,
  PIPE: 13,
  ALRM: 14,
  TERM: 15,
  STKFLT: 16,
  CHLD: 17,
  CONT: 18,
  STOP: 19,
  TSTP: 20,
  TTIN: 21,
  TTOU: 22,
  URG: 23,
  XCPU: 24,
  XFSZ: 25,
  VTALRM: 26,
  PROF: 27,
  WINCH: 28,
  POLL: 29,
  PWR: 30,
  SYS: 31,
} as const;

export type DefaultAction = 'terminate' | 'ignore' | 'stop' | 'continue';

const IGNORED_BY_DEFAULT: ReadonlySet<number> = new Set([SIG.CHLD, SIG.URG, SIG.WINCH]);
const STOPPING: ReadonlySet<number> = new Set([SIG.STOP, SIG.TSTP, SIG.TTIN, SIG.TTOU]);

export function defaultAction(sig: number): DefaultAction {
  if (sig === SIG.CONT) return 'continue';
  if (STOPPING.has(sig)) return 'stop';
  return IGNORED_BY_DEFAULT.has(sig) ? 'ignore' : 'terminate';
}

export function isSignal(sig: number): boolean {
  return Number.isInteger(sig) && sig >= 1 && sig <= 31;
}

export function sigbit(sig: number): number {
  return 1 << sig;
}

export function signalsIn(mask: number): number[] {
  const out: number[] = [];
  for (let sig = 1; sig <= 31; sig++) if (mask & sigbit(sig)) out.push(sig);
  return out;
}

export const SIGNAL_BY_NAME: Readonly<
  Record<'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' | 'SIGCONT', number>
> = {
  SIGINT: SIG.INT,
  SIGTERM: SIG.TERM,
  SIGKILL: SIG.KILL,
  SIGSTOP: SIG.STOP,
  SIGCONT: SIG.CONT,
};
