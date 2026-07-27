// Pure logic for the CI quarantine gate: every `continue-on-error: true` step
// in the gated workflows must be declared in ci-quarantine.json with a reason,
// an owner, and a review date.
//
// An undeclared quarantine fails. A quarantine past its review date only warns,
// and so does a registry entry whose step has disappeared: a date-triggered
// hard failure would break PRs that have nothing to do with the debt, which is
// worse than the debt itself.
//
// The IO + CLI wiring lives in `check-ci-quarantine.mjs`.

const QUARANTINE_LINE = /^continue-on-error:\s*true\b/;
const BLOCK_SCALAR = /:\s*[|>][+-]?\d*\s*$/;
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):/;
const JOB_KEY = /^ {2}([A-Za-z_][\w-]*):\s*(#.*)?$/;
const LIST_ITEM = /^(\s+)-\s+([A-Za-z_][\w-]*):\s*(.*)$/;
const MAPPING_KEY = /^(\s+)([A-Za-z_][\w-]*):\s*(.*)$/;

function unquote(value) {
  const v = value.trim().replace(/\s+#.*$/, '');
  const m = /^(['"])(.*)\1$/.exec(v);
  return m ? m[2] : v;
}

export function quarantineKey({ workflow, job, step }) {
  return `${workflow}\u0000${job}\u0000${step}`;
}

/**
 * Scan a workflow file's text for step-level `continue-on-error: true`, without
 * a YAML dependency. Block scalars (`run: |`, `if: |`) are skipped wholesale so
 * an embedded shell script can neither hide nor fake a quarantine.
 *
 * @param {string} text raw workflow YAML
 * @param {string} workflow repo-relative workflow path, echoed into results
 * @returns {{workflow: string, job: string, step: string, line: number}[]}
 */
function updateJobContext(ctx, raw, trimmed, indent) {
  if (indent === 0) {
    const top = TOP_LEVEL_KEY.exec(trimmed);
    if (top) {
      ctx.inJobs = top[1] === 'jobs';
      ctx.job = '';
      ctx.step = '';
      return true;
    }
  }
  const jobKey = ctx.inJobs ? JOB_KEY.exec(raw) : null;
  if (!jobKey) return false;
  ctx.job = jobKey[1];
  ctx.step = '';
  return true;
}

function updateStepContext(ctx, raw) {
  const item = LIST_ITEM.exec(raw);
  if (item) {
    ctx.step = item[2] === 'name' ? unquote(item[3]) : `<${item[2]}: ${unquote(item[3])}>`;
    return true;
  }
  const mapping = MAPPING_KEY.exec(raw);
  if (mapping && mapping[2] === 'name' && ctx.step) ctx.step = unquote(mapping[3]);
  return false;
}

export function parseContinueOnErrorSteps(text, workflow = '') {
  const out = [];
  const ctx = { inJobs: false, job: '', step: '', blockIndent: null };
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const indent = raw.length - raw.trimStart().length;
    if (ctx.blockIndent !== null) {
      if (indent > ctx.blockIndent) continue;
      ctx.blockIndent = null;
    }
    if (trimmed.startsWith('#')) continue;
    if (BLOCK_SCALAR.test(raw)) ctx.blockIndent = indent;
    if (updateJobContext(ctx, raw, trimmed, indent)) continue;
    if (updateStepContext(ctx, raw)) continue;
    if (QUARANTINE_LINE.test(trimmed)) {
      out.push({ workflow, job: ctx.job, step: ctx.step || '(unnamed step)', line: i + 1 });
    }
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateRegistry(registry) {
  const problems = [];
  const workflows = Array.isArray(registry?.workflows) ? registry.workflows : [];
  if (workflows.length === 0) problems.push('`workflows` must list at least one workflow path');
  const entries = Array.isArray(registry?.quarantines) ? registry.quarantines : [];
  entries.forEach((entry, idx) => {
    const at = `quarantines[${idx}]`;
    for (const field of ['workflow', 'job', 'step']) {
      if (typeof entry?.[field] !== 'string' || entry[field].trim().length === 0) {
        problems.push(`${at}: missing \`${field}\``);
      }
    }
    if (typeof entry?.reason !== 'string' || entry.reason.trim().length < 20) {
      problems.push(`${at}: \`reason\` must be a real sentence, not a placeholder`);
    }
    if (typeof entry?.owner !== 'string' || entry.owner.trim().length === 0) {
      problems.push(`${at}: missing \`owner\``);
    }
    if (typeof entry?.reviewBy !== 'string' || !DATE.test(entry.reviewBy)) {
      problems.push(`${at}: \`reviewBy\` must be a YYYY-MM-DD date`);
    }
    if (entry?.workflow && !workflows.includes(entry.workflow)) {
      problems.push(`${at}: \`workflow\` is not listed in \`workflows\``);
    }
  });
  return problems;
}

/**
 * Compare the quarantines found in the workflows against the registry.
 *
 * @param {{registry: object, found: {workflow: string, job: string, step: string, line: number}[], today: string}} input
 * @returns {{invalid: string[], unregistered: object[], stale: object[], expired: object[], ok: number}}
 */
export function evaluateQuarantines({ registry, found, today }) {
  const invalid = validateRegistry(registry);
  const entries = Array.isArray(registry?.quarantines) ? registry.quarantines : [];
  const byKey = new Map(entries.map((e) => [quarantineKey(e), e]));
  const foundKeys = new Set((found ?? []).map(quarantineKey));
  const unregistered = (found ?? []).filter((f) => !byKey.has(quarantineKey(f)));
  const stale = entries.filter((e) => !foundKeys.has(quarantineKey(e)));
  const expired = entries.filter(
    (e) => typeof e?.reviewBy === 'string' && DATE.test(e.reviewBy) && e.reviewBy < today
  );
  return {
    invalid,
    unregistered,
    stale,
    expired,
    ok: (found ?? []).length - unregistered.length,
  };
}

export function formatUnregisteredHint(entry) {
  return JSON.stringify(
    {
      workflow: entry.workflow,
      job: entry.job,
      step: entry.step,
      reason: 'why this step is allowed to fail, and what makes that safe',
      owner: 'owning package or area',
      reviewBy: 'YYYY-MM-DD',
    },
    null,
    2
  );
}
