// Test 07: import.meta.url
try {
  const url = import.meta.url;
  console.log('result: PASS —', url);
} catch (e) {
  console.log('result: FAIL —', e.message);
}
