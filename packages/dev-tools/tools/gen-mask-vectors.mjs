#!/usr/bin/env node

import { mask } from '../../shared-ts/dist/secret-masking.js';

const vectors = [
  { sessionId: 'session-cross-impl-1', name: 'GITHUB_TOKEN', value: 'ghp_realToken123' },
  { sessionId: 'session-cross-impl-2', name: 'AWS_KEY', value: 'AKIAEXAMPLE' },
  { sessionId: '', name: 'X', value: '' },
  { sessionId: 'session-😀', name: 'Y', value: 'value with spaces' },

  { sessionId: 'session-utf16', name: 'EMOJI_VALUE', value: 'tok🎉end' },
];

for (const v of vectors) {
  const expected = await mask(v.sessionId, v.name, v.value);
  console.log(JSON.stringify({ ...v, expected }));
}
