#!/usr/bin/env node
// Measures how much of a file coding agents read, from public Hugging Face
// `format:agent-traces` datasets (Claude Code, Codex rollout and Pi session JSONL).
//
//   node packages/bench/analysis/hf-reads.mjs fetch <cache-dir>            # sample + download
//   node packages/bench/analysis/hf-reads.mjs extract <cache-dir> <out.jsonl>
//
// Rows hold aggregates only (tool, method, requested/delivered lines, file class,
// file length); no file contents, prompts or paths beyond the file's basename class.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonl, splitShell } from './lib.mjs';

/** Datasets and sampling caps. Revisions are resolved at fetch time and recorded in the cache. */
export const DATASETS = [
  { id: 'armand0e/claude-fable-5-claude-code', maxFiles: 65 },
  { id: 'choucsan/mimo-claude-code-traces-1k', maxFiles: 400 },
  { id: 'AletheiaResearch/GPT-5.5-Codex', maxFiles: 120 },
  { id: 'AletheiaResearch/Kimi-K3-Codex', maxFiles: 10 },
  { id: 'armand0e/claude-opus-4.8-pi-traces', maxFiles: 10 },
  { id: 'thomasmustier/pi-mono-sessions', maxFiles: 107 },
];
const MAX_BYTES = 250 << 20;

async function fetchDataset({ id, maxFiles }, cache) {
  const info = await (await fetch(`https://huggingface.co/api/datasets/${id}?blobs=true`)).json();
  const files = info.siblings
    .filter((s) => s.rfilename.endsWith('.jsonl'))
    .sort((a, b) => a.rfilename.localeCompare(b.rfilename));
  // Deterministic spread over the sorted list, not the first N.
  const step = Math.max(1, files.length / maxFiles);
  const pick = [];
  for (let i = 0; i < files.length && pick.length < maxFiles; i += step)
    pick.push(files[Math.floor(i)]);
  const dir = join(cache, id.replace('/', '__'));
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  const got = [];
  for (const f of pick) {
    if (bytes + (f.size ?? 0) > MAX_BYTES) continue;
    const local = join(dir, f.rfilename.replace(/\//g, '__'));
    if (!existsSync(local)) {
      const res = await fetch(
        `https://huggingface.co/datasets/${id}/resolve/${info.sha}/${f.rfilename}`
      );
      if (!res.ok) continue;
      writeFileSync(local, Buffer.from(await res.arrayBuffer()));
    }
    bytes += f.size ?? 0;
    got.push(f.rfilename);
  }
  const license =
    info.cardData?.license ??
    (info.tags ?? []).find((t) => t.startsWith('license:'))?.slice(8) ??
    'none declared';
  writeFileSync(
    join(dir, '_meta.json'),
    JSON.stringify(
      { id, sha: info.sha, license, totalFiles: files.length, sampled: got.length, bytes },
      null,
      1
    )
  );
  console.error(
    `${id}@${info.sha.slice(0, 10)} (${license}): ${got.length}/${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`
  );
}

const jsonl = (p) => readJsonl(readFileSync(p, 'utf8'));
const textOf = (c) => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('\n');
};
const list = (x) => (Array.isArray(x) ? x : []);

/** Which session format a line belongs to, if it tells. */
function harnessOf(o, current) {
  if (o.type === 'session' || o.type === 'model_change') return 'pi';
  if (o.type === 'response_item' || o.type === 'turn_context') return 'codex';
  if (current === 'unknown' && (o.type === 'assistant' || o.type === 'user') && o.uuid)
    return 'claude-code';
  return current;
}

function trackModel(o, m, s) {
  if (o.type === 'model_change') s.model = o.modelId;
  if (o.type === 'thinking_level_change') s.effort = o.thinkingLevel;
  if (o.type === 'turn_context') {
    s.model = o.payload?.model ?? s.model;
    s.effort = o.payload?.effort ?? o.payload?.reasoning_effort ?? s.effort;
  }
  const assistant = o.type === 'assistant' || (o.type === 'message' && m?.role === 'assistant');
  if (assistant && m?.model && m.model !== '<synthetic>') s.model = m.model;
}

/** Claude Code: tool_use in assistant entries, tool_result (+ toolUseResult.file) in user entries. */
function claudeCode(o, m, calls) {
  if (o.type === 'assistant')
    for (const c of list(m.content))
      if (c?.type === 'tool_use') calls.add(c.id, c.name, c.input ?? {});
  if (o.type !== 'user') return;
  for (const c of list(m.content)) {
    const call = c?.type === 'tool_result' ? calls.byId.get(c.tool_use_id) : undefined;
    if (!call) continue;
    call.output = textOf(c.content);
    if (o.toolUseResult?.file) call.meta = o.toolUseResult.file;
  }
}

/** Pi: toolCall parts in assistant messages, toolResult messages. */
function pi(m, calls) {
  if (m.role === 'assistant')
    for (const c of list(m.content))
      if (c?.type === 'toolCall') calls.add(c.id, c.name, c.arguments ?? {});
  const call = m.role === 'toolResult' ? calls.byId.get(m.toolCallId) : undefined;
  if (call) call.output = textOf(m.content);
}

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

/** Codex rollout: function_call (exec_command / shell) and function_call_output. */
function codex(p, calls) {
  if (p?.type === 'function_call') {
    const a = parseJson(p.arguments ?? '{}', {});
    const cmd = a.cmd ?? (Array.isArray(a.command) ? a.command.at(-1) : a.command);
    calls.add(p.call_id, 'bash', { command: cmd ?? '' });
  }
  const call = p?.type === 'function_call_output' ? calls.byId.get(p.call_id) : undefined;
  if (!call) return;
  let out = typeof p.output === 'string' ? p.output : textOf(p.output?.content ?? p.output);
  const j = parseJson(out, null);
  if (typeof j?.output === 'string') out = j.output;
  const i = out.indexOf('\nOutput:\n');
  call.output = i >= 0 ? out.slice(i + 9) : out;
}

/** Normalises one session to { harness, model, effort, calls: [{ name, input, output, meta, model }] }. */
export function normalise(objs) {
  const s = { harness: 'unknown', model: null, effort: null, calls: [] };
  const calls = {
    byId: new Map(),
    add(id, name, input) {
      const model = s.model?.replace(/^anthropic\//, '') ?? null;
      const c = { name, input, output: '', meta: null, model, effort: s.effort };
      this.byId.set(id, c);
      s.calls.push(c);
    },
  };
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue;
    const m = o.message && typeof o.message === 'object' ? o.message : null;
    s.harness = harnessOf(o, s.harness);
    trackModel(o, m, s);
    if (m && (o.type === 'assistant' || o.type === 'user')) claudeCode(o, m, calls);
    if (m && o.type === 'message') pi(m, calls);
    if (o.type === 'response_item') codex(o.payload, calls);
  }
  if (s.model) s.model = s.model.replace(/^anthropic\//, '');
  return s;
}

const CODE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|scala|sh|lua|zig|vue|svelte|css|scss|html)$/i;
export function fileClass(path) {
  const b = path.split(/[\\/]/).pop() ?? '';
  if (/^SKILL\.md$/i.test(b)) return 'skill';
  if (/^(CLAUDE|AGENTS|GEMINI)\.md$|^\.cursorrules$|copilot-instructions\.md$/i.test(b))
    return 'agent-instructions';
  if (/^README/i.test(b) || /\.(md|mdx|rst)$/i.test(b) || /[\\/]docs?[\\/]/.test(path))
    return 'docs';
  if (CODE.test(b)) return 'source';
  return 'other';
}
const pathKey = (p) =>
  String(p).replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean).slice(-2).join('/');

const READERS = new Set([
  'cat',
  'head',
  'tail',
  'sed',
  'nl',
  'less',
  'more',
  'bat',
  'awk',
  'Get-Content',
  'type',
]);
const headCount = (s) => {
  const m = /(?:^|\s)-n\s*(\d+)|(?:^|\s)-(\d+)\b/.exec(s);
  return m ? Number(m[1] ?? m[2]) : 10;
};
/** `sed -n 'a,bp'` / `sed -n 'ap'` → { from, to }, else the whole file from line 1. */
const sedRange = (s) => {
  const r = /(\d+)\s*,\s*(\d+)\s*p/.exec(s) ?? /(?:^|['"\s])(\d+)p['"]?/.exec(s);
  return r ? { from: Number(r[1]), to: Number(r[2] ?? r[1]) } : { from: 1, to: null };
};

/** File arguments of a reader command: not flags, not sed scripts, and path-like. */
function fileArgs(words) {
  const isArg = (w) =>
    (!w.startsWith('-') &&
      !/^['"]?\d+(,\d+)?p['"]?$/.test(w) &&
      !/^\d+$/.test(w) &&
      !/^['"].*['"]$/.test(w)) ||
    /^['"][^'"]*\.[\w]+['"]$/.test(w);
  return words
    .slice(1)
    .filter(isArg)
    .map((w) => w.replace(/^['"]|['"]$/g, ''))
    .filter((w) => /[./]/.test(w) && !/[<>*$`]/.test(w) && !w.startsWith('/dev/'));
}

/** `cat`/`nl`/`less` piped into a filter: the filter decides. Null when it isn't a read (wc). */
function pagerRead(cmd, next) {
  const f = (next ?? '').split(/\s+/)[0];
  const base = cmd === 'nl' ? 'nl' : 'cat';
  if (f === 'head') {
    const to = headCount(next);
    return { method: `${base}|head`, n: to, from: 1, to };
  }
  if (f === 'sed') return { method: `${base}|sed`, n: null, ...sedRange(next) };
  if (f === 'wc') return null;
  const tail = f === 'grep' || f === 'rg' ? '|grep' : f ? `|${f}` : '';
  return { method: base + tail, n: null, from: 1, to: null };
}

function readerShape(cmd, stages) {
  if (cmd === 'head') {
    if (/-c\s*\d+/.test(stages[0])) return { method: 'head -c', n: null, from: 1, to: null };
    const to = headCount(stages[0]);
    return { method: 'head', n: to, from: 1, to };
  }
  if (cmd === 'sed') return { method: 'sed -n', n: null, ...sedRange(stages[0]) };
  if (cmd === 'tail' || cmd === 'awk') return { method: cmd, n: null, from: 1, to: null };
  return pagerRead(cmd, stages[1]);
}

/** File reads inside one bash command: [{ path, method, n, from, to, multi }]. */
export function bashReads(command) {
  const out = [];
  for (const raw of splitShell(String(command ?? ''), ['&&', '||', ';', '\n'])) {
    const stages = splitShell(raw.trim(), ['|'])
      .map((x) => x.trim())
      .filter(Boolean);
    const words = stages[0]?.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    const cmd = (words[0] ?? '').replace(/^.*\//, '');
    const files = READERS.has(cmd) ? fileArgs(words) : [];
    const shape = files.length ? readerShape(cmd, stages) : null;
    if (!shape) continue;
    for (const path of files) out.push({ path, ...shape, multi: files.length > 1 });
  }
  return out;
}

const lineCount = (t) => (t ? t.replace(/\n$/, '').split('\n').length : 0);
const isReadTool = (c) => /^read$/i.test(c.name) || c.name === 'read_file';
const isBash = (c) => c.name === 'bash' || c.name === 'Bash';
const readPath = (c) => c.input.file_path ?? c.input.path;

/** What a read-tool call reveals about the file's length. */
function readToolLength(c, note) {
  const f = /\[Showing lines \d+-\d+ of (\d+)/.exec(c.output) ?? /of (\d+) lines/.exec(c.output);
  if (f) note(readPath(c), Number(f[1]));
  const more = /\[(\d+) more lines in file\. Use offset=(\d+)/.exec(c.output);
  if (more) note(readPath(c), Number(more[1]) + Number(more[2]) - 1);
  if (/\[Showing lines|more lines in file|truncated/i.test(c.output) || !c.output || c.meta) return;
  const n = lineCount(c.output);
  // Whole-file read, or a limit that came back short (end of file).
  if (!c.input.limit || n < c.input.limit) note(readPath(c), (c.input.offset ?? 1) - 1 + n);
}

/** What a bash call reveals: `wc -l`, a whole `cat`, or a window that came back short (EOF). */
function bashLength(c, note) {
  if (/wc\s+-l/.test(c.input.command ?? ''))
    for (const m of String(c.output).matchAll(/^\s*(\d+)\s+(\S+)$/gm)) note(m[2], Number(m[1]));
  const r = bashReads(c.input.command);
  const clean = r.length === 1 && !r[0].multi && c.output && !/truncated|omitted/i.test(c.output);
  if (!clean) return;
  const n = lineCount(c.output);
  if (r[0].method === 'cat') note(r[0].path, n);
  if (r[0].to && n < r[0].to - r[0].from + 1) note(r[0].path, r[0].from - 1 + n);
}

/** pathKey → longest file length the session reveals. */
function fileLengths(s) {
  const total = new Map();
  const note = (p, n) => {
    if (Number.isFinite(n) && n > 0) total.set(pathKey(p), Math.max(total.get(pathKey(p)) ?? 0, n));
  };
  for (const c of s.calls) {
    if (c.meta?.totalLines) note(c.meta.filePath, c.meta.totalLines);
    if (isReadTool(c)) readToolLength(c, note);
    if (isBash(c)) bashLength(c, note);
  }
  return total;
}

function readToolRead(c) {
  const path = readPath(c);
  if (!path) return [];
  const { offset, limit } = c.input;
  const method =
    offset == null && limit == null
      ? 'read (default)'
      : limit != null
        ? 'read limit'
        : 'read offset';
  const body = c.output
    ? c.output.replace(/\n*\[(Showing lines|\d+ more lines)[^\]]*\]\s*$/, '')
    : '';
  return [
    {
      path,
      tool: 'read-tool',
      method,
      requested: limit ?? null,
      from: offset ?? c.meta?.startLine ?? 1,
      delivered: c.meta?.numLines ?? (c.output ? lineCount(body) : null),
      truncated: /\[Showing lines \d+-\d+ of/.test(c.output ?? '') && !limit,
      full: c.meta ? c.meta.startLine <= 1 && c.meta.numLines >= c.meta.totalLines : undefined,
    },
  ];
}

function bashRead(c) {
  const reads = bashReads(c.input.command);
  const single = reads.length === 1 && !reads[0].multi;
  const out = single ? String(c.output ?? '') : '';
  const truncated = /tokens truncated|\[\.\.\. ?omitted|Output truncated/i.test(out);
  return reads.map((r) => {
    const requested = r.to ? r.to - r.from + 1 : null;
    return {
      path: r.path,
      tool: 'bash',
      method: r.method,
      requested,
      from: r.from,
      delivered: out ? lineCount(out) : requested,
      truncated,
      full: r.method === 'cat' && !truncated && single ? true : undefined,
    };
  });
}

/** Read events of one session with delivered lines and, where the session reveals it, file length. */
export function sessionReads(s) {
  const total = fileLengths(s);
  const seen = new Map();
  const events = [];
  for (const c of s.calls) {
    const reads = isReadTool(c) ? readToolRead(c) : isBash(c) ? bashRead(c) : [];
    for (const e of reads) {
      const k = pathKey(e.path);
      const fl = total.get(k) ?? null;
      seen.set(k, (seen.get(k) ?? 0) + 1);
      const known = fl && e.delivered != null;
      events.push({
        harness: s.harness,
        model: c.model ?? s.model,
        effort: c.effort ?? s.effort,
        tool: e.tool,
        method: e.method,
        requested: e.requested ?? null,
        from: e.from ?? 1,
        delivered: e.delivered,
        fileLines: fl,
        frac: known ? Math.min(1, e.delivered / fl) : null,
        full: e.full ?? (known ? (e.from ?? 1) <= 1 && e.delivered >= fl * 0.95 : null),
        cls: fileClass(e.path),
        ordinal: seen.get(k),
        truncated: e.truncated ?? false,
      });
    }
  }
  return events;
}

const sessionId = (f) => f.replace(/\.jsonl$/, '').slice(-12);
const writeRows = (out, rows) =>
  writeFileSync(out, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

function extract(cache, out) {
  const rows = [];
  for (const d of DATASETS) {
    const dir = join(cache, d.id.replace('/', '__'));
    if (!existsSync(dir)) continue;
    let sessions = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const s = normalise(jsonl(join(dir, f)));
      if (!s.calls.length) continue;
      sessions++;
      for (const e of sessionReads(s)) rows.push({ dataset: d.id, session: sessionId(f), ...e });
    }
    console.error(`${d.id}: ${sessions} sessions`);
  }
  writeRows(out, rows);
  console.error(`${rows.length} read events → ${out}`);
}

/** Your own Claude Code logs (~/.claude/projects): a control for "same model, other harness". */
function extractLocal(root, out, days) {
  const cutoff = Date.now() - days * 864e5;
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs > cutoff) files.push(p);
    }
  };
  walk(root);
  const rows = [];
  for (const f of files) {
    const s = normalise(jsonl(f));
    if (s.harness !== 'claude-code' || !s.calls.length) continue;
    for (const e of sessionReads(s))
      rows.push({ dataset: 'local/claude-code', session: sessionId(f), ...e });
  }
  writeRows(out, rows);
  console.error(`${files.length} local sessions, ${rows.length} read events → ${out}`);
}

async function main() {
  const [mode, dir, out, days] = process.argv.slice(2);
  if (mode === 'fetch' && dir) for (const d of DATASETS) await fetchDataset(d, dir);
  else if (mode === 'extract' && dir && out) extract(dir, out);
  else if (mode === 'extract-local' && dir && out) extractLocal(dir, out, Number(days ?? 60));
  else {
    console.error(
      'usage: hf-reads.mjs fetch <cache-dir> | extract <cache-dir> <out.jsonl> | extract-local <dir> <out.jsonl> [days]'
    );
    process.exit(2);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
