// Test 01: Static import with bare specifier (npm package)
import dotenv from 'dotenv';
console.log('result:', typeof dotenv.config === 'function' ? 'PASS' : 'FAIL');
