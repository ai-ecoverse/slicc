export const ISSUE_MARKER = '<!-- bedrock-model-scout -->';

export const ISSUE_LABEL = 'bedrock-model-scout';

const MODEL_VAR_RE = /vars\.([A-Za-z0-9_]*BEDROCK_MODEL)\b/g;

const QUOTED_RE = /'([^'\n]*)'|"([^"\n]*)"/g;

const EXPRESSION_RE = /\$\{\{([^{}]*)\}\}/g;

export function isBedrockAnthropicModelId(value) {
  return typeof value === 'string' && /^(?:[a-z0-9-]+\.)?anthropic\.[a-z0-9.:-]+$/.test(value);
}

function matchAll(text, re) {
  const found = [];
  for (const match of text.matchAll(re)) {
    found.push(match[1] ?? match[2] ?? '');
  }
  return found;
}

function extractChains(text) {
  return [...text.matchAll(EXPRESSION_RE)]
    .map((match) => match[1].trim())
    .filter((expression) => expression.includes('BEDROCK_MODEL'));
}

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

        if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

export function extractModelReferences(files) {
  const variables = new Map();

  const literals = new Map();

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
    variables: toList(variables, 'name'),
    literals: toList(literals, 'value'),
    chains,
  };
}

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

export const OK = 'ok';
export const INVALID = 'invalid';
export const INCONCLUSIVE = 'inconclusive';

const INVALID_ERROR_TYPES = new Set(['ResourceNotFoundException']);

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

const VALIDATION_MODEL_PHRASES = [
  'model identifier is invalid',
  'invalid model identifier',
  'could not resolve the foundation model',
  'inference profile',
];

const ACCESS_DENIED_MODEL_PHRASES = [
  'access to the model',
  'model with the specified model id',
  'does not exist',
  'is not accessible',
  'not available in your account',
];

export function resolveErrorType({ body, headers } = {}) {
  const header =
    typeof headers?.get === 'function'
      ? headers.get('x-amzn-errortype')
      : (headers?.['x-amzn-errortype'] ?? headers?.['x-amzn-ErrorType']);
  const parsed = typeof body === 'string' ? safeJson(body) : body;

  const fromHeader = header ? String(header).split(':')[0].trim() : '';
  const fromBody = String(parsed?.__type ?? parsed?.code ?? parsed?.name ?? '')
    .split('#')
    .pop()
    .trim();
  return fromHeader || fromBody;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bodyText(body) {
  if (typeof body === 'string') {
    return body;
  }
  return body ? JSON.stringify(body) : '';
}

function bodyMessage(body) {
  const parsed = typeof body === 'string' ? safeJson(body) : body;
  const message = parsed?.message ?? parsed?.Message ?? parsed?.errorMessage;
  return String(message ?? bodyText(body));
}

function mentionsAny(haystack, phrases) {
  const lower = haystack.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

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

function verdict(classification, errorType, reason, evidence) {
  return { classification, errorType, reason, evidence };
}

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

function trim(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

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

    allInconclusive: list.length > 0 && inconclusive === list.length,

    allInvalid: list.length > 1 && invalid === list.length,
  };
}

function codeList(names) {
  return names.length ? names.map((name) => `\`${name}\``).join(', ') : '—';
}

function holderOf(result) {
  const held = result.variables.length ? codeList(result.variables) : '';
  const fallback = result.viaLiteral ? 'hardcoded workflow default' : '';
  return [held, fallback].filter(Boolean).join(' + ') || '—';
}

function replacementLine(result, okModelIds) {
  const suggestion = suggestReplacement(result.modelId, okModelIds);
  return suggestion
    ? `- **Replace with:** \`${suggestion}\` — probed \`ok\` in this run and from the same model family.`
    : '- **Replace with:** no verified replacement was found among the IDs probed this run. Pick a current ID from the Bedrock console (or `aws bedrock list-inference-profiles`) and confirm it answers before setting the variable.';
}

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
