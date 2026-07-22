import type {
  CloudEnv,
  DurableObjectNamespaceLike,
  DurableObjectStubLike,
} from '../src/cloud/handlers.js';

interface RecordedCall {
  endpoint: string;
  body: Record<string, unknown>;
}

let recorded: RecordedCall[] = [];
/** Canned response shaper. The test sets this per-test to control what each
 * DO endpoint returns. Defaults to 200 with a generic shape. */
let nextResponse: (endpoint: string, body: Record<string, unknown>) => Response = () =>
  Response.json({ ok: true });

export function resetMockNamespace(): void {
  recorded = [];
  nextResponse = () => Response.json({ ok: true });
}

export function getRecordedCalls(): RecordedCall[] {
  return [...recorded];
}

export function setMockResponse(
  fn: (endpoint: string, body: Record<string, unknown>) => Response
): void {
  nextResponse = fn;
}

export function makeMockNamespace(): DurableObjectNamespaceLike {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (_id) =>
      ({
        async fetch(input: string | Request, init?: RequestInit) {
          const url = typeof input === 'string' ? input : input.url;
          const bodyRaw = typeof input === 'string' ? init?.body : await input.text();
          const body = bodyRaw ? (JSON.parse(bodyRaw.toString()) as Record<string, unknown>) : {};
          const endpoint = new URL(url).pathname;
          recorded.push({ endpoint, body });
          return nextResponse(endpoint, body);
        },
      }) satisfies DurableObjectStubLike,
  };
}

export function makeCloudEnv(overrides: Partial<CloudEnv> = {}): CloudEnv {
  return {
    CLOUD_SESSIONS: makeMockNamespace(),
    E2B_API_KEY: 'test-e2b-key',
    IMS_ENVIRONMENT: 'prod',
    IMS_CLIENT_ID: 'test-client',
    ALLOWED_EMAIL_DOMAIN: 'adobe.com',
    BLOCKED_EMAILS: '',
    REQUIRE_OWNER_ORG: 'false',
    ...overrides,
  };
}
