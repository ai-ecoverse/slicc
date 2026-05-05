/**
 * In-memory `SecretStore` for tests. Mirrors the minimal `get()` surface
 * defined in production at `packages/webapp/src/fs/mount/profile.ts`. If
 * the production interface grows, mirror the new methods here.
 */
export interface FakeSecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export function createFakeSecretStore(initial?: Record<string, string>): FakeSecretStore {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async list() {
      return [...data.keys()];
    },
  };
}
