import { createLogger } from '../base/logger.js';
import type { SecretRequest, SecretRequestOutcome } from '../base/secret-request-registry.js';
import { getSecretRequestSurface } from '../base/secret-request-registry.js';
import { isValidShellEnvName } from '../base/shell-env-name.js';
import type { ToolDefinition, ToolResult } from './types.js';

const log = createLogger('tool:request-secret');

const SECRET_REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface RequestSecretToolDeps {
  setEnv?: (name: string, value: string) => void;

  requester?: string;

  getProvider?: () => string | undefined;

  callPanelRpc?: (request: SecretRequest) => Promise<SecretRequestOutcome>;
}

async function requestSecret(
  request: SecretRequest,
  deps: RequestSecretToolDeps
): Promise<SecretRequestOutcome> {
  const surface = getSecretRequestSurface();
  if (surface) return surface(request);

  const bridged = deps.callPanelRpc ?? (await defaultPanelRpcBridge());
  if (bridged) return bridged(request);

  return { stored: false, reason: 'unavailable' };
}

async function defaultPanelRpcBridge(): Promise<
  ((request: SecretRequest) => Promise<SecretRequestOutcome>) | null
> {
  const { getPanelRpcClient } = await import('../kernel/panel-rpc.js');
  const client = getPanelRpcClient();
  if (!client) return null;
  return (request) =>
    client.call('secret-request', request, { timeoutMs: SECRET_REQUEST_TIMEOUT_MS });
}

function readProvider(deps: RequestSecretToolDeps): string | undefined {
  try {
    return deps.getProvider?.() || undefined;
  } catch (err) {
    log.warn('could not resolve this unit’s provider for the secret prompt', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function readDomains(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const domains = raw
    .filter((d): d is string => typeof d === 'string')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  return domains.length > 0 ? domains : undefined;
}

function describeStored(
  outcome: Extract<SecretRequestOutcome, { stored: true }>,
  envInjected: boolean
): string {
  const lines = [
    `The user stored the secret "${outcome.name}".`,
    `Scope: ${outcome.domains.join(', ')} — it is only unmasked for requests to these hosts.`,
    outcome.persisted
      ? 'Lifetime: saved (survives this session).'
      : 'Lifetime: this session only (held in memory).',
  ];
  if (outcome.maskedValue) {
    lines.push(
      `Masked value: ${outcome.maskedValue}`,
      'Use the masked value wherever the credential goes (headers, request bodies). SLICC ' +
        'substitutes the real value at the network boundary. You will never see the real value.'
    );
    if (envInjected) lines.push(`It is also available as $${outcome.name} in bash.`);
  } else {
    lines.push(
      `The store did not report a masked value; run \`secret get ${outcome.name}\` to read it.`
    );
  }
  return lines.join('\n');
}

function describeDeclined(outcome: Extract<SecretRequestOutcome, { stored: false }>): string {
  switch (outcome.reason) {
    case 'cancelled':
      return 'The user dismissed the secret prompt — nothing was stored. Do not retry; ask what to do instead.';
    case 'unavailable':
      return 'This float cannot prompt for a secret (no secret-entry surface). Ask the user to add it from the leader UI or with `secret set`.';
    default:
      return `The secret could not be stored${outcome.detail ? `: ${outcome.detail}` : ''}.`;
  }
}

export function createRequestSecretTool(deps: RequestSecretToolDeps = {}): ToolDefinition {
  return {
    name: 'request_secret',
    description:
      'Ask the user for a credential (API key, token, password) through a secure prompt. ' +
      'You never receive the real value: the result carries only the secret name, a masked ' +
      'stand-in to use in requests, and the domains it may be sent to. Use this instead of ' +
      'asking for a credential in chat, which would put it in the transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Suggested secret name, e.g. GITHUB_TOKEN. Use an uppercase POSIX identifier so it ' +
            'is also available as $NAME in bash. The user can change it.',
        },
        reason: {
          type: 'string',
          description:
            'One plain sentence saying what the credential is for. Shown verbatim to the user.',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Suggested hosts the value may be sent to, e.g. ["api.github.com", "*.github.com"]. ' +
            'Be as narrow as the task allows; the user reviews and can edit this.',
        },
        persist: {
          type: 'boolean',
          description:
            'Suggest keeping the secret beyond this session. Defaults to false (session-only).',
        },
      },
      required: ['name', 'reason'],
    },
    async execute(input): Promise<ToolResult> {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (!name || !reason) {
        return { content: 'request_secret needs both `name` and `reason`.', isError: true };
      }

      const request: SecretRequest = {
        name,
        reason,
        domains: readDomains(input.domains),
        persist: input.persist === true,
        requester: deps.requester,
        provider: readProvider(deps),
      };

      let outcome: SecretRequestOutcome;
      try {
        outcome = await requestSecret(request, deps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('secret request failed', { name, error: message });
        return { content: `The secret prompt failed: ${message}`, isError: true };
      }

      if (!outcome.stored) {
        return { content: describeDeclined(outcome), isError: true };
      }

      const envInjected = injectMaskedEnv(outcome.name, outcome.maskedValue, deps);
      log.info('secret stored via request_secret', {
        name: outcome.name,
        persisted: outcome.persisted,
      });
      return { content: describeStored(outcome, envInjected) };
    },
  };
}

function injectMaskedEnv(
  name: string,
  maskedValue: string | null,
  deps: RequestSecretToolDeps
): boolean {
  if (!deps.setEnv || !maskedValue || !isValidShellEnvName(name)) return false;
  try {
    deps.setEnv(name, maskedValue);
    return true;
  } catch (err) {
    log.warn('could not inject the masked value into the shell env', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
