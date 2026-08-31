/**
 * APNs push fan-out for the tray durable object (issue #2062).
 *
 * The leader owns the decision to push; this coordinator owns the *device
 * registry* and the fan-out. It is the trust boundary for what the DO stores,
 * so a `push.register` arriving over the leader socket is re-validated here
 * even though the leader already checked its shape.
 *
 * Structured like `session-tray-preview.ts` / `session-tray-biscotto.ts`: the
 * coordinator takes explicit dependencies rather than reaching into the DO, so
 * it is unit-testable without a DO harness. It is a class rather than a set of
 * functions purely because the "APNs is not configured" warning must be logged
 * once per instance, not once per push.
 */

import type { ApnsPushResult, ApnsSender } from './apns.js';
import type { TrayRecord } from './shared.js';

/** Cap on registered push devices per tray; oldest registrations are evicted. */
export const MAX_PUSH_TOKENS_PER_TRAY = 16;

/** The slice of the durable object this coordinator needs. */
export interface PushDeps {
  requireTray(): TrayRecord;
  persistTray(): Promise<void>;
  isoNow(): string;
  /** `null` when APNs secrets are absent — pushing is disabled, not an error. */
  apns: ApnsSender | null;
}

/** A `push.register` as it arrives over the leader socket. Every field is untyped on purpose. */
export interface PushRegisterMessage {
  bootstrapId?: unknown;
  platform?: unknown;
  token?: unknown;
  environment?: unknown;
}

/** A `push.send` as it arrives over the leader socket. */
export interface PushSendMessage {
  category?: unknown;
  label?: unknown;
  requestId?: unknown;
}

/**
 * Should a dead-token verdict actually evict the registration? Apple's 410
 * body carries the instant the token stopped being valid; a device that
 * re-registered after that instant has a live token again and must be kept,
 * or a reconnect race silently unsubscribes a phone that is right there.
 * A 400 `BadDeviceToken` carries no timestamp and is unconditionally final.
 */
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

  /**
   * A follower registered a push token via the leader. Bounded per tray;
   * re-registering the same token just refreshes it. Silently ignores anything
   * that is not a plausible iOS device token — a bad registration is a client
   * bug, not something to surface on the leader's control socket.
   */
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

  /**
   * Fan a leader push out to every registered device. Dead tokens (410 /
   * BadDeviceToken) are forgotten and the record persisted; transport errors
   * are logged and the token kept. Never throws into the leader socket loop.
   */
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
          // Apple asks for this id when investigating a push that never landed.
          ...(result.uniqueId ? { uniqueId: result.uniqueId } : {}),
        });
      }
    }
    if (mutated) await this.deps.persistTray();
  }
}
