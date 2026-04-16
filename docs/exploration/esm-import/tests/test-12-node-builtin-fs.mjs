// Test 12: Static import of node built-in 'fs'
import { readFileSync } from 'fs';
try {
  const content = readFileSync('/slicc/findings/test-helper.mjs', 'utf-8');
  console.log('result: PASS');
  console.log('read bytes:', content.length);
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
