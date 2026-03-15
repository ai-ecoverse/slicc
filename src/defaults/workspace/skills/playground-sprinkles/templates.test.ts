import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const templatesPath = resolve(__dirname, 'templates.md');
const templates = readFileSync(templatesPath, 'utf-8');

// Extract code blocks from the markdown
function extractCodeBlocks(md: string): { name: string; code: string }[] {
  const blocks: { name: string; code: string }[] = [];
  const headingPattern = /^## ([A-F])\. (.+)$/gm;
  const codePattern = /```html\n([\s\S]*?)```/g;
  const headings: { index: number; label: string }[] = [];

  let m: RegExpExecArray | null;
  while ((m = headingPattern.exec(md)) !== null) {
    headings.push({ index: m.index, label: `${m[1]}. ${m[2]}` });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i < headings.length - 1 ? headings[i + 1].index : md.length;
    const section = md.slice(start, end);
    const codeMatch = codePattern.exec(section);
    codePattern.lastIndex = 0;
    if (codeMatch) {
      blocks.push({ name: headings[i].label, code: codeMatch[1] });
    }
  }
  return blocks;
}

const templateBlocks = extractCodeBlocks(templates);

describe('playground sprinkle templates', () => {
  it('has all 6 templates', () => {
    expect(templateBlocks).toHaveLength(6);
  });

  for (const { name, code } of templateBlocks) {
    describe(name, () => {
      it('contains slicc.lick() call', () => {
        expect(code).toContain('slicc.lick(');
      });

      it('contains slicc.setState() call', () => {
        expect(code).toContain('slicc.setState(');
      });

      it('contains updateAll or equivalent entry-point function', () => {
        // Most templates use updateAll(); Concept Map uses renderMap()+applyMap() (canvas with manual Apply)
        const hasUpdateAll = /function\s+updateAll\s*\(/.test(code);
        const hasRenderAndApply = /function\s+renderMap\s*\(/.test(code) && /function\s+applyMap\s*\(/.test(code);
        expect(hasUpdateAll || hasRenderAndApply).toBe(true);
      });

      it('hoists updateAll to window when using oninput/onchange', () => {
        const usesOninputOnchange = /\bon(input|change)\s*=\s*"updateAll\(\)"/.test(code);
        if (usesOninputOnchange) {
          expect(code).toContain('window.updateAll = updateAll');
        }
      });

      it('does not contain <!DOCTYPE html>', () => {
        expect(code).not.toContain('<!DOCTYPE html>');
      });

      it('does not contain <html> or <body> tags', () => {
        expect(code).not.toMatch(/<html[\s>]/);
        expect(code).not.toMatch(/<body[\s>]/);
      });

      it('contains slicc.getState() for state restoration', () => {
        expect(code).toContain('slicc.getState()');
      });

      it('uses sprinkle CSS classes', () => {
        expect(code).toMatch(/class="sprinkle-/);
      });

      it('has a data-sprinkle-title attribute', () => {
        expect(code).toMatch(/data-sprinkle-title="/);
      });
    });
  }
});

describe('sprinkle CSS selectors in index.html', () => {
  const indexPath = resolve(__dirname, '../../../../../index.html');
  const indexHtml = readFileSync(indexPath, 'utf-8');

  const newSelectors = [
    '.sprinkle-range',
    '.sprinkle-range__header',
    '.sprinkle-chips',
    '.sprinkle-chip',
    '.sprinkle-chip--active',
    '.sprinkle-toggle',
    '.sprinkle-select',
    '.sprinkle-color',
    '.sprinkle-canvas',
    '.sprinkle-canvas__toolbar',
    '.sprinkle-code',
    '.sprinkle-presets',
    '.sprinkle-textarea',
    '.sprinkle-collapsible',
  ];

  for (const selector of newSelectors) {
    it(`defines ${selector}`, () => {
      // Escape dots and dashes for regex, check it appears as a CSS selector
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(indexHtml).toMatch(new RegExp(escaped));
    });
  }
});
