/**
 * Tests for the browser tool.
 *
 * Focuses on pure logic functions (base64ToBytes, preview URL construction).
 * The tool's execute method requires CDP connectivity and BrowserAPI,
 * which are integration-tested but not unit-tested in Node.
 */

import { describe, it, expect } from 'vitest';

/**
 * Helper to decode base64 to Uint8Array.
 * Extracted from browser-tool.ts for testing.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

describe('Browser Tool - base64ToBytes', () => {
  it('decodes empty base64 string', () => {
    const result = base64ToBytes('');
    expect(result).toEqual(new Uint8Array([]));
  });

  it('decodes simple base64 string', () => {
    // 'Hello' in base64 is 'SGVsbG8='
    const result = base64ToBytes('SGVsbG8=');
    const expected = new Uint8Array([72, 101, 108, 108, 111]); // H e l l o
    expect(result).toEqual(expected);
  });

  it('preserves byte values correctly', () => {
    // Test with binary data (all byte values 0-255 would be overkill,
    // but let's test some edge cases)
    const testBytes = new Uint8Array([0, 1, 127, 128, 255]);
    const binaryStr = String.fromCharCode(...Array.from(testBytes));
    const base64 = btoa(binaryStr);
    const decoded = base64ToBytes(base64);
    expect(decoded).toEqual(testBytes);
  });

  it('handles multiline base64', () => {
    // Base64 with padding and line breaks (common in real usage)
    const input = 'SGVsbG8gV29ybGQhIFRoaXMgaXMgYSBsb25nIHN0cmluZyB0byB0ZXN0IGJhc2U2NCBkZWNvZGluZy4=';
    const result = base64ToBytes(input);
    const expected = new TextEncoder().encode('Hello World! This is a long string to test base64 decoding.');
    expect(result).toEqual(expected);
  });

  it('handles PNG header bytes (typical screenshot use case)', () => {
    // PNG file signature: 137 80 78 71 13 10 26 10
    const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const binaryStr = String.fromCharCode(...Array.from(pngSignature));
    const base64 = btoa(binaryStr);
    const decoded = base64ToBytes(base64);
    expect(decoded).toEqual(pngSignature);
  });

  it('correctly rounds-trips arbitrary binary data', () => {
    // Create 256 bytes (0-255)
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      original[i] = i;
    }

    // Convert to base64 and back
    const binaryStr = String.fromCharCode(...Array.from(original));
    const base64 = btoa(binaryStr);
    const decoded = base64ToBytes(base64);

    expect(decoded).toEqual(original);
  });
});

/**
 * Preview URL construction logic — extracted from the serve action.
 * Tests the path normalization that builds /preview/... URLs.
 */
function buildPreviewPath(directory: string, entry: string): string {
  const normalizedDir = directory.startsWith('/') ? directory : '/' + directory;
  return `/preview${normalizedDir}${normalizedDir.endsWith('/') ? '' : '/'}${entry}`;
}

/**
 * Entry validation logic — extracted from the serve action.
 * Rejects path traversal and absolute paths in the entry parameter.
 */
function isValidEntry(entry: string): boolean {
  return !entry.includes('..') && !entry.startsWith('/');
}

describe('Browser Tool - serve action entry validation', () => {
  it('accepts simple filename', () => {
    expect(isValidEntry('index.html')).toBe(true);
  });

  it('accepts subdirectory entry', () => {
    expect(isValidEntry('pages/about.html')).toBe(true);
  });

  it('rejects parent traversal', () => {
    expect(isValidEntry('../escape.html')).toBe(false);
  });

  it('rejects nested parent traversal', () => {
    expect(isValidEntry('pages/../../escape.html')).toBe(false);
  });

  it('rejects absolute path', () => {
    expect(isValidEntry('/etc/passwd')).toBe(false);
  });
});

describe('Browser Tool - serve action URL construction', () => {
  it('constructs preview path for absolute directory', () => {
    expect(buildPreviewPath('/workspace/my-app', 'index.html'))
      .toBe('/preview/workspace/my-app/index.html');
  });

  it('constructs preview path for relative directory', () => {
    expect(buildPreviewPath('workspace/my-app', 'index.html'))
      .toBe('/preview/workspace/my-app/index.html');
  });

  it('handles directory with trailing slash', () => {
    expect(buildPreviewPath('/workspace/my-app/', 'index.html'))
      .toBe('/preview/workspace/my-app/index.html');
  });

  it('handles custom entry file', () => {
    expect(buildPreviewPath('/html', 'hello.html'))
      .toBe('/preview/html/hello.html');
  });

  it('handles root directory', () => {
    expect(buildPreviewPath('/', 'index.html'))
      .toBe('/preview/index.html');
  });

  it('handles nested directories', () => {
    expect(buildPreviewPath('/workspace/my-app/pages', 'about.html'))
      .toBe('/preview/workspace/my-app/pages/about.html');
  });
});
