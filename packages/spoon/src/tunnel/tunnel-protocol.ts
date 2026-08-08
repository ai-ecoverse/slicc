// Wire contract between the CDP virtual-network overlay loader (runs in the
// `srcdoc` frame, `tunnel-loader-entry.ts`) and the controller-side relay
// (node-server `electron-tunnel.ts` / swift-server `ElectronTunnel.swift`).
//
// The `srcdoc` frame is same-origin with the top frame (an `about:srcdoc`
// document inherits its embedder's origin), so the loader reaches the top
// frame's relay globals directly (`window.top[...]`). The relay globals bridge
// to a CDP `Runtime.addBinding` (frame → controller) and are driven by the
// controller's `Runtime.evaluate` (controller → frame). Every network op the
// egress-blocked renderer can't perform (module + resource fetches, the bridge
// WebSocket) rides this channel to the controller, which does have network.

/** Global on the top frame the loader calls to send a request to the controller
 *  (installed by the controller as, or forwarding to, a `Runtime.addBinding`). */
export const TUNNEL_SEND_GLOBAL = '__sliccTunnelSend';

/** Global on the top frame the controller invokes (via `Runtime.evaluate`) to
 *  deliver a message to the overlay frame; the top-frame relay forwards it to
 *  the registered loader frame. */
export const TUNNEL_DELIVER_GLOBAL = '__sliccTunnelDeliver';

/** Global the loader sets on the top frame so the relay knows which frame window
 *  to forward controller messages to. */
export const TUNNEL_FRAME_REGISTER_GLOBAL = '__sliccTunnelRegisterFrame';

/** Global the controller sets on the srcdoc frame carrying the boot config. */
export const TUNNEL_CONFIG_GLOBAL = '__SLICC_TUNNEL_CONFIG__';

/** Boot config the controller injects into the `srcdoc` document. */
export interface TunnelConfig {
  /** Hosted follower app URL (with `?tray=`/bridge params) the loader emulates
   *  as `location` and whose index HTML seeds the module graph. */
  appUrl: string;
  /** Origin (e.g. `https://www.sliccy.ai`) all `/assets/*` resolve against. */
  hostedOrigin: string;
}

// Frame → controller request messages.
export type TunnelRequest =
  | {
      op: 'fetch';
      id: number;
      url: string;
      method: string;
      headers: Record<string, string>;
      bodyB64: string | null;
    }
  | { op: 'ws-open'; id: number; url: string; protocols: string[] }
  | { op: 'ws-send'; id: number; dataB64: string; binary: boolean }
  | { op: 'ws-close'; id: number; code?: number };

// Controller → frame response messages.
export type TunnelResponse =
  | {
      op: 'fetch-res';
      id: number;
      status: number;
      headers: Record<string, string>;
      bodyB64: string;
    }
  | { op: 'fetch-err'; id: number; message: string }
  | { op: 'ws-open-ack'; id: number; protocol: string }
  | { op: 'ws-msg'; id: number; dataB64: string; binary: boolean }
  | { op: 'ws-close'; id: number; code: number }
  | { op: 'ws-err'; id: number; message: string };
