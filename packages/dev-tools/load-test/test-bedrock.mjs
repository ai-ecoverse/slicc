#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * Quick smoke test for Bedrock CAMP credentials.
 * Loads env from /tmp/bedrock-test.env at runtime.
 *
 * Usage: node --env-file=/tmp/bedrock-test.env packages/dev-tools/load-test/test-bedrock.mjs
 */

const apiKey = process.env.BEDROCK_API_KEY;
const baseUrl = process.env.BEDROCK_BASE_URL;
const modelId = process.env.BEDROCK_MODEL;

if (!apiKey || !baseUrl || !modelId) {
  console.error('Missing env vars. Run with:');
  console.error(
    '  node --env-file=/tmp/bedrock-test.env packages/dev-tools/load-test/test-bedrock.mjs'
  );
  console.error('Required: BEDROCK_API_KEY, BEDROCK_BASE_URL, BEDROCK_MODEL');
  process.exit(1);
}

const url = `${baseUrl.replace(/\/$/, '')}/model/${encodeURIComponent(modelId)}/converse`;

console.log(`Testing Bedrock CAMP...`);
console.log(`  URL:   ${url}`);
console.log(`  Model: ${modelId}`);
console.log(`  Key:   ${apiKey.slice(0, 8)}...`);
console.log('');

const body = {
  modelId,
  messages: [{ role: 'user', content: [{ text: 'Say "hello" and nothing else.' }] }],
  inferenceConfig: {
    maxTokens: 50,
    temperature: 0,
  },
};

try {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  console.log(`Status: ${resp.status} ${resp.statusText}`);

  const text = await resp.text();
  if (resp.ok) {
    const json = JSON.parse(text);
    const reply = json.output?.message?.content?.[0]?.text ?? '(no text)';
    console.log(`Response: "${reply}"`);
    console.log('\nCredentials work!');
  } else {
    console.error(`Error body:\n${text.slice(0, 500)}`);
    console.error('\nCredentials or model ID may be wrong.');
  }
} catch (err) {
  console.error(`Fetch failed: ${err.message}`);
}
