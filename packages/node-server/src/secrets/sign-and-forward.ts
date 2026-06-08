/**
 * Server-side request signing for S3 and Adobe da.live mounts.
 *
 * The browser-side mount backends never see real S3 credentials or the IMS
 * bearer token. They post envelopes to `/api/s3-sign-and-forward` and
 * `/api/da-sign-and-forward`, which:
 *  1. Validate the envelope.
 *  2. Resolve credentials server-side (S3) or accept a transient bearer (DA).
 *  3. Reconstruct the upstream URL from profile config (S3) or the path
 *     prefix (DA) — so the browser cannot SSRF arbitrary hosts.
 *  4. Sign with SigV4 v4 (S3) or attach `Authorization: Bearer` (DA).
 *  5. Forward to the upstream and return the response as a JSON envelope.
 *
 * The validate → resolve → sign → forward pipeline is shared with the
 * extension service worker via `@slicc/shared-ts`. These handlers are thin
 * Express adapters: they bridge the node-server `SecretStore` to the shared
 * async `SecretGetter`, then map the structured reply onto an HTTP response.
 *
 * Logging contract: never log envelope contents — request bodies or the
 * `imsToken` may contain credential material.
 */

import {
  type DaSignAndForwardEnvelope,
  executeDaSignAndForward,
  executeS3SignAndForward,
  type S3SignAndForwardEnvelope,
  type SecretGetter,
  type SignAndForwardErrorCode,
  type SignAndForwardReply,
} from '@slicc/shared-ts';
import type { Request, Response } from 'express';

import type { SecretStore } from './types.js';

export type { DaSignAndForwardEnvelope, S3SignAndForwardEnvelope } from '@slicc/shared-ts';

/**
 * Map a structured failure code onto the HTTP status the CLI float returns.
 * Setup/validation errors are client errors (400); an upstream fetch failure
 * is a bad gateway (502); an internal error is 500. The `never` default makes
 * a future addition to `SignAndForwardErrorCode` fail the typecheck here.
 */
function statusForErrorCode(code: SignAndForwardErrorCode): number {
  switch (code) {
    case 'invalid_profile':
    case 'invalid_request':
    case 'profile_not_configured':
      return 400;
    case 'fetch_failed':
      return 502;
    case 'internal':
      return 500;
    default: {
      const _exhaustive: never = code;
      return 500;
    }
  }
}

/** Write a shared `SignAndForwardReply` onto the Express response. */
function writeReply(res: Response, reply: SignAndForwardReply): void {
  if (reply.ok) {
    res.json(reply);
    return;
  }
  res.status(statusForErrorCode(reply.errorCode)).json(reply);
}

/** Adapt the synchronous node-server `SecretStore` to the async `SecretGetter`. */
function secretGetterFor(store: SecretStore): SecretGetter {
  return {
    async get(key: string): Promise<string | undefined> {
      return store.get(key)?.value;
    },
  };
}

/**
 * Handle a `POST /api/s3-sign-and-forward` request. Validates the envelope,
 * resolves credentials, signs, forwards, returns a JSON envelope.
 *
 * Errors in setup return 400 with a structured `{ ok: false, error, errorCode }`.
 * Network errors against the upstream return 502.
 */
export async function handleS3SignAndForward(
  req: Request,
  res: Response,
  secretStore: SecretStore
): Promise<void> {
  const env = req.body as Partial<S3SignAndForwardEnvelope> | undefined;
  const reply = await executeS3SignAndForward(env, secretGetterFor(secretStore));
  writeReply(res, reply);
}

/**
 * Handle a `POST /api/da-sign-and-forward` request. Attaches the IMS bearer
 * token (passed transiently in the envelope), forwards to da.live, returns
 * a JSON envelope.
 *
 * v1: the IMS token comes from the browser at request time. The browser
 * already holds the token via the existing Adobe LLM provider OAuth flow;
 * routing through the server gives architectural symmetry with S3 and a
 * place to tighten the threat model in v2 (server-side OAuth).
 */
export async function handleDaSignAndForward(req: Request, res: Response): Promise<void> {
  const env = req.body as Partial<DaSignAndForwardEnvelope> | undefined;
  const reply = await executeDaSignAndForward(env);
  writeReply(res, reply);
}
