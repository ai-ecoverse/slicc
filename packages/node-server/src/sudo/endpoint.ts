import express, { type Express } from 'express';
import { requireLoopback } from '../cloud-status.js';
import { selectSudoBackend } from './select.js';
import type { SudoApproveRequest, SudoBackend, SudoDecision, SudoKind } from './types.js';

const VALID_KINDS: readonly SudoKind[] = [
  'command',
  'read',
  'write',
  'secret',
  'export',
  'guest-message',
  'guest-tool',
];

export interface SudoEndpointOptions {
  backend?: SudoBackend;

  warn?: (message: string) => void;
}

function isSudoApproveRequest(x: unknown): x is SudoApproveRequest {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as { kind?: unknown; detail?: unknown; suggestedPattern?: unknown };
  if (typeof p.kind !== 'string' || !VALID_KINDS.includes(p.kind as SudoKind)) return false;
  if (typeof p.detail !== 'string' || p.detail.length === 0) return false;
  if ('suggestedPattern' in p && typeof p.suggestedPattern !== 'string') return false;
  return true;
}

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
      ...(typeof req.body.requester === 'string' && req.body.requester
        ? { requester: req.body.requester }
        : {}),
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
