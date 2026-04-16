// Test 03: Dynamic import with bare specifier
try {
  const m = await import('dotenv');
  console.log('result: PASS');
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
