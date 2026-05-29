/*
 * RUM error-triage — pure logic.
 *
 * SLICC has no Sentry; its operational errors land in the helix RUM
 * `cluster` table as `checkpoint='error'` rows (see
 * `packages/webapp/src/ui/telemetry.ts`). This module turns raw error rows
 * into deduplicated, actionable triage candidates. It is intentionally free
 * of I/O so it can be unit-tested in isolation — the BigQuery and GitHub
 * calls live in `triage-rum-errors.mjs`.
 */
import { createHash } from 'node:crypto';

/** Default BigQuery location of the RUM data. */
export const RUM_TABLE = 'helix-225321.helix_rum.cluster';

/**
 * Hostnames that carry SLICC traffic. The CLI/Electron floats report under
 * the shared `localhost` bucket (the port is stripped server-side — see
 * adobe/helix-rum-collector#634), and the published extension reports under
 * its stable extension ID. Override via the `SLICC_RUM_HOSTS` env var.
 */
export const DEFAULT_HOSTS = ['localhost', 'akjjllgokmbgpbdbmafpiefnhidlmbgf'];

/**
 * Frames we never file: dev-server / tooling noise that is not a SLICC bug.
 * The dominant example is the Vite HMR client, which only errors under
 * `npm run dev` and accounts for ~99% of raw CLI `error` checkpoints.
 */
const NOISE_PATTERNS = [/@vite\/client/i, /vite\/dist\/client/i, /__vite_hmr/i];

/**
 * True if an error row is dev/tooling noise rather than an app error.
 * @param {string|null|undefined} source the RUM error `source` (stack frame)
 * @param {string|null|undefined} target the RUM error `target` (message)
 */
export function isNoise(source, target) {
  const hay = `${source ?? ''} ${target ?? ''}`;
  // An error with no alphanumeric content (empty source AND target) carries
  // nothing to act on — drop it rather than filing a contentless issue.
  if (!/[a-z0-9]/i.test(hay)) return true;
  return NOISE_PATTERNS.some((re) => re.test(hay));
}

/**
 * Collapse a raw (source, target) error pair into a stable signature, so
 * that the "same" error across sessions groups together regardless of
 * volatile detail (ports, line:col, ids, counts).
 * @param {string|null|undefined} source
 * @param {string|null|undefined} target
 * @returns {string} the normalized signature
 */
export function normalizeSignature(source, target) {
  return `${source ?? ''} | ${target ?? ''}`
    .toLowerCase()
    .replace(/https?:\/\/[^\s)]+/g, '') // strip URLs (host:port + path)
    .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/g, '<uuid>') // collapse UUIDs
    .replace(/0x[0-9a-f]+/g, '<hex>') // collapse hex addresses
    .replace(/\d+/g, 'N') // collapse remaining numbers (line:col, counts)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable short fingerprint for a signature. Used as the dedup key and
 * embedded in filed issues as `rum-fp:<fingerprint>` so subsequent runs
 * recognise an error that already has an issue.
 * @param {string} signature
 * @returns {string} hex md5 of the signature
 */
export function fingerprint(signature) {
  return createHash('md5').update(signature).digest('hex');
}

/**
 * Extract the `rum-fp:<fingerprint>` markers from a set of existing GitHub
 * issues (as returned by `gh issue list --json body`).
 * @param {Array<{body?: string}>} issues
 * @returns {Set<string>} lowercased fingerprints already filed
 */
export function parseFingerprints(issues) {
  const fps = new Set();
  for (const issue of issues ?? []) {
    for (const m of (issue?.body ?? '').matchAll(/rum-fp:\s*([0-9a-f]{6,64})/gi)) {
      fps.add(m[1].toLowerCase());
    }
  }
  return fps;
}

/**
 * Group raw error rows by fingerprint into candidates, dropping noise.
 * Each candidate carries occurrence stats and one concrete example.
 * @param {Array<{float?: string, source?: string, target?: string, weight?: number|string, time?: string}>} rows
 * @returns {Array<object>} candidates, most-frequent first
 */
export function aggregateCandidates(rows) {
  /** @type {Map<string, any>} */
  const byFp = new Map();
  for (const r of rows ?? []) {
    if (isNoise(r.source, r.target)) continue;
    const signature = normalizeSignature(r.source, r.target);
    const fp = fingerprint(signature);
    const weight = Number(r.weight) || 0;
    const existing = byFp.get(fp);
    if (existing) {
      existing.sampled += 1;
      existing.estimated += weight;
      if (r.time && r.time < existing.firstSeen) existing.firstSeen = r.time;
      if (r.time && r.time > existing.lastSeen) existing.lastSeen = r.time;
    } else {
      byFp.set(fp, {
        fingerprint: fp,
        signature,
        float: r.float ?? 'unknown',
        sampled: 1,
        estimated: weight,
        firstSeen: r.time ?? null,
        lastSeen: r.time ?? null,
        exampleSource: r.source ?? '',
        exampleTarget: r.target ?? '',
      });
    }
  }
  return [...byFp.values()].sort((a, b) => b.estimated - a.estimated || b.sampled - a.sampled);
}

/**
 * Final triage selection: aggregate raw rows and drop any fingerprint that
 * already has an issue.
 * @param {Array<object>} rows raw error rows from BigQuery
 * @param {Set<string>} existingFps fingerprints already filed (see parseFingerprints)
 * @returns {Array<object>} new candidates needing an issue
 */
export function selectNewCandidates(rows, existingFps) {
  const filed = existingFps ?? new Set();
  return aggregateCandidates(rows).filter((c) => !filed.has(c.fingerprint));
}

/**
 * Build the BigQuery SQL that extracts raw SLICC `error` rows over a window.
 * Returns raw rows (not pre-aggregated) so all normalization/dedup stays in
 * tested JS; only the cheap, clustered SLICC-session filter and a coarse
 * Vite exclusion run server-side.
 * @param {{sinceDays?: number, hosts?: string[], table?: string}} [opts]
 * @returns {string} a standard-SQL query
 */
export function buildErrorQuery(opts = {}) {
  const sinceDays = Number.isFinite(opts.sinceDays) ? Math.max(1, Math.floor(opts.sinceDays)) : 1;
  const hosts = opts.hosts?.length ? opts.hosts : DEFAULT_HOSTS;
  const table = opts.table ?? RUM_TABLE;
  const hostList = hosts.map((h) => `"${String(h).replace(/[^\w.:-]/g, '')}"`).join(',');
  return `
DECLARE since TIMESTAMP DEFAULT TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${sinceDays} DAY);
DECLARE hosts ARRAY<STRING> DEFAULT [${hostList}];
WITH sess AS (
  SELECT id,
    -- Navigate target wins. telemetry.ts sets RUM_GENERATION="slicc-\${mode}"
    -- for every float, so a CLI/Electron session can carry a slicc-* generation
    -- too; classify by the navigate target first and treat the generation
    -- marker as the extension-only fallback. Match "slicc-%" (with hyphen) to
    -- mirror the RUM_GENERATION format exactly.
    CASE WHEN LOGICAL_OR(checkpoint="navigate" AND target="cli") THEN "cli"
         WHEN LOGICAL_OR(checkpoint="navigate" AND target="electron") THEN "electron"
         WHEN LOGICAL_OR(generation LIKE "slicc-%") THEN "extension" END AS float
  FROM \`${table}\`
  WHERE time >= since AND hostname IN UNNEST(hosts)
    AND (generation LIKE "slicc-%" OR (checkpoint="navigate" AND target IN ("cli","electron")))
  GROUP BY id
  HAVING float IS NOT NULL
)
SELECT s.float AS float, e.source AS source, e.target AS target, e.weight AS weight,
       FORMAT_TIMESTAMP("%Y-%m-%dT%H:%M:%SZ", e.time) AS time
FROM \`${table}\` e JOIN sess s USING (id)
WHERE e.time >= since AND e.hostname IN UNNEST(hosts) AND e.checkpoint = "error"
  AND COALESCE(e.source, "") NOT LIKE "%@vite/client%"
  AND COALESCE(e.target, "") NOT LIKE "%@vite/client%"
`.trim();
}
