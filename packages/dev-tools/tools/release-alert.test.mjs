import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  alertOnRedRelease,
  closeOnGreenRelease,
  failBody,
  main,
  pickTrackingIssues,
  RED_RELEASE_TITLE,
  recoverBody,
} from './release-alert.mjs';

const CONTEXT = {
  repo: 'ai-ecoverse/slicc',
  runUrl: 'https://github.com/ai-ecoverse/slicc/actions/runs/1',
  sha: 'abc123',
};

function recordingGh(replies) {
  const calls = [];
  const runGh = vi.fn((args) => {
    calls.push(args);
    const key = args[1];
    if (typeof replies[key] === 'function') return replies[key](args);
    if (replies[key] !== undefined) return replies[key];
    return '';
  });
  return { runGh, calls };
}

describe('pickTrackingIssues', () => {
  it('keeps only exact-title matches', () => {
    expect(
      pickTrackingIssues(
        JSON.stringify([
          { number: 3340, title: RED_RELEASE_TITLE },
          { number: 1, title: 'Release pipeline is reddish' },
          { number: 2, title: RED_RELEASE_TITLE },
        ])
      )
    ).toEqual([3340, 2]);
  });

  it('returns an empty list for malformed JSON', () => {
    expect(pickTrackingIssues('not-json')).toEqual([]);
    expect(pickTrackingIssues('{}')).toEqual([]);
  });
});

describe('alertOnRedRelease', () => {
  it('comments on the existing tracking issue', async () => {
    const { runGh, calls } = recordingGh({
      list: JSON.stringify([{ number: 3340, title: RED_RELEASE_TITLE }]),
    });
    await expect(alertOnRedRelease({ ...CONTEXT, runGh })).resolves.toEqual({
      action: 'comment',
      number: 3340,
    });
    expect(calls[1]).toEqual([
      'issue',
      'comment',
      '3340',
      '--repo',
      CONTEXT.repo,
      '--body',
      failBody(CONTEXT),
    ]);
  });

  it('creates the tracking issue when none is open', async () => {
    const { runGh, calls } = recordingGh({ list: '[]' });
    await expect(alertOnRedRelease({ ...CONTEXT, runGh })).resolves.toEqual({ action: 'create' });
    expect(calls[1]).toEqual([
      'issue',
      'create',
      '--repo',
      CONTEXT.repo,
      '--title',
      RED_RELEASE_TITLE,
      '--body',
      failBody(CONTEXT),
      '--label',
      'bug',
    ]);
  });
});

describe('closeOnGreenRelease', () => {
  it('closes every exact-title tracking issue with a completed comment', async () => {
    const { runGh, calls } = recordingGh({
      list: JSON.stringify([
        { number: 3340, title: RED_RELEASE_TITLE },
        { number: 4000, title: RED_RELEASE_TITLE },
      ]),
    });
    await expect(closeOnGreenRelease({ ...CONTEXT, runGh })).resolves.toEqual({
      action: 'close',
      numbers: [3340, 4000],
    });
    expect(calls.filter((args) => args[1] === 'close')).toEqual([
      [
        'issue',
        'close',
        '3340',
        '--repo',
        CONTEXT.repo,
        '--reason',
        'completed',
        '--comment',
        recoverBody(CONTEXT),
      ],
      [
        'issue',
        'close',
        '4000',
        '--repo',
        CONTEXT.repo,
        '--reason',
        'completed',
        '--comment',
        recoverBody(CONTEXT),
      ],
    ]);
  });

  it('is a no-op when no tracking issue is open', async () => {
    const { runGh, calls } = recordingGh({ list: '[]' });
    await expect(closeOnGreenRelease({ ...CONTEXT, runGh })).resolves.toEqual({
      action: 'none',
      numbers: [],
    });
    expect(calls.filter((args) => args[1] === 'close')).toEqual([]);
  });
});

describe('main', () => {
  const env = {
    GH_TOKEN: 'token',
    GITHUB_REPOSITORY: CONTEXT.repo,
    RELEASE_RUN_URL: CONTEXT.runUrl,
    RELEASE_SHA: CONTEXT.sha,
  };

  it('routes fail and recover', async () => {
    const { runGh } = recordingGh({ list: '[]' });
    await expect(main(['fail'], { env, runGh })).resolves.toEqual({ action: 'create' });
    await expect(main(['recover'], { env, runGh })).resolves.toEqual({
      action: 'none',
      numbers: [],
    });
  });

  it('rejects an unknown action', async () => {
    await expect(main(['noop'], { env, runGh: vi.fn() })).rejects.toThrow(/usage/);
  });
});

describe('release workflow', () => {
  it('opens the tracking issue on failure and closes it after a non-deferred publish', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/release.yml', import.meta.url),
      'utf8'
    );
    expect(workflow).toContain('id: publish');
    expect(workflow).toContain('node packages/dev-tools/tools/release-alert.mjs fail');
    expect(workflow).toContain('node packages/dev-tools/tools/release-alert.mjs recover');
    expect(workflow).toContain("steps.publish.outputs.deferred != 'true'");
    expect(workflow).toContain('Checkout never produced a worktree');
  });
});
