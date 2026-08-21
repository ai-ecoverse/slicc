// fx — run Vercel's fx coding agent (https://fx.sh) inside SLICC on fx-core.wasm
// (ipk-installed `libfx`). Model traffic → this realm's fetch; fx's shell tool →
// require('sliccy:exec') on the SLICC VFS; config/sessions → /workspace/.fx/.
// Run `fx --help` for usage; see SKILL.md for setup and credentials.

const LIBFX_SPEC = 'libfx@0.0.4';
const ESBUILD_SPEC = 'esbuild-wasm@0.28.2'; // ESM→CJS transpile of fx-sdk.js
const STATE_DIR = '/workspace/.fx';
const WORKSPACE_ROOT = '/workspace';

const argv = process.argv.slice(2);
const opts = { model: null, session: null, sessions: false, models: false, json: false, help: false };
const words = [];
while (argv.length) {
  const a = argv.shift();
  if (a === '-h' || a === '--help') opts.help = true;
  else if (a === '--model' || a === '-m') opts.model = argv.shift();
  else if (a === '--session' || a === '-s') opts.session = argv.shift();
  else if (a === '--sessions') opts.sessions = true;
  else if (a === '--models') opts.models = true;
  else if (a === '--json') opts.json = true;
  else words.push(a);
}
const prompt = words.join(' ').trim();

if (opts.help || (!prompt && !opts.sessions && !opts.models)) {
  console.log(
    [
      'Usage: fx [--model <id>] [--session <id>] [--json] "<prompt>"',
      '       fx --sessions | fx --models',
      '',
      'Runs the fx coding agent (fx.sh) in-process on fx-core.wasm; its shell tool',
      'executes in this SLICC shell. Needs AI_GATEWAY_API_KEY (auto-seeded when the',
      `selected provider is vercel-ai-gateway), \`ipk add ${ESBUILD_SPEC}\` and \`ipk add ${LIBFX_SPEC}\`.`,
    ].join('\n')
  );
  process.exit(opts.help ? 0 : 2);
}

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) {
  console.error(
    'fx: AI_GATEWAY_API_KEY is not set. Add a "Vercel AI Gateway" account and select one of its models, or run `AI_GATEWAY_API_KEY=… fx …`.'
  );
  process.exit(1);
}

let sdk;
try {
  sdk = require('libfx/wasm');
} catch (err) {
  console.error(
    `fx: cannot load libfx (run: ipk add ${ESBUILD_SPEC} && ipk add ${LIBFX_SPEC}). ${err.message}`
  );
  process.exit(1);
}
if (typeof sdk.supportsJspi === 'function' && !sdk.supportsJspi()) {
  console.error('fx: this runtime has no WebAssembly JSPI (needs Chrome 137+).');
  process.exit(1);
}

const fs = require('fs');
const { exec } = require('sliccy:exec');

// fx-core.wasm: prefer the kernel-side compile bridge, fall back to bytes.
function findWasmPath() {
  const candidates = [
    `${process.cwd()}/node_modules/libfx/fx-core.wasm`,
    '/workspace/node_modules/libfx/fx-core.wasm',
    '/shared/node_modules/libfx/fx-core.wasm',
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[1];
}
async function loadWasm() {
  const path = findWasmPath();
  if (typeof globalThis.__slicc_compileWasm === 'function') {
    return globalThis.__slicc_compileWasm(path);
  }
  const bytes = fs.readFileSync(path);
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(path, value) {
  fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value));
}
const configPath = `${STATE_DIR}/config.json`;
const configStore = {
  get: (id) => {
    const v = readJson(configPath, {})[id];
    return typeof v === 'string' ? v : null;
  },
  set: (id, value) => {
    const all = readJson(configPath, {});
    all[id] = value;
    writeJson(configPath, all);
  },
};
// Sessions: one JSON file per id with a revision-checked commit.
const sessionPath = (id) => `${STATE_DIR}/sessions/${encodeURIComponent(id)}.json`;
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const sessionStore = {
  load: (id) => {
    const rec = readJson(sessionPath(id), null);
    return rec ? { bytes: unb64(rec.value), revision: rec.revision } : null;
  },
  commit: (id, bytes, expectedRevision) => {
    const rec = readJson(sessionPath(id), null);
    if (rec?.revision !== expectedRevision) {
      const err = new Error('fx session revision conflict');
      err.code = 'FX_SESSION_REVISION_CONFLICT';
      throw err;
    }
    const revision = String((Number(rec?.revision) || 0) + 1);
    writeJson(sessionPath(id), { revision, updatedAtMs: Date.now(), value: b64(bytes) });
    return { revision };
  },
  list: () => {
    let names = [];
    try {
      names = fs.readdirSync(`${STATE_DIR}/sessions`);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        const id = decodeURIComponent(n.slice(0, -5));
        const rec = readJson(sessionPath(id), null);
        return rec ? { id, updatedAtMs: rec.updatedAtMs || 0 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  },
  remove: (id) => {
    try {
      fs.unlinkSync(sessionPath(id));
    } catch {
      /* already gone */
    }
  },
};

// fx's shell tool → this SLICC shell.
const workspace = {
  info: {
    version: 1,
    root: WORKSPACE_ROOT,
    cwd: WORKSPACE_ROOT,
    home: WORKSPACE_ROOT,
    gitAvailable: false,
    ephemeral: true,
  },
  permission: 'allow-sandboxed',
  exec: async ({ command }) => {
    const r = await exec(`cd ${WORKSPACE_ROOT} && ${command}`);
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  },
};

function pickPermission(request) {
  const options = Array.isArray(request?.options) ? request.options : [];
  const allow = options.find((o) => /allow/i.test(String(o.kind || o.name || '')));
  return (allow || options[0])?.optionId ?? null;
}

const agent = await sdk.createFxAgent({
  wasm: await loadWasm(),
  env: { AI_GATEWAY_API_KEY: apiKey, HOME: WORKSPACE_ROOT },
  fetch: (url, init) => fetch(url, init),
  onPermission: async (request) => pickPermission(request),
  configStore,
  sessionStore,
  workspace,
});

try {
  if (opts.sessions) {
    const list = await agent.listSessions();
    if (!list.length) console.log('(no stored sessions)');
    for (const s of list) console.log(JSON.stringify(s));
  } else {
    const session = opts.session ? await agent.openSession(opts.session) : await agent.createSession();
    if (opts.models) {
      const modelOpt = (session.configOptions || []).find((o) => o.id === 'model');
      for (const o of modelOpt?.options || []) console.log(o.value === modelOpt.currentValue ? `* ${o.value}` : `  ${o.value}`);
    } else {
      if (opts.model) await session.setModel(opts.model);
      const turn = session.prompt(prompt);
      let wroteText = false;
      for await (const update of turn) {
        if (opts.json) {
          console.log(JSON.stringify(update));
          continue;
        }
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          process.stdout.write(update.content.text);
          wroteText = true;
        } else if (update.sessionUpdate === 'tool_call') {
          process.stderr.write(`[tool] ${update.title || update.kind || 'call'}\n`);
        }
      }
      if (wroteText) process.stdout.write('\n');
      const stop = await turn.stopReason;
      if (stop !== 'end_turn') console.error(`fx: stopped (${stop})`);
    }
    await session.close();
  }
} finally {
  await agent.close();
}
