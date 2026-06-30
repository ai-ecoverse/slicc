#!/usr/bin/env node
// cup-clean: the "I'm done — remove all cup orphans" sweep. A live cup leaves orphans
// that `cup-stop` doesn't reap (it only stops the ONE node-server in cup.json): the
// shared cup-dev wrangler (+ workerd), the cup's Chrome, orphaned lick-back handler
// scripts, and stale state files. This finds and stops ALL of them and reports each.
//
// SAFE by construction (the matching lives in _lib's classifyCupProcess, unit-tested):
// it touches ONLY cup infrastructure — NEVER your everyday Chrome (default profile), a
// `claude` session, or an unrelated wrangler — and re-confirms each pid's command line
// before SIGKILL (pid-reuse guard). It never kills its own shell (selfPids).
//
//   --dry-run    list what WOULD be removed; touch nothing.
//   --profiles   also delete the profile dir of each identified cup Chrome (drops its
//                saved logins) — derived from the cup Chrome's own --user-data-dir, so
//                it can never target a non-cup standalone's profile.
//   --help / -h  print usage and exit WITHOUT touching anything.
//
// Args are validated up front: an unrecognized flag (e.g. a typo'd `--dry-rn`) prints
// usage and exits 2 WITHOUT acting, so a mistyped flag can never trigger a destructive
// run. Exits 0 on a normal run / --help; exits 2 on an unknown flag.
// tva
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyCupProcess,
  cupDiscoveryPath,
  cupProfileDirFromCommand,
  cupRepoDir,
  drainsDir,
  isDirectRun,
  lickbackDir,
  parseCleanArgs,
  parsePsEntries,
  planStateCleanup,
  readCupRecord,
  selectCupOrphans,
  stopByPid,
} from './_lib.mjs';

const USAGE = `cup-clean — stop all SLICC cup orphans (cup server, dev-UI wrangler + workerd,
cup Chrome, chat-handler scripts) and clear stale state files.

Usage: cup-clean.mjs [--dry-run] [--profiles] [--help]

  --dry-run    preview what would be removed; touch nothing
  --profiles   also delete the profile dir of each cup Chrome being stopped (drops its
               saved logins) — only profiles of identified cup Chromes, never others
  --help, -h   show this help and exit (does nothing else)

Safe by design: only cup infrastructure is touched — never your everyday Chrome,
a Claude session, or an unrelated wrangler.
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const CATEGORY_LABEL = {
  'cup-node': 'cup server',
  'lickback-script': 'chat handler',
  wrangler: 'dev UI (wrangler)',
  'wrangler-runtime': 'dev UI (workerd)',
  'cup-chrome': 'cup Chrome',
};

/** Snapshot all processes as `{ pid, command }[]`. */
function snapshotPs() {
  try {
    return parsePsEntries(
      execFileSync('ps', ['-Ao', 'pid=,command='], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
    );
  } catch {
    return [];
  }
}

/** pid-reuse guard: before SIGKILL, re-confirm the pid STILL classifies as a cup
 *  orphan (the original may have exited and the OS recycled its pid). */
function stillCup(pid, repoDir) {
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return classifyCupProcess(cmd, repoDir) !== null;
  } catch {
    return false;
  }
}

/** Stale lick-back state files: the poll-loop buffers/cursors + any drain pidfiles. */
function lickbackStateFiles() {
  const out = [];
  const dir = lickbackDir();
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.ndjson') || name.endsWith('.cursor')) out.push(join(dir, name));
    }
  } catch {
    /* no dir */
  }
  try {
    for (const name of readdirSync(drainsDir())) out.push(join(drainsDir(), name));
  } catch {
    /* none */
  }
  return out;
}

async function stopOne(o, repoDir, out) {
  const label = CATEGORY_LABEL[o.category] ?? o.category;
  const { confirmed, escalated } = await stopByPid({
    pid: o.pid,
    isAlive,
    kill: (pid, signal) => {
      // Guard the uncatchable SIGKILL against pid reuse during the grace window.
      if (signal === 'SIGKILL' && !stillCup(pid, repoDir)) return;
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    },
    sleep,
  });
  if (confirmed) {
    out.push(`  stopped ${label} (pid ${o.pid})${escalated ? ' [SIGKILL]' : ''}`);
    return true;
  }
  out.push(`  COULD NOT stop ${label} (pid ${o.pid}) — survived SIGKILL; investigate manually`);
  return false;
}

/** Remove stale state files (cup.json only when no live cup still owns it) and, when
 *  opted in, the profile dirs of the cup Chromes we identified this run. Appends a
 *  report line per item. `profileDirs` is derived ONLY from cup-chrome orphans (matched
 *  by cup=1), so it can never target a non-cup standalone's profile. */
function cleanStateAndProfiles({ dryRun, doProfiles, repoDir, profileDirs, lines }) {
  const rec = readCupRecord();
  const cupAlive = !!(rec && isAlive(rec.pid) && stillCup(rec.pid, repoDir));
  const stateFiles = planStateCleanup({
    cupJsonPath: rec ? cupDiscoveryPath() : null,
    cupAlive,
    lickbackFiles: lickbackStateFiles(),
  });
  for (const f of stateFiles) {
    if (dryRun) {
      lines.push(`  would remove ${f}`);
      continue;
    }
    try {
      rmSync(f);
      lines.push(`  removed ${f}`);
    } catch {
      /* already gone */
    }
  }
  if (!doProfiles) return;
  for (const d of profileDirs) {
    if (dryRun) {
      lines.push(`  would remove profile ${d}`);
      continue;
    }
    try {
      rmSync(d, { recursive: true, force: true });
      lines.push(`  removed profile ${d}`);
    } catch {
      /* best-effort */
    }
  }
}

async function main() {
  const parsed = parseCleanArgs(process.argv.slice(2));
  if (parsed.mode === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.mode === 'error') {
    process.stderr.write(`cup-clean: unknown option(s): ${parsed.unknown.join(', ')}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { dryRun, doProfiles } = parsed;
  const repoDir = cupRepoDir();
  const orphans = selectCupOrphans(snapshotPs(), {
    repoDir,
    selfPids: [process.pid, process.ppid],
  });

  // Profile dirs to (optionally) delete: ONLY those of the cup Chromes we identified
  // (matched by cup=1), captured BEFORE we kill them so the dead process's argv is gone.
  const profileDirs = doProfiles
    ? orphans
        .filter((o) => o.category === 'cup-chrome')
        .map((o) => cupProfileDirFromCommand(o.command))
        .filter(Boolean)
    : [];

  const lines = [];
  let stopped = 0;
  for (const o of orphans) {
    const label = CATEGORY_LABEL[o.category] ?? o.category;
    if (dryRun) {
      lines.push(`  would stop ${label} (pid ${o.pid})`);
      stopped++;
    } else if (await stopOne(o, repoDir, lines)) {
      stopped++;
    }
  }

  cleanStateAndProfiles({ dryRun, doProfiles, repoDir, profileDirs, lines });

  if (lines.length === 0) {
    process.stdout.write('Nothing to clean — no cup orphans found.\n');
    return;
  }
  process.stdout.write(`${dryRun ? 'Dry run — would clean:' : 'Cleaned up cup orphans:'}\n`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.stdout.write(
    `${dryRun ? 'Re-run without --dry-run to apply.' : `Done — ${stopped} process(es) stopped.`}\n`
  );
}

if (isDirectRun(import.meta.url)) main();
