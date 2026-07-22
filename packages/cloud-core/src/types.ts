// Shared types for cloud-core operations. Consumed by both node-server (CLI)
// and cloudflare-worker (Plan D).

import type { ConeConfigIndex } from './cone-config/index.js';

/**
 * Registry entry for a cloud-hosted cone (sandbox). Renamed from
 * CloudSessionEntry in node-server — the canonical name going forward is
 * ConeEntry to align with the wider SLICC vocabulary (cone/scoops/licks).
 */
export interface ConeEntry {
  /** Substrate identifier (e.g., 'e2b'). Typed as string for cloud-core portability. */
  substrate: string;
  /** Substrate-assigned ID (e.g., e2b sandbox ID). */
  sandboxId: string;
  /** User-supplied or auto-generated name. */
  name?: string;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** Join URL for the tray session. */
  joinUrl: string;
  /** ISO 8601 timestamp; updated on every list/resume tick. */
  lastSeen: string;
  /**
   * Sandbox state. 'reserved' marks an in-flight start/resume operation's
   * atomic name/state reservation before the substrate reports real state.
   * Reconciled state from substrate will only ever be running/paused/dead.
   */
  state: 'running' | 'paused' | 'dead' | 'reserved';
  /**
   * Last-known tray identity from `/tmp/slicc-join.json`. Set by `runStart`
   * after the initial cloud-status read; preserved by `runPause` (do NOT
   * overwrite this on pause — it is the comparison baseline that lets
   * `runResume` detect tray rebuilds). `runResume` overwrites it after a
   * successful refresh.
   */
  trayId?: string;
  /**
   * `updatedAt` from the last successful `/tmp/slicc-join.json` read.
   * `runResume` polls for an `updatedAt` strictly newer than this value, so
   * resume only declares success after the kick produced a fresh refresh.
   * Preserved across `runPause` for the same reason as `trayId`.
   */
  lastJoinUpdatedAt?: string;
  /**
   * ISO timestamp set when state transitions to 'reserved'. Used by listCones
   * to GC stale reservations from crashed operations (TTL: 10 minutes).
   */
  reservedAt?: string;
  /**
   * Additional metadata (e.g., { userId, createdBy }). Used by workers for
   * filtering and by CLI for tracking.
   */
  metadata?: Record<string, string>;
  /**
   * Names-only index of the cone's config bundle (model, account provider IDs,
   * secret names). Persisted on the registry; NO secret values stored.
   */
  coneConfigIndex?: ConeConfigIndex;
}

/**
 * The shape persisted to `/tmp/slicc-join.json` inside the sandbox. Read by
 * both start and resume operations to determine the join URL and tray state.
 */
export interface CloudStatus {
  joinUrl: string;
  trayId?: string;
  sliccVersion?: string;
  /** ISO 8601 timestamp written by /api/cloud-status; load-bearing for resume. */
  updatedAt?: string;
}

/**
 * Return value of the start operation — minimal shape with the sandbox ID,
 * join URL, and optional name.
 */
export interface StartResult {
  sandboxId: string;
  joinUrl: string;
  name?: string;
}

/**
 * Return value of the resume operation — includes join URL, tray rebuild flag,
 * and optional version mismatch warning.
 */
export interface ResumeResult {
  sandboxId: string;
  joinUrl: string;
  trayRebuilt: boolean;
  versionMismatch?: { running: string; local: string };
  coneConfigIndex?: ConeConfigIndex;
}

/**
 * Summary of a sandbox returned by substrate.list(). Minimal shape with ID,
 * name, state, and metadata.
 */
export interface SandboxSummary {
  sandboxId: string;
  name?: string;
  state: 'running' | 'paused' | 'dead';
  metadata: Record<string, string>;
}
