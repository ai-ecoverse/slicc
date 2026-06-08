#!/usr/bin/env node
// Render error-logo-preview.html once via headless Chrome, extract each
// tile's <svg> outerHTML, and write the 33 sliccy-error-*-*scoops.svg files.
// Run with a static server already serving this folder at PORT (default 8765).
// Override the Chrome binary with the CHROME_PATH env var if needed.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.PORT || '8765';
const URL = `http://127.0.0.1:${PORT}/error-logo-preview.html`;

const MODES = ['color', 'mono-light', 'mono-dark'];
const COUNTS = Array.from({ length: 11 }, (_, i) => i);

const dom = execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--virtual-time-budget=8000',
    '--dump-dom',
    URL,
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 }
);

mkdirSync(HERE, { recursive: true });

let written = 0;
for (const mode of MODES) {
  for (const count of COUNTS) {
    const id = `canvas-${mode}-${count}`;
    // The tile <div id="canvas-mode-count"> wraps the rendered <svg>.
    const openIdx = dom.indexOf(`id="${id}"`);
    if (openIdx === -1) throw new Error(`tile not found: ${id}`);
    const svgStart = dom.indexOf('<svg', openIdx);
    if (svgStart === -1) throw new Error(`<svg> not found inside ${id}`);
    const svgEnd = dom.indexOf('</svg>', svgStart);
    if (svgEnd === -1) throw new Error(`</svg> not found inside ${id}`);
    let svg = dom.slice(svgStart, svgEnd + '</svg>'.length);
    // The preview builds the SVG with createElementNS, but the dumped DOM
    // serialization drops xmlns on the root element. Inject it so the file
    // renders standalone (file:// in browsers, image viewers, etc.).
    if (!/^<svg[^>]*\sxmlns=/.test(svg)) {
      svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    const out = `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`;
    const file = join(HERE, `sliccy-error-${mode}-${count}scoops.svg`);
    writeFileSync(file, out);
    written++;
  }
}

console.log(`Wrote ${written} files to ${HERE}`);
