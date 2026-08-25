#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
/**
 * agent-merch — render a hash-stable grid of scoop avatars for merch.
 *
 *   node packages/dev-tools/tools/agent-merch.mjs [--seed <str>] [--grid 10]
 *        [--color 3] [--cell 300] [--scale 2] [--sparse 0.25]
 *        [--tagline "<text>"] [--theme light,dark] [--out dist/merch]
 *
 * Every output is a pure function of `--seed` (default: "slicc"): the seed
 * hashes to a 32-bit generation id that drives an xorshift32 stream, which
 * draws `grid²` names from the agent-names pools, picks which `color` of
 * them are rendered in full colour (those are the names in the tagline), and
 * seeds every face. Each face is derived from its own name, so
 * `agent-freudian-karaage` looks the same in every generation.
 *
 * Rendering uses the real `<slicc-agent-avatar>` element from
 * packages/webcomponents/dist (build it first) under Playwright's Chromium
 * with reduced motion, so the expression engine snaps to its targets and the
 * screenshot is deterministic. Output: `<out>/agent-grid-<gen>.png` + `.html`.
 */
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { binaryAlphaPng, outputPixelWidth, PRINT_DENSITY } from './agent-merch-lib.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const WC_DIST = resolve(ROOT, 'packages/webcomponents/dist');
const NAMES_TS = resolve(ROOT, 'packages/webapp/src/scoops/agent-names.ts');
const FONTS = resolve(ROOT, 'packages/assets/fonts');

// ── CLI ───────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null))
    .filter(Boolean)
);
const SEED = args.seed ?? 'slicc';
const GRID = Number(args.grid ?? 10);
const COLORED = Number(args.color ?? 3);
const CELL = Number(args.cell ?? 300);
const SCALE = Number(args.scale ?? 2);
const OUT = resolve(ROOT, args.out ?? 'dist/merch');
const THEMES = (args.theme ?? 'light,dark').split(',');
const SPARSE = Number(args.sparse ?? 0.25); // fraction of grid cells left empty

// ── deterministic primitives ──────────────────────────────────────────────
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const ch of str) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function rng(seed) {
  let s = seed === 0 ? 0x51cca11e : seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// ── word pools (parsed from the TS module so the script stays dependency-free) ──
async function loadPools() {
  const src = await readFile(NAMES_TS, 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp(`${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`));
    if (!m) throw new Error(`cannot find ${name} in ${NAMES_TS}`);
    return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  };
  return { adjectives: grab('AGENT_ADJECTIVES'), flavors: grab('AGENT_FLAVORS') };
}

// ── ice-cream canon ───────────────────────────────────────────────────────
const CANON = {
  vanilla: '#F3E5AB',
  strawberry: '#FF7A9A',
  chocolate: '#7B4A2D',
  pistachio: '#93C572',
  mint: '#98E4C8',
  caramel: '#C68E4F',
  blueberry: '#6F7FD9',
  lemon: '#FFE566',
  mango: '#FFB347',
  lavender: '#B8A1E3',
  raspberry: '#E0376B',
  matcha: '#7FA65A',
  coffee: '#6B4F3A',
  peach: '#FFC4A3',
  bubblegum: '#FF9FD6',
  butterscotch: '#E3A857',
  blackcurrant: '#5B2C6F',
  cherry: '#C2203C',
};
const FLAVOR_NAMES = Object.keys(CANON);

// A face is a pure function of its name.
function faceFor(name) {
  const r = rng(fnv1a(`face:${name}`));
  const flavor = pick(r, FLAVOR_NAMES);
  const roll = r();
  const activity = roll < 0.3 ? 'thinking' : roll < 0.55 ? 'tool' : roll < 0.62 ? 'awaiting' : '';
  return {
    name,
    type: r() < 0.12 ? 'cone' : 'scoop',
    flavor,
    color: CANON[flavor],
    fill: Math.round(15 + r() * 75),
    activity,
    eyes: r() < 0.04 ? 'dead' : 'open',
  };
}

// ── generation ────────────────────────────────────────────────────────────
async function generate() {
  const { adjectives, flavors } = await loadPools();
  const gen = fnv1a(`gen:${SEED}`);
  const r = rng(gen);
  const total = GRID * GRID;
  const emptyCount = Math.round((total - 1) * SPARSE);
  const empties = new Set();
  while (empties.size < emptyCount) empties.add(Math.floor(r() * (total - 1)));
  const names = new Set();
  while (names.size < total - 1 - emptyCount)
    names.add(`${pick(r, adjectives)}-${pick(r, flavors)}`);
  const list = [...names];
  const faces = list.map((n) => faceFor(n));
  // The featured trio gets distinct flavors so the colour pops read as three.
  const colored = new Set();
  const usedFlavors = new Set();
  while (colored.size < COLORED) {
    const i = Math.floor(r() * list.length);
    if (colored.has(i) || usedFlavors.has(faces[i].flavor)) continue;
    colored.add(i);
    usedFlavors.add(faces[i].flavor);
  }
  for (const i of colored) faces[i].colored = true;
  const cells = [];
  let next = 0;
  for (let i = 0; i < total - 1; i++) cells.push(empties.has(i) ? { empty: true } : faces[next++]);
  cells.push({
    name: 'yours',
    type: 'scoop',
    color: '#bdbdbd',
    fill: 50,
    activity: '',
    eyes: 'none',
    colored: false,
    yours: true,
  });
  const featured = [...colored]
    .sort((a, b) => a - b)
    .map((i) => ({ name: list[i], color: faces[i].color }));
  const combos = adjectives.length * flavors.length;
  const headline =
    args.tagline ?? `${(combos / 1e6).toFixed(1).replace(/\.0$/, '')} million flavors of agent`;
  const tagline = `${headline}: ${featured.map((f) => f.name).join(', ')} … and yours`;
  return {
    gen: gen.toString(16).padStart(8, '0'),
    faces,
    cells,
    headline,
    tagline,
    featured,
    combos,
  };
}

/** Pull a tile colour toward the ink until it reads as text on the paper. */
function textColor(hex, dark) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const target = dark ? 0.62 : 0.42; // min luminance on black / max on white
  const ok = dark ? lum >= target : lum <= target;
  if (ok) return hex;
  const t = dark ? (target - lum) / (1 - lum) : 1 - target / lum;
  const mix = (c) => Math.round(dark ? c + (255 - c) * t : c * (1 - t));
  return `#${[r, g, b].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`;
}

function pageHtml({ cells: grid, headline, featured }, theme) {
  const w = GRID * CELL;
  const cells = grid
    .map((f) => {
      if (f.empty) return '<div class="cell"></div>';
      const cls = `cell${f.colored ? ' colored' : ''}${f.yours ? ' yours' : ''}`;
      const attrs = [
        `type="${f.type}"`,
        `color="${f.color}"`,
        `fill="${f.fill}"`,
        `eyes="${f.eyes}"`,
        f.activity ? `activity="${f.activity}"` : '',
      ].join(' ');
      const q = f.yours ? '<div class="q">?</div>' : '';
      return `<div class="${cls}" title="${f.name}"><slicc-agent-avatar ${attrs}></slicc-agent-avatar>${q}</div>`;
    })
    .join('\n');
  const dark = theme === 'dark';
  const ink = dark ? '#f5f5f2' : '#0a0a0a';
  const fs = w / 15;
  return `<!doctype html><html class="${dark ? 'dark' : ''}"><head><meta charset="utf-8">
<link rel="stylesheet" href="/theme/tokens.css">
<style>
  @font-face{font-family:"Adobe Clean";src:url(/fonts/AdobeClean-Regular.otf);font-weight:400;}
  @font-face{font-family:"Adobe Clean";src:url(/fonts/AdobeClean-Medium.otf);font-weight:500;}
  @font-face{font-family:"Adobe Clean";src:url(/fonts/AdobeClean-Bold.otf);font-weight:700;}
  @font-face{font-family:"Adobe Clean";src:url(/fonts/AdobeClean-ExtraBold.otf);font-weight:800;}
  html,body{margin:0;background:transparent;}
  body{width:${w}px;padding:${fs * 1.6}px 0 ${fs * 1.4}px;box-sizing:border-box;font-family:"Adobe Clean",sans-serif;color:${ink};text-align:center;}
  .head{font-size:${fs * 1.05}px;white-space:nowrap;font-weight:800;letter-spacing:-0.025em;line-height:1.1;padding:0 ${fs}px;}
  .names{font-size:${fs * 0.7}px;font-weight:700;letter-spacing:-0.01em;line-height:1.3;margin:${fs * 0.5}px 0 ${fs * 1.1}px;}
  .names span{white-space:nowrap;}
  .foot{font-size:${fs * 1.05}px;font-weight:800;letter-spacing:-0.025em;line-height:1.1;margin-top:${fs * 1.1}px;}
  .grid{display:grid;grid-template-columns:repeat(${GRID},${CELL}px);justify-content:center;}
  .cell{width:${CELL}px;height:${CELL}px;padding:${CELL * 0.1}px;box-sizing:border-box;filter:grayscale(1) contrast(${dark ? 0.6 : 0.55}) brightness(${dark ? 0.7 : 1.3});}
  .cell.colored{filter:none;}
  .cell.yours{filter:none;position:relative;color:#888;}
  .cell.yours .q{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:${CELL * 0.5}px;font-weight:800;}
  slicc-agent-avatar{display:block;width:100%;height:100%;}
</style></head><body>
<div class="head">${headline}</div>
<div class="names">${featured.map((f) => `<span style="color:${textColor(f.color, dark)}">${f.name}</span>`).join(', ')}</div>
<div class="grid">${cells}</div>
<div class="foot">… and yours</div>
<script type="module">import '/switcher/slicc-agent-avatar.js';</script>
</body></html>`;
}

const MIME = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.map': 'application/json',
  '.otf': 'font/otf',
};
function serve(html) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    try {
      const dir = url.pathname.startsWith('/fonts/') ? resolve(FONTS, '..') : WC_DIST;
      const body = await readFile(resolve(dir, `.${url.pathname}`));
      res
        .writeHead(200, {
          'content-type': MIME[extname(url.pathname)] ?? 'application/octet-stream',
        })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function main() {
  const g = await generate();
  await mkdir(OUT, { recursive: true });
  await writeFile(
    resolve(OUT, `agent-grid-${g.gen}.json`),
    JSON.stringify(
      {
        seed: SEED,
        grid: GRID,
        cell: CELL,
        scale: SCALE,
        dpi: PRINT_DENSITY,
        pixelWidth: outputPixelWidth(GRID, CELL, SCALE),
        ...g,
      },
      null,
      2
    )
  );
  const browser = await chromium.launch();
  try {
    for (const theme of THEMES) await render(browser, g, theme);
  } finally {
    await browser.close();
  }
  console.log(`gen ${g.gen}  ${g.faces.length} faces  ${g.combos.toLocaleString('en-US')} combos`);
  console.log(`tagline: ${g.tagline}`);
}

async function render(browser, g, theme) {
  const html = pageHtml(g, theme);
  const base = resolve(OUT, `agent-grid-${g.gen}-${theme}`);
  await writeFile(`${base}.html`, html);
  const server = await serve(html);
  const { port } = server.address();
  try {
    const page = await browser.newPage({
      viewport: { width: GRID * CELL, height: 800 },
      deviceScaleFactor: SCALE,
      reducedMotion: 'reduce',
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => customElements.get('slicc-agent-avatar') !== undefined);
    // Same crop as the UI tab icon (zoom + 7px radius at 26px), radius scaled to the cell.
    await page.evaluate((cell) => {
      for (const el of document.querySelectorAll('slicc-agent-avatar')) {
        const avatar = el.shadowRoot?.querySelector('.avatar');
        if (!(avatar instanceof HTMLElement)) continue;
        avatar.style.borderRadius = `${(7 / 26) * cell}px`;
        if (el.closest('.yours')) {
          for (const path of el.shadowRoot.querySelectorAll('.glyph path'))
            path.setAttribute('fill', 'none');
          avatar.style.boxSizing = 'border-box';
          avatar.style.border = `${Math.max(2, cell * 0.02)}px dashed currentColor`;
        }
      }
    }, CELL * 0.8);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    const screenshot = await page.screenshot({ fullPage: true, omitBackground: true });
    await writeFile(`${base}.png`, await binaryAlphaPng(screenshot));
    await page.close();
    console.log(`${base}.png`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
