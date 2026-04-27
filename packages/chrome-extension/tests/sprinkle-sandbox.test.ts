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

describe('sprinkle-sandbox.html structural integrity', () => {
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

describe('sprinkle-sandbox.html extension sandbox fixes', () => {
  it('does not dynamically inject slicc-editor.js or slicc-diff.js via createElement', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    for (const scriptText of scripts) {
      expect(scriptText).not.toMatch(
        /createElement\s*\(\s*['"]script['"]\s*\)[\s\S]*?\.src\s*=\s*['"]slicc-editor\.js['"]/
      );
      expect(scriptText).not.toMatch(
        /createElement\s*\(\s*['"]script['"]\s*\)[\s\S]*?\.src\s*=\s*['"]slicc-diff\.js['"]/
      );
    }
  });

  it('loads slicc-editor.js and slicc-diff.js statically in head', () => {
    const headMatch = sandboxHtml.match(/<head[\s\S]*?<\/head>/i);
    expect(headMatch).toBeTruthy();
    const head = headMatch![0];
    expect(head).toContain('src="slicc-editor.js"');
    expect(head).toContain('src="slicc-diff.js"');
    expect(head).toContain('src="lucide-icons.js"');
  });

  it('contains the fetchScriptViaRelay function for partial-content external scripts', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    const hasRelay = scripts.some((s) => s.includes('fetchScriptViaRelay'));
    expect(hasRelay).toBe(true);
  });

  it('includes sprinkle-fetch-script in bridgeTypes relay array', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    const hasFetchBridge = scripts.some((s) => s.includes("'sprinkle-fetch-script'"));
    expect(hasFetchBridge).toBe(true);
  });

  it('includes sprinkle-fetch-script-response in responseTypes relay array', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    const hasFetchResponse = scripts.some((s) => s.includes("'sprinkle-fetch-script-response'"));
    expect(hasFetchResponse).toBe(true);
  });

  it('fetchScriptViaRelay has a timeout', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    const relayScript = scripts.find((s) => s.includes('fetchScriptViaRelay'));
    expect(relayScript).toBeTruthy();
    expect(relayScript).toContain('setTimeout');
    expect(relayScript).toContain('30000');
  });

  it('calls LucideIcons.render() after partial-content script execution', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    const mainScript = scripts.find((s) => s.includes('executeScripts'));
    expect(mainScript).toBeTruthy();
    expect(mainScript).toContain('LucideIcons');
    expect(mainScript).toContain('.render()');
  });

  it('partial-content scripts handle non-HTTP src with a warning', () => {
    const scripts = extractScriptBlocks(sandboxHtml);
    const mainScript = scripts.find((s) => s.includes('executeScripts'));
    expect(mainScript).toBeTruthy();
    expect(mainScript).toContain('unsupported src');
  });
});
