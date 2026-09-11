import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const releaseScript = resolve('packages/cloudflare-worker/scripts/publish-worker.sh');

/** Execute the actual release script, with every network-capable command stubbed. */
function release(gate: 'skip' | 'deploy', archiveStatus = 0, lifecycleStatus = 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'slicc-release-flow-'));
  const bin = join(cwd, 'bin');
  const trace = join(cwd, 'trace');
  const template = join(cwd, 'packages/dev-tools/e2b-template/scripts');
  try {
    mkdirSync(bin);
    mkdirSync(template, { recursive: true });
    writeFileSync(trace, '');
    writeFileSync(
      join(bin, 'node'),
      `#!/bin/sh
case "$1" in
  */release-native.mjs)
    echo gate >> "$TEST_TRACE"
    echo "$TEST_GATE"
    ;;
  */upload-assets-to-r2.mjs)
    echo archive >> "$TEST_TRACE"
    exit "$TEST_ARCHIVE_STATUS"
    ;;
  */verify-preview-lifecycle.mjs)
    echo lifecycle >> "$TEST_TRACE"
    exit "$TEST_LIFECYCLE_STATUS"
    ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(bin, 'npx'),
      `#!/bin/sh
case "$1 $2 $3" in
  "wrangler secret put")
    echo secret >> "$TEST_TRACE"
    cat > /dev/null
    ;;
  "wrangler deploy --config")
    case "$4" in
      *wrangler-preview.jsonc) echo preview >> "$TEST_TRACE" ;;
      *wrangler.jsonc) echo hub >> "$TEST_TRACE" ;;
      *) exit 99 ;;
    esac
    ;;
  "vitest run --project") echo smoke >> "$TEST_TRACE" ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(template, 'build-template.sh'),
      '#!/bin/sh\necho template >> "$TEST_TRACE"\n'
    );
    const result = spawnSync('bash', [releaseScript], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        RUNNER_TEMP: cwd,
        TEST_TRACE: trace,
        TEST_GATE: gate,
        TEST_ARCHIVE_STATUS: String(archiveStatus),
        TEST_LIFECYCLE_STATUS: String(lifecycleStatus),
        CLOUDFLARE_TURN_API_TOKEN: 'test-only',
        GITHUB_CLIENT_SECRET: 'test-only',
        E2B_API_KEY: 'test-only',
        APNS_PRIVATE_KEY: '',
      },
    });
    if (result.error) throw result.error;
    return { status: result.status, events: readFileSync(trace, 'utf8').trim().split('\n') };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('production worker release ordering', () => {
  it('archives skipped releases without depending on lifecycle API availability', () => {
    expect(release('skip', 0, 1)).toEqual({ status: 0, events: ['gate', 'archive'] });
  });

  it('archives before the lifecycle gate and gates every secret and both deployments', () => {
    expect(release('deploy')).toEqual({
      status: 0,
      events: [
        'gate',
        'template',
        'archive',
        'lifecycle',
        'secret',
        'secret',
        'secret',
        'hub',
        'preview',
        'smoke',
      ],
    });
  });

  it('does not mutate secrets or deploy when the lifecycle prerequisite fails', () => {
    expect(release('deploy', 0, 1)).toEqual({
      status: 1,
      events: ['gate', 'template', 'archive', 'lifecycle'],
    });
  });

  it.each(['skip', 'deploy'] as const)('preserves archive failure as a hard stop on %s', (gate) => {
    expect(release(gate, 1)).toEqual({
      status: 1,
      events: gate === 'skip' ? ['gate', 'archive'] : ['gate', 'template', 'archive'],
    });
  });
});
