#!/usr/bin/env npx tsx

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.__DEV__ = false;
const { deriveTokens } = await import('../../webapp/src/ui/theme-engine.ts');

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(
  here,
  '../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/theme-vectors.json'
);

const vectors = [
  {
    name: 'slicc-default-dark',
    base: 'dark',
    slots: {
      background: '#0f0f1a',
      surface: '#1c1c2e',
      text: '#e8e8f0',
      accent: '#7155fa',
      border: '#2a2a3e',
      success: '#34d399',
      error: '#ef4444',
    },
  },
  {
    name: 'plain-light',
    base: 'light',
    slots: {
      background: '#ffffff',
      surface: '#f4f4f5',
      text: '#111827',
      accent: '#2563eb',
      border: '#d4d4d8',
      success: '#16a34a',
      error: '#dc2626',
    },
  },
  {
    name: 'achromatic-gray',
    base: 'dark',
    slots: {
      background: '#808080',
      surface: '#808080',
      text: '#808080',
      accent: '#808080',
      border: '#808080',
      success: '#808080',
      error: '#808080',
    },
  },
  {
    name: 'clamp-extremes',
    base: 'light',
    slots: {
      background: '#010101',
      surface: '#000000',
      text: '#ffffff',
      accent: '#fefefe',
      border: '#020202',
      success: '#000000',
      error: '#ffffff',
    },
  },
  {
    name: 'channel-branches',
    base: 'dark',
    slots: {
      background: '#ff0000',
      surface: '#00ff00',
      text: '#0000ff',
      accent: '#00ff7f',
      border: '#7f00ff',
      success: '#ff007f',
      error: '#7fff00',
    },
  },
];

const pinned = vectors.map((v) => ({
  ...v,
  expected: deriveTokens(v.slots, v.base),
}));

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(pinned, null, 2)}\n`);
console.log(`wrote ${pinned.length} vectors to ${out}`);
