import { uint8ToBase64 } from '@slicc/shared-ts';
import { readVfsFileBytes } from '../binary.js';
import { callOnElement, requireTabSnapshot, resolveSnapshotRef } from '../snapshot.js';
import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

type MouseButton = 'left' | 'right' | 'middle';

function parseButton(raw: string | undefined): MouseButton | { error: string } {
  if (raw === undefined) return 'left';
  if (raw === 'left' || raw === 'right' || raw === 'middle') return raw;
  return { error: `Invalid button "${raw}". Must be left, right, or middle.\n` };
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

export const mousemoveHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
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
  await onTab(tab.targetId, async ({ sessionId, transport }) => {
    await transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'none', modifiers: 0 },
      sessionId
    );
  });
  state.lastMousePosition.set(tab.targetId, { x, y });
  return { stdout: `Mouse moved to (${x}, ${y})\n`, stderr: '', exitCode: 0 };
};

export const mousedownHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };
  const button = parseButton(positional[0]);
  if (typeof button === 'object') return { stdout: '', stderr: button.error, exitCode: 1 };
  const pos = state.lastMousePosition.get(tab.targetId) ?? { x: 0, y: 0 };
  await onTab(tab.targetId, async ({ sessionId, transport }) => {
    await transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', button, clickCount: 1, x: pos.x, y: pos.y, modifiers: 0 },
      sessionId
    );
  });
  return { stdout: `Mouse button ${button} pressed\n`, stderr: '', exitCode: 0 };
};

export const mouseupHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };
  const button = parseButton(positional[0]);
  if (typeof button === 'object') return { stdout: '', stderr: button.error, exitCode: 1 };
  const pos = state.lastMousePosition.get(tab.targetId) ?? { x: 0, y: 0 };
  await onTab(tab.targetId, async ({ sessionId, transport }) => {
    await transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', button, clickCount: 1, x: pos.x, y: pos.y, modifiers: 0 },
      sessionId
    );
  });
  return { stdout: `Mouse button ${button} released\n`, stderr: '', exitCode: 0 };
};

export const mousewheelHandler: PlaywrightHandler = async ({
  browser,
  state,
  positional,
  flags,
  onTab,
}) => {
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
  const pos = state.lastMousePosition.get(tab.targetId) ?? { x: 0, y: 0 };
  let stderr = '';
  await onTab(tab.targetId, async ({ sessionId, transport }) => {
    const visibility = (await transport.send(
      'Runtime.evaluate',
      { expression: 'document.visibilityState', returnByValue: true },
      sessionId
    )) as { result?: { value?: unknown } };
    if (visibility.result?.value === 'hidden') {
      const scrolled = (await transport.send(
        'Runtime.evaluate',
        { expression: pageScrollScript(pos.x, pos.y, dx, dy), returnByValue: true },
        sessionId
      )) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
      if (scrolled.exceptionDetails) {
        throw new Error(
          scrolled.exceptionDetails.exception?.description ??
            scrolled.exceptionDetails.text ??
            'Page scroll failed'
        );
      }
      stderr = 'note: the tab is in the background, so the wheel was applied as a page scroll\n';
      return;
    }
    await transport.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', deltaX: dx, deltaY: dy, x: pos.x, y: pos.y, modifiers: 0 },
      sessionId
    );
  });
  return { stdout: `Mouse wheel scrolled (dx=${dx}, dy=${dy})\n`, stderr, exitCode: 0 };
};

function pageScrollScript(x: number, y: number, dx: number, dy: number): string {
  return `(() => {
  const dx = ${JSON.stringify(dx)}, dy = ${JSON.stringify(dy)};
  const canScroll = (el) => {
    const style = getComputedStyle(el);
    const y = /(auto|scroll|overlay)/.test(style.overflowY) &&
      (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight : dy < 0 && el.scrollTop > 0);
    const x = /(auto|scroll|overlay)/.test(style.overflowX) &&
      (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth : dx < 0 && el.scrollLeft > 0);
    return y || x;
  };
  let el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
  while (el && el !== document.body && el !== document.documentElement && !canScroll(el)) {
    el = el.parentElement;
  }
  const target = el && el !== document.body && el !== document.documentElement
    ? el
    : (document.scrollingElement || document.documentElement);
  target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return true;
})()`;
}

export const dropHandler: PlaywrightHandler = async ({
  browser,
  fs,
  state,
  positional,
  flags,
  onTab,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'drop requires a ref (e.g. e5)\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) return { stdout: '', stderr: tab.error, exitCode: 1 };

  const ref = positional[0];

  const vfsPath = flags['path'];
  const dataArg = flags['data'];

  const files: Array<{ name: string; type: string; base64: string }> = [];
  if (vfsPath) {
    const bytes = await readVfsFileBytes(fs, vfsPath);
    const name = vfsPath.split('/').pop() ?? vfsPath;
    files.push({ name, type: mimeForFilename(name), base64: uint8ToBase64(bytes) });
  }

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

  const output = await onTab(tab.targetId, async (page) => {
    const snapshot = requireTabSnapshot(state, tab.targetId);
    const { objectId } = await resolveSnapshotRef(page, snapshot, ref);
    await callOnElement(page, objectId, dropFunctionDeclaration, [files, dataItems]);
    state.snapshots.delete(tab.targetId);
    return `Dropped onto ${ref}`;
  });

  return { stdout: output + '\n', stderr: '', exitCode: 0 };
};
