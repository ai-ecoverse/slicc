import { describe, expect, it, vi } from 'vitest';
import {
  bedrockBase,
  buildConverseBody,
  buildJudgeText,
  converse,
  DEFAULT_JUDGE_MODEL,
  findingsSchema,
  judgeRun,
  score,
  truncateMiddle,
  validateJudgement,
} from './judge.mjs';

const CAPS = {
  task: 1000,
  website: 100,
  rubric: 1000,
  finalResult: 1000,
  trajectory: 1000,
  files: 1000,
};
const SPEC = { systemPrompt: 'SYSTEM', caps: CAPS };
const TASK = {
  id: 't1',
  task: 'Find X.',
  rubric: 'A1_x — x\nA2_y — y',
  weights: { A1_x: 70, A2_y: 30 },
  canary: 'CANARY-123',
  slicc: { website: 'https://example.com' },
};
const TRACE = {
  finalResult: 'FINAL ANSWER: x',
  steps: ['## user\nFind X.', '## assistant\nopened the page'],
  screenshots: [{ label: '3 s into the run, https://example.com/', format: 'png', base64: 'AAAA' }],
  outputFilesText: null,
};
const JUDGEMENT = {
  agent_task_reading: 'r',
  findings: [
    { item: 'A1_x', evidence: 'e', status: 'met' },
    { item: 'A2_y', evidence: 'e', status: 'met' },
  ],
  observations: [],
  infra_error: false,
  pii_present: false,
  reward_hacking_suspected: false,
  flag_notes: null,
};

describe('truncateMiddle', () => {
  it('keeps short text and clips the middle of long text', () => {
    expect(truncateMiddle('abc', 10)).toBe('abc');
    expect(truncateMiddle(null, 10)).toBe('');
    const out = truncateMiddle('a'.repeat(10) + 'b'.repeat(10), 10);
    expect(out).toBe('aaaaa\n... [10 characters omitted] ...\nbbbbb');
  });
});

describe('request building', () => {
  it('lays out upstream sections with numbered steps', () => {
    const text = buildJudgeText({ task: TASK, trace: TRACE, caps: CAPS });
    expect(text).toContain('<task>\nFind X.\n</task>');
    expect(text).toContain('<website>\nhttps://example.com\n</website>');
    expect(text).toContain('rubrics/t1.md');
    expect(text).toContain('[step 2] ## assistant\nopened the page');
    expect(text).toContain('<final_result>\nFINAL ANSWER: x\n</final_result>');
    expect(text).not.toContain('<output_files>');
    expect(text).toContain('1 screenshots are attached');
    const withFiles = buildJudgeText({
      task: { ...TASK, slicc: undefined },
      trace: { ...TRACE, outputFilesText: '### /tmp/a\nhi', finalResult: '' },
      caps: CAPS,
    });
    expect(withFiles).toContain('<output_files>\n### /tmp/a\nhi\n</output_files>');
    expect(withFiles).toContain('No website provided');
    expect(withFiles).toContain('No final result provided');
  });

  it('pins the item enum to the task and forces the tool', () => {
    expect(findingsSchema(['A1_x']).properties.findings.items.properties.item.enum).toEqual([
      'A1_x',
    ]);
    const body = buildConverseBody({ spec: SPEC, task: TASK, trace: TRACE });
    expect(body.system).toEqual([{ text: 'SYSTEM' }]);
    expect(body.toolConfig.toolChoice).toEqual({ tool: { name: 'report_findings' } });
    expect(
      body.toolConfig.tools[0].toolSpec.inputSchema.json.properties.findings.items.properties.item
        .enum
    ).toEqual(['A1_x', 'A2_y']);
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content[2]).toEqual({
      image: { format: 'png', source: { bytes: 'AAAA' } },
    });
    expect(
      buildConverseBody({ spec: SPEC, task: TASK, trace: TRACE, includeImages: false }).messages[0]
        .content
    ).toHaveLength(1);
  });
});

describe('validateJudgement', () => {
  it('accepts a complete judgement and names what is wrong otherwise', () => {
    expect(validateJudgement(JUDGEMENT, ['A1_x', 'A2_y'])).toEqual([]);
    expect(validateJudgement(null, [])).toEqual(['judgement is not an object']);
    const bad = validateJudgement({ findings: [{ item: 'Z', status: 'maybe' }] }, ['A1_x']);
    expect(bad).toContain('finding for unknown item "Z"');
    expect(bad).toContain('finding Z has status "maybe"');
    expect(bad).toContain('infra_error is not a boolean');
    expect(
      validateJudgement(
        { findings: 'x', infra_error: false, pii_present: false, reward_hacking_suspected: false },
        []
      )
    ).toEqual(['findings is not a list']);
  });
});

describe('score', () => {
  it('earns the weight of met items only', () => {
    const s = score(TASK, {
      findings: [
        { item: 'A1_x', status: 'met' },
        { item: 'A2_y', status: 'not_assessable' },
      ],
    });
    expect(s.score).toBeCloseTo(0.7);
    expect(s.verdict).toBe(false);
    expect(s.missing_items).toEqual([]);
  });

  it('resolves duplicate findings worst-wins and counts missing items as unearned', () => {
    const s = score(TASK, {
      findings: [
        { item: 'A1_x', status: 'met' },
        { item: 'A1_x', status: 'violated' },
        { item: 'A1_x', status: 'met' },
      ],
    });
    expect(s.score).toBe(0);
    expect(s.statuses.A1_x).toBe('violated');
    expect(s.missing_items).toEqual(['A2_y']);
  });

  it('passes when every item is met', () => {
    expect(score(TASK, JUDGEMENT)).toMatchObject({ score: 1, verdict: true, earned_weight: 100 });
  });

  it('zeroes a run on suspected reward hacking or a canary leak', () => {
    expect(score(TASK, { ...JUDGEMENT, reward_hacking_suspected: true })).toMatchObject({
      score: 0,
      verdict: false,
      rh_zeroed: true,
    });
    expect(score(TASK, JUDGEMENT, ['I read CANARY-123'])).toMatchObject({
      score: 0,
      canary_leak: true,
    });
    expect(score({ ...TASK, canary: undefined }, JUDGEMENT, ['CANARY-123']).canary_leak).toBe(
      false
    );
  });
});

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
const TOOL_REPLY = {
  output: { message: { content: [{ toolUse: { name: 'report_findings', input: JUDGEMENT } }] } },
  usage: { totalTokens: 9 },
};

describe('converse', () => {
  it('builds the Bedrock URL and bearer header', async () => {
    expect(bedrockBase('eu-central-1')).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com');
    expect(bedrockBase('https://x.example/')).toBe('https://x.example');
    expect(bedrockBase()).toBe('https://bedrock-runtime.us-west-2.amazonaws.com');
    const fetchImpl = vi.fn(async () => reply(200, TOOL_REPLY));
    const out = await converse({
      model: DEFAULT_JUDGE_MODEL,
      body: {},
      apiKey: 'k',
      region: 'us-west-2',
      fetchImpl,
    });
    expect(out).toEqual({ input: JUDGEMENT, usage: { totalTokens: 9 } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://bedrock-runtime.us-west-2.amazonaws.com/model/${encodeURIComponent(DEFAULT_JUDGE_MODEL)}/converse`
    );
    expect(init.headers.authorization).toBe('Bearer k');
  });

  it('retries throttling and server errors, not client errors', async () => {
    const sleep = vi.fn(async () => {});
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(reply(429, 'slow down'))
      .mockResolvedValueOnce(reply(503, 'busy'))
      .mockResolvedValueOnce(reply(200, TOOL_REPLY));
    await expect(
      converse({ model: 'm', body: {}, apiKey: 'k', fetchImpl: flaky, sleep })
    ).resolves.toMatchObject({ input: JUDGEMENT });
    expect(sleep).toHaveBeenCalledTimes(2);
    const down = vi.fn(async () => reply(500, 'down'));
    await expect(
      converse({ model: 'm', body: {}, apiKey: 'k', fetchImpl: down, sleep })
    ).rejects.toThrow(/HTTP 500/);
    const bad = vi.fn(async () => reply(400, 'The model does not support image input'));
    await expect(
      converse({ model: 'm', body: {}, apiKey: 'k', fetchImpl: bad, sleep })
    ).rejects.toMatchObject({ imageUnsupported: true });
  });

  it('refuses without a key and when the tool was not called', async () => {
    await expect(converse({ model: 'm', body: {}, apiKey: '' })).rejects.toThrow(/API key/);
    const noTool = vi.fn(async () =>
      reply(200, { output: { message: { content: [{ text: 'hi' }] } } })
    );
    await expect(
      converse({ model: 'm', body: {}, apiKey: 'k', fetchImpl: noTool })
    ).rejects.toThrow(/without calling/);
  });
});

describe('judgeRun', () => {
  it('scores a valid judgement', async () => {
    const fetchImpl = vi.fn(async () => reply(200, TOOL_REPLY));
    const out = await judgeRun({ spec: SPEC, task: TASK, trace: TRACE, apiKey: 'k', fetchImpl });
    expect(out.result.score).toBe(1);
    expect(out.imagesSent).toBe(true);
  });

  it('retries text-only when the model refuses images', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(400, 'image not supported'))
      .mockResolvedValueOnce(reply(200, TOOL_REPLY));
    const out = await judgeRun({ spec: SPEC, task: TASK, trace: TRACE, apiKey: 'k', fetchImpl });
    expect(out.imagesSent).toBe(false);
    const secondBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondBody.messages[0].content).toHaveLength(1);
  });

  it('rethrows other client errors, and rejects an invalid judgement', async () => {
    const denied = vi.fn(async () => reply(403, 'denied'));
    await expect(
      judgeRun({ spec: SPEC, task: TASK, trace: TRACE, apiKey: 'k', fetchImpl: denied })
    ).rejects.toThrow(/403/);
    const noImages = { ...TRACE, screenshots: [] };
    const refusedAnyway = vi.fn(async () => reply(400, 'image problem'));
    await expect(
      judgeRun({ spec: SPEC, task: TASK, trace: noImages, apiKey: 'k', fetchImpl: refusedAnyway })
    ).rejects.toThrow(/400/);
    const invalid = vi.fn(async () =>
      reply(200, {
        output: {
          message: {
            content: [{ toolUse: { input: { findings: [{ item: 'nope', status: 'met' }] } } }],
          },
        },
      })
    );
    await expect(
      judgeRun({ spec: SPEC, task: TASK, trace: TRACE, apiKey: 'k', fetchImpl: invalid })
    ).rejects.toThrow(/judge output is invalid/);
  });
});
