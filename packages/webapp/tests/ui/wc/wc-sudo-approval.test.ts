// @vitest-environment jsdom

/**
 * In-page sudo approval dialog (#2062) — the page-realm prompt shared by a
 * leader with no native modal and by web followers rendering a delegated
 * prompt. Ported from the retired transcript-export approval dialog tests.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSudoApprovalDialog } from '../../../src/ui/wc/wc-sudo-approval.js';

describe('openSudoApprovalDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const dialog = (): HTMLElement | null => document.querySelector('slicc-dialog');
  const button = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll('button')].find((b) => b.textContent === label);

  it('resolves allow on "Allow" and removes the dialog', async () => {
    const promise = openSudoApprovalDialog({ kind: 'command', detail: 'git push origin main' });
    expect(dialog()?.getAttribute('heading')).toBe('Run command?');
    button('Allow')?.click();
    expect(await promise).toEqual({ decision: 'allow', attestation: 'none' });
    expect(dialog()).toBeNull();
  });

  it('resolves deny on "Deny"', async () => {
    const promise = openSudoApprovalDialog({ kind: 'write', detail: '/workspace/.git/config' });
    button('Deny')?.click();
    expect(await promise).toEqual({ decision: 'deny' });
  });

  it('withholds "Always" unless allowAlways is set (web followers cannot widen policy)', async () => {
    const promise = openSudoApprovalDialog({ kind: 'command', detail: 'rm -rf build' });
    expect(button('Always')).toBeUndefined();
    button('Deny')?.click();
    await promise;
  });

  it('offers an editable pattern for "Always" and keeps the suggestion on an empty edit', async () => {
    const req = {
      kind: 'command' as const,
      detail: 'git push origin main',
      suggestedPattern: 'git push *',
    };
    let promise = openSudoApprovalDialog(req, { allowAlways: true });
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Always allow pattern"]'
    );
    expect(input?.value).toBe('git push *');
    if (input) input.value = 'git push origin *';
    button('Always')?.click();
    expect(await promise).toEqual({
      decision: 'always',
      pattern: 'git push origin *',
      attestation: 'none',
    });

    promise = openSudoApprovalDialog(req, { allowAlways: true });
    const again = document.querySelector<HTMLInputElement>(
      'input[aria-label="Always allow pattern"]'
    );
    if (again) again.value = '   ';
    button('Always')?.click();
    expect(await promise).toMatchObject({ decision: 'always', pattern: 'git push *' });
  });

  it('closes and denies when the signal aborts (leader cancel / timeout)', async () => {
    const controller = new AbortController();
    const promise = openSudoApprovalDialog(
      { kind: 'export', detail: 'active' },
      { signal: controller.signal }
    );
    expect(dialog()).not.toBeNull();
    controller.abort();
    expect(await promise).toEqual({ decision: 'deny' });
    expect(dialog()).toBeNull();
  });

  it('never opens a dialog for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = openSudoApprovalDialog(
      { kind: 'read', detail: '/shared/secrets/x' },
      { signal: controller.signal }
    );
    expect(await promise).toEqual({ decision: 'deny' });
    expect(dialog()).toBeNull();
  });

  it('ignores a late click after an abort', async () => {
    const controller = new AbortController();
    const promise = openSudoApprovalDialog(
      { kind: 'command', detail: 'npm publish' },
      { signal: controller.signal }
    );
    const allow = button('Allow');
    controller.abort();
    allow?.click();
    expect(await promise).toEqual({ decision: 'deny' });
  });

  it('describes export subjects and names the requester', async () => {
    const promise = openSudoApprovalDialog(
      { kind: 'export', detail: 'frozen:sess-42' },
      { requester: 'Chrome follower' }
    );
    const text = document.body.textContent ?? '';
    expect(dialog()?.getAttribute('heading')).toBe('Export transcript?');
    expect(text).toContain('Archived session (sess-42)');
    expect(text).toContain('Chrome follower');
    button('Deny')?.click();
    await promise;
  });
});
