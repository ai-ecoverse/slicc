// Test 10: import fs shim
import { readFile } from 'fs';
try {
  const content = await readFile('/slicc/findings/helper.mjs', 'utf-8');
  console.log('result: PASS — read', content.length, 'bytes');
} catch (e) {
  console.log('result: FAIL —', e.message);
}
