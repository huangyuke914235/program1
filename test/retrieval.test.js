import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument, searchKnowledge } from '../src/agent/retrieval.js';
import { createRun, advanceRun } from '../src/agent/engine.js';
import { createProvider } from '../src/agent/providers.js';

test('overlapping chunks preserve document offsets and boundary evidence', () => {
  const document = { id: 'boundary', title: 'Guide', content: 'a'.repeat(590) + 'needlexyz'.repeat(4) + 'b'.repeat(700) };
  const chunks = chunkDocument(document);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) assert.equal(chunk.content, document.content.slice(chunk.startOffset, chunk.endOffset));
  assert.ok(chunks.some(chunk => chunk.content.includes('needlexyz'.repeat(4))));
  assert.throws(() => chunkDocument(document, { size: 50, overlap: 50 }));
});

test('BM25 favors focused passages and returns verifiable offsets without duplicate documents', () => {
  const docs = [
    { id: 'generic', title: 'Reference', content: 'cache '.repeat(1500) + 'eviction' },
    { id: 'specific', title: 'Design', content: 'Cache eviction uses a least recently used policy.' },
  ];
  const results = searchKnowledge(docs, 'cache eviction');
  assert.equal(results[0].id, 'specific');
  assert.equal(new Set(results.map(item => item.id)).size, results.length);
  for (const result of results) {
    const original = docs.find(doc => doc.id === result.id).content.slice(result.startOffset, result.endOffset);
    assert.ok(original.includes(result.excerpt));
  }
  assert.deepEqual(searchKnowledge(docs, 'galacticunicorn'), []);
});

test('long-document retrieval and agent answer use evidence after the first 20,000 characters', async () => {
  const evidence = 'rarekeywordxyz distributed lease requires fencing tokens.';
  const document = { id: 'long', title: 'Engineering handbook', content: 'background filler '.repeat(1500) + evidence };
  const hit = searchKnowledge([document], 'rarekeywordxyz')[0];
  assert.ok(hit.startOffset > 20000);
  assert.match(hit.excerpt, /fencing tokens/);
  const run = createRun('Explain rarekeywordxyz');
  await advanceRun(run, { provider: createProvider(), documents: [document] });
  assert.equal(run.status, 'completed');
  assert.match(run.answer, /fencing tokens/);
  assert.ok(run.citations[0].startOffset > 20000);
});
