import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sandboxHtml = readFileSync(resolve(__dirname, '..', 'sprinkle-sandbox.html'), 'utf-8');

/**
 * Extract the text content of every <script> block in the HTML,
 * using the same rule the HTML parser applies: a <script> ends
 * at the first `</script` (case-insensitive).
 */
function extractScriptBlocks(html: string) {
  const scriptTexts: string[] = [];
  const openTag = /<script\b[^>]*>/gi;
  const closeTag = /<\/script\b[^>]*>/gi;
  let match;

  while ((match = openTag.exec(html)) !== null) {
    const contentStart = match.index + match[0].length;
    closeTag.lastIndex = contentStart;
    const close = closeTag.exec(html);
    if (close) {
      scriptTexts.push(html.slice(contentStart, close.index));
    }
  }

  return scriptTexts;
}

describe('sprinkle-sandbox.html', () => {
  it('does not contain literal </script> inside any <script> block', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    expect(scripts.length).toBeGreaterThan(0);

    for (const scriptText of scripts) {
      // The HTML parser terminates a <script> at any `</script` occurrence.
      // Inside JS, `</script` must be escaped (e.g. `<\/script` in strings
      // or regex). If the raw text contains `</script` (without a preceding
      // backslash), the HTML parser will close the tag prematurely and leak
      // the rest of the JS as visible page text.
      //
      // Match `</script` NOT preceded by `\` — the pattern that breaks HTML.
      const unescaped = /(?<!\\)<\/script/gi;
      const bad = scriptText.match(unescaped);
      expect(bad, `Found unescaped </script inside a <script> block: ${bad}`).toBeNull();
    }
  });

  it('contains the escapeForScript helper inside a script block', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    const hasEscape = scripts.some((s) => s.includes('escapeForScript'));
    expect(hasEscape).toBe(true);
  });

  it('contains the buildNestedBridgeScript helper inside a script block', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    const hasBridge = scripts.some((s) => s.includes('buildNestedBridgeScript'));
    expect(hasBridge).toBe(true);
  });

  it('has the slicc bridge API defined inside a script block', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    const hasBridge = scripts.some((s) => s.includes('window.slicc'));
    expect(hasBridge).toBe(true);
  });
});
