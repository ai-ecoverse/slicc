# Live-network mount tests

These tests hit real S3 / R2 / da.live endpoints to verify SigV4 against
production servers and confirm `/api/fetch-proxy` doesn't strip signed
headers. **They are excluded from CI** and gated on environment variables
so they only run when explicitly invoked with credentials.

## Running

```bash
SLICC_TEST_S3_BUCKET=my-test-bucket \
SLICC_TEST_S3_ACCESS_KEY_ID=AKIA... \
SLICC_TEST_S3_SECRET_ACCESS_KEY=... \
SLICC_TEST_S3_REGION=us-east-1 \
npm run test:live
```

For DA tests, also set:

```bash
SLICC_TEST_DA_ORG=my-org SLICC_TEST_DA_REPO=my-repo SLICC_TEST_DA_TOKEN=... npm run test:live
```

`npm run test:live` sets `SLICC_TEST_LIVE=1` automatically. Tests check this
flag at the top of each `describe` block via `liveDescribe` (`describe.skip`
when unset) so the suite is invocable without env vars but no-ops cleanly.

## Why opt-in

- **Cost**: hits real AWS / Cloudflare / Adobe endpoints.
- **Cred risk**: requires real keys; should never run in CI.
- **Rate limits**: noisy under parallel CI runs.

## What's covered

- **SigV4 against AWS S3 / R2** — confirms the in-tree signer produces
  signatures the production servers actually accept (the offline AWS
  test vectors verify the algorithm, but only live tests catch
  canonicalization edge cases that only matter against real endpoints).
- **CLI fetch-proxy header preservation** — confirms `Authorization`,
  `X-Amz-Date`, `X-Amz-Content-Sha256`, and the URL host all survive the
  CLI's `/api/fetch-proxy` round-trip without modification. The
  `X-Slicc-Raw-Body: 1` bypass on the same proxy is also covered.
- **DA write verb** — confirms whether the live API expects POST or PUT
  for content writes (the in-tree implementation uses POST per docs).

## Files

- `live.config.ts` — `liveDescribe` helper that switches between `describe`
  and `describe.skip` based on `SLICC_TEST_LIVE`.
- `s3-live.test.ts` — S3 / R2 round-trip stub. Implementer fills in the
  body once they have a disposable test bucket.
- `da-live.test.ts` — DA round-trip stub.
