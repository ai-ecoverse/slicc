import type { ApnsPushResult, ApnsSender } from './apns.js';
import type { TrayRecord } from './shared.js';

export const MAX_PUSH_TOKENS_PER_TRAY = 16;

export interface PushDeps {
  requireTray(): TrayRecord;
  persistTray(): Promise<void>;
  isoNow(): string;

  apns: ApnsSender | null;
}

export interface PushRegisterMessage {
  bootstrapId?: unknown;
  platform?: unknown;
  token?: unknown;
  environment?: unknown;
}

export interface PushSendMessage {
  category?: unknown;
  label?: unknown;
  requestId?: unknown;
}

export function forgetsPushToken(tray: TrayRecord, result: ApnsPushResult): boolean {
  if (result.invalidatedAtMs === undefined) return true;
  const record = tray.pushTokens?.[result.token];
  if (!record) return true;
  const registeredAtMs = Date.parse(record.registeredAt);
  if (!Number.isFinite(registeredAtMs)) return true;
  return registeredAtMs < result.invalidatedAtMs;
}

export class PushCoordinator {
  private disabledLogged = false;

  constructor(private readonly deps: PushDeps) {}

  register(message: PushRegisterMessage): void {
    const tray = this.deps.requireTray();
    const token = typeof message.token === 'string' ? message.token.trim() : '';
    if (message.platform !== 'ios' || !/^[0-9a-fA-F]{32,400}$/.test(token)) return;
    const environment = message.environment === 'production' ? 'production' : 'sandbox';
    const bootstrapId = typeof message.bootstrapId === 'string' ? message.bootstrapId : '';
    tray.pushTokens ??= {};
    tray.pushTokens[token] = {
      platform: 'ios',
      environment,
      bootstrapId,
      registeredAt: this.deps.isoNow(),
    };
    const entries = Object.entries(tray.pushTokens);
    if (entries.length > MAX_PUSH_TOKENS_PER_TRAY) {
      const evict = entries
        .sort((a, b) => a[1].registeredAt.localeCompare(b[1].registeredAt))
        .slice(0, entries.length - MAX_PUSH_TOKENS_PER_TRAY);
      for (const [dead] of evict) delete tray.pushTokens[dead];
    }
  }

  async send(message: PushSendMessage): Promise<void> {
    const tray = this.deps.requireTray();
    const tokens = Object.entries(tray.pushTokens ?? {});
    if (tokens.length === 0) return;
    const apns = this.deps.apns;
    if (!apns) {
      if (!this.disabledLogged) {
        this.disabledLogged = true;
        console.warn('[push] APNs secrets not configured — push.send ignored', {
          trayId: tray.trayId,
        });
      }
      return;
    }
    if (message.category !== 'sudo_request' && message.category !== 'turn_end') return;
    const category = message.category;
    const label =
      typeof message.label === 'string' && message.label.trim()
        ? message.label.trim().slice(0, 80)
        : 'SLICC';
    const requestId =
      typeof message.requestId === 'string' && message.requestId ? message.requestId : undefined;

    const results = await Promise.all(
      tokens.map(([token, record]) =>
        apns
          .send({
            token,
            environment: record.environment,
            category,
            label,
            trayId: tray.trayId,
            ...(requestId ? { requestId } : {}),
          })
          .catch(
            (err): ApnsPushResult => ({
              token,
              status: 0,
              reason: err instanceof Error ? err.message : String(err),
              dropToken: false,
            })
          )
      )
    );

    let mutated = false;
    for (const result of results) {
      if (result.dropToken && forgetsPushToken(tray, result)) {
        delete tray.pushTokens?.[result.token];
        mutated = true;
        continue;
      }
      if (result.status !== 200) {
        console.warn('[push] APNs delivery failed', {
          trayId: tray.trayId,
          status: result.status,
          reason: result.reason,

          ...(result.uniqueId ? { uniqueId: result.uniqueId } : {}),
        });
      }
    }
    if (mutated) await this.deps.persistTray();
  }
}
