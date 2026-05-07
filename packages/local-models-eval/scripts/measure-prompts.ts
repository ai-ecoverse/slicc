import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SCENARIOS } from '../src/scenarios.js';
import { pickTools } from '../src/tools.js';
import { Sandbox } from '../src/sandbox.js';

const estTokens = (s: string) => Math.round(s.length / 4);

console.log(
  'Scenario              | sys chars | sys tok~ | tool schema chars | tool tok~ | request tok~'
);
console.log(
  '----------------------+-----------+----------+-------------------+-----------+-------------'
);
for (const s of SCENARIOS) {
  const sb = s.needsSandbox ? new Sandbox(mkdtempSync(`${tmpdir()}/m-`)) : null;
  const tools = pickTools(s.toolNames, sb);
  const toolsJson = JSON.stringify(
    tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  );
  const total = estTokens(s.system) + estTokens(toolsJson) + estTokens(s.user);
  console.log(
    `${s.name.padEnd(21)} | ${String(s.system.length).padStart(9)} | ${String(estTokens(s.system)).padStart(8)} | ${String(toolsJson.length).padStart(17)} | ${String(estTokens(toolsJson)).padStart(9)} | ${String(total).padStart(12)}`
  );
}
console.log('\nSLICC cone first prompt (observed in SwiftLM logs earlier): ~32,938 tokens');
console.log('SLICC cone delta turns (cached, mid-session):              ~1,200 tokens / round');
