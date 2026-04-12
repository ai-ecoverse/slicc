#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * Test Bedrock CAMP credentials across multiple regions.
 * Usage: node --env-file=.env packages/dev-tools/load-test/test-bedrock-regions.mjs
 */

const apiKey = process.env.BEDROCK_API_KEY;
const modelId = process.env.BEDROCK_MODEL;

if (!apiKey || !modelId) {
  console.error('Missing BEDROCK_API_KEY or BEDROCK_MODEL in env');
  process.exit(1);
}

const regions = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1'];

const body = JSON.stringify({
  modelId,
  messages: [{ role: 'user', content: [{ text: 'Say "hello" and nothing else.' }] }],
  inferenceConfig: { maxTokens: 50, temperature: 0 },
});

console.log(`Testing ${regions.length} regions with model: ${modelId}\n`);

for (const region of regions) {
  const baseUrl = `https://bedrock-runtime.${region}.amazonaws.com`;
  const url = `${baseUrl}/model/${encodeURIComponent(modelId)}/converse`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.ok) {
      const json = await resp.json();
      const reply = json.output?.message?.content?.[0]?.text ?? '(no text)';
      console.log(`  ${region}: ✓ 200 — "${reply}"`);
    } else {
      const text = await resp.text();
      console.log(`  ${region}: ✗ ${resp.status} — ${text.slice(0, 100)}`);
    }
  } catch (err) {
    console.log(`  ${region}: ✗ ${err.message}`);
  }
}
