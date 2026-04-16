// Test 02: Static named import from npm package
import { parse } from 'dotenv';
const result = parse('FOO=bar\nBAZ=qux');
console.log('result:', JSON.stringify(result) === '{"FOO":"bar","BAZ":"qux"}' ? 'PASS' : 'FAIL');
console.log('parsed:', JSON.stringify(result));
