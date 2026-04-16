// Test 11: node: prefix imports
import { readFile } from 'node:fs/promises';
try {
  const content = await readFile('/slicc/findings/helper.mjs', 'utf-8');
  console.log('result: PASS — read', content.length, 'bytes');
} catch (e) {
  console.log('result: FAIL —', e.message);
}
