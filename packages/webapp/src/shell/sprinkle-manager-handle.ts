export interface ShellSprinkle {
  name: string;
  title: string;
  path: string;
}

export interface SprinkleInstance {
  name: string;

  runtimeId: string;

  runtime?: string;
}

export interface SprinkleSendTarget {
  runtime?: string;
}

export interface SprinkleSendReport {
  leader: boolean;

  followers: string[];

  unknownRuntime?: string;
}

export interface SprinkleBroadcastResult {
  followers: string[];

  unknownRuntime?: string;
}

export interface SprinkleOpenOptions {
  lickOriginTarget?: string;
}

export function sendReportReach(report: SprinkleSendReport): number {
  return (report.leader ? 1 : 0) + report.followers.length;
}

export interface SprinkleEntry extends ShellSprinkle {
  autoOpen?: boolean;
  icon?: string;
}

export interface SprinkleManagerProxySurface extends SprinkleManagerHandle {
  available(): SprinkleEntry[];
  openNewAutoOpenSprinkles(): Promise<void>;
  restoreOpenSprinkles?(): Promise<void>;
}

export interface SprinkleManagerHandle {
  refresh(): Promise<void>;
  available(): ShellSprinkle[];
  opened(): string[];
  open(name: string, zone?: string, options?: SprinkleOpenOptions): Promise<void>;
  close(name: string): void;
  reload(name: string): Promise<void>;
  sendToSprinkle(
    name: string,
    data: unknown,
    target?: SprinkleSendTarget
  ): SprinkleSendReport | Promise<SprinkleSendReport>;
}
