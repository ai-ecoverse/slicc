export const TUNNEL_SEND_GLOBAL = '__sliccTunnelSend';

export const TUNNEL_DELIVER_GLOBAL = '__sliccTunnelDeliver';

export const TUNNEL_FRAME_REGISTER_GLOBAL = '__sliccTunnelRegisterFrame';

export const TUNNEL_CONFIG_GLOBAL = '__SLICC_TUNNEL_CONFIG__';

export interface TunnelConfig {
  appUrl: string;

  hostedOrigin: string;
}

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
