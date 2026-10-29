import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRun, advanceRun } from './agent/engine.js';
import { createProvider } from './agent/providers.js';

const documents = [
  { id: 'eval-tools', title: 'Agent 工具调用循环', content: '# Agent 工具调用循环\n\nAgent 接收任务，调用 search_knowledge 检索知识，再读取文档，依据证据回答。工具调用循环必须验证参数、限制最大步数，并为每个工具调用记录执行结果。\n\n写入笔记属于有副作用的操作，需要用户审批。拒绝审批后不得保存笔记。', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'eval-rag', title: 'RAG 检索与引用', content: '# RAG 检索与引用\n\nRAG retrieval searches local knowledge documents and returns evidence with source citations. 检索不到相关资料时，应明确说明缺少证据，不编造答案。\n\n检索流程是文档导入、分段、召回、阅读相关段落，最后回答并标注来源。', createdAt: '2026-01-01T00:00:00Z' },
];

export async function runEvaluation() {
  const cases = [];
  async function check(name, callback) {
    const start = performance.now();
    try {
      await callback();
      cases.push({ name, passed: true, detail: '通过', durationMs: Math.round(performance.now() - start) });
    } catch (error) {
      cases.push({ name, passed: false, detail: error.message, durationMs: Math.round(performance.now() - start) });
    }
  }
  const setup = question => {
    const run = createRun(question, 'demo');
    const notes = [];
    const options = { provider: createProvider({ provider: 'demo' }), documents, saveNote: async note => { notes.push(note); return { id: randomUUID(), ...note }; }, persist: async () => {}, maxSteps: 12 };
    return { run, notes, options };
  };
  await check('中文知识检索与来源引用', async () => {
    const { run, options } = setup('如何设计 Agent 工具调用循环？');
    await advanceRun(run, options);
    assert.equal(run.status, 'completed');
    assert.ok(run.answer.length > 20, '回答应包含实际内容');
    assert.ok(run.citations.some(c => c.documentId === 'eval-tools'), '必须引用检索到的工具文档');
  });
  await check('英文检索与证据返回', async () => {
    const { run, options } = setup('Explain RAG retrieval and source citations');
    await advanceRun(run, options);
    assert.equal(run.status, 'completed');
    assert.ok(run.citations.some(c => c.documentId === 'eval-rag'), '英文关键词应能检索到文档');
  });
  await check('没有证据时不生成来源', async () => {
    const { run, options } = setup('量子海豚星际航行燃料配方 xyzzy987');
    await advanceRun(run, options);
    assert.equal(run.status, 'completed');
    assert.equal(run.citations.length, 0, '无关问题不应产生引用');
    assert.match(run.answer, /没有|未找到|不足|缺少|无法|no .*evidence/i);
  });
  await check('写入操作先等待人工审批', async () => {
    const { run, notes, options } = setup('总结 Agent 工具调用循环并保存为笔记');
    await advanceRun(run, options);
    assert.equal(run.status, 'waiting_approval');
    assert.equal(notes.length, 0, '审批前不能写入');
    assert.equal(run.pendingApproval.name, 'save_note');
  });
  await check('拒绝审批不会写入笔记', async () => {
    const { run, notes, options } = setup('总结 RAG 检索流程并保存为笔记');
    await advanceRun(run, options);
    assert.equal(run.status, 'waiting_approval');
    await advanceRun(run, { ...options, decision: false });
    assert.equal(run.status, 'completed');
    assert.equal(notes.length, 0);
    assert.equal(run.pendingApproval, null);
  });
  await check('序列化恢复后批准，恰好保存一次', async () => {
    const { run, notes, options } = setup('总结 Agent 工具调用循环并保存为笔记');
    await advanceRun(run, options);
    assert.equal(run.status, 'waiting_approval');
    const restored = JSON.parse(JSON.stringify(run));
    await advanceRun(restored, { ...options, decision: true });
    assert.equal(restored.status, 'completed');
    assert.equal(notes.length, 1);
    assert.ok(notes[0].content.length > 20);
  });
  return { id: randomUUID(), createdAt: new Date().toISOString(), provider: 'demo', passed: cases.filter(c => c.passed).length, total: cases.length, cases };
}
