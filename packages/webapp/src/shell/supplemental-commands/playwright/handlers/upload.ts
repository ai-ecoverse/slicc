/**
 * Upload subcommand: upload [ref] <file> [file...]
 *
 * Uploads one or more VFS files to a file input element on the page using
 * DataTransfer injection. The optional leading ref (e.g. "e3") targets the
 * element directly via DOM.resolveNode + Runtime.callFunctionOn, which handles
 * the common `<label><input type="file" hidden>` pattern where clicking the
 * label opens the picker but never focuses the hidden input. When no ref is
 * given, falls back to targeting document.activeElement.
 */

import { requireTab } from '../state.js';
import type { PlaywrightHandler } from '../types.js';

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

/** Convert a Uint8Array to a base64 string without relying on spread (avoids stack overflow for large files). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export const uploadHandler: PlaywrightHandler = async ({
  browser,
  fs,
  state,
  positional,
  flags,
}) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'upload requires at least one file path\n', exitCode: 1 };
  }
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }

  // Detect optional leading ref argument (e.g. "e3") targeting a file input directly.
  let targetRef: string | null = null;
  let filePaths = positional;

  const snapshot = state.snapshots.get(tab.targetId);
  if (snapshot && positional.length > 0 && snapshot.refToBackendNodeId.has(positional[0])) {
    targetRef = positional[0];
    filePaths = positional.slice(1);
  }

  if (filePaths.length === 0) {
    return { stdout: '', stderr: 'upload requires at least one file path\n', exitCode: 1 };
  }

  // Read files from VFS and encode as base64.
  const files: Array<{ name: string; type: string; base64: string }> = [];
  for (const filePath of filePaths) {
    const content = await fs.readFile(filePath);
    const name = filePath.split('/').pop() ?? filePath;
    const type = mimeForFilename(name);
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const base64 = uint8ToBase64(bytes);
    files.push({ name, type, base64 });
  }

  if (targetRef) {
    const backendNodeId = snapshot!.refToBackendNodeId.get(targetRef)!;
    await browser.withTab(tab.targetId, async (sessionId) => {
      const transport = browser.getTransport();
      await transport.send('DOM.enable', {}, sessionId);
      const { object } = (await transport.send(
        'DOM.resolveNode',
        { backendNodeId },
        sessionId
      )) as { object: { objectId: string } };
      const result = (await transport.send(
        'Runtime.callFunctionOn',
        {
          objectId: object.objectId,
          functionDeclaration: `function(filesData) {
            const el = this;
            if (el.tagName !== 'INPUT' || el.type !== 'file') {
              throw new Error('Element ' + el.tagName + ' is not a file input');
            }
            const dt = new DataTransfer();
            for (const f of filesData) {
              const bytes = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
              dt.items.add(new File([bytes], f.name, { type: f.type }));
            }
            el.files = dt.files;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return el.files.length;
          }`,
          arguments: [{ value: files }],
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
          'Upload failed';
        throw new Error(msg);
      }
    });
  } else {
    await browser.withTab(tab.targetId, async (sessionId) => {
      const filesJson = JSON.stringify(files);
      const script = `(function() {
        var el = document.activeElement;
        if (!el || el.tagName !== 'INPUT' || el.type !== 'file') {
          throw new Error('No file input is currently focused');
        }
        var dt = new DataTransfer();
        var filesData = ${filesJson};
        for (var i = 0; i < filesData.length; i++) {
          var f = filesData[i];
          var bytes = Uint8Array.from(atob(f.base64), function(c) { return c.charCodeAt(0); });
          var file = new File([bytes], f.name, { type: f.type });
          dt.items.add(file);
        }
        el.files = dt.files;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.files.length;
      })()`;
      const transport = browser.getTransport();
      const result = (await transport.send(
        'Runtime.evaluate',
        { expression: script, returnByValue: true, awaitPromise: false },
        sessionId
      )) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
      if (result.exceptionDetails) {
        const msg =
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'File upload failed';
        throw new Error(msg);
      }
    });
  }

  const names = filePaths.map((p) => p.split('/').pop() ?? p).join(', ');
  return {
    stdout: `Uploaded ${filePaths.length} file(s): ${names}\n`,
    stderr: '',
    exitCode: 0,
  };
};
