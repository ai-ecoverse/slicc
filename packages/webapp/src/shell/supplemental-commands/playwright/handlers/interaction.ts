/**
 * Element interaction subcommands: click, type, fill, press, dblclick, hover,
 * select, check, uncheck, drag.
 */

import {
  CLEAR_FOCUSABLE_ELEMENT_FUNCTION,
  parseRef,
  REACT_FILL_FALLBACK_FUNCTION,
  READ_INPUT_VALUE_FUNCTION,
  requireTab,
} from '../state.js';
import type { PlaywrightHandler } from '../types.js';

export const clickHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'click requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const output = await browser.withTab(tab.targetId, async () => {
    const snapshot = state.snapshots.get(tab.targetId);
    if (!snapshot) {
      throw new Error('No snapshot available. Run "snapshot" first.');
    }

    // Handle iframe-routed clicks
    const { isIframe } = parseRef(ref);
    const frameId = snapshot.refToFrameId?.get(ref);
    if (isIframe && frameId) {
      const selector = snapshot.refToSelector.get(ref);
      if (!selector) throw new Error(`Unknown ref "${ref}" in iframe`);
      const firstSelector = selector.split(',')[0].trim();
      await browser.evaluateInFrame(
        frameId,
        `(function() {
                  var el = document.querySelector(${JSON.stringify(firstSelector)});
                  if (!el) throw new Error('Element not found in iframe for ref ${ref}');
                  el.scrollIntoView({ block: 'center' });
                  el.click();
                })()`
      );
      state.snapshots.delete(tab.targetId);
      return `Clicked ${ref} (in iframe)`;
    }

    // Prefer backendNodeId for reliable clicking
    const backendNodeId = snapshot.refToBackendNodeId.get(ref);
    if (backendNodeId) {
      await browser.clickByBackendNodeId(backendNodeId);
      state.snapshots.delete(tab.targetId);
      return `Clicked ${ref}`;
    }

    // Fall back to CSS selector
    const selector = snapshot.refToSelector.get(ref);
    if (!selector) {
      throw new Error(
        `Unknown ref "${ref}". Available: ${[...snapshot.refToSelector.keys()].slice(0, 10).join(', ')}...`
      );
    }
    await browser.click(selector);
    state.snapshots.delete(tab.targetId);
    return `Clicked ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const typeHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'type requires text\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const text = positional.join(' ');
  await browser.withTab(tab.targetId, async () => {
    await browser.type(text);
  });
  return { stdout: `Typed: ${text}\n`, stderr: '', exitCode: 0 };
};

export const fillHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'fill requires <ref> <text>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const fillText = positional.slice(1).join(' ');
  const output = await browser.withTab(tab.targetId, async () => {
    const snapshot = state.snapshots.get(tab.targetId);
    if (!snapshot) {
      throw new Error('No snapshot available. Run "snapshot" first.');
    }

    // Handle iframe-routed fill
    const { isIframe: isFillIframe } = parseRef(ref);
    const fillFrameId = snapshot.refToFrameId?.get(ref);
    if (isFillIframe && fillFrameId) {
      const selector = snapshot.refToSelector.get(ref);
      if (!selector) throw new Error(`Unknown ref "${ref}" in iframe`);
      const firstSelector = selector.split(',')[0].trim();
      await browser.evaluateInFrame(
        fillFrameId,
        `(function() {
                  var el = document.querySelector(${JSON.stringify(firstSelector)});
                  if (!el) throw new Error('Element not found in iframe for ref ${ref}');
                  el.scrollIntoView({ block: 'center' });
                  el.focus();
                  el.value = '';
                  el.value = ${JSON.stringify(fillText)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                })()`
      );
      state.snapshots.delete(tab.targetId);
      return `Filled ${ref} with: ${fillText} (in iframe)`;
    }

    // Prefer backendNodeId for reliable element targeting
    const backendNodeId = snapshot.refToBackendNodeId.get(ref);
    if (backendNodeId) {
      // Click to focus, then clear and type
      await browser.clickByBackendNodeId(backendNodeId);
      // Clear via DOM using resolved node
      const transport = browser.getTransport();
      const sessionId = browser.getSessionId();
      await transport.send('DOM.enable', {}, sessionId!);
      await transport.send('Runtime.enable', {}, sessionId!);
      const resolveResult = await transport.send('DOM.resolveNode', { backendNodeId }, sessionId!);
      const obj = resolveResult['object'] as { objectId?: string } | undefined;
      if (obj?.objectId) {
        await transport.send(
          'Runtime.callFunctionOn',
          {
            objectId: obj.objectId,
            functionDeclaration: CLEAR_FOCUSABLE_ELEMENT_FUNCTION,
            returnByValue: true,
          },
          sessionId!
        );
      }
      // Single Input.insertText frame so the per-frame whole-token
      // unmask gate in the node-server CDP proxy can replace a
      // masked secret with its real value (a per-character
      // Input.dispatchKeyEvent loop fragments the token).
      await browser.insertText(fillText);
      // Verify value and use native setter fallback for React-controlled inputs
      if (obj?.objectId) {
        const readResult = await transport.send(
          'Runtime.callFunctionOn',
          {
            objectId: obj.objectId,
            functionDeclaration: READ_INPUT_VALUE_FUNCTION,
            returnByValue: true,
          },
          sessionId!
        );
        const currentValue = (readResult['result'] as { value?: string })?.value ?? '';
        if (currentValue !== fillText) {
          await transport.send(
            'Runtime.callFunctionOn',
            {
              objectId: obj.objectId,
              functionDeclaration: REACT_FILL_FALLBACK_FUNCTION,
              arguments: [{ value: fillText }],
              returnByValue: true,
            },
            sessionId!
          );
        }
      }
      state.snapshots.delete(tab.targetId);
      return `Filled ${ref} with: ${fillText}`;
    }

    // Fall back to CSS selector
    const selector = snapshot.refToSelector.get(ref);
    if (!selector) {
      throw new Error(`Unknown ref "${ref}"`);
    }
    await browser.click(selector);
    await browser.evaluate(
      `(function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (el) {
                  return (${CLEAR_FOCUSABLE_ELEMENT_FUNCTION}).call(el);
                }
                return false;
              })()`
    );
    // Single Input.insertText frame so the per-frame whole-token
    // unmask gate in the node-server CDP proxy can replace a
    // masked secret with its real value (a per-character
    // Input.dispatchKeyEvent loop fragments the token).
    await browser.insertText(fillText);
    // Verify value and use native setter fallback for React-controlled inputs
    {
      const currentValue = (await browser.evaluate(
        `(function() {
                  const el = document.querySelector(${JSON.stringify(selector.split(',')[0].trim())});
                  if (!el) return '';
                  return (${READ_INPUT_VALUE_FUNCTION}).call(el);
                })()`
      )) as string;
      if (currentValue !== fillText) {
        await browser.evaluate(
          `(function() {
                    const el = document.querySelector(${JSON.stringify(selector.split(',')[0].trim())});
                    if (!el) return;
                    (${REACT_FILL_FALLBACK_FUNCTION}).call(el, ${JSON.stringify(fillText)});
                  })()`
        );
      }
    }
    state.snapshots.delete(tab.targetId);
    return `Filled ${ref} with: ${fillText}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const pressHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'press requires a key name\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const key = positional[0];
  await browser.withTab(tab.targetId, async () => {
    // Use CDP Input.dispatchKeyEvent
    const transport = browser.getTransport();
    const sessionId = browser.getSessionId();
    await transport.send('Input.dispatchKeyEvent', { type: 'keyDown', key }, sessionId!);
    await transport.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, sessionId!);
  });
  return { stdout: `Pressed ${key}\n`, stderr: '', exitCode: 0 };
};

export const keydownHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'keydown requires a key name\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const key = positional[0];
  await browser.withTab(tab.targetId, async () => {
    const transport = browser.getTransport();
    const sessionId = browser.getSessionId();
    await transport.send('Input.dispatchKeyEvent', { type: 'keyDown', key }, sessionId!);
  });
  return { stdout: `Key ${key} down\n`, stderr: '', exitCode: 0 };
};

export const keyupHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'keyup requires a key name\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const key = positional[0];
  await browser.withTab(tab.targetId, async () => {
    const transport = browser.getTransport();
    const sessionId = browser.getSessionId();
    await transport.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, sessionId!);
  });
  return { stdout: `Key ${key} up\n`, stderr: '', exitCode: 0 };
};

export const dblclickHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'dblclick requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const button = (positional[1] || 'left') as 'left' | 'right' | 'middle';
  const output = await browser.withTab(tab.targetId, async () => {
    const snapshot = state.snapshots.get(tab.targetId);
    if (!snapshot) {
      throw new Error('No snapshot available. Run "snapshot" first.');
    }

    // Handle iframe-routed dblclick
    const { isIframe: isDblIframe } = parseRef(ref);
    const dblFrameId = snapshot.refToFrameId?.get(ref);
    if (isDblIframe && dblFrameId) {
      const selector = snapshot.refToSelector.get(ref);
      if (!selector) throw new Error(`Unknown ref "${ref}" in iframe`);
      const firstSelector = selector.split(',')[0].trim();
      await browser.evaluateInFrame(
        dblFrameId,
        `(function() {
                  var el = document.querySelector(${JSON.stringify(firstSelector)});
                  if (!el) throw new Error('Element not found in iframe for ref ${ref}');
                  el.scrollIntoView({ block: 'center' });
                  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                })()`
      );
      state.snapshots.delete(tab.targetId);
      return `Double-clicked ${ref} (in iframe)`;
    }

    const backendNodeId = snapshot.refToBackendNodeId.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown ref "${ref}"`);
    }
    await browser.dblclickByBackendNodeId(backendNodeId, button);
    state.snapshots.delete(tab.targetId);
    return `Double-clicked ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const hoverHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'hover requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const output = await browser.withTab(tab.targetId, async () => {
    const snapshot = state.snapshots.get(tab.targetId);
    if (!snapshot) {
      throw new Error('No snapshot available. Run "snapshot" first.');
    }

    // Handle iframe-routed hover
    const { isIframe: isHoverIframe } = parseRef(ref);
    const hoverFrameId = snapshot.refToFrameId?.get(ref);
    if (isHoverIframe && hoverFrameId) {
      const selector = snapshot.refToSelector.get(ref);
      if (!selector) throw new Error(`Unknown ref "${ref}" in iframe`);
      const firstSelector = selector.split(',')[0].trim();
      await browser.evaluateInFrame(
        hoverFrameId,
        `(function() {
                  var el = document.querySelector(${JSON.stringify(firstSelector)});
                  if (!el) throw new Error('Element not found in iframe for ref ${ref}');
                  el.scrollIntoView({ block: 'center' });
                  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                })()`
      );
      return `Hovered ${ref} (in iframe)`;
    }

    const backendNodeId = snapshot.refToBackendNodeId.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown ref "${ref}"`);
    }
    await browser.hoverByBackendNodeId(backendNodeId);
    return `Hovered ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const selectHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'select requires <ref> <value>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const value = positional.slice(1).join(' ');
  const output = await browser.withTab(tab.targetId, async () => {
    const snapshot = state.snapshots.get(tab.targetId);
    if (!snapshot) {
      throw new Error('No snapshot available. Run "snapshot" first.');
    }

    // Handle iframe-routed select
    const { isIframe: isSelectIframe } = parseRef(ref);
    const selectFrameId = snapshot.refToFrameId?.get(ref);
    if (isSelectIframe && selectFrameId) {
      const selector = snapshot.refToSelector.get(ref);
      if (!selector) throw new Error(`Unknown ref "${ref}" in iframe`);
      const firstSelector = selector.split(',')[0].trim();
      await browser.evaluateInFrame(
        selectFrameId,
        `(function() {
                  var el = document.querySelector(${JSON.stringify(firstSelector)});
                  if (!el) throw new Error('Element not found in iframe for ref ${ref}');
                  el.value = ${JSON.stringify(value)};
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                })()`
      );
      state.snapshots.delete(tab.targetId);
      return `Selected "${value}" on ${ref} (in iframe)`;
    }

    const backendNodeId = snapshot.refToBackendNodeId.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown ref "${ref}"`);
    }
    await browser.selectByBackendNodeId(backendNodeId, value);
    state.snapshots.delete(tab.targetId);
    return `Selected "${value}" on ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const checkHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'check requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const output = await browser.withTab(tab.targetId, async () => {
    const snapshot = state.snapshots.get(tab.targetId);
    if (!snapshot) {
      throw new Error('No snapshot available. Run "snapshot" first.');
    }

    // Handle iframe-routed check
    const { isIframe: isCheckIframe } = parseRef(ref);
    const checkFrameId = snapshot.refToFrameId?.get(ref);
    if (isCheckIframe && checkFrameId) {
      const selector = snapshot.refToSelector.get(ref);
      if (!selector) throw new Error(`Unknown ref "${ref}" in iframe`);
      const firstSelector = selector.split(',')[0].trim();
      await browser.evaluateInFrame(
        checkFrameId,
        `(function() {
                  var el = document.querySelector(${JSON.stringify(firstSelector)});
                  if (!el) throw new Error('Element not found in iframe for ref ${ref}');
                  if (!el.checked) {
                    el.checked = true;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  }
                })()`
      );
      state.snapshots.delete(tab.targetId);
      return `Checked ${ref} (in iframe)`;
    }

    const backendNodeId = snapshot.refToBackendNodeId.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown ref "${ref}"`);
    }
    const action = await browser.setCheckedByBackendNodeId(backendNodeId, true);
    if (action === 'toggled') state.snapshots.delete(tab.targetId);
    return action === 'already' ? `${ref} already checked` : `Checked ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const uncheckHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'uncheck requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const ref = positional[0];
  const output = await browser.withTab(tab.targetId, async () => {
    const snapshot = state.snapshots.get(tab.targetId);
    if (!snapshot) {
      throw new Error('No snapshot available. Run "snapshot" first.');
    }

    // Handle iframe-routed uncheck
    const { isIframe: isUncheckIframe } = parseRef(ref);
    const uncheckFrameId = snapshot.refToFrameId?.get(ref);
    if (isUncheckIframe && uncheckFrameId) {
      const selector = snapshot.refToSelector.get(ref);
      if (!selector) throw new Error(`Unknown ref "${ref}" in iframe`);
      const firstSelector = selector.split(',')[0].trim();
      await browser.evaluateInFrame(
        uncheckFrameId,
        `(function() {
                  var el = document.querySelector(${JSON.stringify(firstSelector)});
                  if (!el) throw new Error('Element not found in iframe for ref ${ref}');
                  if (el.checked) {
                    el.checked = false;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                  }
                })()`
      );
      state.snapshots.delete(tab.targetId);
      return `Unchecked ${ref} (in iframe)`;
    }

    const backendNodeId = snapshot.refToBackendNodeId.get(ref);
    if (!backendNodeId) {
      throw new Error(`Unknown ref "${ref}"`);
    }
    const action = await browser.setCheckedByBackendNodeId(backendNodeId, false);
    if (action === 'toggled') state.snapshots.delete(tab.targetId);
    return action === 'already' ? `${ref} already unchecked` : `Unchecked ${ref}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};

export const dragHandler: PlaywrightHandler = async ({ browser, state, positional, flags }) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'drag requires <startRef> <endRef>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }
  const startRef = positional[0];
  const endRef = positional[1];
  const output = await browser.withTab(tab.targetId, async () => {
    const snapshot = state.snapshots.get(tab.targetId);
    if (!snapshot) {
      throw new Error('No snapshot available. Run "snapshot" first.');
    }
    const startNode = snapshot.refToBackendNodeId.get(startRef);
    const endNode = snapshot.refToBackendNodeId.get(endRef);
    if (!startNode) {
      throw new Error(`Unknown ref "${startRef}"`);
    }
    if (!endNode) {
      throw new Error(`Unknown ref "${endRef}"`);
    }
    await browser.dragByBackendNodeIds(startNode, endNode);
    state.snapshots.delete(tab.targetId);
    return `Dragged ${startRef} to ${endRef}`;
  });
  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};
