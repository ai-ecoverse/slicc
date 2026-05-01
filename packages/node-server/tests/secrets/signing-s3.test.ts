import { describe, it, expect } from 'vitest';
import { signSigV4 } from '../../src/secrets/signing-s3.js';

/**
 * Canonical SigV4 v4 test vectors from AWS's official suite, mirrored from
 * `packages/webapp/tests/fs/mount/signing-s3.test.ts`. Both test files
 * exercise the same vectors against their respective copies of the signer
 * (see header in `signing-s3.ts` for why two copies exist). Drift between
 * copies fails one or both of these suites.
 *
 * Constants used by every case (per the AWS test-suite README):
 *   - access key id: AKIDEXAMPLE
 *   - secret access key: wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
 *   - region: us-east-1
 *   - service: service (the suite is service-agnostic; not 's3', so our
 *     impl skips the x-amz-content-sha256 header for these cases — see
 *     the gate in signing-s3.ts)
 *   - now: 2015-08-30T12:36:00Z
 */

const TEST_CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const TEST_DATE = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
const TEST_REGION = 'us-east-1';
const TEST_SERVICE = 'service';

describe('signSigV4 against AWS canonical test vectors (node-server mirror)', () => {
  it('get-vanilla: GET / with Host + X-Amz-Date', async () => {
    const signed = await signSigV4(
      {
        method: 'GET',
        url: new URL('https://example.amazonaws.com/'),
        headers: { host: 'example.amazonaws.com' },
      },
      TEST_CREDS,
      TEST_REGION,
      TEST_SERVICE,
      TEST_DATE
    );
    expect(signed.headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
  });

  it('post-x-www-form-urlencoded: POST / with body', async () => {
    const body = new TextEncoder().encode('Param1=value1');
    const signed = await signSigV4(
      {
        method: 'POST',
        url: new URL('https://example.amazonaws.com/'),
        headers: {
          host: 'example.amazonaws.com',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      },
      TEST_CREDS,
      TEST_REGION,
      TEST_SERVICE,
      TEST_DATE
    );
    expect(signed.headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a'
    );
  });
});

describe('signSigV4 service-specific behavior (node-server mirror)', () => {
  it('adds x-amz-content-sha256 header when service is s3', async () => {
    const signed = await signSigV4(
      {
        method: 'GET',
        url: new URL('https://my-bucket.s3.us-east-1.amazonaws.com/foo.txt'),
        headers: { host: 'my-bucket.s3.us-east-1.amazonaws.com' },
      },
      TEST_CREDS,
      'us-east-1',
      's3',
      TEST_DATE
    );
    expect(signed.headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(signed.headers.Authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date'
    );
  });

  it('omits x-amz-content-sha256 for non-s3 services', async () => {
    const signed = await signSigV4(
      {
        method: 'GET',
        url: new URL('https://example.amazonaws.com/'),
        headers: { host: 'example.amazonaws.com' },
      },
      TEST_CREDS,
      'us-east-1',
      'service',
      TEST_DATE
    );
    expect(signed.headers['x-amz-content-sha256']).toBeUndefined();
  });

  it('passes session token through as x-amz-security-token', async () => {
    const signed = await signSigV4(
      {
        method: 'GET',
        url: new URL('https://my-bucket.s3.us-east-1.amazonaws.com/foo.txt'),
        headers: { host: 'my-bucket.s3.us-east-1.amazonaws.com' },
      },
      { ...TEST_CREDS, sessionToken: 'TEMP-SESSION-TOKEN' },
      'us-east-1',
      's3',
      TEST_DATE
    );
    expect(signed.headers['x-amz-security-token']).toBe('TEMP-SESSION-TOKEN');
    expect(signed.headers.Authorization).toContain('x-amz-security-token');
  });

  it('hashes non-empty bodies into x-amz-content-sha256', async () => {
    const body = new TextEncoder().encode('hello world');
    const signed = await signSigV4(
      {
        method: 'PUT',
        url: new URL('https://my-bucket.s3.us-east-1.amazonaws.com/foo.txt'),
        headers: { host: 'my-bucket.s3.us-east-1.amazonaws.com' },
        body,
      },
      TEST_CREDS,
      'us-east-1',
      's3',
      TEST_DATE
    );
    // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(signed.headers['x-amz-content-sha256']).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    );
  });
});
