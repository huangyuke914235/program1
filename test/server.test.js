import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { readConfig } from '../src/config.js';

async function setup(t, store = new Store(':memory:', { seed: false })) {
  if (!store.documents().length) store.addDocument({ id: 'tools', title: 'Agent 工具调用循环', content: 'Agent 工具调用循环包括检索知识、读取文档、返回带引用的答案。工具参数需要验证，设置最大步数防止无限循环。保存笔记需要人工审批，拒绝后不应写入。' });
  const app = createApp({ config: { ...readConfig({}), port: 0 }, store });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, method = 'GET', data, extraHeaders = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: data !== undefined ? JSON.stringify(data) : undefined });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { app, request, base };
}
async function settled(request, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { body: { run } } = await request(`/api/runs/${id}`);
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Run did not settle');
}

test('config validates provider credentials and never silently changes modes', () => {
  assert.equal(readConfig({}).provider, 'demo');
  assert.throws(() => readConfig({ AGENT_PROVIDER: 'openai' }), /OPENAI_API_KEY/);
  assert.throws(() => readConfig({ AGENT_PROVIDER: 'made-up' }), /AGENT_PROVIDER/);
  assert.throws(() => readConfig({ PORT: 'no' }), /PORT/);
});

test('API executes a grounded run and excludes internal provider transcript', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/health')).body.status, 'ok');
  const config = await request('/api/config');
  assert.equal(config.body.provider, 'demo');
  assert.equal('apiKey' in config.body, false);
  const created = await request('/api/runs', 'POST', { question: '如何设计 Agent 工具调用循环？' });
  assert.equal(created.status, 202);
  const run = await settled(request, created.body.run.id);
  assert.equal(run.status, 'completed');
  assert.ok(run.citations.some(c => c.documentId === 'tools'));
  assert.equal('state' in run, false);
  assert.ok(run.steps.length >= 2);
});

test('approval endpoint saves once and rejects repeated or stale decisions', async t => {
  const { request } = await setup(t);
  const { body: { run: created } } = await request('/api/runs', 'POST', { question: '总结 Agent 工具调用循环并保存笔记' });
  const run = await settled(request, created.id);
  assert.equal(run.status, 'waiting_approval');
  assert.equal((await request('/api/notes')).body.notes.length, 0);
  assert.equal((await request(`/api/runs/${run.id}/approval`, 'POST', { approved: true, approvalId: 'old' })).status, 409);
  const decision = { approved: true, approvalId: run.pendingApproval.id };
  assert.equal((await request(`/api/runs/${run.id}/approval`, 'POST', decision)).status, 202);
  assert.equal((await settled(request, run.id)).status, 'completed');
  assert.equal((await request('/api/notes')).body.notes.length, 1);
  assert.equal((await request(`/api/runs/${run.id}/approval`, 'POST', decision)).status, 409);
  assert.equal((await request('/api/notes')).body.notes.length, 1);
});

test('rejecting approval leaves notes unchanged', async t => {
  const { request } = await setup(t);
  const { body: { run } } = await request('/api/runs', 'POST', { question: '总结 Agent 工具调用循环并保存笔记' });
  const pending = await settled(request, run.id);
  await request(`/api/runs/${run.id}/approval`, 'POST', { approved: false, approvalId: pending.pendingApproval.id });
  assert.equal((await settled(request, run.id)).status, 'completed');
  assert.equal((await request('/api/notes')).body.notes.length, 0);
});

test('a slow duplicate approval cannot replay a completed run', async t => {
  const { request, app, base } = await setup(t);
  const { body: { run } } = await request('/api/runs', 'POST', { question: '总结 Agent 工具调用循环并保存笔记' });
  const pending = await settled(request, run.id);
  const decision = { approved: true, approvalId: pending.pendingApproval.id };
  const raw = JSON.stringify(decision);
  const received = new Promise(resolve => app.server.once('request', resolve));
  let held;
  const heldResponse = new Promise((resolve, reject) => {
    held = httpRequest(`${base}/api/runs/${run.id}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    held.on('error', reject);
    held.write(raw.slice(0, 1));
  });
  t.after(() => held.destroy());
  await received;
  assert.equal((await request(`/api/runs/${run.id}/approval`, 'POST', decision)).status, 202);
  assert.equal((await settled(request, run.id)).status, 'completed');
  held.end(raw.slice(1));
  assert.equal(await heldResponse, 409);
  assert.equal((await request('/api/notes')).body.notes.length, 1);
  assert.equal((await request(`/api/runs/${run.id}`)).body.run.status, 'completed');
});

test('knowledge CRUD, validation, missing resources, and same-origin boundaries', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/documents', 'POST', { title: '', content: 'abc' })).status, 400);
  assert.equal((await request('/api/runs', 'POST', { question: ' ' })).status, 400);
  assert.equal((await request('/api/runs', 'POST', { question: 'x'.repeat(4001) })).status, 400);
  assert.equal((await request('/api/runs', 'POST', { question: 'test' }, { Origin: 'https://untrusted.example' })).status, 403);
  const created = await request('/api/documents', 'POST', { title: '新增知识', content: '<script>evil()</script> is just text' });
  assert.equal(created.status, 201);
  assert.ok((await request('/api/documents')).body.documents.some(doc => doc.id === created.body.document.id));
  assert.equal((await request(`/api/documents/${created.body.document.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/documents/${created.body.document.id}`, 'DELETE')).status, 404);
  assert.equal((await request('/api/runs/missing')).status, 404);
  assert.equal((await request('/api/not-a-route')).status, 404);
});

test('API parses JSON defensively and protects static file boundaries', async t => {
  const { base } = await setup(t);
  const invalid = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(invalid.status, 400);
  const wrongType = await fetch(`${base}/api/runs`, { method: 'POST', body: 'question=test' });
  assert.equal(wrongType.status, 415);
  const oversized = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'huge', content: 'a'.repeat(400000) }) });
  assert.equal(oversized.status, 413);
  const forbidden = await fetch(`${base}/%2e%2e%2f.env`);
  assert.equal(forbidden.status, 404);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Agent Lab/);
});

test('SQLite preserves pending approvals and de-duplicates writes after reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-lab-test-'));
  const path = join(directory, 'lab.sqlite');
  try {
    let store = new Store(path, { seed: false });
    store.addDocument({ title: '持久化', content: '保留内容' });
    store.saveRun({ id: 'pending', status: 'waiting_approval', createdAt: '2026-01-01', state: { durable: true }, pendingApproval: { id: 'approval-1' } });
    store.saveRun({ id: 'interrupted', status: 'running', createdAt: '2026-01-01' });
    const note = store.saveNote({ title: '笔记', content: '第一次' }, 'pending:approval-1');
    store.close();
    store = new Store(path, { seed: false });
    store.recoverInterruptedRuns();
    assert.equal(store.run('pending').status, 'waiting_approval');
    assert.equal(store.run('pending').state.durable, true);
    assert.equal(store.run('interrupted').status, 'failed');
    assert.equal(store.documents().length, 1);
    assert.equal(store.saveNote({ title: '笔记', content: '重试' }, 'pending:approval-1').id, note.id);
    assert.equal(store.notes().length, 1);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('evaluation API runs actual checks and stores the report', async t => {
  const { request } = await setup(t);
  const { status, body } = await request('/api/evaluations', 'POST', {});
  assert.equal(status, 200);
  assert.equal(body.evaluation.passed, body.evaluation.total);
  assert.equal(body.evaluation.total, 6);
  assert.equal((await request('/api/evaluations')).body.evaluations[0].id, body.evaluation.id);
});

test('a pending approval survives a full app restart and resumes through HTTP', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-lab-restart-'));
  const path = join(directory, 'lab.sqlite');
  let first;
  let second;
  try {
    first = await setup(t, new Store(path, { seed: false }));
    const { body: { run } } = await first.request('/api/runs', 'POST', { question: '总结 Agent 工具调用循环并保存笔记' });
    const pending = await settled(first.request, run.id);
    assert.equal(pending.status, 'waiting_approval');
    await first.app.close();
    second = await setup(t, new Store(path, { seed: false }));
    assert.equal((await second.request(`/api/runs/${run.id}`)).body.run.pendingApproval.id, pending.pendingApproval.id);
    assert.equal((await second.request(`/api/runs/${run.id}/approval`, 'POST', { approved: true, approvalId: pending.pendingApproval.id })).status, 202);
    assert.equal((await settled(second.request, run.id)).status, 'completed');
    assert.equal((await second.request('/api/notes')).body.notes.length, 1);
  } finally {
    if (first) await first.app.close();
    if (second) await second.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
