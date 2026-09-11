/**
 * `gelatiere` — the shell surface of SLICC's resident advisor (the body;
 * `../gelatiere-command.ts` is the thin registration that lazy-loads this
 * file so the help text and the store stay out of the worker's eager
 * bundle).
 *
 * The gelatiere is a persistent scoop (`scoops/gelatiere-unit.ts`) that
 * runs its passes in its own conversation; this command is how those passes
 * land and how anyone else pokes it:
 *
 *   init                 create the unit + its nightly crontask (idempotent)
 *   run                  lick the unit: "do a pass now"
 *   suggest <file>       the gelatiere's last step — fold candidates into the store
 *   deliver              the gelatiere's other last step — lick every other cone
 *   catalog | commands | man <cmd>   pinned-host fetches (the unit has no curl)
 *   list | dismiss | status
 *
 * `shell/` sits below `scoops/`, so the orchestrator-facing operations come
 * through the seam the kernel host publishes on `globalThis.__slicc_gelatiere`
 * (mirrored structurally here, like `__slicc_agent`); the pure store logic is
 * `base/gelatiere-store.ts`, a legal down-edge.
 */

import type { VirtualFS } from '../../../fs/index.js';
import { defaultLickTarget, type LickTargetEnv } from '../../lick-target-env.js';
import { parseKnownFlags } from '../subcommand-flags.js';
import { isHelpRequest } from '../subcommand-help.js';

type CommandResult = { stdout: string; stderr: string; exitCode: number };

/** Mirror of `GelatiereSeam` (`scoops/gelatiere-unit.ts`). */
interface GelatiereRootLike {
  folder: string;
  name: string;
  jid: string;
}
interface GelatiereSeamLike {
  ensureUnit(): Promise<{ folder: string; jid: string; created: boolean }>;
  unregisterOwned(): Promise<string[]>;
  unit(): GelatiereRootLike | undefined;
  roots(): GelatiereRootLike[];
  ensureNightly(cron: string): Promise<{ id: string; cron: string; created: boolean }>;
  nightly(): { id: string; cron: string } | undefined;
  lick(target: string, body: unknown): void;
}

interface GelatiereGlobals {
  __slicc_gelatiere?: GelatiereSeamLike;
}

export interface GelatiereCommandOptions {
  fs: VirtualFS;
}

const HELP = `usage: gelatiere <command> [options]

The gelatiere is SLICC's resident advisor: a persistent unit no cone owns that
reviews your archived sessions — nightly, and after a chat ends — and suggests
skills to install, use cases to try, and habits to change. Suggestions show up
as cards in the suggestions sprinkle and every cone gets a lick.

Commands:
  init [--reset]       Create the gelatiere unit and its nightly crontask (idempotent);
                       --reset first drops every unit the gelatiere owner holds
  run                  Ask the gelatiere for a pass right now
  suggest <file>       Fold a pass's candidates (JSON) into the store — the gelatiere's own step
  deliver [options]    Lick every other cone with the open suggestions — the gelatiere's other step
  list [--all|--json]  Show open suggestions (--all includes taken and dismissed)
  dismiss <id>         Wave a suggestion away so it is not shown again
  status               Unit, nightly schedule, last pass, last delivery, counts
  catalog              The skill catalog (JSON) from www.sliccy.com
  commands             Every shell command SLICC ships, from the sitemap
  man <command>        One man page, plain text

deliver options:
  --scoop <target>     One cone (folder, name or jid) instead of every cone; does not
                       advance the delivery watermark, so the others still get theirs
  --force              Send even when nothing is new since the last delivery

Files:
  /shared/GELATIERE.md                 Pass instructions + config (intervalHours, nightly, maxSuggestions)
  /shared/.gelatiere/suggestions.json  Every suggestion; takenAt when acted on, dismissedAt when waved away
  /shared/.gelatiere/state.json        Pass and delivery ledger

Examples:
  gelatiere init
  gelatiere run
  gelatiere suggest "$TMPDIR/candidates.json" && gelatiere deliver
  gelatiere dismiss skill-github
`;

const DELIVER_VALUE_FLAGS = ['--scoop'] as const;

function ok(stdout: string): CommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(message: string): CommandResult {
  return { stdout: '', stderr: `gelatiere: ${message}\n`, exitCode: 1 };
}

const NO_SEAM = 'kernel host has not booted yet — try again in a moment';

function seam(): GelatiereSeamLike | null {
  const found = (globalThis as unknown as GelatiereGlobals).__slicc_gelatiere;
  return found && typeof found.roots === 'function' ? found : null;
}

function loadStore(): Promise<typeof import('../../../base/gelatiere-store.js')> {
  return import('../../../base/gelatiere-store.js');
}

async function handleInit(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { bool: ['--reset'] });
  if ('error' in parsed) return fail(parsed.error);
  const host = seam();
  if (!host) return fail(NO_SEAM);
  const store = await loadStore();
  const config = await store.loadGelatiereConfig(fs);
  let dropped = '';
  if (parsed.bools.has('--reset')) {
    const jids = await host.unregisterOwned();
    dropped = jids.length ? `Dropped ${jids.length} gelatiere unit(s): ${jids.join(', ')}\n` : '';
  }
  let unit: { folder: string; jid: string; created: boolean };
  try {
    unit = await host.ensureUnit();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const nightly = await host.ensureNightly(config.nightly);
  return ok(
    dropped +
      `${unit.created ? 'Created' : 'Found'} the gelatiere (${unit.jid}, folder ${unit.folder})\n` +
      `${nightly.created ? 'Registered' : 'Found'} nightly pass: cron "${nightly.cron}" (${nightly.id})\n` +
      'Suggestions render in the suggestions card; `gelatiere run` asks for a pass now.\n'
  );
}

async function handleRun(env: LickTargetEnv): Promise<CommandResult> {
  const host = seam();
  if (!host) return fail(NO_SEAM);
  let unit: { folder: string; jid: string };
  try {
    unit = await host.ensureUnit();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const requester = defaultLickTarget(undefined, env) ?? 'the default cone';
  host.lick(unit.folder, { action: 'run', data: { reason: 'manual', requestedBy: requester } });
  return ok(
    `Asked the gelatiere (${unit.jid}) for a pass. Suggestions land in the suggestions card.\n`
  );
}

async function handleSuggest(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const file = args[0];
  if (!file) return fail('suggest requires a JSON file: gelatiere suggest <file>');
  const store = await loadStore();
  let raw: unknown;
  try {
    const text = await fs.readFile(file, { encoding: 'utf-8' });
    raw = JSON.parse(typeof text === 'string' ? text : new TextDecoder().decode(text));
  } catch (error) {
    return fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { added, open } = await store.recordPass(fs, raw);
  let output = `Pass recorded: ${added.length} new, ${open.length} open\n`;
  for (const s of added) output += `  + ${s.id}  [${s.kind}]  ${s.title}\n`;
  if (added.length === 0) output += 'Nothing new (every candidate was already known or invalid).\n';
  return ok(output);
}

async function handleDeliver(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { value: DELIVER_VALUE_FLAGS, bool: ['--force'] });
  if ('error' in parsed) return fail(parsed.error);
  const host = seam();
  if (!host) return fail(NO_SEAM);
  const store = await loadStore();
  const all = await store.readGelatiereSuggestions(fs);
  const open = store.openSuggestions(all);
  const state = await store.readGelatiereState(fs);
  const added = store.suggestionsSince(all, state.lastDeliveredAt);
  if (added.length === 0 && !parsed.bools.has('--force')) {
    return ok('Nothing new since the last delivery; no lick sent (use --force to resend).\n');
  }
  // An unresolvable explicit target would drop the lick downstream while this
  // command still stamped `lastDeliveredAt` — and the next ordinary delivery
  // would then say "nothing new". Validate against the roster before sending.
  const roster = host.roots();
  const explicit = parsed.values.get('--scoop');
  const resolves = (r: GelatiereRootLike): boolean =>
    r.folder === explicit || r.name === explicit || r.jid === explicit;
  if (explicit && !roster.some(resolves)) {
    const known = roster.map((r) => r.folder).join(', ') || 'none running';
    return fail(`unknown delivery target "${explicit}" (cones: ${known})`);
  }
  const targets = explicit ? [explicit] : roster.map((r) => r.folder);
  if (targets.length === 0) return fail('no cone is running to deliver to');
  const body = store.buildGelatiereLickBody(added, open);
  for (const target of targets) host.lick(target, body);
  // `lastDeliveredAt` records what EVERY cone has been told, so only a
  // broadcast advances it. A targeted send that stamped it would make the
  // next ordinary delivery compute "nothing new" and the other cones would
  // never hear about these suggestions.
  if (!explicit) {
    await store.writeGelatiereState(fs, { ...state, lastDeliveredAt: new Date().toISOString() });
  }
  const note = explicit ? ' (targeted; the delivery watermark is unchanged)' : '';
  return ok(
    `Delivered ${added.length} new (${open.length} open) to ${targets.length} cone(s): ${targets.join(', ')}${note}\n`
  );
}

async function handleList(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const parsed = parseKnownFlags(args, { bool: ['--all', '--json'] });
  if ('error' in parsed) return fail(parsed.error);
  const store = await loadStore();
  const all = await store.readGelatiereSuggestions(fs);
  const shown = parsed.bools.has('--all') ? all : store.openSuggestions(all);
  if (parsed.bools.has('--json')) return ok(`${JSON.stringify(shown, null, 2)}\n`);
  if (shown.length === 0) {
    return ok(
      all.length === 0
        ? 'No suggestions yet. `gelatiere run` asks for a pass now.\n'
        : 'No open suggestions (every one has been taken or dismissed; `--all` lists them).\n'
    );
  }
  let output = '';
  for (const s of shown) {
    const state = s.dismissedAt ? ' (dismissed)' : s.takenAt ? ' (taken)' : '';
    output += `${s.id}  [${s.kind}]${state}\n  ${s.title}\n`;
    if (s.install) output += `  install: ${s.install}\n`;
    if (s.prompt) output += `  try: ${s.prompt}\n`;
  }
  return ok(output);
}

async function handleDismiss(args: string[], fs: VirtualFS): Promise<CommandResult> {
  const id = args[0];
  if (!id) return fail('dismiss requires a suggestion id (see `gelatiere list`)');
  const store = await loadStore();
  return (await store.dismissGelatiereSuggestion(fs, id))
    ? ok(`Dismissed ${id}.\n`)
    : fail(`no open suggestion with id "${id}"`);
}

/**
 * The pass recipe's whole web surface, served through pinned-host fetches so
 * the unit needs no `curl`: for a child unit `allowedCommands` is the only
 * network gate, and an unattended agent that reads third-party content while
 * seeing `/sessions/` must not hold general egress (an injected catalog line
 * could otherwise exfiltrate any archive). These verbs fetch three known
 * `www.sliccy.com` resources and nothing else.
 */
const GELATIERE_FETCH_ORIGIN = 'https://www.sliccy.com';
/** Man pages cap: the recipe only ever wanted `head -60` worth. */
const MAN_BYTE_CAP = 16_000;
/** Catalog / sitemap cap — generous, but bounded against a hijacked CDN. */
const FETCH_BYTE_CAP = 512_000;
const MAN_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

async function fetchSliccy(path: string, cap: number): Promise<string> {
  const response = await fetch(`${GELATIERE_FETCH_ORIGIN}${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const text = await response.text();
  return text.length > cap ? text.slice(0, cap) : text;
}

async function handleCatalog(): Promise<CommandResult> {
  try {
    const body = await fetchSliccy('/skills/catalog.json', FETCH_BYTE_CAP);
    return ok(body.endsWith('\n') ? body : `${body}\n`);
  } catch (error) {
    return fail(`catalog fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleCommands(): Promise<CommandResult> {
  try {
    const xml = await fetchSliccy('/sitemap.xml', FETCH_BYTE_CAP);
    const names = [...xml.matchAll(/<loc>[^<]*\/man\/([a-z0-9-]+)(?:\.html)?<\/loc>/g)]
      .map((m) => m[1])
      .sort();
    if (names.length === 0) return fail('no man pages found in the sitemap');
    return ok(`${[...new Set(names)].join(' ')}\n`);
  } catch (error) {
    return fail(`sitemap fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleMan(args: string[]): Promise<CommandResult> {
  const name = args[0];
  if (!name) return fail('man requires a command name: gelatiere man <command>');
  // The name lands in the URL path; only a plain command slug may travel.
  if (!MAN_NAME_RE.test(name)) return fail(`not a command name: "${name}"`);
  try {
    const body = await fetchSliccy(`/man/${name}.plain.html`, MAN_BYTE_CAP);
    return ok(body.endsWith('\n') ? body : `${body}\n`);
  } catch (error) {
    return fail(`man fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleStatus(fs: VirtualFS): Promise<CommandResult> {
  const store = await loadStore();
  const host = seam();
  const unit = host?.unit();
  const config = await store.loadGelatiereConfig(fs);
  const state = await store.readGelatiereState(fs);
  const all = await store.readGelatiereSuggestions(fs);
  let output = '';
  // The unit itself survives the flag being turned off (it is a frozen
  // transcript without licks) — say so, or "registered" reads like "active".
  const { isMemoryV2Enabled } = await import('../../../transcript/memory-v2-flag.js');
  if (!isMemoryV2Enabled()) {
    output +=
      'Memory v2:      OFF — the nightly is unscheduled and session ends do not trigger passes\n';
  }
  output += `Unit:           ${unit ? `${unit.jid} (folder ${unit.folder})` : 'not created — run `gelatiere init`'}\n`;
  const nightly = host?.nightly();
  output += `Nightly:        ${nightly ? `registered, cron "${nightly.cron}" (${nightly.id})` : `not registered — run \`gelatiere init\` (cron "${config.nightly}")`}\n`;
  output += `Interval:       ${config.intervalHours}h between session-end passes\n`;
  output += `Passes:         ${state.passes}\n`;
  output += `Last pass:      ${state.lastPassAt ?? 'never'}\n`;
  output += `Last trigger:   ${state.lastTriggeredAt ?? 'never'}\n`;
  output += `Last delivery:  ${state.lastDeliveredAt ?? 'never'}\n`;
  output += `Suggestions:    ${store.openSuggestions(all).length} open, ${store.takenSuggestions(all).length} taken, ${all.length} total\n`;
  return ok(output);
}

/** The command body: `args` after the `gelatiere` word, the shell context, the shared FS. */
export async function runGelatiere(
  args: string[],
  ctx: { env: LickTargetEnv },
  options: GelatiereCommandOptions
): Promise<CommandResult> {
  const subcommand = args[0];
  if (!subcommand || isHelpRequest(args, { valueFlags: DELIVER_VALUE_FLAGS })) return ok(HELP);
  const rest = args.slice(1);
  switch (subcommand) {
    case 'init':
      return handleInit(rest, options.fs);
    case 'run':
      return handleRun(ctx.env);
    case 'suggest':
      return handleSuggest(rest, options.fs);
    case 'deliver':
      return handleDeliver(rest, options.fs);
    case 'list':
      return handleList(rest, options.fs);
    case 'dismiss':
      return handleDismiss(rest, options.fs);
    case 'status':
      return handleStatus(options.fs);
    case 'catalog':
      return handleCatalog();
    case 'commands':
      return handleCommands();
    case 'man':
      return handleMan(rest);
    default:
      return fail(`unknown command: ${subcommand}\n${HELP}`);
  }
}
