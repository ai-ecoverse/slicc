// Test 15: Top-level await
const result = await Promise.resolve('async works');
console.log('result:', result === 'async works' ? 'PASS' : 'FAIL');
console.log('value:', result);
