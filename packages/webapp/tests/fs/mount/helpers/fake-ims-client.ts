/**
 * In-memory IMS client for tests. Returns a static bearer token and tracks
 * how many times `getBearerToken()` was called so tests can verify the
 * auth-retry path actually re-fetched.
 */
export interface FakeImsClient {
  getBearerToken(): Promise<string>;
  identity?: string;
  /** Test-only: number of times getBearerToken() was called. */
  readonly callCount: number;
  /** Test-only: replace the token (e.g. simulate refresh). */
  setToken(token: string): void;
}

export function createFakeImsClient(initialToken: string = 'fake-ims-token'): FakeImsClient {
  let token = initialToken;
  let callCount = 0;
  return {
    identity: 'adobe-ims',
    async getBearerToken() {
      callCount++;
      return token;
    },
    get callCount() {
      return callCount;
    },
    setToken(t: string) {
      token = t;
    },
  };
}
