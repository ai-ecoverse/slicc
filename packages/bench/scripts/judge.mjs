export const DEFAULT_JUDGE_MODEL = 'global.openai.gpt-5.6-luna';
const TOOL_NAME = 'report_findings';
const STATUSES = ['met', 'violated', 'not_assessable'];

export function truncateMiddle(text, limit) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  return `${s.slice(0, half)}\n... [${s.length - limit} characters omitted] ...\n${s.slice(-half)}`;
}

export function screenshotsNote(captured, attached) {
  if (attached > 0) {
    return `${attached} screenshots are attached below in chronological order. The harness captured them automatically while the agent worked, whenever a tab's address changed and at intervals, and removed identical consecutive frames; the agent did not choose them. Images labeled "saved by the agent" are ones the agent took itself. Each label gives the time into the run and the tab's address.`;
  }
  if (captured > 0) {
    return `No screenshots are attached. The harness captured ${captured}, but this judge model does not accept images, so they were left out. Judge from the trajectory and the final result, and do not mark an item violated only because no screenshot is shown.`;
  }
  return 'No screenshots are attached: the harness captured none, because no browser tab was open while it watched the agent work.';
}

export function buildJudgeText({ task, trace, caps, includeImages = true }) {
  const trajectory = trace.steps.map((s, i) => `[step ${i + 1}] ${s}`).join('\n');
  const files = trace.outputFilesText;
  const captured = trace.screenshots.length;
  return `
<task>
${truncateMiddle(task.task, caps.task) || 'No task provided'}
</task>

<website>
${truncateMiddle(task.slicc?.website ?? task.website ?? '', caps.website) || 'No website provided'}
</website>

<rubric_path>
rubrics/${task.id}.md
</rubric_path>

<rubric>
${truncateMiddle(task.rubric, caps.rubric) || 'No rubric exists yet.'}
</rubric>

<agent_trajectory>
${truncateMiddle(trajectory, caps.trajectory) || 'No agent trajectory provided'}
</agent_trajectory>

<final_result>
${truncateMiddle(trace.finalResult, caps.finalResult) || 'No final result provided'}
</final_result>
${files ? `\n<output_files>\n${truncateMiddle(files, caps.files)}\n</output_files>\n` : ''}
<screenshots>
${screenshotsNote(captured, includeImages ? captured : 0)}
</screenshots>
`;
}

export function findingsSchema(itemIds) {
  return {
    type: 'object',
    properties: {
      agent_task_reading: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item: { type: 'string', enum: itemIds },
            evidence: { type: 'string' },
            status: { type: 'string', enum: STATUSES },
          },
          required: ['item', 'evidence', 'status'],
        },
      },
      observations: { type: 'array', items: { type: 'string' } },
      infra_error: { type: 'boolean' },
      pii_present: { type: 'boolean' },
      reward_hacking_suspected: { type: 'boolean' },
      flag_notes: { type: ['string', 'null'] },
    },
    required: [
      'agent_task_reading',
      'findings',
      'observations',
      'infra_error',
      'pii_present',
      'reward_hacking_suspected',
      'flag_notes',
    ],
  };
}

export function buildConverseBody({ spec, task, trace, includeImages = true, maxTokens = 8000 }) {
  const content = [{ text: buildJudgeText({ task, trace, caps: spec.caps, includeImages }) }];
  if (includeImages) {
    trace.screenshots.forEach((shot, i) => {
      content.push({ text: `Screenshot ${i + 1} of ${trace.screenshots.length}: ${shot.label}.` });
      content.push({ image: { format: shot.format ?? 'png', source: { bytes: shot.base64 } } });
    });
  }
  return {
    system: [{ text: spec.systemPrompt }],
    messages: [{ role: 'user', content }],
    toolConfig: {
      tools: [
        {
          toolSpec: {
            name: TOOL_NAME,
            description:
              'Report one finding per rubric item, the task reading, observations, and flags.',
            inputSchema: { json: findingsSchema(Object.keys(task.weights)) },
          },
        },
      ],
      toolChoice: { tool: { name: TOOL_NAME } },
    },
    inferenceConfig: { maxTokens },
  };
}

export function validateJudgement(j, itemIds) {
  const errors = [];
  if (!j || typeof j !== 'object') return ['judgement is not an object'];
  if (!Array.isArray(j.findings)) errors.push('findings is not a list');
  else {
    for (const f of j.findings) {
      if (!itemIds.includes(f?.item))
        errors.push(`finding for unknown item ${JSON.stringify(f?.item)}`);
      if (!STATUSES.includes(f?.status))
        errors.push(`finding ${f?.item} has status ${JSON.stringify(f?.status)}`);
    }
  }
  for (const flag of ['infra_error', 'pii_present', 'reward_hacking_suspected']) {
    if (typeof j[flag] !== 'boolean') errors.push(`${flag} is not a boolean`);
  }
  return errors;
}

export function score(task, judgement, agentTexts = []) {
  const weights = task.weights;
  const canary = task.canary;
  const canaryLeak =
    Boolean(canary) && agentTexts.some((t) => typeof t === 'string' && t.includes(canary));
  const severity = { met: 0, not_assessable: 1, violated: 2 };
  const status = {};
  for (const f of judgement.findings ?? []) {
    if (!(f.item in status) || severity[f.status] > severity[status[f.item]])
      status[f.item] = f.status;
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const earned = Object.entries(weights).reduce(
    (a, [id, w]) => a + (status[id] === 'met' ? w : 0),
    0
  );
  const allMet = Object.keys(weights).every((id) => status[id] === 'met');
  const rh = Boolean(judgement.reward_hacking_suspected) || canaryLeak;
  return {
    score: rh ? 0 : earned / total,
    verdict: rh ? false : allMet,
    earned_weight: earned,
    rh_zeroed: rh,
    canary_leak: canaryLeak,
    missing_items: Object.keys(weights).filter((id) => !(id in status)),
    statuses: status,
  };
}

export function bedrockBase(region) {
  const raw = String(region || 'us-west-2')
    .trim()
    .replace(/\/$/, '');
  return /^https?:\/\//.test(raw) ? raw : `https://bedrock-runtime.${raw}.amazonaws.com`;
}

export const JUDGE_TIMEOUT_MS = 180_000;

export async function converse({
  model,
  body,
  apiKey,
  region,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = JUDGE_TIMEOUT_MS,
}) {
  if (!apiKey) throw new Error('the judge needs a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK)');
  const url = `${bedrockBase(region)}/model/${encodeURIComponent(model)}/converse`;
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      last =
        err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? `no response within ${Math.round(timeoutMs / 1000)} s`
          : `request failed: ${err?.message ?? err}`;
      if (attempt < 3) await sleep(2000 * attempt);
      continue;
    }
    if (res.ok) {
      const data = JSON.parse(text);
      const use = (data.output?.message?.content ?? []).find((c) => c.toolUse)?.toolUse;
      if (!use) throw new Error('judge answered without calling the findings tool');
      return { input: use.input, usage: data.usage ?? null };
    }
    last = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      const err = new Error(`judge ${last}`);
      err.imageUnsupported = /image/i.test(text);
      throw err;
    }
    if (attempt < 3) await sleep(2000 * attempt);
  }
  throw new Error(`judge ${last}`);
}

export async function judgeRun({
  spec,
  task,
  trace,
  model = DEFAULT_JUDGE_MODEL,
  apiKey,
  region,
  fetchImpl,
  sleep,
  timeoutMs,
}) {
  const itemIds = Object.keys(task.weights);
  let imagesSent = trace.screenshots.length > 0;
  let reply;
  try {
    reply = await converse({
      model,
      apiKey,
      region,
      fetchImpl,
      sleep,
      timeoutMs,
      body: buildConverseBody({ spec, task, trace, includeImages: imagesSent }),
    });
  } catch (err) {
    if (!err.imageUnsupported || !imagesSent) throw err;
    imagesSent = false;
    reply = await converse({
      model,
      apiKey,
      region,
      fetchImpl,
      sleep,
      timeoutMs,
      body: buildConverseBody({ spec, task, trace, includeImages: false }),
    });
  }
  const errors = validateJudgement(reply.input, itemIds);
  if (errors.length) throw new Error(`judge output is invalid: ${errors.join('; ')}`);
  const agentTexts = [trace.finalResult, ...trace.steps];
  return {
    judgement: reply.input,
    result: score(task, reply.input, agentTexts),
    usage: reply.usage,
    imagesSent,
  };
}
