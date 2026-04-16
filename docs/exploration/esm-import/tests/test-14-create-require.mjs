// Test 14: createRequire from 'module' built-in
import { createRequire } from 'module';
try {
  const require = createRequire(import.meta.url);
  const p = require('process');
  console.log('result: PASS');
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
