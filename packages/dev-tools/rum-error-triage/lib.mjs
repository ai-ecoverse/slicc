import { createHash } from 'node:crypto';

export const RUM_TABLE = 'helix-225321.helix_rum.cluster';

export const DEFAULT_HOSTS = ['localhost', 'akjjllgokmbgpbdbmafpiefnhidlmbgf'];

const NOISE_PATTERNS = [/@vite\/client/i, /vite\/dist\/client/i, /__vite_hmr/i];

export function isNoise(source, target) {
  const hay = `${source ?? ''} ${target ?? ''}`;

  if (!/[a-z0-9]/i.test(hay)) return true;
  return NOISE_PATTERNS.some((re) => re.test(hay));
}

export function normalizeSignature(source, target) {
  return `${source ?? ''} | ${target ?? ''}`
    .toLowerCase()
    .replace(/https?:\/\/[^\s)]+/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/g, '<uuid>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprint(signature) {
  return createHash('md5').update(signature).digest('hex');
}

export function parseFingerprints(issues) {
  const fps = new Set();
  for (const issue of issues ?? []) {
    for (const m of (issue?.body ?? '').matchAll(/rum-fp:\s*([0-9a-f]{6,64})/gi)) {
      fps.add(m[1].toLowerCase());
    }
  }
  return fps;
}

export function aggregateCandidates(rows) {
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

export function selectNewCandidates(rows, existingFps) {
  const filed = existingFps ?? new Set();
  return aggregateCandidates(rows).filter((c) => !filed.has(c.fingerprint));
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function buildSinceExpression(opts) {
  const raw = opts.since == null ? '' : String(opts.since);
  if (raw === '') {
    const sinceDays = Number.isFinite(opts.sinceDays) ? Math.max(1, Math.floor(opts.sinceDays)) : 1;
    return `TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${sinceDays} DAY)`;
  }
  if (!ISO_INSTANT.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new Error(
      `buildErrorQuery: since must be an ISO-8601 UTC instant like 2026-09-15T03:00:00Z, got ${JSON.stringify(raw)}`
    );
  }
  return `TIMESTAMP("${raw}")`;
}

export function buildErrorQuery(opts = {}) {
  const hosts = opts.hosts?.length ? opts.hosts : DEFAULT_HOSTS;
  const table = opts.table ?? RUM_TABLE;
  const hostList = hosts.map((h) => `"${String(h).replace(/[^\w.:-]/g, '')}"`).join(',');
  return `
DECLARE since TIMESTAMP DEFAULT ${buildSinceExpression(opts)};
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
