/**
 * `POST /api/sudo-approve` — the trusted-process approval endpoint.
 *
 * The in-browser broker (`packages/webapp/src/sudo/http-broker.ts`) POSTs the
 * gated action here; this process raises a genuine native dialog / TTY prompt
 * (the agent's browser `node` shim can't reach this process) and returns the
 * human's decision. Loopback-only, like the other local node-server endpoints.
 *
 * Fail closed: an invalid body → 400; a backend that throws → `deny` (200).
 * Requests never auto-resolve to allow.
 */

import express, { type Express } from 'express';
import { requireLoopback } from '../cloud-status.js';
import { selectSudoBackend } from './select.js';
import type { SudoApproveRequest, SudoBackend, SudoDecision, SudoKind } from './types.js';

const VALID_KINDS: readonly SudoKind[] = ['command', 'read', 'write', 'secret'];

export interface SudoEndpointOptions {
  /**
   * Backend to use for every request. Defaults to lazy per-request selection
   * via {@link selectSudoBackend} so the environment is probed at call time.
   * Tests inject a deterministic backend here.
   */
  backend?: SudoBackend;
  /** Logger seam; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

function isSudoApproveRequest(x: unknown): x is SudoApproveRequest {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  if (typeof p.kind !== 'string' || !VALID_KINDS.includes(p.kind as SudoKind)) return false;
  if (typeof p.detail !== 'string' || p.detail.length === 0) return false;
  if ('suggestedPattern' in p && typeof p.suggestedPattern !== 'string') return false;
  return true;
}

/** Register the sudo approval endpoint on the Express app. */
export function registerSudoApproveEndpoint(app: Express, options: SudoEndpointOptions = {}): void {
  const warn = options.warn ?? ((m: string) => console.warn(m));

  app.post('/api/sudo-approve', requireLoopback, express.json(), async (req, res) => {
    if (!isSudoApproveRequest(req.body)) {
      res.status(400).json({ error: 'invalid sudo-approve payload' });
      return;
    }
    const request: SudoApproveRequest = {
      kind: req.body.kind,
      detail: req.body.detail,
      suggestedPattern: req.body.suggestedPattern ?? req.body.detail,
    };

    const backend = options.backend ?? selectSudoBackend();
    let decision: SudoDecision;
    try {
      decision = await backend.prompt(request);
    } catch (err) {
      warn(`sudo-approve backend "${backend.name}" threw — denying: ${String(err)}`);
      decision = { decision: 'deny' };
    }
    res.json(decision);
  });
}
