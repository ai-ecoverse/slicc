/**
 * Element interaction subcommands: click, type, fill, press, keydown, keyup,
 * dblclick, hover, select, check, uncheck, drag.
 */

import { keyEventParams, pressKeyParams } from '../keyboard.js';
import {
  callOnElement,
  requireTabSnapshot,
  requireTopFrameRef,
  resolveSnapshotRef,
} from '../snapshot.js';
import {
  CLEAR_FOCUSABLE_ELEMENT_FUNCTION,
  REACT_FILL_FALLBACK_FUNCTION,
  READ_INPUT_VALUE_FUNCTION,
  requireTab,
} from '../state.js';
import type { PlaywrightHandler, TabHandle } from '../types.js';

/** Parse --modifiers flag (comma-separated) into a CDP bitmask. Alt=1, Control=2, Meta=4, Shift=8. */
function parseModifiersBitmask(modifiersFlag: string | undefined): number {
  if (!modifiersFlag) return 0;
  const MAP: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  return modifiersFlag
    .split(',')
    .map((m) => MAP[m.trim()] ?? 0)
    .reduce((acc, v) => acc | v, 0);
}

/** Send Enter keyDown+keyUp via CDP (used by --submit on type/fill). */
async function sendEnterKey(page: TabHandle): Promise<void> {
  const [keyDown, keyUp] = pressKeyParams('Enter');
  await page.send('Input.dispatchKeyEvent', keyDown);
  await page.send('Input.dispatchKeyEvent', keyUp);
}

/** Verify the filled value and apply React native-setter fallback if needed (backendNodeId path). */
async function verifyFillAndApplyFallback(
  page: TabHandle,
  objectId: string,
  fillText: string
): Promise<void> {
  const readResult = await page.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: READ_INPUT_VALUE_FUNCTION,
    returnByValue: true,
  });
  const currentValue = (readResult['result'] as { value?: string })?.value ?? '';
  if (currentValue !== fillText) {
    await page.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: REACT_FILL_FALLBACK_FUNCTION,
      arguments: [{ value: fillText }],
      returnByValue: true,
    });
  }
}

/** Fill a resolved element: click to focus, clear, insertText, verify+fallback. */
async function fillElement(
  page: TabHandle,
  target: { backendNodeId: number; objectId: string },
  fillText: string
): Promise<void> {
  await page.clickByBackendNodeId(target.backendNodeId);
  await page.send('Runtime.callFunctionOn', {
    objectId: target.objectId,
    functionDeclaration: CLEAR_FOCUSABLE_ELEMENT_FUNCTION,
    returnByValue: true,
  });
  // Single Input.insertText frame so the per-frame whole-token
  // unmask gate in the node-server CDP proxy can replace a
  // masked secret with its real value (a per-character
  // Input.dispatchKeyEvent loop fragments the token).
  await page.insertText(fillText);
  await verifyFillAndApplyFallback(page, target.objectId, fillText);
}

export const clickHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'click requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const modifiers = parseModifiersBitmask(flags['modifiers']);
  const output = await onTab(tab.targetId, async (page) => {
    const snapshot = requireTabSnapshot(state, tab.targetId);
    const target = await resolveSnapshotRef(page, snapshot, ref);
    if (target.entry.frameId) {
      await callOnElement(
        page,
        target.objectId,
        `function() {
          this.scrollIntoView({ block: 'center' });
          this.click();
        }`
      );
      state.snapshots.delete(tab.targetId);
      return `Clicked ${ref} (in iframe)`;
    }
    await page.clickByBackendNodeId(target.backendNodeId, modifiers);
    state.snapshots.delete(tab.targetId);
    return `Clicked ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const typeHandler: PlaywrightHandler = async ({ browser, positional, flags, onTab }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'type requires text\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const text = positional.join(' ');
  await onTab(tab.targetId, async (page) => {
    await page.type(text);
    if (flags['submit'] === 'true') await sendEnterKey(page);
  });
  return { stdout: `Typed: ${text}\n`, stderr: '', exitCode: 0 };
};

export const fillHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'fill requires <ref> <text>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const fillText = positional.slice(1).join(' ');
  const output = await onTab(tab.targetId, async (page) => {
    const snapshot = requireTabSnapshot(state, tab.targetId);
    const target = await resolveSnapshotRef(page, snapshot, ref);
    if (target.entry.frameId) {
      await callOnElement(
        page,
        target.objectId,
        `function(text) {
          this.scrollIntoView({ block: 'center' });
          this.focus();
          this.value = '';
          this.value = text;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        [fillText]
      );
      state.snapshots.delete(tab.targetId);
      if (flags['submit'] === 'true') await sendEnterKey(page);
      return `Filled ${ref} with: ${fillText} (in iframe)`;
    }
    await fillElement(page, target, fillText);
    state.snapshots.delete(tab.targetId);
    if (flags['submit'] === 'true') await sendEnterKey(page);
    return `Filled ${ref} with: ${fillText}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const pressHandler: PlaywrightHandler = async ({ browser, positional, flags, onTab }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'press requires a key name\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const key = positional[0];
  const [keyDown, keyUp] = pressKeyParams(key);
  await onTab(tab.targetId, async ({ sessionId, transport }) => {
    await transport.send('Input.dispatchKeyEvent', keyDown, sessionId);
    await transport.send('Input.dispatchKeyEvent', keyUp, sessionId);
  });
  return { stdout: `Pressed ${key}\n`, stderr: '', exitCode: 0 };
};

export const keydownHandler: PlaywrightHandler = async ({ browser, positional, flags, onTab }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'keydown requires a key name\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const key = positional[0];
  const params = keyEventParams(key, 'keyDown');
  await onTab(tab.targetId, async ({ sessionId, transport }) => {
    await transport.send('Input.dispatchKeyEvent', params, sessionId);
  });
  return { stdout: `Key ${key} down\n`, stderr: '', exitCode: 0 };
};

export const keyupHandler: PlaywrightHandler = async ({ browser, positional, flags, onTab }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'keyup requires a key name\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const key = positional[0];
  const params = keyEventParams(key, 'keyUp');
  await onTab(tab.targetId, async ({ sessionId, transport }) => {
    await transport.send('Input.dispatchKeyEvent', params, sessionId);
  });
  return { stdout: `Key ${key} up\n`, stderr: '', exitCode: 0 };
};

export const dblclickHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'dblclick requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const button = (positional[1] || 'left') as 'left' | 'right' | 'middle';
  const modifiers = parseModifiersBitmask(flags['modifiers']);
  const output = await onTab(tab.targetId, async (page) => {
    const snapshot = requireTabSnapshot(state, tab.targetId);
    const target = await resolveSnapshotRef(page, snapshot, ref);
    if (target.entry.frameId) {
      await callOnElement(
        page,
        target.objectId,
        `function() {
          this.scrollIntoView({ block: 'center' });
          this.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        }`
      );
      state.snapshots.delete(tab.targetId);
      return `Double-clicked ${ref} (in iframe)`;
    }
    await page.dblclickByBackendNodeId(target.backendNodeId, button, modifiers);
    state.snapshots.delete(tab.targetId);
    return `Double-clicked ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const hoverHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'hover requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const output = await onTab(tab.targetId, async (page) => {
    const snapshot = requireTabSnapshot(state, tab.targetId);
    const target = await resolveSnapshotRef(page, snapshot, ref);
    if (target.entry.frameId) {
      await callOnElement(
        page,
        target.objectId,
        `function() {
          this.scrollIntoView({ block: 'center' });
          this.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        }`
      );
      return `Hovered ${ref} (in iframe)`;
    }
    await page.hoverByBackendNodeId(target.backendNodeId);
    return `Hovered ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const selectHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'select requires <ref> <value>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const value = positional.slice(1).join(' ');
  const output = await onTab(tab.targetId, async (page) => {
    const snapshot = requireTabSnapshot(state, tab.targetId);
    const target = await resolveSnapshotRef(page, snapshot, ref);
    if (target.entry.frameId) {
      await callOnElement(
        page,
        target.objectId,
        `function(value) {
          this.value = value;
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        [value]
      );
      state.snapshots.delete(tab.targetId);
      return `Selected "${value}" on ${ref} (in iframe)`;
    }
    await page.selectByBackendNodeId(target.backendNodeId, value);
    state.snapshots.delete(tab.targetId);
    return `Selected "${value}" on ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

/** In-frame check/uncheck: flip `checked` and fire the events a user toggle would. */
const SET_CHECKED_IN_FRAME_FUNCTION = `function(checked) {
  if (this.checked === checked) return 'already';
  this.checked = checked;
  this.dispatchEvent(new Event('change', { bubbles: true }));
  this.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'toggled';
}`;

/** Shared body of check/uncheck. */
function setCheckedHandler(checked: boolean): PlaywrightHandler {
  const verb = checked ? 'check' : 'uncheck';
  const past = checked ? 'Checked' : 'Unchecked';
  return async ({ state, positional, flags, onTab }) => {
    if (positional.length === 0) {
      return { stdout: '', stderr: `${verb} requires a ref (e.g. e5)\n`, exitCode: 1 };
    }
    const tab = requireTab(flags);
    if ('error' in tab) {
      return { stdout: '', stderr: tab.error, exitCode: 1 };
    }
    const ref = positional[0];
    const output = await onTab(tab.targetId, async (page) => {
      const snapshot = requireTabSnapshot(state, tab.targetId);
      const target = await resolveSnapshotRef(page, snapshot, ref);
      const inFrame = Boolean(target.entry.frameId);
      const action = inFrame
        ? await callOnElement(page, target.objectId, SET_CHECKED_IN_FRAME_FUNCTION, [checked])
        : await page.setCheckedByBackendNodeId(target.backendNodeId, checked);
      if (action === 'already') return `${ref} already ${past.toLowerCase()}`;
      state.snapshots.delete(tab.targetId);
      return inFrame ? `${past} ${ref} (in iframe)` : `${past} ${ref}`;
    });
    return { stdout: output + '\n', stderr: '', exitCode: 0 };
  };
}

export const checkHandler: PlaywrightHandler = setCheckedHandler(true);

export const uncheckHandler: PlaywrightHandler = setCheckedHandler(false);

export const dragHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'drag requires <startRef> <endRef>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const startRef = positional[0];
  const endRef = positional[1];
  const output = await onTab(tab.targetId, async (page) => {
    const snapshot = requireTabSnapshot(state, tab.targetId);
    const start = await resolveSnapshotRef(page, snapshot, startRef);
    requireTopFrameRef(start.entry, startRef, 'drag');
    const end = await resolveSnapshotRef(page, snapshot, endRef);
    requireTopFrameRef(end.entry, endRef, 'drag');
    await page.dragByBackendNodeIds(start.backendNodeId, end.backendNodeId);
    state.snapshots.delete(tab.targetId);
    return `Dragged ${startRef} to ${endRef}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};
