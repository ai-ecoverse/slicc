// Test 12b: fs default import (not named) — check what fs shim actually exports
import fs from 'fs';
try {
  const content = fs.readFileSync('/slicc/findings/test-helper.mjs', 'utf-8');
  console.log('result: PASS');
  console.log('read bytes:', content.length);
} catch (e) {
  console.log('result: FAIL');
  console.log('error:', e.message);
  console.log('fs keys:', Object.keys(fs));
}
