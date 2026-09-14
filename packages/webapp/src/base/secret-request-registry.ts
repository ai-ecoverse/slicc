export interface SecretRequest {
  name?: string;

  domains?: string[];

  reason?: string;

  requester?: string;

  persist?: boolean;

  provider?: string;
}

export interface SecretRequestStored {
  stored: true;

  name: string;

  maskedValue: string | null;

  domains: string[];

  persisted: boolean;
}

export interface SecretRequestDeclined {
  stored: false;

  reason: 'cancelled' | 'unavailable' | 'failed';

  detail?: string;
}

export type SecretRequestOutcome = SecretRequestStored | SecretRequestDeclined;

export type SecretRequestSurface = (request: SecretRequest) => Promise<SecretRequestOutcome>;

let surface: SecretRequestSurface | null = null;

export function getSecretRequestSurface(): SecretRequestSurface | null {
  return surface;
}

export function setSecretRequestSurface(value: SecretRequestSurface | null): void {
  surface = value;
}
