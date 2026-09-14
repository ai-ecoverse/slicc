export interface FakeImsClient {
  getBearerToken(): Promise<string>;
  identity?: string;

  readonly callCount: number;

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
