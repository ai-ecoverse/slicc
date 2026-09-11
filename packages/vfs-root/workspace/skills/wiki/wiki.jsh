// wiki.jsh — CLI for the shared LLM wiki knowledge base at /shared/wiki.
//
// Adapted from ai-ecoverse/skills → skills/llm-wiki/wiki.jsh (post the
// bind-fs-via-require / fail-loudly-on-zero-scan fix and the NFC-normalized
// comparisons); only the WIKI_ROOT constant differs. Keep the body in sync
// with upstream when refreshing.
const fs = require('fs');
const WIKI_ROOT = '/shared/wiki';
const RAW_DIR = WIKI_ROOT + '/_raw';
const nk = (s) => String(s).normalize('NFC');

let CATS = null; // populated once by discoverCats()

async function discoverCats(soft) {
  if (CATS) return CATS;
  const root = [], nested = [];
  try {
    const top = await fs.readDir(WIKI_ROOT);
    for (const e of top) {
      const n = en(e);
      if (!n || n.startsWith('_') || n.startsWith('.')) continue;
      const dp = WIKI_ROOT + '/' + n;
      try {
        const es = await fs.readDir(dp);
        if (es.some(f => { const fn = en(f); return fn && fn.endsWith('.md'); }))
          root.push(n);
        if (n === 'projects') {
          for (const pe of es) {
            const pn = en(pe);
            if (!pn || pn.startsWith('_') || pn.startsWith('.')) continue;
            const pp = dp + '/' + pn;
            try {
              const pes = await fs.readDir(pp);
              if (pes.some(f => { const fn = en(f); return fn && fn.endsWith('.md'); }))
                nested.push('projects/' + pn);
            } catch (_) {}
          }
        }
      } catch (_) {} // not a directory or unreadable
    }
  } catch (e) {
    if (soft) return [];
    console.error('Error discovering categories: ' + e.message);
    process.exit(1);
  }
  root.sort((a, b) => a.localeCompare(b));
  nested.sort((a, b) => a.localeCompare(b));
  CATS = root.concat(nested);
  return CATS;
}

const args = process.argv.slice(2);
const sub = (args[0] || '').toLowerCase();

function en(e) {
  return typeof e === 'string' ? e : e.name;
}

async function catDirs(cs) {
  const r = [];
  for (const c of cs) {
    try {
      const es = await fs.readDir(WIKI_ROOT + '/' + c);
      for (const e of es) {
        const n = en(e);
        if (n && n.endsWith('.md')) r.push({ cat: c, file: n, path: WIKI_ROOT + '/' + c + '/' + n });
      }
    } catch (_) {}
  }
  return r;
}

function t(f) {
  return f.replace(/\.md$/, '').replace(/-/g, ' ');
}

async function find(name) {
  const cats = await discoverCats();
  let c = null, s = name;
  if (name.includes('/')) {
    const p = name.split('/');
    // Support projects/<name>/page as well as cat/page
    if (p[0] === 'projects' && p.length >= 3) {
      c = p[0] + '/' + p[1];
      s = p.slice(2).join('/');
    } else {
      c = p[0];
      s = p.slice(1).join('/');
    }
  }
  s = s.replace(/\.md$/, '');
  const ds = c ? [c] : cats;
  for (const d of ds) {
    const p = WIKI_ROOT + '/' + d + '/' + s + '.md';
    if (await fs.exists(p)) return { cat: d, file: s + '.md', path: p };
  }
  const l = nk(s).toLowerCase();
  for (const d of ds) {
    try {
      const es = await fs.readDir(WIKI_ROOT + '/' + d);
      for (const e of es) {
        const n = en(e);
        if (n && nk(n).replace(/\.md$/, '').toLowerCase() === l) return { cat: d, file: n, path: WIKI_ROOT + '/' + d + '/' + n };
      }
    } catch (_) {}
  }
  return null;
}

function wl(c) {
  const r = /\[\[([^\]]+)\]\]/g, ls = [];
  let m;
  for (m = r.exec(c); m !== null; m = r.exec(c)) {
    const target = m[1].split('|', 1)[0].trim();
    if (target) ls.push(target);
  }
  return ls;
}

async function cmdSearch() {
  const cats = await discoverCats();
  const term = args.slice(1).join(' ');
  if (!term) { console.error('Usage: wiki search <term>'); process.exit(1); }
  const lo = nk(term).toLowerCase(), pages = await catDirs(cats);
  let h = 0;
  for (const p of pages) {
    if (h >= 20) break;
    const nm = nk(p.file).toLowerCase().includes(lo);
    let lm = null;
    try {
      const c = await fs.readFile(p.path);
      for (const line of c.split('\n')) {
        if (nk(line).toLowerCase().includes(lo)) { lm = line.trim(); break; }
      }
    } catch (_) { continue; }
    if (nm || lm) { console.log('  ' + p.cat + '/' + p.file + '  —  ' + (lm || t(p.file))); h++; }
  }
  if (!h) console.log('No results for "' + term + '".');
  else console.log('\n' + h + ' result' + (h === 1 ? '' : 's') + '.');
}

async function cmdList() {
  const cats = await discoverCats();
  let c = null;
  if (args[1]) {
    const want = nk(args[1]).toLowerCase();
    c = cats.find(x => nk(x).toLowerCase() === want) || null;
    if (!c) { console.error('Unknown category: ' + args[1] + '\nCategories: ' + cats.join(', ')); process.exit(1); }
  }
  const pages = await catDirs(c ? [c] : cats);
  if (!pages.length) { console.log(c ? 'No pages in ' + c + '.' : 'No wiki pages found.'); return; }
  let cur = null;
  for (const p of pages) {
    if (p.cat !== cur) { if (cur) console.log(''); console.log(p.cat + '/'); cur = p.cat; }
    console.log('  ' + t(p.file) + '  (' + p.cat + '/' + p.file + ')');
  }
  console.log('\n' + pages.length + ' page' + (pages.length === 1 ? '' : 's') + ' total.');
}

async function cmdRead() {
  const name = args.slice(1).join(' ');
  if (!name) { console.error('Usage: wiki read <note-name>'); process.exit(1); }
  const n = await find(name);
  if (!n) { console.error('Page not found: ' + name); process.exit(1); }
  try {
    const c = await fs.readFile(n.path);
    console.log('[' + n.cat + '/' + n.file + ']\n');
    console.log(c);
  } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
}

async function cmdStats() {
  const cats = await discoverCats();
  const rows = [];
  let tot = 0;
  for (const c of cats) {
    try {
      const es = await fs.readDir(WIKI_ROOT + '/' + c);
      const md = es.filter(e => { const n = en(e); return n && n.endsWith('.md'); });
      if (md.length) rows.push('  ' + c.padEnd(24) + ' ' + md.length);
      tot += md.length;
    } catch (_) {}
  }
  let rc = 0, ea = null, la = null;
  try {
    const re = await fs.readDir(RAW_DIR);
    const mf = re.map(e => en(e)).filter(n => n && n.endsWith('.md'));
    rc = mf.length;
    const ds = [];
    for (const f of mf) { const m = f.match(/^(\d{4}-\d{2}-\d{2})_/); if (m) ds.push(m[1]); }
    ds.sort();
    if (ds.length) { ea = ds[0]; la = ds[ds.length - 1]; }
  } catch (_) {}
  if (tot === 0 && rc === 0) {
    console.error('Error: No wiki pages or raw source files found at ' + WIKI_ROOT + '.');
    process.exit(1);
  }
  console.log('Wiki pages by category:');
  for (const row of rows) console.log(row);
  console.log('  ' + 'total'.padEnd(24) + ' ' + tot);
  console.log('\nRaw source files: ' + rc);
  if (ea && la) console.log('  Date range: ' + ea + ' to ' + la);
  let tl = 0;
  const pages = await catDirs(cats);
  for (const p of pages) { try { tl += wl(await fs.readFile(p.path)).length; } catch (_) {} }
  console.log('\nTotal wikilinks: ' + tl);
}

async function cmdLinks() {
  const cats = await discoverCats();
  const name = args.slice(1).join(' ');
  if (!name) { console.error('Usage: wiki links <note-name>'); process.exit(1); }
  const n = await find(name);
  if (!n) { console.error('Page not found: ' + name); process.exit(1); }
  let ob = [];
  try { ob = [...new Set(wl(await fs.readFile(n.path)))]; } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
  console.log('Links for: ' + n.cat + '/' + n.file + '\n');
  console.log('Outbound (' + ob.length + '):');
  if (!ob.length) console.log('  (none)');
  else for (const l of ob.sort()) console.log('  -> [[' + l + ']]');
  const nm = nk(n.file).replace(/\.md$/, ''), pages = await catDirs(cats), ib = [];
  for (const p of pages) {
    if (nk(p.path) === nk(n.path)) continue;
    try { if (wl(await fs.readFile(p.path)).some(l => nk(l) === nm)) ib.push(p.cat + '/' + p.file); } catch (_) {}
  }
  console.log('\nInbound (' + ib.length + '):');
  if (!ib.length) console.log('  (none)');
  else for (const r of ib.sort()) console.log('  <- ' + r);
}

async function cmdOrphans() {
  const cats = await discoverCats();
  const pages = await catDirs(cats), linked = new Set();
  let readable = 0;
  for (const p of pages) {
    try {
      const c = await fs.readFile(p.path);
      readable++;
      for (const l of wl(c)) linked.add(nk(l));
    } catch (_) {}
  }
  if (readable === 0) {
    console.error('Error: No wiki pages could be read at ' + WIKI_ROOT + '.');
    process.exit(1);
  }
  const orph = [];
  for (const p of pages) { const s = nk(p.file).replace(/\.md$/, ''); if (!linked.has(s)) orph.push(p.cat + '/' + p.file); }
  if (!orph.length) { console.log('No orphan pages found.'); return; }
  console.log('Orphan pages (' + orph.length + '):\n');
  for (const o of orph) console.log('  ' + o);
}

async function cmdRecent() {
  const n = parseInt(args[1], 10) || 10;
  try {
    const es = await fs.readDir(RAW_DIR);
    const mf = es.map(e => en(e)).filter(n => n && n.endsWith('.md'));
    const d = [];
    for (const f of mf) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})_(.+?)_[0-9a-f]+\.md$/);
      if (m) d.push({ date: m[1], title: m[2].replace(/-/g, ' '), file: f });
    }
    d.sort((a, b) => b.date.localeCompare(a.date));
    const s = d.slice(0, n);
    console.log(s.length + ' most recent raw sources:\n');
    for (const e of s) { console.log('  ' + e.date + '  ' + e.title); console.log('             ' + e.file); }
  } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
}

async function cmdLog() {
  const n = parseInt(args[1], 10) || 10;
  const lp = WIKI_ROOT + '/log.md';
  try {
    if (!(await fs.exists(lp))) { console.log('log.md does not exist yet.'); return; }
    const c = await fs.readFile(lp), lines = c.split('\n'), entries = [];
    let cur = null;
    for (const l of lines) {
      if (l.startsWith('## ')) { if (cur) entries.push(cur); cur = { heading: l, body: [] }; }
      else if (cur) cur.body.push(l);
    }
    if (cur) entries.push(cur);
    if (!entries.length) { console.log('No log entries found.'); return; }
    const s = entries.slice(-n);
    console.log('Last ' + s.length + ' log entr' + (s.length === 1 ? 'y' : 'ies') + ':\n');
    for (const e of s) { console.log(e.heading); for (const b of e.body.filter(l => l.trim()).slice(0, 3)) console.log('  ' + b.trim()); console.log(''); }
  } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
}

async function cmdHelp() {
  const cats = await discoverCats(true);
  const catLine = cats.length ? cats.join(', ') : '(none discovered at ' + WIKI_ROOT + ')';
  console.log('wiki — LLM wiki knowledge base CLI\n\nUsage: wiki <command> [args]\n\nCommands:\n  search <term>      Search wiki pages by title and content (max 20 results)\n  list [category]    List all wiki pages, optionally filtered by category\n  read <note>        Display a wiki page (accepts name, name.md, or category/name)\n  stats              Pages per category, raw file count, date range, wikilink count\n  links <note>       Show inbound and outbound wikilinks for a note\n  orphans            Find pages with zero inbound links\n  recent [n]         Show N most recent raw source files (default 10)\n  log [n]            Show last N log.md entries (default 10)\n  help               Show this help\n\nCategories: ' + catLine + '\nWiki root:  ' + WIKI_ROOT);
}

switch (sub) {
  case 'search': await cmdSearch(); break;
  case 'list': await cmdList(); break;
  case 'read': await cmdRead(); break;
  case 'stats': await cmdStats(); break;
  case 'links': await cmdLinks(); break;
  case 'orphans': await cmdOrphans(); break;
  case 'recent': await cmdRecent(); break;
  case 'log': await cmdLog(); break;
  case 'help': await cmdHelp(); break;
  default: await cmdHelp(); break;
}
