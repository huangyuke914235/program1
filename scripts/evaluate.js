import { runEvaluation } from '../src/evaluation.js';

const evaluation = await runEvaluation();
for (const item of evaluation.cases) console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.name} (${item.durationMs}ms)${item.passed ? '' : `: ${item.detail}`}`);
console.log(`\n${evaluation.passed}/${evaluation.total} passed · deterministic demo · no API calls`);
if (evaluation.passed !== evaluation.total) process.exitCode = 1;
