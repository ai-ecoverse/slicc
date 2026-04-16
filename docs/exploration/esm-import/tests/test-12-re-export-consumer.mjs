// Test 12b: consuming the re-export barrel
import { helperFn, parse } from './test-12-re-export.mjs';
try {
  const h = helperFn();
  const p = parse('X=1');
  console.log('result: PASS — helperFn:', h, '| parse:', JSON.stringify(p));
} catch (e) {
  console.log('result: FAIL —', e.message);
}
