// Test 06: Static import with relative path
import { helperFn } from './helper.mjs';
console.log('result:', helperFn() === 'hello from helper' ? 'PASS' : 'FAIL');
