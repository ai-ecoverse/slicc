import { mountSliccImpl } from './mount.js';
import type { SliccTheme } from './theme-types.js';
import type { ExportSessionOptions } from './transcript-types.js';

export type { SliccTheme, ThemeComponent, ThemeComponents } from './theme-types.js';
export type {
  ExportSessionOptions,
  TranscriptExportErrorCode,
  TranscriptExportProgress,
} from './transcript-types.js';
export { TranscriptExportError } from './transcript-types.js';

export interface HostCapabilities {
  navigate: boolean;

  screenshot: 'html2canvas' | 'none';

  openUrl: boolean;
}

export interface CherryFeatures {
  terminal?: boolean;

  files?: boolean;

  memory?: boolean;

  browser?: boolean;

  modelPicker?: boolean;

  history?: boolean;

  nav?: boolean;

  monitor?: boolean;

  showTimestamps?: boolean;
}

export interface HostHooks {
  onOpenUrl?: (url: string) => void;

  onSliccEvent?: (name: string, detail: unknown) => void;

  onPermissionRequest?: (domain: string) => boolean | Promise<boolean>;

  onHandshakeComplete?: () => void;

  onProtocolMismatch?: (peerVersion: number, sdkVersion: number) => void;
}

export type EffortLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface MountSliccOptions {
  container?: HTMLElement;

  iframe?: HTMLIFrameElement;

  sliccOrigin: string;

  capabilities: HostCapabilities;

  hooks?: HostHooks;

  features?: CherryFeatures;

  theme?: SliccTheme;

  layout?: unknown;

  joinToken: string;

  uiOnly?: boolean;

  effortLevel?: EffortLevel;

  flags?: Record<string, string>;
}

export interface SliccHandle {
  iframe: HTMLIFrameElement;

  emitHostEvent(name: string, detail?: unknown): void;

  exportSession(options?: ExportSessionOptions): Promise<Blob>;

  destroy(): void;
}

export function mountSlicc(options: MountSliccOptions): SliccHandle {
  if (!options?.container && !options?.iframe) {
    throw new Error('mountSlicc: either options.container or options.iframe is required');
  }
  return mountSliccImpl(options);
}
