// page-state.jsh — what the tab shows right now, in one call.
//
// Composes `playwright-cli snapshot --boxes` and `playwright-cli eval`: the
// snapshot is filtered to the viewport plus a margin, with a scroll summary.
// Refs stay valid for click/fill because this IS the tab's latest snapshot.
// Modelled on browser-use's per-step browser state (viewport-filtered
// elements, "pages above/below", markers for elements that appeared since
// the last look).
const fs = require('fs');
const exec = require('sliccy:exec');

const USAGE = `Usage: page-state --tab=<targetId> [--scroll=down|up] [--margin=<px>] [--all] [--max-lines=<n>]

Prints the page URL, title, scroll position (screens above/below) and the
snapshot lines whose elements sit in the viewport +/- the margin (default half
a screen). Names and values longer than 200 characters are cut. Refs (e5, ...) are live: use them with click, fill, select, check.
Lines marked * appeared since your last page-state on the same URL.

  --tab=<id>       tab target id (required)
  --scroll=down|up scroll one screen first (via eval, works on background tabs)
  --margin=<px>    how far beyond the viewport to include (default: half a viewport)
  --all            no viewport filter (whole snapshot, boxes stripped)
  --max-lines=<n>  cap on printed tree lines (default 300)
`;

function parseArgs(argv) {
  const out = { tab: '', scroll: '', margin: null, all: false, maxLines: 300, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const next = () => (v !== null ? v : argv[++i]);
    if (k === '--tab') out.tab = next() || '';
    else if (k === '--scroll') out.scroll = next() || '';
    else if (k === '--margin') out.margin = Number(next());
    else if (k === '--max-lines') out.maxLines = Number(next());
    else if (k === '--all') out.all = true;
    else if (k === '-h' || k === '--help') out.help = true;
    else throw new Error(`page-state: unknown argument "${a}"`);
  }
  if (out.scroll && out.scroll !== 'down' && out.scroll !== 'up') throw new Error(`page-state: --scroll must be down or up, got "${out.scroll}"`);
  return out;
}

const METRICS_JS =
  'JSON.stringify({y: Math.round(scrollY), vh: innerHeight, vw: innerWidth, ' +
  'h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), ' +
  'ready: document.readyState})';

const LINE_RE = /^(\s*)- (.*)$/;
// Quoted names/values past this length are cut; refs after them survive.
const MAX_TEXT = 200;
const LONG_STRING_RE = /"((?:[^"\\]|\\.){201,})"/g;
const BOX_RE = / \[box=(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/;

function parseTree(text) {
  const lines = text.split('\n');
  const head = {};
  const nodes = [];
  for (const line of lines) {
    const hm = /^Page (URL|Title): (.*)$/.exec(line);
    if (hm && nodes.length === 0) {
      head[hm[1].toLowerCase()] = hm[2];
      continue;
    }
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const bm = BOX_RE.exec(m[2]);
    nodes.push({
      depth: m[1].length,
      body: m[2].replace(BOX_RE, ''),
      box: bm ? bm.slice(1, 5).map(Number) : null,
    });
  }
  return { head, nodes };
}

// Place every node relative to the window: 'above', 'in', 'below' or
// 'hidden' (zero-size). Boxed nodes use their rect; unboxed leaves (plain
// text) inherit the last boxed node's place in document order; unboxed
// containers follow their descendants. Any ancestor of a shown node is shown.
function placeNodes(nodes, window) {
  const hasChildren = (i) => i + 1 < nodes.length && nodes[i + 1].depth > nodes[i].depth;
  let last = window.top <= 0 ? 'in' : 'above';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.box) {
      const [, y, w, h] = n.box;
      if (w === 0 && h === 0) n.place = 'hidden';
      else if (y + h < window.top) n.place = 'above';
      else if (y > window.bottom) n.place = 'below';
      else n.place = 'in';
      if (n.place !== 'hidden') last = n.place;
    } else {
      n.place = hasChildren(i) ? null : last;
    }
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.place === 'in') continue;
    let first = null;
    for (let j = i + 1; j < nodes.length && nodes[j].depth > n.depth; j++) {
      const p = nodes[j].place;
      if (p === 'in') {
        n.place = 'in';
        n.ancestor = true;
        break;
      }
      if (!first && (p === 'above' || p === 'below')) first = p;
    }
    if (n.place === null) n.place = first || 'hidden';
  }
}

const signature = (n) => n.body.replace(/ \[ref=[a-z0-9]+\]/g, '');

async function loadPrevious(path) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function run(tab, opts) {
  if (opts.scroll) {
    const dir = opts.scroll === 'up' ? -1 : 1;
    const res = await exec(`playwright-cli eval --tab=${tab} 'scrollBy(0, ${dir} * innerHeight * 0.9); "ok"'`);
    if (res.exitCode !== 0) return fail(res);
    await new Promise((r) => setTimeout(r, 300));
  }
  const metricsRes = await exec(`playwright-cli eval --tab=${tab} '${METRICS_JS}'`);
  if (metricsRes.exitCode !== 0) return fail(metricsRes);
  let m;
  try {
    m = JSON.parse(metricsRes.stdout.trim());
  } catch (_) {
    return fail({ stderr: `page-state: unexpected eval output: ${metricsRes.stdout.slice(0, 200)}\n`, exitCode: 1 });
  }
  const snapRes = await exec(`playwright-cli snapshot --tab=${tab}${opts.all ? '' : ' --boxes'}`);
  if (snapRes.exitCode !== 0) return fail(snapRes);
  const { head, nodes } = parseTree(snapRes.stdout);

  const margin = Number.isFinite(opts.margin) && opts.margin >= 0 ? opts.margin : Math.round(m.vh / 2);
  const window = { top: -margin, bottom: m.vh + margin };
  if (opts.all) for (const n of nodes) n.place = 'in';
  else placeNodes(nodes, window);

  const above = m.vh > 0 ? m.y / m.vh : 0;
  const below = m.vh > 0 ? Math.max(0, m.h - m.y - m.vh) / m.vh : 0;
  const out = [];
  out.push(`URL: ${head.url ?? '?'}`);
  out.push(`Title: ${head.title ?? ''}`);
  let scroll = `Scroll: ${above.toFixed(1)} screens above, ${below.toFixed(1)} below (viewport ${m.vw}x${m.vh}, page ${m.h}px)`;
  if (below > 0.2) scroll += ` — more below: page-state --tab=${tab} --scroll=down`;
  out.push(scroll);
  if (m.ready !== 'complete') out.push(`Document: ${m.ready} (may still be loading)`);

  const statePath = `${process.env.TMPDIR || '/tmp'}/.page-state-${tab}.json`;
  const prev = await loadPrevious(statePath);
  const prevSigs = prev && prev.url === head.url ? new Set(prev.sigs) : null;

  const shown = nodes.filter((n) => n.place === 'in');
  const hiddenAbove = nodes.filter((n) => n.place === 'above').length;
  const hiddenBelow = nodes.filter((n) => n.place === 'below').length;
  let newCount = 0;
  const tree = [];
  if (!opts.all && m.y <= 0) tree.push('[Start of page]');
  if (hiddenAbove) tree.push(`… ${hiddenAbove} snapshot lines above this window`);
  const baseDepth = shown.length ? Math.min(...shown.map((n) => n.depth)) : 0;
  for (const n of shown) {
    const isNew = prevSigs && !n.ancestor && !prevSigs.has(signature(n));
    if (isNew) newCount++;
    const body = n.body.replace(LONG_STRING_RE, (_, text) => `"${text.slice(0, MAX_TEXT)}…"`);
    tree.push(`${' '.repeat(n.depth - baseDepth)}${isNew ? '*' : ''}- ${body}`);
  }
  if (hiddenBelow) tree.push(`… ${hiddenBelow} snapshot lines below this window`);
  if (!opts.all && m.y + m.vh >= m.h - 2) tree.push('[End of page]');

  const cap = Number.isFinite(opts.maxLines) && opts.maxLines > 0 ? opts.maxLines : 300;
  if (tree.length > cap) {
    const dropped = tree.length - cap;
    tree.length = cap;
    tree.push(`… ${dropped} more lines (narrow with: playwright-cli find --tab=${tab} <text>)`);
  }
  if (prevSigs) out.push(`New since your last page-state here: ${newCount} (marked *)`);
  out.push('');
  out.push(...tree);

  try {
    await fs.writeFile(statePath, JSON.stringify({ url: head.url, sigs: nodes.map(signature) }));
  } catch (_) {
    // Marking new elements is a convenience; never fail the look over it.
  }
  process.stdout.write(out.join('\n') + '\n');
}

function fail(res) {
  process.stderr.write(res.stderr || res.stdout || 'page-state: command failed\n');
  process.exit(res.exitCode || 1);
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`${e.message}\n\n${USAGE}`);
  process.exit(2);
}
if (opts.help) {
  process.stdout.write(USAGE);
} else if (!opts.tab) {
  process.stderr.write(`page-state: --tab=<targetId> is required\n\n${USAGE}`);
  process.exit(2);
} else {
  await run(opts.tab, opts);
}
