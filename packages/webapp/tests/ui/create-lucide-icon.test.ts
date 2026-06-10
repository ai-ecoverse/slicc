// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createLucideIcon, type IconNode } from '../../src/ui/create-lucide-icon.js';
import { createLickIcon } from '../../src/ui/lick-view.js';
import { createClusterIcon, createToolIcon } from '../../src/ui/tool-call-view.js';
import type { ChatMessage } from '../../src/ui/types.js';

const sampleNode: IconNode = [
  ['path', { d: 'M5 12h14' }],
  ['circle', { cx: 12, cy: 12, r: 3 }],
];

describe('createLucideIcon', () => {
  it('builds an <svg> with the standard lucide attributes', () => {
    const svg = createLucideIcon(sampleNode);
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('2');
    expect(svg.getAttribute('stroke-linecap')).toBe('round');
    expect(svg.getAttribute('stroke-linejoin')).toBe('round');
  });

  it('defaults to size 18 and honors an explicit size', () => {
    const def = createLucideIcon(sampleNode);
    expect(def.getAttribute('width')).toBe('18');
    expect(def.getAttribute('height')).toBe('18');

    const sized = createLucideIcon(sampleNode, 14);
    expect(sized.getAttribute('width')).toBe('14');
    expect(sized.getAttribute('height')).toBe('14');
  });

  it('renders one child element per node entry with its attributes', () => {
    const svg = createLucideIcon(sampleNode);
    const children = Array.from(svg.children);
    expect(children.map((c) => c.tagName.toLowerCase())).toEqual(['path', 'circle']);
    expect(children[0].getAttribute('d')).toBe('M5 12h14');
    expect(children[1].getAttribute('r')).toBe('3');
  });

  it('produces a childless <svg> for an empty node', () => {
    expect(createLucideIcon([]).children.length).toBe(0);
  });
});

describe('icon entry points route through the shared builder', () => {
  function makeLick(channel: string, content: string): ChatMessage {
    return { id: 'm1', role: 'user', content, timestamp: Date.now(), source: 'lick', channel };
  }

  it('createToolIcon renders a 14px svg with children', () => {
    const svg = createToolIcon('read_file');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('width')).toBe('14');
    expect(svg.children.length).toBeGreaterThan(0);
  });

  it('createClusterIcon renders a 14px svg', () => {
    expect(createClusterIcon().getAttribute('width')).toBe('14');
  });

  it('createLickIcon renders a 14px svg', () => {
    const svg = createLickIcon(makeLick('webhook', '[Webhook Event: x]'));
    expect(svg.getAttribute('width')).toBe('14');
    expect(svg.children.length).toBeGreaterThan(0);
  });
});
