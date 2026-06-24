/**
 * Mouse subcommands: mousemove, mousedown, mouseup, mousewheel, drop.
 */

import { parseRef, requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

type MouseButton = 'left' | 'right' | 'middle';

/** Normalize a button string to a valid CDP mouse button. Returns error string if invalid. */
function parseButton(raw: string | undefined): MouseButton | { error: string } {
  if (raw === undefined) return 'left';
  if (raw === 'left' || raw === 'right' || raw === 'middle') return raw;
  return { error: `Invalid button "${raw}". Must be left, right, or middle.\n` };
}

/** Convert a Uint8Array to a base64 string without relying on spread (avoids stack overflow). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

function mimeForFilename(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

export const mousemoveHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'mousemove requires <x> <y>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };
  const x = parseFloat(positional[0]);
  const y = parseFloat(positional[1]);
  if (isNaN(x) || isNaN(y)) {
    return { stdout: '', stderr: 'x and y must be numbers\n', exitCode: 1 };
  }
  await browser.withTab(tab.targetId, async (sessionId) => {
    const transport = browser.getTransport();
    await transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'none', modifiers: 0 },
      sessionId
    );
  });
  return { stdout: `Mouse moved to (${x}, ${y})\n`, stderr: '', exitCode: 0 };
};

export const mousedownHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };
  const button = parseButton(positional[0]);
  if (typeof button === 'object') return { stdout: '', stderr: button.error, exitCode: 1 };
  await browser.withTab(tab.targetId, async (sessionId) => {
    const transport = browser.getTransport();
    await transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', button, clickCount: 1, x: 0, y: 0, modifiers: 0 },
      sessionId
    );
  });
  return { stdout: `Mouse button ${button} pressed\n`, stderr: '', exitCode: 0 };
};

export const mouseupHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };
  const button = parseButton(positional[0]);
  if (typeof button === 'object') return { stdout: '', stderr: button.error, exitCode: 1 };
  await browser.withTab(tab.targetId, async (sessionId) => {
    const transport = browser.getTransport();
    await transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', button, clickCount: 1, x: 0, y: 0, modifiers: 0 },
      sessionId
    );
  });
  return { stdout: `Mouse button ${button} released\n`, stderr: '', exitCode: 0 };
};

export const mousewheelHandler: PlaywrightHandler = async ({ browser, positional, flags }) => {
  if (positional.length < 2) {
    return { stdout: '', stderr: 'mousewheel requires <dx> <dy>\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };
  const dx = parseFloat(positional[0]);
  const dy = parseFloat(positional[1]);
  if (isNaN(dx) || isNaN(dy)) {
    return { stdout: '', stderr: 'dx and dy must be numbers\n', exitCode: 1 };
  }
  await browser.withTab(tab.targetId, async (sessionId) => {
    const transport = browser.getTransport();
    await transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', deltaX: dx, deltaY: dy, x: 0, y: 0, modifiers: 0 },
      sessionId
    );
  });
  return { stdout: `Mouse wheel scrolled (dx=${dx}, dy=${dy})\n`, stderr: '', exitCode: 0 };
};

export const dropHandler: PlaywrightHandler = async ({ browser, fs, state, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'drop requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const ref = positional[0];
  // ponytail: only one --path and one --data value supported; parseFlags takes last-wins
  const vfsPath = flags['path'];
  const dataArg = flags['data'];

  // Build the files array from --path
  const files: Array<{ name: string; type: string; base64: string }> = [];
  if (vfsPath) {
    const content = await fs.readFile(vfsPath);
    const name = vfsPath.split('/').pop() ?? vfsPath;
    const type = mimeForFilename(name);
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    files.push({ name, type, base64: uint8ToBase64(bytes) });
  }

  // Build the data items array from --data (format: "mime/type=value")
  const dataItems: Array<{ mimeType: string; value: string }> = [];
  if (dataArg) {
    const eqIdx = dataArg.indexOf('=');
    if (eqIdx === -1) {
      return {
        stdout: '',
        stderr: '--data format must be "mime/type=value"\n',
        exitCode: 1,
      };
    }
    dataItems.push({ mimeType: dataArg.slice(0, eqIdx), value: dataArg.slice(eqIdx + 1) });
  }

  const dropFunctionDeclaration = `function(filesData, dataItems) {
    var dt = new DataTransfer();
    for (var i = 0; i < filesData.length; i++) {
      var f = filesData[i];
      var bytes = Uint8Array.from(atob(f.base64), function(c) { return c.charCodeAt(0); });
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    for (var j = 0; j < dataItems.length; j++) {
      var d = dataItems[j];
      dt.items.add(d.value, d.mimeType);
    }
    this.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    this.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return this.tagName;
  }`;

  const output = await browser.withTab(tab.targetId, async (sessionId) => {
    const snapshot = state.snapshots.get(tab.targetId);
    if (!snapshot) {
      throw new Error('No snapshot available. Run "snapshot" first.');
    }

    const transport = browser.getTransport();

    // Prefer backendNodeId for stable targeting (same pattern as click, upload)
    const backendNodeId = snapshot.refToBackendNodeId.get(ref);
    if (backendNodeId) {
      await transport.send('DOM.enable', {}, sessionId);
      const resolveResult = (await transport.send(
        'DOM.resolveNode',
        { backendNodeId },
        sessionId
      )) as { object: { objectId: string } };
      const result = (await transport.send(
        'Runtime.callFunctionOn',
        {
          objectId: resolveResult.object.objectId,
          functionDeclaration: dropFunctionDeclaration,
          arguments: [{ value: files }, { value: dataItems }],
          returnByValue: true,
        },
        sessionId
      )) as {
        result: { value: unknown };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      if (result.exceptionDetails) {
        const msg =
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Drop failed';
        throw new Error(msg);
      }
      state.snapshots.delete(tab.targetId);
      return `Dropped onto ${ref}`;
    }

    // Fallback to CSS selector for when snapshot has no backendNodeId
    const { isIframe } = parseRef(ref);
    const frameId = snapshot.refToFrameId?.get(ref);

    let selector: string;
    if (isIframe && frameId) {
      const s = snapshot.refToSelector.get(ref);
      if (!s) throw new Error(`Unknown ref "${ref}" in iframe`);
      selector = s.split(',')[0].trim();
    } else {
      const s = snapshot.refToSelector.get(ref);
      if (!s) {
        throw new Error(
          `Unknown ref "${ref}". Available: ${[...snapshot.refToSelector.keys()].slice(0, 10).join(', ')}...`
        );
      }
      selector = s.split(',')[0].trim();
    }

    const filesJson = JSON.stringify(files);
    const dataJson = JSON.stringify(dataItems);
    const script = `(function() {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('Element not found for ref ${ref}: ' + ${JSON.stringify(selector)});
  var dt = new DataTransfer();
  var filesData = ${filesJson};
  for (var i = 0; i < filesData.length; i++) {
    var f = filesData[i];
    var bytes = Uint8Array.from(atob(f.base64), function(c) { return c.charCodeAt(0); });
    var file = new File([bytes], f.name, { type: f.type });
    dt.items.add(file);
  }
  var dataItems = ${dataJson};
  for (var j = 0; j < dataItems.length; j++) {
    var d = dataItems[j];
    dt.items.add(d.value, d.mimeType);
  }
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
})()`;

    const result = (await transport.send(
      'Runtime.evaluate',
      { expression: script, returnByValue: true, awaitPromise: false },
      sessionId
    )) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      const msg =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Drop failed';
      throw new Error(msg);
    }
    state.snapshots.delete(tab.targetId);
    return `Dropped onto ${ref}`;
  });

  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};
