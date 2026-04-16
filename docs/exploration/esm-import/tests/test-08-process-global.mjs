// Test 08: process global availability
try {
  const env = process.env;
  console.log('result: PASS — process.env is', typeof env);
} catch (e) {
  console.log('result: FAIL —', e.message);
}
