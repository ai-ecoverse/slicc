import { KernelError } from './fd-table.js';
import type { KernelTty } from './tty.js';

export interface JobMember {
  pid: number;
  pgid: number;
  sid: number;

  signal(sig: number): void;

  execParent?: number;

  ppid?: number;

  execed?: boolean;
}

export class JobTable {
  private readonly members = new Map<number, JobMember>();
  private readonly foreground = new Map<KernelTty, number>();

  private readonly terminals = new Map<number, KernelTty>();

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

  exec(pid: number, child: number): void {
    const member = this.members.get(child);
    if (member) member.execParent = pid;
    const execer = this.members.get(pid);
    if (execer) execer.execed = true;
  }

  pgidOf(pid: number): number | undefined {
    return this.members.get(pid)?.pgid;
  }

  private member(pid: number): JobMember {
    const member = this.members.get(pid);
    if (!member) throw new KernelError('ESRCH');
    return member;
  }

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
    if (target.pid === target.sid) throw new KernelError('EPERM');

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

  setsid(pid: number): number {
    const member = this.member(pid);
    if (member.pgid === pid) throw new KernelError('EPERM');
    member.sid = pid;
    member.pgid = pid;
    this.terminals.delete(pid);
    return pid;
  }

  controllingTerminal(pid: number): KernelTty | null | undefined {
    const member = this.members.get(pid);
    return member && (this.terminals.get(member.sid) ?? null);
  }

  killGroup(pgid: number, sig: number): boolean {
    const targets = [...this.members.values()].filter((m) => m.pgid === pgid);
    const pids = new Set(targets.map((m) => m.pid));
    if (sig !== 0) {
      for (const m of targets)
        if (m.execParent === undefined || !pids.has(m.execParent)) m.signal(sig);
    }
    return targets.length > 0;
  }

  tcgetpgrp(tty: KernelTty, fallback: number): number {
    return this.foreground.get(tty) ?? fallback;
  }

  tcsetpgrp(caller: number, tty: KernelTty, pgid: number): void {
    const self = this.member(caller);
    const inSession = [...this.members.values()].some((m) => m.pgid === pgid && m.sid === self.sid);
    if (!inSession) throw new KernelError('EPERM');
    this.foreground.set(tty, pgid);
  }

  signalForeground(tty: KernelTty, fallback: number, sig: number): void {
    this.killGroup(this.tcgetpgrp(tty, fallback), sig);
  }
}
