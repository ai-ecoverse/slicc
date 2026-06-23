import {
  createSubstrate,
  isCloudError,
  killCone,
  listCones,
  pauseCone,
  reserveSlot,
  resumeCone,
  type SandboxSubstrate,
  startCone,
} from '@slicc/cloud-core';
import { bundleIndex, type ConeConfigDelta, imsTokenExpiry } from '@slicc/cloud-core/cone-config';
import { checkCapsForRun } from './caps.js';
import { buildStartConeArgs, coneConfigToBundle } from './cone-config-bridge.js';
import { errorResponse, okResponse } from './error-envelope.js';
import { LocalRegistry } from './local-registry.js';

interface DoEnv {
  E2B_API_KEY: string;
  CONE_CAP_RUNNING: string;
  CONE_CAP_PAUSED: string;
  /** Test-only hatch: inject a substrate factory in place of e2b. */
  __SUBSTRATE_FACTORY__?: () => SandboxSubstrate;
}

interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export const ADOBE_TOKEN_DOMAINS = 'adobe-llm-proxy.paolo-moz.workers.dev';

interface StartConeBody {
  bearer: string;
  name?: string;
  userId: string;
  workerOrigin: string;
  coneConfig?: unknown;
}
interface ResumeConeBody {
  bearer: string;
  sandboxId: string;
  localSliccVersion: string;
  userId: string;
  coneConfigDelta?: unknown;
}
interface SimpleSandboxBody {
  sandboxId: string;
}
interface ListConesBody {
  userId: string;
}

export class CloudSessionsDurableObject {
  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: DoEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    return this.dispatch(url.pathname, request);
  }

  private substrate(): SandboxSubstrate {
    if (this.env.__SUBSTRATE_FACTORY__) return this.env.__SUBSTRATE_FACTORY__();
    return createSubstrate('e2b', { apiKey: this.env.E2B_API_KEY });
  }
  private registry(): LocalRegistry {
    return new LocalRegistry(this.state.storage);
  }

  private async dispatch(op: string, request: Request): Promise<Response> {
    try {
      switch (op) {
        case '/start-cone':
          return await this.startConeOp((await request.json()) as StartConeBody);
        case '/resume-cone':
          return await this.resumeConeOp((await request.json()) as ResumeConeBody);
        case '/pause-cone':
          return await this.pauseConeOp((await request.json()) as SimpleSandboxBody);
        case '/kill-cone':
          return await this.killConeOp((await request.json()) as SimpleSandboxBody);
        case '/list-cones':
          return await this.listConesOp((await request.json()) as ListConesBody);
        case '/cone-config-index':
          return await this.coneConfigIndexOp((await request.json()) as SimpleSandboxBody);
        default:
          return new Response(`unknown DO op: ${op}`, { status: 404 });
      }
    } catch (err) {
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }

  private async startConeOp(body: StartConeBody): Promise<Response> {
    const substrate = this.substrate();
    const registry = this.registry();

    // Reconcile outside lock (slow e2b API calls). Side-effecting: updates
    // the registry to match substrate state; return value intentionally
    // unused since the atomic phase below re-reads fresh registry state.
    try {
      await listCones({ substrate, registry }, { metadata: { userId: body.userId } });
    } catch (err) {
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }

    // Atomic phase under DO lock: registry-only cap + name + reserve placeholder. Fast (<10ms).
    // Re-read registry inside the lock to catch concurrent reservations (the reconciled
    // list from outside the lock may be stale if another start-cone reserved while we
    // were waiting for the lock). Filter by userId to match the reconciliation scope.
    const reservation = await this.state.blockConcurrencyWhile(async () => {
      try {
        const freshRegistry = await registry.list();
        const filtered = body.userId
          ? freshRegistry.filter((e) => e.metadata?.userId === body.userId)
          : freshRegistry;

        return {
          ok: true as const,
          ...(await reserveSlot(
            { substrate, registry },
            {
              userId: body.userId,
              name: body.name?.trim(),
              metadata: { userId: body.userId },
              sliccVersion: 'web-' + new Date().toISOString().slice(0, 10),
              env: this.env,
              reconciledCones: filtered,
            }
          )),
        };
      } catch (err) {
        if (isCloudError(err)) {
          return {
            ok: false as const,
            response: errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details),
          };
        }
        return {
          ok: false as const,
          response: errorResponse(500, 'INTERNAL', String(err)),
        };
      }
    });

    if (!reservation.ok) return reservation.response;

    // Slow phase: NO LOCK. The reservation entry holds the cap slot.
    // ~15-25s for substrate.create + poll.
    try {
      const bundle = coneConfigToBundle(body.coneConfig, body.bearer);
      const { envContents, coneConfigJson } = buildStartConeArgs(bundle, body.bearer);

      const result = await startCone(
        { substrate, registry },
        {
          reservationId: reservation.reservationId,
          envContents,
          coneConfigJson,
          envs: {
            ADOBE_IMS_TOKEN: body.bearer,
            ADOBE_IMS_TOKEN_DOMAINS: ADOBE_TOKEN_DOMAINS,
          },
          workerBaseUrl: body.workerOrigin,
          sliccVersion: 'web-' + new Date().toISOString().slice(0, 10),
          name: body.name?.trim(),
          metadata: { userId: body.userId },
        }
      );

      // Persist the names-only index on the DO record after successful start
      const index = bundleIndex(bundle);
      await registry.update(result.sandboxId, { coneConfigIndex: index });

      return okResponse({
        sandboxId: result.sandboxId,
        name: result.name,
        joinUrl: result.joinUrl,
      });
    } catch (err) {
      // startCone itself cleans up the reservation entry on failure.
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }

  private async resumeConeOp(body: ResumeConeBody): Promise<Response> {
    const substrate = this.substrate();
    const registry = this.registry();

    // Reconcile state outside the lock — substrate.list() + extendTimeout()
    // may take seconds. Concurrent /list-cones / /resume-cone calls can still
    // arrive during this window; their own reconciliation is idempotent.
    try {
      await listCones({ substrate, registry }, { metadata: { userId: body.userId } });
    } catch (err) {
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }

    // Atomic phase: registry-only reads + state flip. Fast (<10ms typical).
    let originalState: 'paused' | 'dead' | undefined;
    const precheck = await this.state.blockConcurrencyWhile(async () => {
      const all = await registry.list();
      const target = all.find((c) => c.sandboxId === body.sandboxId);
      if (!target) {
        return {
          error: errorResponse(404, 'NOT_FOUND', `cloud session not found: ${body.sandboxId}`),
        };
      }
      if (target.state === 'running' || target.state === 'reserved') {
        return {
          error: errorResponse(
            409,
            'ALREADY_RUNNING',
            `cloud session is already running: ${body.sandboxId}`
          ),
        };
      }
      // Filter dead entries before cap math — dead entries are accounted for
      // by listCones reconciliation above, but a stale entry that was JUST
      // reconciled to dead in this same call wouldn't be filtered without
      // this guard. Cap check should reflect only live (running/paused/reserved).
      const others = all
        .filter((c) => c.sandboxId !== body.sandboxId)
        .filter((c) => c.state !== 'dead');
      const cap = checkCapsForRun(others, this.env);
      if (!cap.ok) {
        return {
          error: errorResponse(403, 'CAP_EXCEEDED', 'resuming would exceed running cap', {
            running: cap.running,
            cap: { running: cap.runningCap, paused: cap.pausedCap },
          }),
        };
      }

      // Capture original state for rollback (paused or dead).
      originalState = target.state;
      // Reserve the slot: flip target to 'reserved' so concurrent /resume sees it in cap count.
      await registry.update(body.sandboxId, {
        state: 'reserved',
        reservedAt: new Date().toISOString(),
      });
      return { error: null };
    });
    if (precheck.error) return precheck.error;

    // Slow phase: no lock. substrate.connect + kick + poll + registry.update.
    try {
      const userDelta = body.coneConfigDelta as ConeConfigDelta | undefined;
      // Always refresh the Adobe IMS bearer, merged with any user edits, through
      // the read-modify-write delta path. A raw refreshSecretsContents overwrite
      // would clobber every OTHER flat secret/account in /slicc/secrets.env. User
      // upserts come after Adobe's (so a user re-auth wins by providerId/name),
      // and a user delete of 'adobe' still wins (merge applies upserts then deletes).
      // Stamp tokenExpiresAt so a resume without a fresh user-supplied adobe
      // account doesn't leave the cone with an expiry-less oauth entry — the
      // window-less kernel worker would otherwise treat the refreshed (valid)
      // token as expired and throw "Adobe session expired" on its first turn.
      const adobeExpiresAt = imsTokenExpiry(body.bearer);
      const mergedDelta: ConeConfigDelta = {
        ...(userDelta?.model ? { model: userDelta.model } : {}),
        upsert: {
          accounts: [
            {
              providerId: 'adobe',
              kind: 'oauth',
              accessToken: body.bearer,
              ...(adobeExpiresAt !== undefined ? { tokenExpiresAt: adobeExpiresAt } : {}),
            },
            ...(userDelta?.upsert?.accounts ?? []),
          ],
          secrets: [
            { name: 'ADOBE_IMS_TOKEN', value: body.bearer, domains: [ADOBE_TOKEN_DOMAINS] },
            ...(userDelta?.upsert?.secrets ?? []),
          ],
        },
        ...(userDelta?.delete ? { delete: userDelta.delete } : {}),
      };
      const result = await resumeCone(
        { substrate, registry },
        {
          query: body.sandboxId,
          localSliccVersion: body.localSliccVersion,
          coneConfigDelta: mergedDelta,
          skipStateCheck: true, // Already checked + reserved under lock
        }
      );

      // Persist the updated index if resumeCone returned one
      if (result.coneConfigIndex) {
        await registry.update(body.sandboxId, { coneConfigIndex: result.coneConfigIndex });
      }

      return okResponse({
        sandboxId: result.sandboxId,
        joinUrl: result.joinUrl,
        trayRebuilt: result.trayRebuilt,
      });
    } catch (err) {
      // Rollback the speculative state flip to the original state (not always 'paused').
      try {
        if (originalState) {
          await registry.update(body.sandboxId, { state: originalState });
        }
      } catch (rollbackErr) {
        const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        console.warn('[cloud-do] resume rollback failed', { sandboxId: body.sandboxId, err: msg });
      }

      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }

  private async pauseConeOp(body: SimpleSandboxBody): Promise<Response> {
    try {
      await pauseCone({ substrate: this.substrate(), registry: this.registry() }, body.sandboxId);
      return okResponse();
    } catch (err) {
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }

  private async killConeOp(body: SimpleSandboxBody): Promise<Response> {
    try {
      await killCone({ substrate: this.substrate(), registry: this.registry() }, body.sandboxId);
    } catch (err) {
      if (isCloudError(err) && err.code === 'NOT_FOUND') return okResponse();
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
    return okResponse();
  }

  private async listConesOp(body: ListConesBody): Promise<Response> {
    try {
      const cones = await listCones(
        { substrate: this.substrate(), registry: this.registry() },
        { metadata: { userId: body.userId } }
      );
      return okResponse({ cones });
    } catch (err) {
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }

  private async coneConfigIndexOp(body: SimpleSandboxBody): Promise<Response> {
    try {
      const entry = await this.registry().findByNameOrId(body.sandboxId);
      if (!entry) {
        return errorResponse(404, 'NOT_FOUND', `cone not found: ${body.sandboxId}`);
      }
      return okResponse({ coneConfigIndex: entry.coneConfigIndex ?? null });
    } catch (err) {
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }
}

function errCodeToStatus(code: string): number {
  const map: Record<string, number> = {
    CAP_EXCEEDED: 403,
    NOT_FOUND: 404,
    NAME_TAKEN: 409,
    ALREADY_PAUSED: 409,
    ALREADY_RUNNING: 409,
    LEADER_NOT_READY: 503,
    SANDBOX_NOT_READY: 503,
    CDP_NOT_READY: 503,
    CDP_ERROR: 500,
    DO_UNREACHABLE: 503,
    UPSTREAM_UNAVAILABLE: 503,
    INTERNAL: 500,
  };
  return map[code] ?? 500;
}
