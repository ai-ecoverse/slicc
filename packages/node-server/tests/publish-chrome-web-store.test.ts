import { generateKeyPairSync } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  createServiceAccountAssertion,
  parseServiceAccountCredentials,
  publishChromeWebStoreRelease,
  readChromeWebStoreConfig,
} from '../src/publish-chrome-web-store.js';

interface TestFixture {
  root: string;
  manifestPath: string;
  zipBytes: Buffer;
}

function createServiceAccountJson(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    client_email: 'slicc-release@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

function createFixture(version = '1.2.3'): TestFixture {
  const root = mkdtempSync(join(tmpdir(), 'slicc-cws-release-'));
  const releaseDir = join(root, 'artifacts', 'release');
  const manifestPath = join(releaseDir, 'release-artifacts.json');
  const archivePath = join(releaseDir, `slicc-extension-v${version}.zip`);
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(archivePath, zipBytes);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version,
        extensionArchive: `artifacts/release/slicc-extension-v${version}.zip`,
      },
      null,
      2
    )}\n`
  );

  return { root, manifestPath, zipBytes };
}

function destroyFixture(fixture: TestFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('publish-chrome-web-store', () => {
  it('returns null when Chrome Web Store publishing is not configured', async () => {
    const fetchMock = vi.fn();

    await expect(
      publishChromeWebStoreRelease({
        env: {},
        fetchImpl: fetchMock as unknown as typeof fetch,
        log: { log: vi.fn(), warn: vi.fn() },
      })
    ).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses base64 service account credentials and optional publish settings', () => {
    const serviceAccountJson = createServiceAccountJson();
    const config = readChromeWebStoreConfig({
      CHROME_WEB_STORE_PUBLISHER_ID: 'publisher-123',
      CHROME_WEB_STORE_ITEM_ID: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
      CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON_BASE64:
        Buffer.from(serviceAccountJson).toString('base64'),
      CHROME_WEB_STORE_PUBLISH_TYPE: 'STAGED_PUBLISH',
      CHROME_WEB_STORE_DEPLOY_PERCENTAGE: '25',
      CHROME_WEB_STORE_SKIP_REVIEW: 'true',
    });

    expect(config).toMatchObject({
      publisherId: 'publisher-123',
      itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
      publishType: 'STAGED_PUBLISH',
      deployPercentage: 25,
      skipReview: true,
    });
    expect(config?.serviceAccount.client_email).toContain('@');
  });

  it('rejects malformed deploy percentage values instead of truncating them', () => {
    expect(() =>
      readChromeWebStoreConfig({
        CHROME_WEB_STORE_PUBLISHER_ID: 'publisher-123',
        CHROME_WEB_STORE_ITEM_ID: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
        CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON: createServiceAccountJson(),
        CHROME_WEB_STORE_DEPLOY_PERCENTAGE: '25%',
      })
    ).toThrow('CHROME_WEB_STORE_DEPLOY_PERCENTAGE must be an integer between 0 and 100.');

    expect(() =>
      readChromeWebStoreConfig({
        CHROME_WEB_STORE_PUBLISHER_ID: 'publisher-123',
        CHROME_WEB_STORE_ITEM_ID: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
        CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON: createServiceAccountJson(),
        CHROME_WEB_STORE_DEPLOY_PERCENTAGE: '7.5',
      })
    ).toThrow('CHROME_WEB_STORE_DEPLOY_PERCENTAGE must be an integer between 0 and 100.');
  });

  it('creates a signed service account assertion with the expected claims', () => {
    const credentials = parseServiceAccountCredentials(createServiceAccountJson(), undefined)!;
    const assertion = createServiceAccountAssertion(credentials, 1_700_000_000);
    const [encodedHeader, encodedClaims, signature] = assertion.split('.');

    expect(signature).toBeTruthy();
    expect(JSON.parse(Buffer.from(encodedHeader!, 'base64url').toString('utf8'))).toMatchObject({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(encodedClaims!, 'base64url').toString('utf8'))).toMatchObject({
      iss: credentials.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/chromewebstore',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });

  it('uploads the packaged extension, polls async status, and submits the item for review', async () => {
    const fixture = createFixture();
    const logs: string[] = [];
    const waits: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          uploadState: 'IN_PROGRESS',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          lastAsyncUploadState: 'SUCCEEDED',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          state: 'PENDING_REVIEW',
        })
      );

    try {
      const result = await publishChromeWebStoreRelease({
        env: {
          CHROME_WEB_STORE_PUBLISHER_ID: 'publisher-123',
          CHROME_WEB_STORE_ITEM_ID: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON: createServiceAccountJson(),
        },
        fetchImpl: fetchMock as unknown as typeof fetch,
        log: {
          log: (message: string) => logs.push(message),
          warn: vi.fn(),
        },
        manifestPath: fixture.manifestPath,
        projectRoot: fixture.root,
        nowSeconds: () => 1_700_000_000,
        pollIntervalMs: 123,
        waitMs: async (ms: number) => {
          waits.push(ms);
        },
      });

      expect(result).toEqual({
        version: '1.2.3',
        itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
        uploadState: 'SUCCEEDED',
        publishState: 'PENDING_REVIEW',
      });
      expect(waits).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const tokenRequest = fetchMock.mock.calls[0]!;
      expect(tokenRequest[0]).toBe('https://oauth2.googleapis.com/token');
      expect((tokenRequest[1] as RequestInit).method).toBe('POST');

      const uploadRequest = fetchMock.mock.calls[1]!;
      expect(uploadRequest[0]).toBe(
        'https://chromewebstore.googleapis.com/upload/v2/publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf:upload'
      );
      expect((uploadRequest[1] as RequestInit).method).toBe('POST');
      expect((uploadRequest[1] as RequestInit).headers).toMatchObject({
        authorization: 'Bearer access-token',
        'content-type': 'application/zip',
      });
      expect(
        Buffer.compare(
          Buffer.from((uploadRequest[1] as RequestInit).body as Uint8Array),
          fixture.zipBytes
        )
      ).toBe(0);

      const publishRequest = fetchMock.mock.calls[3]!;
      expect(publishRequest[0]).toBe(
        'https://chromewebstore.googleapis.com/v2/publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf:publish'
      );
      expect(JSON.parse((publishRequest[1] as RequestInit).body as string)).toEqual({});
      expect(logs[0]).toContain('Published artifacts/release/slicc-extension-v1.2.3.zip');
    } finally {
      destroyFixture(fixture);
    }
  });

  it('keeps polling when async upload status has not propagated yet', async () => {
    const fixture = createFixture();
    const waits: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          uploadState: 'IN_PROGRESS',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          lastAsyncUploadState: 'SUCCEEDED',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          state: 'PENDING_REVIEW',
        })
      );

    try {
      const result = await publishChromeWebStoreRelease({
        env: {
          CHROME_WEB_STORE_PUBLISHER_ID: 'publisher-123',
          CHROME_WEB_STORE_ITEM_ID: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON: createServiceAccountJson(),
        },
        fetchImpl: fetchMock as unknown as typeof fetch,
        log: { log: vi.fn(), warn: vi.fn() },
        manifestPath: fixture.manifestPath,
        projectRoot: fixture.root,
        pollIntervalMs: 321,
        waitMs: async (ms: number) => {
          waits.push(ms);
        },
      });

      expect(result).toMatchObject({
        uploadState: 'SUCCEEDED',
        publishState: 'PENDING_REVIEW',
      });
      expect(waits).toEqual([321]);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    } finally {
      destroyFixture(fixture);
    }
  });

  it('fails when Chrome Web Store publishing is only partially configured', async () => {
    await expect(
      publishChromeWebStoreRelease({
        env: {
          CHROME_WEB_STORE_PUBLISHER_ID: 'publisher-123',
        },
        log: { log: vi.fn(), warn: vi.fn() },
      })
    ).rejects.toThrow(
      'Chrome Web Store publishing is partially configured. Missing: CHROME_WEB_STORE_ITEM_ID, CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON or CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON_BASE64.'
    );
  });

  it('fails when the upload completes but the publish response is rejected', async () => {
    const fixture = createFixture();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          uploadState: 'SUCCEEDED',
          crxVersion: '1.2.3',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          state: 'REJECTED',
        })
      );

    try {
      await expect(
        publishChromeWebStoreRelease({
          env: {
            CHROME_WEB_STORE_PUBLISHER_ID: 'publisher-123',
            CHROME_WEB_STORE_ITEM_ID: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
            CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON: createServiceAccountJson(),
          },
          fetchImpl: fetchMock as unknown as typeof fetch,
          log: { log: vi.fn(), warn: vi.fn() },
          manifestPath: fixture.manifestPath,
          projectRoot: fixture.root,
        })
      ).rejects.toThrow('Chrome Web Store publish returned unexpected item state REJECTED.');
    } finally {
      destroyFixture(fixture);
    }
  });

  it('fails when the Chrome Web Store upload is rejected before publish', async () => {
    const fixture = createFixture();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'publishers/publisher-123/items/akjjllgokmbgpbdbmafpiefnhidlmbgf',
          itemId: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
          uploadState: 'FAILED',
        })
      );

    try {
      await expect(
        publishChromeWebStoreRelease({
          env: {
            CHROME_WEB_STORE_PUBLISHER_ID: 'publisher-123',
            CHROME_WEB_STORE_ITEM_ID: 'akjjllgokmbgpbdbmafpiefnhidlmbgf',
            CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON: createServiceAccountJson(),
          },
          fetchImpl: fetchMock as unknown as typeof fetch,
          log: { log: vi.fn(), warn: vi.fn() },
          manifestPath: fixture.manifestPath,
          projectRoot: fixture.root,
        })
      ).rejects.toThrow('Chrome Web Store upload finished immediately in state FAILED.');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      destroyFixture(fixture);
    }
  });
});
