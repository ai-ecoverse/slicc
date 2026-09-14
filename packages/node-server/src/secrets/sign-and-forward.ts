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

function writeReply(res: Response, reply: SignAndForwardReply): void {
  if (reply.ok) {
    res.json(reply);
    return;
  }
  res.status(statusForErrorCode(reply.errorCode)).json(reply);
}

function secretGetterFor(store: SecretStore): SecretGetter {
  return {
    async get(key: string): Promise<string | undefined> {
      return store.get(key)?.value;
    },
  };
}

export async function handleS3SignAndForward(
  req: Request,
  res: Response,
  secretStore: SecretStore
): Promise<void> {
  const env = req.body as Partial<S3SignAndForwardEnvelope> | undefined;
  const reply = await executeS3SignAndForward(env, secretGetterFor(secretStore));
  writeReply(res, reply);
}

export async function handleDaSignAndForward(req: Request, res: Response): Promise<void> {
  const env = req.body as Partial<DaSignAndForwardEnvelope> | undefined;
  const reply = await executeDaSignAndForward(env);
  writeReply(res, reply);
}
