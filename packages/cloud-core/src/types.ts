import type { ConeConfigIndex } from './cone-config/index.js';

export interface ConeEntry {
  substrate: string;

  sandboxId: string;

  name?: string;

  createdAt: string;

  joinUrl: string;

  lastSeen: string;

  state: 'running' | 'paused' | 'dead' | 'reserved';

  trayId?: string;

  lastJoinUpdatedAt?: string;

  reservedAt?: string;

  metadata?: Record<string, string>;

  coneConfigIndex?: ConeConfigIndex;
}

export interface CloudStatus {
  joinUrl: string;
  trayId?: string;
  sliccVersion?: string;

  updatedAt?: string;
}

export interface StartResult {
  sandboxId: string;
  joinUrl: string;
  name?: string;
}

export interface ResumeResult {
  sandboxId: string;
  joinUrl: string;
  trayRebuilt: boolean;
  versionMismatch?: { running: string; local: string };
  coneConfigIndex?: ConeConfigIndex;
}

export interface SandboxSummary {
  sandboxId: string;
  name?: string;
  state: 'running' | 'paused' | 'dead';
  metadata: Record<string, string>;
}
