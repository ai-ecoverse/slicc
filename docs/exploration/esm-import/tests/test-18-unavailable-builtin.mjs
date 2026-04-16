// Test 18: unavailable built-in (http) — should throw helpful error
import http from 'http';
try {
  const s = http.createServer();
  console.log('result: UNEXPECTED PASS');
} catch (e) {
  console.log('result: PASS (expected error) —', e.message);
}
