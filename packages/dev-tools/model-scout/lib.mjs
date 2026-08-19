/*
 * Bedrock model scout — pure logic.
 *
 * Every agentic workflow in `.github/workflows/` picks its Claude model with a
 * chain like `vars.X_BEDROCK_MODEL || vars.RUM_BEDROCK_MODEL ||
 * 'global.anthropic.claude-sonnet-4-6'`. Bedrock model IDs are mutable
 * infrastructure: they get retired, renamed, and superseded, and a repository
 * variable holding a dead ID (an actual incident: `us.anthropic.claude-opus-4-9`,
 * which does not exist) makes every scheduled agent fail on every run with
 * nothing watching. This module holds the rules a weekly canary needs:
 *
 *   1. which model IDs the workflows can actually reach (derived from the files,
 *      never a hand-maintained list — a stale scout is the bug it monitors);
 *   2. how to read a Bedrock `InvokeModel` response, in particular the
 *      `invalid` vs `inconclusive` split;
 *   3. whether there is anything worth filing, and the issue body.
 *
 * No I/O and no `process.env` reads live here so every rule is unit-testable;
 * the HTTP calls and `$GITHUB_OUTPUT` writes live in `scan-models.mjs`.
 */

/** Marker used to find this monitor's existing issue for deduplication. */
export const ISSUE_MARKER = '<!-- bedrock-model-scout -->';

/** Label used for issue dedup, matching the cloudflare-spend-monitor shape. */
export const ISSUE_LABEL = 'bedrock-model-scout';

// ── model-ID extraction ──────────────────────────────────────────────────────

// `vars.SOMETHING_BEDROCK_MODEL`. The `vars.` prefix is what keeps prose
// mentions of a variable name in workflow comments out of the results.
const MODEL_VAR_RE = /vars\.([A-Za-z0-9_]*BEDROCK_MODEL)\b/g;

// Single- or double-quoted YAML/expression scalar.
const QUOTED_RE = /'([^'\n]*)'|"([^"\n]*)"/g;

// A `${{ … }}` expression, used only to report the fallback chain verbatim.
const EXPRESSION_RE = /\$\{\{([^{}]*)\}\}/g;

/**
 * Whether a string looks like a Bedrock Anthropic model ID or cross-region
 * inference profile (`global.anthropic.claude-sonnet-4-6`,
 * `us.anthropic.claude-opus-4-8`, `anthropic.claude-3-5-sonnet-20241022-v2:0`).
 * Restricted to `anthropic.` on purpose: this repo only ever calls Claude, and a
 * vendor allowlist would be another list to keep current.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBedrockAnthropicModelId(value) {
  return typeof value === 'string' && /^(?:[a-z0-9-]+\.)?anthropic\.[a-z0-9.:-]+$/.test(value);
}

/** @param {string} text @param {RegExp} re @returns {string[]} */
function matchAll(text, re) {
  const found = [];
  for (const match of text.matchAll(re)) {
    found.push(match[1] ?? match[2] ?? '');
  }
  return found;
}

/**
 * The `||` fallback chains that select a model, verbatim, so a report can show
 * the precedence order a workflow actually applies.
 * @param {string} text
 * @returns {string[]}
 */
function extractChains(text) {
  return [...text.matchAll(EXPRESSION_RE)]
    .map((match) => match[1].trim())
    .filter((expression) => expression.includes('BEDROCK_MODEL'));
}

/**
 * Every distinct Bedrock model ID the given workflow sources can reach: each
 * `vars.*_BEDROCK_MODEL` variable referenced (with the workflows that read it)
 * and every hardcoded model-ID literal (with the workflows that default to it).
 * @param {Array<{name: string, text: string}>} files
 * @returns {{variables: Array<{name: string, workflows: string[]}>, literals: Array<{value: string, workflows: string[]}>, chains: Array<{workflow: string, expression: string}>}}
 */
/**
 * Drop YAML comments before scanning, tracking quote state so a `#` inside a
 * string survives.
 *
 * A commented-out reference is not reachable, and treating it as reachable fails
 * in both directions: a disabled `vars.X_BEDROCK_MODEL` would trip the
 * unwatched-variable guard and abort every scheduled run, and a retired model ID
 * left in a comment would be probed and reported dead — a weekly false alarm
 * about a model nothing calls. Both are worse than missing a reference, because
 * both train people to ignore this issue.
 *
 * @param {string} text
 * @returns {string}
 */
function stripYamlComments(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (quote) {
          if (char === quote) quote = null;
          continue;
        }
        if (char === "'" || char === '"') {
          quote = char;
          continue;
        }
        // A YAML comment needs whitespace (or line start) before the `#`, which
        // is what keeps `us.anthropic.foo#bar` from being cut in half.
        if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

export function extractModelReferences(files) {
  /** @type {Map<string, Set<string>>} */
  const variables = new Map();
  /** @type {Map<string, Set<string>>} */
  const literals = new Map();
  /** @type {Array<{workflow: string, expression: string}>} */
  const chains = [];

  const record = (map, key, workflow) => {
    if (!map.has(key)) {
      map.set(key, new Set());
    }
    map.get(key).add(workflow);
  };

  for (const file of Array.isArray(files) ? files : []) {
    const text = stripYamlComments(String(file?.text ?? ''));
    const workflow = String(file?.name ?? '');
    for (const name of matchAll(text, MODEL_VAR_RE)) {
      record(variables, name, workflow);
    }
    for (const value of matchAll(text, QUOTED_RE)) {
      if (isBedrockAnthropicModelId(value)) {
        record(literals, value, workflow);
      }
    }
    for (const expression of extractChains(text)) {
      chains.push({ workflow, expression });
    }
  }

  const toList = (map, key) =>
    [...map.entries()]
      .map(([value, workflows]) => ({ [key]: value, workflows: [...workflows].sort() }))
      .sort((a, b) => String(a[key]).localeCompare(String(b[key])));

  return {
    variables: /** @type {any} */ (toList(variables, 'name')),
    literals: /** @type {any} */ (toList(literals, 'value')),
    chains,
  };
}

/**
 * Turn extracted references plus the variable values supplied by the workflow
 * into the distinct set of IDs to probe.
 *
 * `env` must be the *complete* set of variables the workflow passed in: a
 * variable that is present but empty is simply unset in the repo (the chain
 * falls through to the next entry, which is correct and expected), whereas a
 * variable **absent** from `env` never reached the scout at all and is reported
 * as `missingEnv` so a new workflow variable cannot silently escape the canary.
 * @param {{references: ReturnType<typeof extractModelReferences>, env: Record<string, string|undefined>}} input
 * @returns {{targets: Array<{modelId: string, variables: string[], workflows: string[], viaLiteral: boolean}>, missingEnv: string[], unsetVariables: string[]}}
 */
/**
 * Parse the manual `probe_extra_ids` self-test input.
 *
 * These IDs are probed and classified so the `invalid` path can be exercised
 * against real Bedrock — while every configured ID is healthy that branch is
 * unreachable, and it is the only branch that ever alerts anyone, so leaving it
 * unproven means the canary's failure mode is silence. Anything that is not a
 * Bedrock Anthropic model ID is discarded rather than probed, so a typo becomes a
 * dropped entry instead of a request to an arbitrary URL path.
 *
 * @param {string} raw
 * @returns {{ids: string[], rejected: string[]}}
 */
export function parseExtraProbeIds(raw) {
  const ids = [];
  const rejected = [];
  for (const part of String(raw ?? '').split(',')) {
    const value = part.trim();
    if (!value) continue;
    if (isBedrockAnthropicModelId(value)) {
      if (!ids.includes(value)) ids.push(value);
    } else {
      rejected.push(value);
    }
  }
  return { ids, rejected };
}

/**
 * Compare self-test verdicts against the classification the operator expected.
 *
 * Printing the verdict is not a test: the regression this guards against is
 * Bedrock rewording its rejection so a dead ID starts classifying as
 * `inconclusive`, and the whole problem with that regression is that it is
 * *quiet*. If nobody reads the log line, the canary looks healthy while its only
 * alerting path is broken. An expectation turns that into a red run.
 *
 * @param {{verdicts: Array<{modelId: string, classification: string}>, expected: string}} input
 * @returns {{checked: boolean, failures: Array<{modelId: string, expected: string, actual: string}>}}
 */
export function evaluateSelfTest({ verdicts = [], expected = '' }) {
  const want = String(expected ?? '')
    .trim()
    .toLowerCase();
  if (!want || want === 'any') {
    return { checked: false, failures: [] };
  }
  const failures = (Array.isArray(verdicts) ? verdicts : [])
    .filter((verdict) => verdict?.classification !== want)
    .map((verdict) => ({
      modelId: String(verdict?.modelId ?? ''),
      expected: want,
      actual: String(verdict?.classification ?? ''),
    }));
  return { checked: true, failures };
}

export function resolveProbeTargets({ references, env }) {
  /** @type {Map<string, {modelId: string, variables: string[], workflows: Set<string>, viaLiteral: boolean}>} */
  const targets = new Map();
  const missingEnv = [];
  const unsetVariables = [];

  const target = (modelId, viaLiteral) => {
    if (!targets.has(modelId)) {
      targets.set(modelId, { modelId, variables: [], workflows: new Set(), viaLiteral });
    }
    const entry = targets.get(modelId);
    entry.viaLiteral = entry.viaLiteral || viaLiteral;
    return entry;
  };

  for (const variable of references.variables) {
    if (!Object.hasOwn(env, variable.name)) {
      missingEnv.push(variable.name);
      continue;
    }
    const value = String(env[variable.name] ?? '').trim();
    if (!value) {
      unsetVariables.push(variable.name);
      continue;
    }
    const entry = target(value, false);
    entry.variables.push(variable.name);
    for (const workflow of variable.workflows) {
      entry.workflows.add(workflow);
    }
  }

  for (const literal of references.literals) {
    const entry = target(literal.value, true);
    for (const workflow of literal.workflows) {
      entry.workflows.add(workflow);
    }
  }

  return {
    targets: [...targets.values()]
      .map((entry) => ({
        modelId: entry.modelId,
        variables: entry.variables.sort(),
        workflows: [...entry.workflows].sort(),
        viaLiteral: entry.viaLiteral,
      }))
      .sort((a, b) => a.modelId.localeCompare(b.modelId)),
    missingEnv: missingEnv.sort(),
    unsetVariables: unsetVariables.sort(),
  };
}

// ── result classification ────────────────────────────────────────────────────

export const OK = 'ok';
export const INVALID = 'invalid';
export const INCONCLUSIVE = 'inconclusive';

// A dead model ID, no ambiguity: Bedrock could not resolve it at all.
const INVALID_ERROR_TYPES = new Set(['ResourceNotFoundException']);

// Everything transient or environmental. Any of these means "we learned nothing
// about this model this week" and must never be reported as a dead model.
const INCONCLUSIVE_ERROR_TYPES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceQuotaExceededException',
  'ModelNotReadyException',
  'ModelTimeoutException',
  'ModelErrorException',
  'InternalServerException',
  'ServiceUnavailableException',
  'InternalFailure',
  'ExpiredTokenException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'IncompleteSignature',
  'MissingAuthenticationToken',
  'ServiceUnavailable',
]);

// Phrases in a ValidationException body that name the model itself rather than
// the request shape.
const VALIDATION_MODEL_PHRASES = [
  'model identifier is invalid',
  'invalid model identifier',
  'could not resolve the foundation model',
  'inference profile',
];

// Phrases in an AccessDeniedException body that mean "this model ID is not a
// thing you can use", as opposed to "these credentials lack the IAM action" —
// the latter is an environment problem and stays inconclusive.
const ACCESS_DENIED_MODEL_PHRASES = [
  'access to the model',
  'model with the specified model id',
  'does not exist',
  'is not accessible',
  'not available in your account',
];

/**
 * Best-effort AWS error type for a response. Bedrock puts it in the
 * `x-amzn-errortype` header (sometimes suffixed with a Coral URL) and/or a
 * `__type` field in the JSON body (sometimes prefixed with a shape namespace).
 * @param {{body?: unknown, headers?: Record<string, string>|Headers}} input
 * @returns {string}
 */
export function resolveErrorType({ body, headers } = {}) {
  const header =
    typeof headers?.get === 'function'
      ? headers.get('x-amzn-errortype')
      : (headers?.['x-amzn-errortype'] ?? headers?.['x-amzn-ErrorType']);
  const parsed = typeof body === 'string' ? safeJson(body) : body;
  // The header is `Type:<coral url>` (type first); `__type` is `<namespace>#Type`
  // (type last). Splitting both the same way silently returns a URL fragment.
  const fromHeader = header ? String(header).split(':')[0].trim() : '';
  const fromBody = String(parsed?.__type ?? parsed?.code ?? parsed?.name ?? '')
    .split('#')
    .pop()
    .trim();
  return fromHeader || fromBody;
}

/** @param {string} text @returns {any} */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {unknown} body @returns {string} */
function bodyText(body) {
  if (typeof body === 'string') {
    return body;
  }
  return body ? JSON.stringify(body) : '';
}

/** @param {unknown} body @returns {string} */
function bodyMessage(body) {
  const parsed = typeof body === 'string' ? safeJson(body) : body;
  const message = parsed?.message ?? parsed?.Message ?? parsed?.errorMessage;
  return String(message ?? bodyText(body));
}

/** @param {string} haystack @param {string[]} phrases @returns {boolean} */
function mentionsAny(haystack, phrases) {
  const lower = haystack.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

/**
 * Classify one Bedrock `InvokeModel` attempt.
 *
 * The only classification that opens an issue is `invalid`. A 403 that is about
 * quota or IAM, a 429, a 5xx, a timeout, and a transport error are all
 * `inconclusive`: reporting one of those as a dead model would tell a human to
 * change a working variable, and the second false issue is the one nobody reads.
 * @param {{modelId?: string, status?: number, body?: unknown, headers?: Record<string, string>|Headers, networkError?: string|Error|null}} input
 * @returns {{classification: 'ok'|'invalid'|'inconclusive', errorType: string, reason: string, evidence: string}}
 */
export function classifyProbeResult({ modelId = '', status, body, headers, networkError } = {}) {
  if (networkError) {
    const detail = networkError instanceof Error ? networkError.message : String(networkError);
    return verdict(INCONCLUSIVE, '', `transport error, model state unknown: ${detail}`, detail);
  }
  const code = Number(status);
  const errorType = resolveErrorType({ body, headers });
  const message = bodyMessage(body);
  const evidence = `${Number.isFinite(code) ? code : '?'} ${errorType || 'no error type'}: ${trim(message, 300)}`;

  if (code >= 200 && code < 300) {
    return verdict(OK, errorType, 'the model answered a 1-token request', evidence);
  }
  if (INVALID_ERROR_TYPES.has(errorType)) {
    return verdict(INVALID, errorType, 'Bedrock could not resolve this model ID', evidence);
  }
  if (INCONCLUSIVE_ERROR_TYPES.has(errorType) || code === 429 || code >= 500) {
    return verdict(INCONCLUSIVE, errorType, 'throttling, quota, or service error', evidence);
  }
  if (errorType === 'ValidationException') {
    return classifyValidation({ modelId, errorType, message, evidence });
  }
  if (errorType === 'AccessDeniedException' || code === 403) {
    return mentionsAny(message, ACCESS_DENIED_MODEL_PHRASES)
      ? verdict(INVALID, errorType, 'this account cannot invoke this model ID', evidence)
      : verdict(
          INCONCLUSIVE,
          errorType,
          'permission or quota denial, not a model verdict',
          evidence
        );
  }
  return verdict(INCONCLUSIVE, errorType, 'unrecognised response, assumed transient', evidence);
}

/** @returns {{classification: any, errorType: string, reason: string, evidence: string}} */
function verdict(classification, errorType, reason, evidence) {
  return { classification, errorType, reason, evidence };
}

/** @param {{modelId: string, errorType: string, message: string, evidence: string}} input */
function classifyValidation({ modelId, errorType, message, evidence }) {
  const namesModel =
    (modelId && message.includes(modelId)) || mentionsAny(message, VALIDATION_MODEL_PHRASES);
  return namesModel
    ? verdict(INVALID, errorType, 'rejected as an unusable model ID', evidence)
    : verdict(
        INCONCLUSIVE,
        errorType,
        'request rejected for a reason other than the model ID',
        evidence
      );
}

/** @param {string} text @param {number} max @returns {string} */
function trim(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ── replacement suggestions ──────────────────────────────────────────────────

/**
 * Split a Bedrock model ID into its cross-region prefix, model family, and
 * version so a dead ID can be matched against a probed-working sibling.
 * @param {string} modelId
 * @returns {{regionPrefix: string, family: string, version: string}|null}
 */
export function parseModelFamily(modelId) {
  if (!isBedrockAnthropicModelId(modelId)) {
    return null;
  }
  const parts = String(modelId).split('.');
  const regionPrefix = parts.length >= 3 ? parts[0] : '';
  const rest = (regionPrefix ? parts.slice(1) : parts).join('.');
  const version = rest.match(/-(\d+(?:-\d+)*)$/);
  return {
    regionPrefix,
    family: version ? rest.slice(0, -version[0].length) : rest,
    version: version ? version[1] : '',
  };
}

/**
 * A model ID from the same family that was probed `ok` in this run. Deliberately
 * never guesses an unprobed ID: naming an ID nobody verified is how a "fix" turns
 * into the next outage.
 * @param {string} modelId
 * @param {string[]} okModelIds
 * @returns {string|null}
 */
export function suggestReplacement(modelId, okModelIds) {
  const dead = parseModelFamily(modelId);
  if (!dead) {
    return null;
  }
  const candidates = (okModelIds ?? []).filter((candidate) => {
    const parsed = parseModelFamily(candidate);
    return parsed && parsed.family === dead.family;
  });
  const sameRegion = candidates.filter(
    (candidate) => parseModelFamily(candidate)?.regionPrefix === dead.regionPrefix
  );
  return (sameRegion.length ? sameRegion : candidates).sort().pop() ?? null;
}

// ── reporting ────────────────────────────────────────────────────────────────

/**
 * @typedef {{modelId: string, variables: string[], workflows: string[], viaLiteral: boolean,
 *   classification: 'ok'|'invalid'|'inconclusive', reason: string, evidence: string, attempts?: number}} ProbeResult
 */

/**
 * Counts plus the two states that change what the run does.
 * @param {ProbeResult[]} results
 * @returns {{ok: number, invalid: number, inconclusive: number, anyInvalid: boolean, allInconclusive: boolean}}
 */
export function summarizeResults(results) {
  const list = Array.isArray(results) ? results : [];
  const count = (kind) => list.filter((result) => result.classification === kind).length;
  const invalid = count(INVALID);
  const inconclusive = count(INCONCLUSIVE);
  return {
    ok: count(OK),
    invalid,
    inconclusive,
    anyInvalid: invalid > 0,
    // A run that learned nothing about any ID is a blind canary, not a clean bill
    // of health — the caller must say so loudly even though it files nothing.
    allInconclusive: list.length > 0 && inconclusive === list.length,
    // Every single ID unusable is almost never what it claims to be. Bedrock
    // returns the same "you don't have access to the model with the specified
    // model ID" for a retired ID and for an account that lost its entitlement, so
    // one revoked or misprovisioned credential fails every probe at once. Model
    // IDs, by contrast, die one family at a time. Reporting that as N dead models
    // would tell someone to rewrite every healthy variable in the repo, which is
    // the same false alarm the inconclusive class exists to prevent — just
    // arriving through the credential door instead of the throttling one.
    allInvalid: list.length > 1 && invalid === list.length,
  };
}

/** @param {string[]} names @returns {string} */
function codeList(names) {
  return names.length ? names.map((name) => `\`${name}\``).join(', ') : '—';
}

/** @param {ProbeResult} result @returns {string} */
function holderOf(result) {
  const held = result.variables.length ? codeList(result.variables) : '';
  const fallback = result.viaLiteral ? 'hardcoded workflow default' : '';
  return [held, fallback].filter(Boolean).join(' + ') || '—';
}

/** @param {ProbeResult} result @param {string[]} okModelIds @returns {string} */
function replacementLine(result, okModelIds) {
  const suggestion = suggestReplacement(result.modelId, okModelIds);
  return suggestion
    ? `- **Replace with:** \`${suggestion}\` — probed \`ok\` in this run and from the same model family.`
    : '- **Replace with:** no verified replacement was found among the IDs probed this run. Pick a current ID from the Bedrock console (or `aws bedrock list-inference-profiles`) and confirm it answers before setting the variable.';
}

/** @param {ProbeResult} result @param {string[]} okModelIds @returns {string[]} */
function invalidSection(result, okModelIds) {
  const consumers = result.workflows.length
    ? result.workflows.map((workflow) => `\`.github/workflows/${workflow}\``).join(', ')
    : '—';
  return [
    `### \`${result.modelId}\` — unusable`,
    '',
    `- **Evidence:** ${result.reason} → \`${result.evidence}\``,
    `- **Held by:** ${holderOf(result)}`,
    `- **Consumed by:** ${consumers}`,
    replacementLine(result, okModelIds),
    '',
  ];
}

/** @param {ProbeResult[]} results @returns {string[]} */
function resultTable(results) {
  return [
    '| Model ID | Result | Held by | Workflows |',
    '| -------- | ------ | ------- | --------- |',
    ...results.map(
      (result) =>
        `| \`${result.modelId}\` | ${result.classification} | ${holderOf(result)} | ${result.workflows.length || 0} |`
    ),
  ];
}

/**
 * Decide whether this run has anything worth filing and render the issue body.
 *
 * Silence is the correct output for a healthy week: no "all good" issue, because
 * a weekly issue nobody needs is a weekly issue nobody reads.
 * @param {{results: ProbeResult[], region?: string, generatedAt?: Date}} input
 * @returns {{shouldFile: boolean, title: string, body: string, summary: ReturnType<typeof summarizeResults>}}
 */
export function buildReport({ results, region = '', generatedAt = new Date() }) {
  const list = Array.isArray(results) ? results : [];
  const summary = summarizeResults(list);
  const invalid = list.filter((result) => result.classification === INVALID);
  const okModelIds = list.filter((r) => r.classification === OK).map((r) => r.modelId);
  const inconclusive = list.filter((result) => result.classification === INCONCLUSIVE);
  const plural = invalid.length === 1 ? 'model ID' : 'model IDs';
  const title = summary.allInvalid
    ? 'Bedrock model scout: every probed model ID failed — check the credential first'
    : `Bedrock model scout: ${invalid.length} unusable ${plural} in workflow configuration`;

  if (!summary.anyInvalid) {
    return { shouldFile: false, title, body: '', summary };
  }

  // Still filed — a total failure is an outage and must be loud — but diagnosed
  // as what it probably is, so nobody starts by editing variables that are fine.
  if (summary.allInvalid) {
    return {
      shouldFile: true,
      title,
      body: [
        ISSUE_MARKER,
        `## All ${invalid.length} probed Bedrock model IDs were rejected`,
        '',
        `Probed on ${generatedAt.toISOString()}${region ? ` in \`${region}\`` : ''}. Every ID failed, which is why this issue does **not** list ${invalid.length} model IDs to replace.`,
        '',
        'Bedrock answers a retired model ID and an account that cannot invoke a model with the same rejection, so a single revoked, rotated, or misprovisioned credential fails every probe at once. Model IDs do not all die in the same week. Check, in this order:',
        '',
        `1. **\`AWS_BEARER_TOKEN_BEDROCK\`** — still valid, and still entitled to Anthropic models${region ? ` in \`${region}\`` : ''}?`,
        '2. **Region** — `RUM_AWS_REGION` pointing somewhere these models are offered?',
        '3. **Model access** — Anthropic models still enabled for the account in Bedrock?',
        '',
        'Only if all three are healthy is this what it looks like: the model IDs themselves. Note that the agentic workflows use these same credentials, so if this is a credential fault they are all failing too.',
        '',
        '### All probe results',
        '',
        ...resultTable(list),
      ].join('\n'),
      summary,
    };
  }

  const body = [
    ISSUE_MARKER,
    `## ${invalid.length} Bedrock ${plural} reachable from \`.github/workflows/\` cannot be invoked`,
    '',
    `Probed one 1-token \`InvokeModel\` call per distinct model ID on ${generatedAt.toISOString()}${region ? ` in \`${region}\`` : ''}: **${summary.ok} ok, ${summary.invalid} unusable, ${summary.inconclusive} inconclusive.** Any workflow that resolves to an unusable ID fails on *every* run, silently — which is why this check exists.`,
    '',
    ...invalid.flatMap((result) => invalidSection(result, okModelIds)),
    '### A human has to apply the fix',
    '',
    'A GitHub Actions token cannot write repository variables, so this issue is the whole of what automation can do. Set the variable by hand under **Settings → Secrets and variables → Actions → Variables**; deleting the variable is also a valid fix when the workflow default below it is healthy.',
    '',
    '### All probe results',
    '',
    ...resultTable(list),
    '',
    inconclusive.length
      ? `<sub>${inconclusive.length} ID(s) came back inconclusive (throttling, quota, IAM, or 5xx) and are deliberately **not** reported as unusable: ${codeList(inconclusive.map((r) => r.modelId))}.</sub>`
      : '<sub>Every probed ID returned a definite verdict this run.</sub>',
  ].join('\n');

  return { shouldFile: true, title, body, summary };
}
