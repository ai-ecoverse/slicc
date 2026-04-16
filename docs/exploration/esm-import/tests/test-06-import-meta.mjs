// Test 06: import.meta.url
try {
  const url = import.meta.url;
  console.log('result: PASS');
  console.log('import.meta.url:', url);
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
}
