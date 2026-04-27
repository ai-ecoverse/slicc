import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nodeCommandSrc = readFileSync(
  resolve(__dirname, '..', '..', '..', 'src', 'shell', 'supplemental-commands', 'node-command.ts'),
  'utf-8'
);

describe('node-command __loadModule (extension sandbox)', () => {
  it('uses jsdelivr CDN instead of esm.sh for extension mode', () => {
    expect(nodeCommandSrc).toContain("'https://cdn.jsdelivr.net/npm/'");
  });

  it('does not use import() in the extension __loadModule', () => {
    const wrappedCodeMatch = nodeCommandSrc.match(
      /async function __loadModule\(id\)([\s\S]*?)^\s{10}\}/m
    );
    expect(wrappedCodeMatch).toBeTruthy();
    const body = wrappedCodeMatch![1];
    expect(body).not.toContain('await import(');
    expect(body).not.toContain('import(url)');
  });

  it('uses indirect Function constructor with module/exports shim', () => {
    expect(nodeCommandSrc).toContain(
      "(0, Function)('module', 'exports', text)(__mod, __mod.exports)"
    );
  });

  it('wraps Function invocation in try-catch', () => {
    expect(nodeCommandSrc).toContain("'Failed to execute module '");
  });

  it('falls back to globalThis for libraries that set self[id]', () => {
    expect(nodeCommandSrc).toContain('self[id]');
  });
});
