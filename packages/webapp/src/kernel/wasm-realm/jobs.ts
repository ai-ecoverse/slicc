/**
 * `jobs.ts` — process groups, sessions and the terminal's foreground group
 * for the processes of one `wasm` invocation (#3530): what a shell's job
 * control stands on.
 *
 * Every process belongs to a group and a session; a child starts in its
 * parent's. `setpgid` moves a process into a group of the same session (or
 * makes it one), `setsid` starts a new session. A terminal's foreground group
 * (`tcsetpgrp`) is where ^C / ^Z / SIGWINCH go; `kill(-pgid)` signals a group.
 * A session's controlling terminal is the one its leader started on:
 * what `/dev/tty` opens for every process of the session.
 */
import { KernelError } from './fd-table.js';
import type { KernelTty } from './tty.js';

export interface JobMember {
  pid: number;
  pgid: number;
  sid: number;
  /** Send the process a signal (its kernel handle's `signal`). */
  signal(sig: number): void;
  /** The process that exec'd it: that one forwards its signals, so a group signal skips it. */
  execParent?: number;
  /** Its parent, when that is a process of the table. */
  ppid?: number;
  /** It exec'd a program: its parent may no longer move it (setpgid's EACCES). */
  execed?: boolean;
}

export class JobTable {
  private readonly members = new Map<number, JobMember>();
  private readonly foreground = new Map<KernelTty, number>();
  /** Controlling terminals by session id. */
  private readonly terminals = new Map<number, KernelTty>();

  /**
   * A new process: its own group and session (a leader), or its parent's. A
   * leader started on `terminal` makes it the session's controlling terminal.
   */
  add(
    pid: number,
    parentPid: number | undefined,
    signal: (sig: number) => void,
    terminal?: KernelTty
  ): JobMember {
    const parent = parentPid === undefined ? undefined : this.members.get(parentPid);
    if (!parent && terminal) this.terminals.set(pid, terminal);
    const member: JobMember = {
      pid,
      ppid: parent?.pid,
      pgid: parent?.pgid ?? pid,
      sid: parent?.sid ?? pid,
      signal,
    };
    this.members.set(pid, member);
    return member;
  }

  remove(pid: number): void {
    this.members.delete(pid);
  }

  /** `pid` exec'd the program running as `child` (which stands for it from now on). */
  exec(pid: number, child: number): void {
    const member = this.members.get(child);
    if (member) member.execParent = pid;
    const execer = this.members.get(pid);
    if (execer) execer.execed = true;
  }

  /** The group of `pid`, if it is a process of the table. */
  pgidOf(pid: number): number | undefined {
    return this.members.get(pid)?.pgid;
  }

  private member(pid: number): JobMember {
    const member = this.members.get(pid);
    if (!member) throw new KernelError('ESRCH');
    return member;
  }

  /**
   * setpgid(2) by `caller`: `pid` 0 is the caller, `pgid` 0 is `pid`. Only
   * the caller itself or a child of it that has not exec'd yet can move.
   */
  setpgid(caller: number, pid: number, pgid: number): void {
    const target = this.member(pid || caller);
    const group = pgid || target.pid;
    if (group < 0) throw new KernelError('EINVAL');
    const self = this.member(caller);
    if (target.pid !== caller) {
      if (target.ppid !== caller) throw new KernelError('ESRCH');
      if (target.execed) throw new KernelError('EACCES');
    }
    if (target.sid !== self.sid) throw new KernelError('EPERM');
    if (target.pid === target.sid) throw new KernelError('EPERM'); // a session leader stays put
    // Joining another group needs a member of it in the same session.
    const exists = [...this.members.values()].some((m) => m.pgid === group && m.sid === target.sid);
    if (group !== target.pid && !exists) throw new KernelError('EPERM');
    target.pgid = group;
  }

  getpgid(caller: number, pid: number): number {
    return this.member(pid || caller).pgid;
  }

  getsid(caller: number, pid: number): number {
    return this.member(pid || caller).sid;
  }

  /** setsid(2): a new session and group led by `pid`, with no controlling terminal; not for a group leader. */
  setsid(pid: number): number {
    const member = this.member(pid);
    if (member.pgid === pid) throw new KernelError('EPERM');
    member.sid = pid;
    member.pgid = pid;
    this.terminals.delete(pid);
    return pid;
  }

  /**
   * The controlling terminal of `pid`'s session: null when the session has
   * none, undefined when `pid` is no process of the table.
   */
  controllingTerminal(pid: number): KernelTty | null | undefined {
    const member = this.members.get(pid);
    return member && (this.terminals.get(member.sid) ?? null);
  }

  /** Signal every process of group `pgid`; false when there is none. */
  killGroup(pgid: number, sig: number): boolean {
    const targets = [...this.members.values()].filter((m) => m.pgid === pgid);
    const pids = new Set(targets.map((m) => m.pid));
    if (sig !== 0) {
      // An exec'd program hears it from the process it stands for, once.
      for (const m of targets)
        if (m.execParent === undefined || !pids.has(m.execParent)) m.signal(sig);
    }
    return targets.length > 0;
  }

  /** The terminal's foreground group; `fallback` (the terminal's first user) until one is set. */
  tcgetpgrp(tty: KernelTty, fallback: number): number {
    return this.foreground.get(tty) ?? fallback;
  }

  /** tcsetpgrp(3): only a group of the caller's session. */
  tcsetpgrp(caller: number, tty: KernelTty, pgid: number): void {
    const self = this.member(caller);
    const inSession = [...this.members.values()].some((m) => m.pgid === pgid && m.sid === self.sid);
    if (!inSession) throw new KernelError('EPERM');
    this.foreground.set(tty, pgid);
  }

  /** Where the terminal's signals go (^C, ^Z, SIGWINCH): its foreground group. */
  signalForeground(tty: KernelTty, fallback: number, sig: number): void {
    this.killGroup(this.tcgetpgrp(tty, fallback), sig);
  }
}
