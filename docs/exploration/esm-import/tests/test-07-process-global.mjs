// Test 07: process global in .mjs
try {
  const val = process.env;
  console.log('result: PASS');
  console.log('process.env type:', typeof val);
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
