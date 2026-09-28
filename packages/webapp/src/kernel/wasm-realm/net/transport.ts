export type HeaderList = ReadonlyArray<readonly [name: string, value: string]>;

export interface RealmTransportRequest {
  url: string;

  method: string;

  headers: HeaderList;

  body?: Uint8Array;

  signal: AbortSignal;
}

export interface RealmTransportResponse {
  status: number;
  statusText: string;

  headers: HeaderList;

  body: AsyncIterable<Uint8Array>;

  cancel(): Promise<void>;
}

export interface RealmTransportTraits {
  manualRedirects: boolean;

  encodedBodies: boolean;

  maxRequestBody: number;
}

export interface RealmTransport {
  readonly traits: RealmTransportTraits;

  fetch(request: RealmTransportRequest): Promise<RealmTransportResponse>;
}
