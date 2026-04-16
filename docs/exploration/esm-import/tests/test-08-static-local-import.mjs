// Test 08: Static import of a local relative file
import { value } from './test-helper.mjs';
console.log('result:', value === 'hello' ? 'PASS' : 'FAIL');
console.log('value:', value);
