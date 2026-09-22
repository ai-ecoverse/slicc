let blocked = false;
let logged = false;

export class BridgeTokenRequiredError extends Error {
  constructor() {
    super(
      'OAuth refresh stopped: the local bridge rejected the request (403 bridge-token-required).'
    );
    this.name = 'BridgeTokenRequiredError';
  }
}

export function bridgeRefreshBlocked(): boolean {
  return blocked;
}

export function noteBridgeTokenRequired(status: number, body: string): boolean {
  if (status !== 403 || !body.includes('bridge-token-required')) return false;
  blocked = true;
  if (!logged) {
    logged = true;
    console.error(
      '[oauth] refresh stopped: 403 bridge-token-required. The local bridge rejected the call, so another refresh cannot reach the provider.'
    );
  }
  return true;
}

export function resetBridgeTokenRefreshBlockForTests(): void {
  blocked = false;
  logged = false;
}
