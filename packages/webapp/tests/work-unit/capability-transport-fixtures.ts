import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SignAndForwardReply } from '@slicc/shared-ts';
import type {
  ApprovalRequest,
  ExtensionCapabilityTransports,
  NetworkFetchRequest,
  SecretsControlMessage,
} from '../../src/work-unit/capability/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface RestContractOperation {
  operation: string;
  method: string;
  path: string;
}

export interface RestContractServerCase {
  name: string;
  operation: string;
  method: string;
  path: string;
  body?: unknown;
  expect: {
    status: number;
    bodyKind?: 'array' | 'object';
    itemFields?: string[];
    bodyFields?: Record<string, unknown>;
  };
}

export interface RestContract {
  version: number;
  operations: RestContractOperation[];
  serverCases: RestContractServerCase[];
}

export function loadRestContract(): RestContract {
  const path = join(
    here,
    '..',
    '..',
    '..',
    'shared-ts',
    'fixtures',
    'capability-rest-contract.json'
  );
  return JSON.parse(readFileSync(path, 'utf8')) as RestContract;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const MASKED_ENTRIES = [
  { name: 'GITHUB_TOKEN', maskedValue: 'ghp_25243876bf81', domains: ['api.github.com'] },
  { name: 'X', maskedValue: 'masked-x', domains: [] },
];

const SIGN_REPLY: SignAndForwardReply = {
  ok: true,
  status: 200,
  headers: { 'content-type': 'application/json' },
  bodyBase64: '',
};

function decodeBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function scriptedRestFetch(log?: RecordedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    log?.push({ method, path, headers, body: decodeBody(init?.body) });

    if (path === '/api/fetch-proxy') {
      return new Response('upstream-body', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (path === '/api/secrets/masked' && method === 'GET') return json(MASKED_ENTRIES);
    if ((path === '/api/secrets' || path === '/api/secrets/session') && method === 'POST') {
      return json({ ok: true });
    }
    if (path.startsWith('/api/secrets/') && method === 'DELETE') {
      return json({ ok: true, removed: true });
    }
    if (path === '/api/s3-sign-and-forward' || path === '/api/da-sign-and-forward') {
      return json(SIGN_REPLY);
    }
    if (path === '/api/sudo-approve') return json({ decision: 'allow' });
    return json({ error: `no scripted route for ${method} ${path}` }, 404);
  }) as typeof fetch;
}

export interface CapturedExtensionCalls {
  secrets: SecretsControlMessage[];
  mounts: Array<{ type: string; envelope: unknown }>;
  fetches: NetworkFetchRequest[];
  approvals: ApprovalRequest[];
}

export function scriptedRestTransports(): {
  transports: ExtensionCapabilityTransports;
  captured: CapturedExtensionCalls;
} {
  const captured: CapturedExtensionCalls = {
    secrets: [],
    mounts: [],
    fetches: [],
    approvals: [],
  };
  const transports: ExtensionCapabilityTransports = {
    callSecrets: (message) => {
      captured.secrets.push(message);
      switch (message.type) {
        case 'secrets.list-masked-entries':
          return Promise.resolve({ entries: MASKED_ENTRIES });
        case 'secrets.set':
        case 'secrets.session.set':
          return Promise.resolve({ ok: true });
        case 'secrets.delete':
          return Promise.resolve({ ok: true, removed: true, fromSession: false });
      }
    },
    callMount: (type, envelope) => {
      captured.mounts.push({ type, envelope });
      return Promise.resolve(SIGN_REPLY);
    },
    crossOriginFetch: (request) => {
      captured.fetches.push(request);
      return Promise.resolve({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
        bytes: new TextEncoder().encode(`upstream:${request.url}`),
      });
    },
    requestApproval: (request) => {
      captured.approvals.push(request);
      return Promise.resolve({ decision: 'allow' });
    },
  };
  return { transports, captured };
}
