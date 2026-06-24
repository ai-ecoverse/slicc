/**
 * Developer tools subcommands: generate-locator, highlight.
 */

import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

export const generateLocatorHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
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

  const backendNodeId = snapshot.refToBackendNodeId.get(ref);
  if (!backendNodeId) {
    const selector = snapshot.refToSelector.get(ref);
    if (!selector) {
      return { stdout: '', stderr: `Unknown ref "${ref}"\n`, exitCode: 1 };
    }
    // ponytail: CSS selector fallback — returns page.locator() with CSS selector
    return {
      stdout: `page.locator(${JSON.stringify(selector.split(',')[0].trim())})\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  let locator = '';
  await browser.withTab(tab.targetId, async (sessionId) => {
    const transport = browser.getTransport();
    await transport.send('DOM.enable', {}, sessionId);
    const resolveResult = await transport.send('DOM.resolveNode', { backendNodeId }, sessionId);
    const obj = resolveResult['object'] as { objectId?: string } | undefined;
    if (!obj?.objectId) {
      const selector = snapshot.refToSelector.get(ref)?.split(',')[0].trim() ?? '';
      locator = `page.locator(${JSON.stringify(selector)})`;
      return;
    }
    const callResult = await transport.send(
      'Runtime.callFunctionOn',
      {
        objectId: obj.objectId,
        functionDeclaration: `function() {
          const el = this;
          const testId = el.getAttribute('data-testid');
          const label =
            el.getAttribute('aria-label') ||
            (el.labels && el.labels[0] ? el.labels[0].textContent.trim() : null);
          const placeholder = el.getAttribute('placeholder');
          const id = el.id;
          return JSON.stringify({ testId, label, placeholder, id });
        }`,
        returnByValue: true,
      },
      sessionId
    );
    const props = JSON.parse((callResult['result'] as { value?: string })?.value ?? '{}') as {
      testId?: string;
      label?: string;
      placeholder?: string;
      id?: string;
    };

    if (props.testId) {
      locator = `page.getByTestId(${JSON.stringify(props.testId)})`;
    } else if (props.label) {
      locator = `page.getByLabel(${JSON.stringify(props.label)})`;
    } else if (props.placeholder) {
      locator = `page.getByPlaceholder(${JSON.stringify(props.placeholder)})`;
    } else if (props.id) {
      locator = `page.locator(${JSON.stringify(`#${props.id}`)})`;
    } else {
      const selector = snapshot.refToSelector.get(ref)?.split(',')[0].trim() ?? '';
      locator = `page.locator(${JSON.stringify(selector)})`;
    }
  });

  return { stdout: locator + '\n', stderr: '', exitCode: 0 };
};

export const highlightHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const hide = flags['hide'] === 'true';
  const style = flags['style'] ?? 'outline: 3px solid #ff4444; background: rgba(255, 68, 68, 0.1);';

  if (hide && !positional[0]) {
    // Remove all highlights
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
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

  const backendNodeId = snapshot.refToBackendNodeId.get(ref);

  await browser.withTab(tab.targetId, async (sessionId) => {
    const transport = browser.getTransport();

    if (backendNodeId) {
      await transport.send('DOM.enable', {}, sessionId);
      const resolveResult = await transport.send('DOM.resolveNode', { backendNodeId }, sessionId);
      const obj = resolveResult['object'] as { objectId?: string } | undefined;
      if (!obj?.objectId) {
        throw new Error(`Could not resolve element for ref "${ref}"`);
      }
      await transport.send(
        'Runtime.callFunctionOn',
        {
          objectId: obj.objectId,
          functionDeclaration: hide
            ? `function() {
                this.style.outline = '';
                this.style.background = '';
                this.removeAttribute('data-slicc-highlight');
              }`
            : `function(s) {
                this.style.cssText += '; ' + s;
                this.setAttribute('data-slicc-highlight', '1');
              }`,
          arguments: hide ? [] : [{ value: style }],
          returnByValue: true,
        },
        sessionId
      );
    } else {
      const selector = snapshot.refToSelector.get(ref)?.split(',')[0].trim();
      if (!selector) throw new Error(`Unknown ref "${ref}"`);
      const escapedStyle = style.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const script = hide
        ? `(function(){
            var el = document.querySelector(${JSON.stringify(selector)});
            if(el){
              el.style.outline='';
              el.style.background='';
              el.removeAttribute('data-slicc-highlight');
            }
          })()`
        : `(function(){
            var el = document.querySelector(${JSON.stringify(selector)});
            if(el){
              el.style.cssText += '; ${escapedStyle}';
              el.setAttribute('data-slicc-highlight','1');
            }
          })()`;
      await transport.send(
        'Runtime.evaluate',
        { expression: script, returnByValue: true },
        sessionId
      );
    }
  });

  return {
    stdout: hide ? `Highlight removed from ${ref}\n` : `Highlighted ${ref}\n`,
    stderr: '',
    exitCode: 0,
  };
};
