import {
  createSubstrate,
  isCloudError,
  startCone,
  listCones,
  pauseCone,
  resumeCone,
  killCone,
  type SandboxSubstrate,
} from '@slicc/cloud-core';
import { checkCapsForRun } from './caps.js';
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

const ADOBE_TOKEN_DOMAINS = 'adobe-llm-proxy.paolo-moz.workers.dev';

interface StartConeBody {
  bearer: string;
  name?: string;
  userId: string;
  email: string;
  workerOrigin: string;
}
interface ResumeConeBody {
  bearer: string;
  sandboxId: string;
  localSliccVersion: string;
  userId: string;
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

    // Atomic phase: reconcile, cap check, name conflict check.
    // Fast (<1s) — fits comfortably under blockConcurrencyWhile.
    //
    // RACE NOTE: between this check and substrate.create() below, two concurrent
    // /start-cone calls could both pass. With CAP_RUNNING=1 that briefly yields
    // 2 running cones. v1 acceptable since the worker shards per-userId and a
    // single user rarely issues two simultaneous starts; tighter reservation
    // (pending-slot append + atomic finalize) is a future enhancement.
    const reservation = await this.state.blockConcurrencyWhile(async () => {
      const reconciled = await listCones(
        { substrate, registry },
        { metadata: { userId: body.userId } }
      );
      const requestedName = body.name?.trim();
      if (requestedName && reconciled.some((c) => c.state !== 'dead' && c.name === requestedName)) {
        return {
          error: errorResponse(
            409,
            'NAME_TAKEN',
            `cloud session name already exists: ${requestedName}`
          ),
        };
      }

      const cap = checkCapsForRun(reconciled, this.env);
      if (!cap.ok) {
        return {
          error: errorResponse(403, 'CAP_EXCEEDED', `at ${cap.reason} cap`, {
            running: cap.running,
            paused: cap.paused,
            cap: { running: cap.runningCap, paused: cap.pausedCap },
          }),
        };
      }
      return { error: null };
    });

    if (reservation.error) return reservation.error;

    // Slow phase: NOT under lock. ~15-25s.
    try {
      const result = await startCone(
        { substrate, registry },
        {
          envContents: [
            `ADOBE_IMS_TOKEN=${body.bearer}`,
            `ADOBE_IMS_TOKEN_DOMAINS=${ADOBE_TOKEN_DOMAINS}`,
          ].join('\n'),
          envs: {
            ADOBE_IMS_TOKEN: body.bearer,
            ADOBE_IMS_TOKEN_DOMAINS: ADOBE_TOKEN_DOMAINS,
          },
          workerBaseUrl: body.workerOrigin,
          sliccVersion: 'web-' + new Date().toISOString().slice(0, 10),
          name: body.name?.trim(),
          metadata: { userId: body.userId, email: body.email },
        }
      );
      return okResponse({
        sandboxId: result.sandboxId,
        name: result.name,
        joinUrl: result.joinUrl,
      });
    } catch (err) {
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }

  private async resumeConeOp(body: ResumeConeBody): Promise<Response> {
    const substrate = this.substrate();
    const registry = this.registry();

    // Atomic phase: list, cap check (excluding the target), entry existence/state.
    const precheck = await this.state.blockConcurrencyWhile(async () => {
      const all = await listCones({ substrate, registry }, { metadata: { userId: body.userId } });
      const target = all.find((c) => c.sandboxId === body.sandboxId);
      if (!target) {
        return {
          error: errorResponse(404, 'NOT_FOUND', `cloud session not found: ${body.sandboxId}`),
        };
      }
      if (target.state === 'running') {
        return {
          error: errorResponse(
            409,
            'ALREADY_RUNNING',
            `cloud session is already running: ${body.sandboxId}`
          ),
        };
      }
      const others = all.filter((c) => c.sandboxId !== body.sandboxId);
      const cap = checkCapsForRun(others, this.env);
      if (!cap.ok) {
        return {
          error: errorResponse(403, 'CAP_EXCEEDED', 'resuming would exceed running cap', {
            running: cap.running,
            cap: { running: cap.runningCap, paused: cap.pausedCap },
          }),
        };
      }
      return { error: null };
    });
    if (precheck.error) return precheck.error;

    // Slow phase: no lock. substrate.connect + kick + poll + registry.update.
    try {
      const result = await resumeCone(
        { substrate, registry },
        {
          query: body.sandboxId,
          localSliccVersion: body.localSliccVersion,
          refreshSecretsContents: [
            `ADOBE_IMS_TOKEN=${body.bearer}`,
            `ADOBE_IMS_TOKEN_DOMAINS=${ADOBE_TOKEN_DOMAINS}`,
          ].join('\n'),
        }
      );
      return okResponse({
        sandboxId: result.sandboxId,
        joinUrl: result.joinUrl,
        trayRebuilt: result.trayRebuilt,
      });
    } catch (err) {
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
    INTERNAL: 500,
  };
  return map[code] ?? 500;
}
