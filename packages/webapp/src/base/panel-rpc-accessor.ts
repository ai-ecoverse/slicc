import type { PanelRpcClient } from '../kernel/panel-rpc.js';

export function getPanelRpcClient(): PanelRpcClient | null {
  const g = globalThis as unknown as { __slicc_panelRpc?: PanelRpcClient };
  return g.__slicc_panelRpc ?? null;
}

export function hasLocalDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}
