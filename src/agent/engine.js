import { randomUUID } from 'node:crypto';
import { searchKnowledge, excerptFor } from './retrieval.js';
import { toolDefinitions, validateToolCall } from './tools.js';
import { ProviderError } from './providers.js';

const activeRuns = new Set();
const now = () => new Date().toISOString();

export function createRun(question, providerName = 'demo') {
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) throw new Error('Question must contain between 1 and 4000 characters.');
  const createdAt = now();
  return {
    id: randomUUID(), question: question.trim(), provider: providerName,
    status: 'queued', createdAt, updatedAt: createdAt,
    answer: '', citations: [], steps: [], usage: { inputTokens: 0, outputTokens: 0 }, pendingApproval: null,
    state: { input: [{ role: 'user', content: question.trim() }], pendingCalls: [], toolResults: [], budgetUsed: 0 },
  };
}

function record(run, type, title, detail, durationMs) {
  const step = { id: randomUUID(), type, title, detail, createdAt: now() };
  if (durationMs !== undefined) step.durationMs = durationMs;
  run.steps.push(step);
  run.updatedAt = now();
}

function addCitation(run, document, excerpt) {
  if (!run.citations.some(citation => citation.documentId === document.id)) {
    run.citations.push({ documentId: document.id, title: document.title, excerpt });
  }
}

function finishTool(run, call, args, output) {
  run.state.input.push({ type: 'function_call_output', call_id: call.id, output: JSON.stringify(output) });
  run.state.toolResults.push({ name: call.name, arguments: args, output });
  run.state.pendingCalls.shift();
}

/**
 * Mutates and persists a serializable run. Approval state includes the queued call
 * and the complete model transcript, so resuming does not depend on process memory.
 */
export async function advanceRun(run, { provider, documents = [], saveNote, persist = async () => {}, decision, maxSteps = 12 } = {}) {
  if (!provider?.next) throw new Error('A provider with next() is required.');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('maxSteps must be between 1 and 100.');
  if (['completed', 'failed'].includes(run.status)) return run;
  if (run.status === 'waiting_approval' && typeof decision !== 'boolean') return run;
  if (activeRuns.has(run.id)) throw new Error('This run is already being processed.');
  activeRuns.add(run.id);
  let approvalDecision = decision;

  async function checkpoint() {
    run.updatedAt = now();
    await persist(run);
  }
  function takeBudget() {
    if (run.state.budgetUsed >= maxSteps) throw new ProviderError(`达到 ${maxSteps} 步执行上限，运行已停止。请缩小问题范围后重试。`);
    run.state.budgetUsed++;
  }
  try {
    run.status = 'running';
    if (!run.steps.length) record(run, 'start', '开始研究', provider.name === 'demo' ? '离线演示策略 · 使用真实本地检索与审批流程' : '使用真实模型检索本地知识库');
    await checkpoint();

    while (true) {
      const call = run.state.pendingCalls[0];
      if (!call) {
        takeBudget();
        const startedAt = Date.now();
        const response = await provider.next({ run, tools: toolDefinitions });
        if (!response || !Array.isArray(response.output) || !Array.isArray(response.calls)) throw new ProviderError('模型返回格式无效，运行已停止。');
        if (response.calls.length > 12) throw new ProviderError('模型单次请求了过多工具调用，运行已停止。');
        run.state.input.push(...response.output);
        for (const key of ['inputTokens', 'outputTokens']) {
          const count = response.usage?.[key];
          if (Number.isFinite(count) && count > 0) run.usage[key] += count;
        }
        record(run, 'model', provider.name === 'demo' ? '执行离线策略' : '模型响应', response.calls.length ? `请求 ${response.calls.length} 次工具调用：${response.calls.map(item => item.name).join('、')}` : '生成最终回答', Date.now() - startedAt);
        if (!response.calls.length) {
          if (typeof response.text !== 'string' || !response.text.trim()) throw new ProviderError('模型没有返回可显示的回答。');
          run.answer = response.text.trim();
          run.status = 'completed';
          run.pendingApproval = null;
          record(run, 'complete', '研究完成', `已检索 ${run.citations.length} 份资料；共执行 ${run.state.toolResults.length} 次工具调用`);
          await checkpoint();
          return run;
        }
        run.state.pendingCalls = response.calls;
        await checkpoint();
        continue;
      }

      let args;
      try {
        args = validateToolCall(call.name, typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments);
        if (typeof call.id !== 'string' || !call.id) throw new Error('Tool call is missing its call id.');
      } catch {
        takeBudget();
        const output = { error: 'Invalid tool name or arguments. Use the declared tool schema and try again.' };
        record(run, 'tool_error', '工具参数校验失败', '已拦截未知工具、无效 JSON 或不符合声明的参数');
        finishTool(run, { ...call, id: typeof call.id === 'string' ? call.id : 'invalid_call' }, {}, output);
        await checkpoint();
        continue;
      }

      if (call.name === 'save_note') {
        if (run.state.toolResults.some(result => result.name === 'save_note' && result.output.denied)) {
          takeBudget();
          finishTool(run, call, args, { saved: false, denied: true, message: 'Saving was already declined in this run.' });
          record(run, 'approval_denied', '保存请求已拦截', '你已拒绝本次保存，不再重复请求批准');
          await checkpoint();
          continue;
        }
        if (!run.pendingApproval) {
          // Budget is consumed after a decision, so pausing never spends two steps.
          if (run.state.budgetUsed >= maxSteps) takeBudget();
          run.pendingApproval = { id: randomUUID(), name: call.name, arguments: args };
          run.status = 'waiting_approval';
          record(run, 'approval', '等待你批准保存笔记', `拟保存「${args.title}」，审批前不会写入`);
          await checkpoint();
          return run;
        }
        if (typeof approvalDecision !== 'boolean') {
          run.status = 'waiting_approval';
          await checkpoint();
          return run;
        }
        // Execute exactly the immutable proposal that was presented to the user.
        args = validateToolCall('save_note', run.pendingApproval.arguments);
        takeBudget();
        let output;
        if (approvalDecision) {
          if (typeof saveNote !== 'function') throw new ProviderError('笔记存储不可用，未能保存。');
          const note = await saveNote(args);
          output = { saved: true, note: { id: note.id, title: note.title } };
          record(run, 'tool', 'save_note · 已保存', `已按批准写入「${note.title}」`);
        } else {
          output = { saved: false, denied: true, message: 'The user declined. Do not propose saving again in this run.' };
          record(run, 'approval_denied', '已拒绝保存', '没有写入笔记，继续生成回答');
        }
        run.pendingApproval = null;
        approvalDecision = undefined;
        finishTool(run, call, args, output);
        await checkpoint();
        continue;
      }

      takeBudget();
      const startedAt = Date.now();
      let output;
      if (call.name === 'search_knowledge') {
        const results = searchKnowledge(documents, args.query);
        output = { results };
        for (const result of results) addCitation(run, result, result.excerpt);
        record(run, 'tool', 'search_knowledge · 检索资料', `关键词：${args.query}；找到 ${results.length} 份相关文档`, Date.now() - startedAt);
      } else if (call.name === 'read_document') {
        const document = documents.find(item => item.id === args.id);
        output = document ? { document: { id: document.id, title: document.title, content: document.content.slice(0, 20000), truncated: document.content.length > 20000 } } : { error: 'Document not found. Search for a valid document id.' };
        if (document) addCitation(run, document, excerptFor(document, run.question));
        record(run, document ? 'tool' : 'tool_error', 'read_document · 读取文档', document ? `读取「${document.title}」` : '未找到该文档', Date.now() - startedAt);
      }
      finishTool(run, call, args, output);
      await checkpoint();
    }
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof ProviderError ? error.message : '运行出现错误，请检查服务端配置后重试。';
    record(run, 'error', '运行停止', run.error);
    await checkpoint();
    return run;
  } finally {
    activeRuns.delete(run.id);
  }
}
