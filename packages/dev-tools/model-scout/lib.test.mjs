import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  classifyProbeResult,
  evaluateSelfTest,
  extractModelReferences,
  ISSUE_MARKER,
  isBedrockAnthropicModelId,
  parseExtraProbeIds,
  parseModelFamily,
  resolveErrorType,
  resolveProbeTargets,
  suggestReplacement,
  summarizeResults,
} from './lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

/*
 * Recorded Bedrock `InvokeModel` error payloads.
 *
 * Bedrock reports the error type in the `x-amzn-errortype` header (suffixed with
 * a Coral namespace URL) and the human text in a `message` field. The assertions
 * below key on the **status + error type**, which are the parts of these shapes
 * that are documented and stable; the `message` strings are representative rather
 * than byte-exact, so no test asserts on a message verbatim — only that a message
 * naming the model ID flips a ValidationException to `invalid` while one that does
 * not stays `inconclusive`.
 */
const coral = (type) => ({
  'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/`,
});

const PAYLOADS = {
  invalidModelId: {
    status: 400,
    headers: coral('ValidationException'),
    body: JSON.stringify({ message: 'The provided model identifier is invalid.' }),
  },
  resourceNotFound: {
    status: 404,
    headers: coral('ResourceNotFoundException'),
    body: JSON.stringify({
      message: 'Could not resolve the foundation model from the provided model identifier.',
    }),
  },
  onDemandUnsupported: {
    status: 400,
    headers: coral('ValidationException'),
    body: JSON.stringify({
      message:
        "Invocation of model ID anthropic.claude-sonnet-4-5-20250929-v1:0 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.",
    }),
  },
  badRequestShape: {
    status: 400,
    headers: coral('ValidationException'),
    body: JSON.stringify({ message: 'max_tokens: Field required' }),
  },
  modelAccessDenied: {
    status: 403,
    headers: coral('AccessDeniedException'),
    body: JSON.stringify({
      message: "You don't have access to the model with the specified model ID.",
    }),
  },
  iamAccessDenied: {
    status: 403,
    headers: coral('AccessDeniedException'),
    body: JSON.stringify({
      message:
        'User: arn:aws:sts::111122223333:assumed-role/runner is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1::foundation-model/us.anthropic.claude-opus-4-8',
    }),
  },
  throttled: {
    status: 429,
    headers: coral('ThrottlingException'),
    body: JSON.stringify({ message: 'Too many requests, please wait before trying again.' }),
  },
  quotaExceeded: {
    status: 400,
    headers: coral('ServiceQuotaExceededException'),
    body: JSON.stringify({ message: 'Your request exceeds the service quota for your account.' }),
  },
  internalError: {
    status: 500,
    headers: coral('InternalServerException'),
    body: JSON.stringify({ message: 'An internal server error occurred. Retry your request.' }),
  },
  answered: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'p' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 8, output_tokens: 1 },
    }),
  },
};

const classify = (modelId, payload) => classifyProbeResult({ modelId, ...payload }).classification;

describe('isBedrockAnthropicModelId', () => {
  it('accepts plain, regional, and versioned Anthropic IDs', () => {
    expect(isBedrockAnthropicModelId('global.anthropic.claude-sonnet-4-6')).toBe(true);
    expect(isBedrockAnthropicModelId('us.anthropic.claude-opus-4-8')).toBe(true);
    expect(isBedrockAnthropicModelId('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(true);
  });

  it('rejects anything that is not a Bedrock Anthropic model ID', () => {
    expect(isBedrockAnthropicModelId('true')).toBe(false);
    expect(isBedrockAnthropicModelId('us-east-1')).toBe(false);
    expect(isBedrockAnthropicModelId('claude-opus-4-6')).toBe(false);
    expect(isBedrockAnthropicModelId(undefined)).toBe(false);
  });
});

describe('evaluateSelfTest', () => {
  it('checks nothing without an expectation', () => {
    const verdicts = [{ modelId: 'us.anthropic.claude-opus-4-9', classification: 'inconclusive' }];

    for (const expected of ['', '  ', 'any', undefined]) {
      expect(evaluateSelfTest({ verdicts, expected })).toEqual({ checked: false, failures: [] });
    }
  });

  it('reports the mismatch when a known-dead ID stops classifying as invalid', () => {
    // The regression that matters: Bedrock rewords its rejection, a dead model
    // reads as inconclusive, and the scout silently loses its only alerting path.
    const outcome = evaluateSelfTest({
      verdicts: [{ modelId: 'us.anthropic.claude-opus-4-9', classification: 'inconclusive' }],
      expected: 'invalid',
    });

    expect(outcome.checked).toBe(true);
    expect(outcome.failures).toEqual([
      { modelId: 'us.anthropic.claude-opus-4-9', expected: 'invalid', actual: 'inconclusive' },
    ]);
  });

  it('passes when every probe matches, case-insensitively', () => {
    const outcome = evaluateSelfTest({
      verdicts: [
        { modelId: 'us.anthropic.claude-opus-4-9', classification: 'invalid' },
        { modelId: 'us.anthropic.claude-gone-1-0', classification: 'invalid' },
      ],
      expected: 'INVALID',
    });

    expect(outcome).toEqual({ checked: true, failures: [] });
  });
});

describe('parseExtraProbeIds', () => {
  it('parses, trims, and de-duplicates a comma-separated list', () => {
    const parsed = parseExtraProbeIds(
      ' us.anthropic.claude-opus-4-9 , global.anthropic.claude-sonnet-4-6,us.anthropic.claude-opus-4-9 ,, '
    );

    expect(parsed.ids).toEqual([
      'us.anthropic.claude-opus-4-9',
      'global.anthropic.claude-sonnet-4-6',
    ]);
    expect(parsed.rejected).toEqual([]);
  });

  it('drops anything that is not a Bedrock Anthropic model ID instead of probing it', () => {
    // A typo must become a dropped entry, not a request to an arbitrary URL path.
    const parsed = parseExtraProbeIds('../../etc/passwd, meta.llama3-70b, us.anthropic.claude-x-1');

    expect(parsed.ids).toEqual(['us.anthropic.claude-x-1']);
    expect(parsed.rejected).toEqual(['../../etc/passwd', 'meta.llama3-70b']);
  });

  it('treats empty, undefined, and whitespace input as no self-test', () => {
    for (const input of ['', '   ', undefined, null, ',,']) {
      expect(parseExtraProbeIds(input)).toEqual({ ids: [], rejected: [] });
    }
  });
});

describe('extractModelReferences', () => {
  it('ignores commented-out variables and model IDs', () => {
    // A commented-out reference is not reachable. Counting one would break the
    // scout in both directions: a disabled variable trips the unwatched-variable
    // guard and aborts every scheduled run, and a retired ID left in a comment
    // gets probed and reported dead every week.
    const files = [
      {
        name: 'agent.yml',
        text: [
          '      # model: ${{ vars.DISABLED_BEDROCK_MODEL }}',
          "      # was 'us.anthropic.claude-opus-4-9' until it was retired",
          "      model: ${{ vars.LIVE_BEDROCK_MODEL || 'us.anthropic.claude-opus-4-8' }}",
        ].join('\n'),
      },
    ];
    const references = extractModelReferences(files);

    expect(references.variables.map((v) => v.name)).toEqual(['LIVE_BEDROCK_MODEL']);
    expect(references.literals.map((l) => l.value)).toEqual(['us.anthropic.claude-opus-4-8']);
  });

  it('keeps a reference on a line whose comment comes after it', () => {
    const files = [
      {
        name: 'agent.yml',
        text: "      model: ${{ vars.LIVE_BEDROCK_MODEL || 'us.anthropic.claude-opus-4-8' }} # pinned\n",
      },
    ];
    const references = extractModelReferences(files);

    expect(references.variables.map((v) => v.name)).toEqual(['LIVE_BEDROCK_MODEL']);
    expect(references.literals.map((l) => l.value)).toEqual(['us.anthropic.claude-opus-4-8']);
  });

  it('does not treat a # inside a quoted string as a comment', () => {
    const files = [
      {
        name: 'agent.yml',
        text: "      run: echo 'issue #42' && echo '${{ vars.LIVE_BEDROCK_MODEL }}'\n",
      },
    ];

    expect(extractModelReferences(files).variables.map((v) => v.name)).toEqual([
      'LIVE_BEDROCK_MODEL',
    ]);
  });

  it('extracts both the variables and the literal from a fallback chain', () => {
    const files = [
      {
        name: 'agent.yml',
        text: "            --model ${{ vars.AGENT_BEDROCK_MODEL || vars.RUM_BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-6' }}\n",
      },
    ];
    const references = extractModelReferences(files);
    expect(references.variables.map((v) => v.name)).toEqual([
      'AGENT_BEDROCK_MODEL',
      'RUM_BEDROCK_MODEL',
    ]);
    expect(references.literals).toEqual([
      { value: 'global.anthropic.claude-sonnet-4-6', workflows: ['agent.yml'] },
    ]);
    expect(references.chains).toHaveLength(1);
    expect(references.chains[0].expression).toContain('vars.AGENT_BEDROCK_MODEL');
  });

  it('returns nothing for a workflow with no model reference', () => {
    const references = extractModelReferences([
      { name: 'ci.yml', text: 'jobs:\n  build:\n    runs-on: ubuntu-latest\n' },
    ]);
    expect(references).toEqual({ variables: [], literals: [], chains: [] });
  });

  it('ignores variable names mentioned only in prose comments', () => {
    const references = extractModelReferences([
      { name: 'agent.yml', text: '# RUM_AWS_REGION / AGENT_BEDROCK_MODEL tune the profile.\n' },
    ]);
    expect(references.variables).toEqual([]);
  });

  it('maps each variable and literal to every workflow that uses it', () => {
    const chain = (name) =>
      `--model \${{ vars.${name} || vars.RUM_BEDROCK_MODEL || 'global.anthropic.claude-sonnet-4-6' }}`;
    const references = extractModelReferences([
      { name: 'a.yml', text: chain('A_BEDROCK_MODEL') },
      { name: 'b.yml', text: chain('B_BEDROCK_MODEL') },
    ]);
    const rum = references.variables.find((v) => v.name === 'RUM_BEDROCK_MODEL');
    expect(rum.workflows).toEqual(['a.yml', 'b.yml']);
    expect(references.literals[0].workflows).toEqual(['a.yml', 'b.yml']);
  });

  it('derives the live workflow set from disk rather than a hardcoded list', () => {
    const files = readdirSync(workflowsDir)
      .filter((name) => name.endsWith('.yml'))
      .map((name) => ({ name, text: readFileSync(join(workflowsDir, name), 'utf8') }));
    const references = extractModelReferences(files);
    // Lower bounds, not a copy of the list: the point of deriving from disk is
    // that the list is allowed to change without touching this test.
    expect(references.variables.length).toBeGreaterThanOrEqual(8);
    expect(references.variables.every((v) => v.name.endsWith('_BEDROCK_MODEL'))).toBe(true);
    expect(references.variables.map((v) => v.name)).toContain('RUM_BEDROCK_MODEL');
    expect(references.literals.map((l) => l.value)).toContain('global.anthropic.claude-sonnet-4-6');
  });
});

describe('resolveProbeTargets', () => {
  const references = {
    variables: [
      { name: 'A_BEDROCK_MODEL', workflows: ['a.yml'] },
      { name: 'B_BEDROCK_MODEL', workflows: ['b.yml'] },
      { name: 'RUM_BEDROCK_MODEL', workflows: ['a.yml', 'b.yml'] },
    ],
    literals: [{ value: 'global.anthropic.claude-sonnet-4-6', workflows: ['a.yml', 'b.yml'] }],
    chains: [],
  };

  it('deduplicates IDs and unions the workflows that reach them', () => {
    const resolved = resolveProbeTargets({
      references,
      env: {
        A_BEDROCK_MODEL: 'us.anthropic.claude-opus-4-8',
        B_BEDROCK_MODEL: 'us.anthropic.claude-opus-4-8',
        RUM_BEDROCK_MODEL: '',
      },
    });
    expect(resolved.targets).toHaveLength(2);
    const opus = resolved.targets.find((t) => t.modelId === 'us.anthropic.claude-opus-4-8');
    expect(opus.variables).toEqual(['A_BEDROCK_MODEL', 'B_BEDROCK_MODEL']);
    expect(opus.workflows).toEqual(['a.yml', 'b.yml']);
    expect(opus.viaLiteral).toBe(false);
  });

  it('treats a present-but-empty variable as unset, not as a gap', () => {
    const resolved = resolveProbeTargets({
      references,
      env: { A_BEDROCK_MODEL: '', B_BEDROCK_MODEL: '  ', RUM_BEDROCK_MODEL: '' },
    });
    expect(resolved.missingEnv).toEqual([]);
    expect(resolved.unsetVariables).toEqual([
      'A_BEDROCK_MODEL',
      'B_BEDROCK_MODEL',
      'RUM_BEDROCK_MODEL',
    ]);
    // Only the hardcoded default is reachable, and it is still probed.
    expect(resolved.targets.map((t) => t.modelId)).toEqual(['global.anthropic.claude-sonnet-4-6']);
    expect(resolved.targets[0].viaLiteral).toBe(true);
  });

  it('reports a variable the workflow never passed in as an unwatched gap', () => {
    const resolved = resolveProbeTargets({
      references,
      env: { A_BEDROCK_MODEL: 'us.anthropic.claude-opus-4-8' },
    });
    expect(resolved.missingEnv).toEqual(['B_BEDROCK_MODEL', 'RUM_BEDROCK_MODEL']);
  });
});

describe('resolveErrorType', () => {
  it('strips the Coral namespace from the x-amzn-errortype header', () => {
    expect(resolveErrorType(PAYLOADS.throttled)).toBe('ThrottlingException');
  });

  it('falls back to the __type field in the body', () => {
    expect(
      resolveErrorType({
        body: JSON.stringify({ __type: 'com.amazon.bedrock#ValidationException', message: 'x' }),
      })
    ).toBe('ValidationException');
  });

  it('reads a real Headers instance as well as a plain object', () => {
    expect(resolveErrorType({ headers: new Headers(coral('ResourceNotFoundException')) })).toBe(
      'ResourceNotFoundException'
    );
  });

  it('returns an empty string when nothing identifies the error', () => {
    expect(resolveErrorType({ body: 'gateway timeout' })).toBe('');
  });
});

describe('classifyProbeResult', () => {
  const dead = 'us.anthropic.claude-opus-4-9';
  const live = 'us.anthropic.claude-opus-4-8';

  it('calls a 2xx ok', () => {
    const result = classifyProbeResult({ modelId: live, ...PAYLOADS.answered });
    expect(result.classification).toBe('ok');
    expect(result.evidence).toContain('200');
  });

  it('calls a ValidationException naming the model invalid', () => {
    // The exact ID behind the outage this canary was built for.
    expect(classify(dead, PAYLOADS.invalidModelId)).toBe('invalid');
    expect(classify(dead, PAYLOADS.onDemandUnsupported)).toBe('invalid');
  });

  it('calls a ResourceNotFoundException invalid', () => {
    expect(classify(dead, PAYLOADS.resourceNotFound)).toBe('invalid');
  });

  it('calls an AccessDeniedException about the model itself invalid', () => {
    expect(classify(dead, PAYLOADS.modelAccessDenied)).toBe('invalid');
  });

  it('never calls a throttled, quota-limited, or 5xx week a dead model', () => {
    expect(classify(live, PAYLOADS.throttled)).toBe('inconclusive');
    expect(classify(live, PAYLOADS.quotaExceeded)).toBe('inconclusive');
    expect(classify(live, PAYLOADS.internalError)).toBe('inconclusive');
  });

  it('calls an IAM permission denial inconclusive even though it is a 403', () => {
    // The message quotes the model ARN, so a naive "does the body mention the
    // model ID" rule would report a working model as dead.
    const result = classifyProbeResult({ modelId: live, ...PAYLOADS.iamAccessDenied });
    expect(result.classification).toBe('inconclusive');
    expect(result.reason).toContain('permission');
  });

  it('calls a request-shape ValidationException inconclusive, not a model verdict', () => {
    expect(classify(live, PAYLOADS.badRequestShape)).toBe('inconclusive');
  });

  it('calls a transport error or timeout inconclusive', () => {
    const timeout = classifyProbeResult({
      modelId: live,
      networkError: new Error('The operation was aborted due to timeout'),
    });
    expect(timeout.classification).toBe('inconclusive');
    expect(timeout.evidence).toContain('timeout');
    expect(classifyProbeResult({ modelId: live, networkError: 'ECONNRESET' }).classification).toBe(
      'inconclusive'
    );
  });

  it('defaults an unrecognised response to inconclusive', () => {
    expect(classify(live, { status: 418, body: 'teapot' })).toBe('inconclusive');
  });
});

describe('parseModelFamily / suggestReplacement', () => {
  it('splits region prefix, family, and version', () => {
    expect(parseModelFamily('us.anthropic.claude-opus-4-9')).toEqual({
      regionPrefix: 'us',
      family: 'anthropic.claude-opus',
      version: '4-9',
    });
    expect(parseModelFamily('anthropic.claude-sonnet-4-6').regionPrefix).toBe('');
    expect(parseModelFamily('not-a-model')).toBeNull();
  });

  it('prefers a same-family, same-region ID that was probed ok', () => {
    expect(
      suggestReplacement('us.anthropic.claude-opus-4-9', [
        'global.anthropic.claude-sonnet-4-6',
        'us.anthropic.claude-opus-4-8',
      ])
    ).toBe('us.anthropic.claude-opus-4-8');
  });

  it('never invents an ID when no probed sibling exists', () => {
    expect(
      suggestReplacement('us.anthropic.claude-opus-4-9', ['global.anthropic.claude-sonnet-4-6'])
    ).toBeNull();
    expect(suggestReplacement('us.anthropic.claude-opus-4-9', [])).toBeNull();
  });
});

describe('summarizeResults / buildReport', () => {
  const result = (modelId, classification, extra = {}) => ({
    modelId,
    variables: [],
    workflows: [],
    viaLiteral: true,
    classification,
    reason: 'reason',
    evidence: `evidence for ${modelId}`,
    ...extra,
  });

  it('files nothing when every reachable ID is ok', () => {
    const results = [
      result('global.anthropic.claude-sonnet-4-6', 'ok'),
      result('us.anthropic.claude-opus-4-8', 'ok'),
    ];
    const report = buildReport({ results });
    expect(report.shouldFile).toBe(false);
    expect(report.body).toBe('');
    expect(report.summary).toMatchObject({ ok: 2, invalid: 0, allInconclusive: false });
  });

  it('files nothing when every probe was inconclusive, but flags the blind run', () => {
    const results = [
      result('global.anthropic.claude-sonnet-4-6', 'inconclusive'),
      result('us.anthropic.claude-opus-4-8', 'inconclusive'),
    ];
    const report = buildReport({ results });
    expect(report.shouldFile).toBe(false);
    expect(report.summary.allInconclusive).toBe(true);
    expect(report.summary.anyInvalid).toBe(false);
  });

  it('blames the credential, not eleven variables, when every probe fails', () => {
    // Bedrock rejects a retired model ID and an account that lost its entitlement
    // with the same message, so one bad credential fails every probe at once. The
    // report has to stay loud — that is an outage — while not sending someone to
    // rewrite every healthy variable in the repo.
    const results = [
      result('global.anthropic.claude-sonnet-4-6', 'invalid'),
      result('us.anthropic.claude-opus-4-8', 'invalid'),
      result('us.anthropic.claude-haiku-4-5', 'invalid'),
    ];
    const report = buildReport({ results, region: 'us-east-1' });

    expect(report.shouldFile).toBe(true);
    expect(report.summary.allInvalid).toBe(true);
    expect(report.title).toContain('check the credential first');
    expect(report.body).toContain('AWS_BEARER_TOKEN_BEDROCK');
    // The per-model "set this variable" instruction must NOT appear here.
    expect(report.body).not.toContain('Secrets and variables');
  });

  it('still reports a single dead ID as a model problem, not a credential one', () => {
    const results = [
      result('us.anthropic.claude-opus-4-8', 'ok'),
      result('us.anthropic.claude-opus-4-9', 'invalid'),
    ];
    const report = buildReport({ results });

    expect(report.summary.allInvalid).toBe(false);
    expect(report.title).toContain('1 unusable model ID');
    expect(report.body).toContain('Secrets and variables');
  });

  it('does not flag a blind run when at least one probe was definite', () => {
    expect(
      summarizeResults([result('a.anthropic.x-1', 'ok'), result('b.anthropic.x-1', 'inconclusive')])
        .allInconclusive
    ).toBe(false);
    expect(summarizeResults([]).allInconclusive).toBe(false);
  });

  it('renders an actionable body naming the variable, workflows, and replacement', () => {
    const results = [
      result('us.anthropic.claude-opus-4-9', 'invalid', {
        variables: ['PR_FIX_BEDROCK_MODEL'],
        workflows: ['pr-fix-dispatcher.yml'],
        viaLiteral: false,
        reason: 'rejected as an unusable model ID',
        evidence: '400 ValidationException: The provided model identifier is invalid.',
      }),
      result('us.anthropic.claude-opus-4-8', 'ok'),
      result('global.anthropic.claude-sonnet-4-6', 'inconclusive'),
    ];
    const report = buildReport({ results, region: 'us-east-1' });
    expect(report.shouldFile).toBe(true);
    expect(report.title).toContain('1 unusable model ID');
    expect(report.body).toContain(ISSUE_MARKER);
    expect(report.body).toContain('us.anthropic.claude-opus-4-9');
    expect(report.body).toContain('`PR_FIX_BEDROCK_MODEL`');
    expect(report.body).toContain('.github/workflows/pr-fix-dispatcher.yml');
    expect(report.body).toContain('400 ValidationException');
    expect(report.body).toContain('Replace with:** `us.anthropic.claude-opus-4-8`');
    expect(report.body).toContain('cannot write repository variables');
    // The inconclusive ID is listed as inconclusive and never as unusable.
    expect(report.body).toContain('inconclusive');
    expect(report.body).not.toMatch(/### `global\.anthropic\.claude-sonnet-4-6` — unusable/);
  });

  it('says plainly when no verified replacement exists', () => {
    const report = buildReport({
      results: [result('us.anthropic.claude-opus-4-9', 'invalid')],
    });
    expect(report.body).toContain('no verified replacement was found');
  });
});
