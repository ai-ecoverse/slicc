import { createLogger } from './logger.js';
import { type LeaveTrayTransport, resolveAmbientLeaveTrayTransport } from './tray-leave.js';
import {
  parseTrayJoinUrlValue,
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from './tray-url-config.js';

const log = createLogger('scoops.tray-join');

export interface JoinTrayOptions {
  requestId?: string;
}

export async function joinTray(
  joinUrl: string,
  opts: JoinTrayOptions = {},
  transport: LeaveTrayTransport = resolveAmbientLeaveTrayTransport()
): Promise<void> {
  if (transport.storage) {
    const parsed = parseTrayJoinUrlValue(joinUrl);
    try {
      transport.storage.setItem(TRAY_JOIN_STORAGE_KEY, parsed?.joinUrl ?? joinUrl);
      if (parsed) {
        transport.storage.setItem(TRAY_WORKER_STORAGE_KEY, parsed.workerBaseUrl);
      }
    } catch (err) {
      log.error('tray-join storage write failed', {
        requestId: opts.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!transport.wire) {
    throw new Error(
      'joinTray: no transport available — inject a panelRpcClient (worker) ' +
        'or run in a context with window'
    );
  }

  switch (transport.wire.kind) {
    case 'standalone-page':
      transport.wire.dispatchEvent(
        new CustomEvent('slicc:tray-join', {
          detail: { joinUrl, requestId: opts.requestId },
        })
      );
      return;
    case 'standalone-worker':
      throw new Error(
        'joinTray: standalone-worker transport must be driven via panel-RPC tray-join'
      );
  }
}
