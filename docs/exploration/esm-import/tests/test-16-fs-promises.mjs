// Test 16: fs/promises (async fs)
import { readFile } from 'fs/promises';
try {
  const content = await readFile('/slicc/findings/test-helper.mjs', 'utf-8');
  console.log('result: PASS');
  console.log('read bytes:', content.length);
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
