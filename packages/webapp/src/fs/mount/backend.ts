export type MountKind = 'local' | 'hostfs' | 's3' | 'da' | 'aem' | 'proc';

export interface MountStatIdentity {
  ctime?: number;

  ino?: number;
  uid?: number;
  gid?: number;

  mode?: number;
}

export interface MountDirEntry extends MountStatIdentity {
  name: string;
  kind: 'file' | 'directory';
  size?: number;

  etag?: string;

  lastModified?: number;
}

export interface ReadDirOptions {
  includeStats?: boolean;
}

export interface MountStat extends MountStatIdentity {
  kind: 'file' | 'directory';
  size: number;

  mtime: number;
  etag?: string;
}

export interface RefreshReport {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  errors: { path: string; message: string }[];
}

export interface MountDescription {
  displayName: string;
  source?: string;
  profile?: string;

  extra?: string;
}

export interface MountBackend {
  readonly kind: MountKind;

  readonly listingStatsMatchStat?: boolean;

  readonly source: string | undefined;
  readonly profile?: string;
  readonly mountId: string;

  readDir(path: string, opts?: ReadDirOptions): Promise<MountDirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, body: Uint8Array): Promise<void>;

  readFileRange?(path: string, start: number, end: number): Promise<Uint8Array>;

  getNativeFile?(path: string): Promise<File | null>;
  stat(path: string): Promise<MountStat>;

  mkdir(path: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;

  rename?(fromPath: string, toPath: string): Promise<void>;

  refresh(opts?: { bodies?: boolean }): Promise<RefreshReport>;

  describe(): MountDescription;

  close(): Promise<void>;
}
