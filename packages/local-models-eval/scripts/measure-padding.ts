import { buildSyntheticPadding } from '../src/padding.js';

console.log('target | actual~ | chars   | files in | files skipped');
console.log('-------+---------+---------+----------+---------------');
for (const t of [0, 4000, 8000, 16000, 25000, 50000]) {
  const p = buildSyntheticPadding(t);
  console.log(
    `${String(t).padStart(6)} | ${String(p.approxTokens).padStart(7)} | ${String(p.chars).padStart(7)} | ${String(p.filesIncluded.length).padStart(8)} | ${String(p.filesSkipped.length).padStart(13)}`
  );
}

console.log('\nIncluded at target=25000:');
const big = buildSyntheticPadding(25000);
for (const f of big.filesIncluded) console.log(`  + ${f}`);
console.log('\nSkipped at target=25000:');
for (const f of big.filesSkipped) console.log(`  - ${f}`);
