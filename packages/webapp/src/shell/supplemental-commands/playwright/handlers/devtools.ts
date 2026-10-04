/**
 * Developer tools subcommands: generate-locator, highlight.
 */

import { callOnElement, requireSnapshotRef, resolveSnapshotRef } from '../snapshot.js';
import { requireTab } from '../state.js';
import type { CmdResult, PlaywrightHandler, TabSnapshot } from '../types.js';

/** The "unknown ref" result for a ref the snapshot never printed, before taking a tab hold. */
function unknownRefResult(snapshot: TabSnapshot, ref: string): CmdResult | null {
  try {
    requireSnapshotRef(snapshot, ref);
    return null;
  } catch (err) {
    return { stdout: '', stderr: `${(err as Error).message}\n`, exitCode: 1 };
  }
}

export const generateLocatorHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'generate-locator requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const ref = positional[0];
  const snapshot = state.snapshots.get(tab.targetId);
  if (!snapshot) {
    return {
      stdout: '',
      stderr: 'No snapshot available. Run "snapshot" first.\n',
      exitCode: 1,
    };
  }
  const unknown = unknownRefResult(snapshot, ref);
  if (unknown) return unknown;

  const locator = await onTab(tab.targetId, async (page) => {
    const { objectId, entry } = await resolveSnapshotRef(page, snapshot, ref);
    const props = JSON.parse(
      ((await callOnElement(
        page,
        objectId,
        `function() {
          const el = this;
          const testId = el.getAttribute('data-testid');
          const label =
            el.getAttribute('aria-label') ||
            (el.labels && el.labels[0] ? el.labels[0].textContent.trim() : null);
          const placeholder = el.getAttribute('placeholder');
          const id = el.id;
          return JSON.stringify({ testId, label, placeholder, id });
        }`
      )) as string | undefined) ?? '{}'
    ) as { testId?: string; label?: string; placeholder?: string; id?: string };

    // Priority: testId > label > placeholder > id > role + accessible name.
    if (props.testId) return `page.getByTestId(${JSON.stringify(props.testId)})`;
    if (props.label) return `page.getByLabel(${JSON.stringify(props.label)})`;
    if (props.placeholder) return `page.getByPlaceholder(${JSON.stringify(props.placeholder)})`;
    if (props.id) return `page.locator(${JSON.stringify(`#${props.id}`)})`;
    return entry.name
      ? `page.getByRole(${JSON.stringify(entry.role)}, { name: ${JSON.stringify(entry.name)} })`
      : `page.getByRole(${JSON.stringify(entry.role)})`;
  });

  return { stdout: locator + '\n', stderr: '', exitCode: 0 };
};

export const highlightHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const hide = flags['hide'] === 'true';
  const style = flags['style'] ?? 'outline: 3px solid #ff4444; background: rgba(255, 68, 68, 0.1);';

  if (hide && !positional[0]) {
    // Remove all highlights
    await onTab(tab.targetId, async ({ sessionId, transport }) => {
      await transport.send(
        'Runtime.evaluate',
        {
          expression: `document.querySelectorAll('[data-slicc-highlight]').forEach(el => {
            el.style.outline = '';
            el.style.background = '';
            el.removeAttribute('data-slicc-highlight');
          })`,
          returnByValue: true,
        },
        sessionId
      );
    });
    return { stdout: 'All highlights removed\n', stderr: '', exitCode: 0 };
  }

  if (!positional[0]) {
    return {
      stdout: '',
      stderr: 'highlight requires a ref, or use --hide to remove all\n',
      exitCode: 1,
    };
  }

  const ref = positional[0];
  const snapshot = state.snapshots.get(tab.targetId);
  if (!snapshot) {
    return {
      stdout: '',
      stderr: 'No snapshot available. Run "snapshot" first.\n',
      exitCode: 1,
    };
  }
  const unknown = unknownRefResult(snapshot, ref);
  if (unknown) return unknown;

  await onTab(tab.targetId, async (page) => {
    const { objectId } = await resolveSnapshotRef(page, snapshot, ref);
    await callOnElement(
      page,
      objectId,
      hide
        ? `function() {
            this.style.outline = '';
            this.style.background = '';
            this.removeAttribute('data-slicc-highlight');
          }`
        : `function(s) {
            this.style.cssText += '; ' + s;
            this.setAttribute('data-slicc-highlight', '1');
          }`,
      hide ? [] : [style]
    );
  });

  return {
    stdout: hide ? `Highlight removed from ${ref}\n` : `Highlighted ${ref}\n`,
    stderr: '',
    exitCode: 0,
  };
};
