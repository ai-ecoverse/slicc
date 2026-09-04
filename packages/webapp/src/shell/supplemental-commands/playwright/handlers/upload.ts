/**
 * Upload subcommand: upload [ref] <file> [file...]
 *
 * Uploads one or more VFS files to a file input element on the page using
 * DataTransfer injection. Files are read as raw bytes — a UTF-8 text round-trip
 * substitutes U+FFFD (`EF BF BD`) for every byte >= 0x80 (#2878). The optional
 * leading ref (e.g. "e3") targets the element directly via DOM.resolveNode +
 * Runtime.callFunctionOn, which handles the common
 * `<label><input type="file" hidden>` pattern where clicking the label opens
 * the picker but never focuses the hidden input. A leading `eN` / `fNeN` token
 * is always a ref, never a filename. When no ref is given, falls back to
 * targeting document.activeElement.
 */

import { uint8ToBase64 } from '@slicc/shared-ts';
import { isElementRef, requireTab } from '../state.js';
import type { PlaywrightHandler, PlaywrightHandlerCtx, TabSnapshot } from '../types.js';

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

/**
 * Read a VFS file as raw bytes. Never UTF-8-decodes: a text round-trip
 * substitutes U+FFFD for every byte >= 0x80 (#2878, same family as #2818).
 *
 * If a backend still returns a string, refuse any payload that already
 * contains U+FFFD rather than uploading a silently mangled File.
 */
export async function readUploadBytes(
  fs: PlaywrightHandlerCtx['fs'],
  path: string
): Promise<Uint8Array> {
  const content = await fs.readFile(path, { encoding: 'binary' });
  if (content instanceof Uint8Array) return content;
  if (typeof content !== 'string') {
    throw new Error(`cannot represent '${path}' faithfully: unexpected file content type`);
  }
  if (content.includes('\uFFFD')) {
    throw new Error(
      `cannot represent '${path}' faithfully: file was read as text (contains U+FFFD). ` +
        'Binary files must be read as bytes, not UTF-8.'
    );
  }
  return new TextEncoder().encode(content);
}

function parseUploadArgs(
  positional: string[],
  snapshot: TabSnapshot | undefined
): { targetRef: string | null; filePaths: string[] } | { error: string } {
  if (positional.length === 0) {
    return { error: 'upload requires at least one file path\n' };
  }
  if (!isElementRef(positional[0])) {
    return { targetRef: null, filePaths: positional };
  }
  const targetRef = positional[0];
  const filePaths = positional.slice(1);
  if (!snapshot) {
    return { error: 'No snapshot available. Run "snapshot" first.\n' };
  }
  if (!snapshot.refToBackendNodeId.has(targetRef)) {
    return { error: `Unknown ref "${targetRef}"\n` };
  }
  if (filePaths.length === 0) {
    return { error: 'upload requires at least one file path\n' };
  }
  return { targetRef, filePaths };
}

export const uploadHandler: PlaywrightHandler = async ({
  browser,
  fs,
  state,
  positional,
  flags,
}) => {
  const tab = requireTab(flags);
  if ('error' in tab) {
    return { stdout: '', stderr: tab.error, exitCode: 1 };
  }

  const snapshot = state.snapshots.get(tab.targetId);
  const parsed = parseUploadArgs(positional, snapshot);
  if ('error' in parsed) {
    return { stdout: '', stderr: parsed.error, exitCode: 1 };
  }
  const { targetRef, filePaths } = parsed;

  const files: Array<{ name: string; type: string; base64: string }> = [];
  for (const filePath of filePaths) {
    const bytes = await readUploadBytes(fs, filePath);
    const name = filePath.split('/').pop() ?? filePath;
    files.push({ name, type: mimeForFilename(name), base64: uint8ToBase64(bytes) });
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
