const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { view: 'workbench', config: { provider: 'demo' }, documents: [], notes: [], runs: [], evaluations: [], selectedRun: null, pollTimer: null, runStream: null, pollGeneration: 0, submitting: false, approving: false, evaluating: false, deletingId: null, connected: false };
const statuses = { queued: '等待执行', running: '正在执行', waiting_approval: '等待你的审批', completed: '执行完成', failed: '执行失败' };
const viewNames = { workbench: '工作台', knowledge: '知识库', notes: '我的笔记', evaluations: '质量评测' };

function node(tag, properties = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  }
  children.flat().forEach(child => { if (child !== null && child !== undefined) element.append(child instanceof Node ? child : document.createTextNode(String(child))); });
  return element;
}

function icon(name, extraClass = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function text(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function date(value, time = false) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(parsed);
}

function toast(message, error = false) {
  const item = node('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status', text: message });
  $('#toast-container').append(item);
  window.setTimeout(() => item.remove(), error ? 7000 : 3600);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: options.signal ?? AbortSignal.timeout(90000) });
  } catch (error) {
    setConnection(false);
    throw new Error(error.name === 'TimeoutError' ? '请求超时，请稍后重试。' : '无法连接本地服务，请确认 Agent Lab 正在运行。');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  setConnection(true);
  return result;
}

function setConnection(connected) {
  state.connected = connected;
  $('#connection').classList.toggle('offline', !connected);
  $('#connection-label').textContent = connected ? '本地服务已连接' : '本地服务未连接';
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').hidden = true;
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
}

function showView(view, updateHash = true) {
  if (!viewNames[view]) view = 'workbench';
  state.view = view;
  $$('.view').forEach(section => { section.hidden = section.id !== `view-${view}`; });
  $$('.nav-item').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#breadcrumb-current').textContent = viewNames[view];
  document.title = `${viewNames[view]} · Agent Lab`;
  if (updateHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  closeSidebar();
}

function renderConfig() {
  const real = state.config.provider === 'openai';
  $('#sidebar-mode').textContent = real ? '模型已连接' : '演示模式';
  $('#sidebar-mode-description').textContent = real ? state.config.model || 'OpenAI Responses' : '无需 API Key，即刻体验';
  $('#composer-mode').textContent = real ? state.config.model || 'OpenAI Agent' : 'Demo Agent';
  $('#mode-explanation').textContent = real ? '真实模型决定工具调用；知识检索和写入审批由本地服务执行。请只添加允许发送给模型的内容。' : '演示模式使用确定性流程运行真实检索与工具；连接模型后，由模型决定下一步操作。';
}

function renderCounts() {
  $('#document-count').textContent = state.documents.length;
  $('#note-count').textContent = state.notes.length;
  $('#composer-source-count').textContent = `知识库 · ${state.documents.length} 篇文档`;
  $('#knowledge-total').textContent = `${state.documents.length} 篇文档`;
  $('#history-count').textContent = state.runs.length;
}

function renderHistory() {
  const holder = $('#run-history');
  if (!state.runs.length) {
    holder.replaceChildren(node('p', { class: 'sidebar-empty', text: '每一次探索，都会留在这里。' }));
    return;
  }
  holder.replaceChildren(...state.runs.slice(0, 30).map(run => node('button', {
    class: `history-item${state.selectedRun?.id === run.id ? ' selected' : ''}`,
    title: `${run.question} · ${statuses[run.status] || run.status}`,
    onclick: () => selectRun(run.id),
  }, icon(run.status === 'completed' ? 'check' : run.status === 'waiting_approval' ? 'shield' : 'clock'), node('span', { text: run.question }))));
  renderCounts();
}

function emptyState(iconName, title, description, action = null) {
  const empty = node('div', { class: 'full-empty' }, node('span', { class: 'starter-icon purple' }, icon(iconName)), node('h3', { text: title }), node('p', { text: description }));
  if (action) empty.append(node('button', { class: 'secondary-button', onclick: action.handler }, icon('plus'), action.label));
  return empty;
}

function openReader(item, type = 'document') {
  $('#reader-eyebrow').textContent = type === 'note' ? 'APPROVED NOTE' : 'KNOWLEDGE SOURCE';
  $('#reader-title').textContent = item.title || '未命名文档';
  $('#reader-meta').textContent = `${type === 'note' ? '已审批笔记' : '知识库文档'} · ${date(item.createdAt, true)} · ${text(item.content).length.toLocaleString('zh-CN')} 字符`;
  $('#reader-content').textContent = text(item.content);
  $('#reader-dialog').showModal();
}

function openDocumentForm() {
  $('#document-form').reset();
  $('#document-dialog').showModal();
  $('#document-title').focus();
}

function renderDocuments() {
  const filter = $('#knowledge-search').value.trim().toLocaleLowerCase();
  const documents = state.documents.filter(item => `${item.title} ${item.content}`.toLocaleLowerCase().includes(filter));
  const holder = $('#document-list');
  if (!documents.length) {
    holder.replaceChildren(emptyState('book', filter ? '还没有匹配的文档' : '给 Agent 一点你的知识', filter ? '试试其他关键词，或添加一篇新文档。' : '从一篇开发文档、一份笔记或一段文本开始。', { label: '添加文档', handler: openDocumentForm }));
    renderCounts();
    return;
  }
  holder.replaceChildren(...documents.map(item => node('article', { class: 'document-card' },
    node('div', { class: 'document-card-top' }, node('span', { class: 'starter-icon purple' }, icon('file')), node('button', { class: 'icon-button', 'aria-label': `删除文档：${item.title}`, title: '删除文档', onclick: () => confirmDelete(item) }, icon('trash'))),
    node('h3', { text: item.title }), node('p', { class: 'document-preview', text: text(item.content) }),
    node('div', { class: 'document-card-footer' }, node('span', { text: `${text(item.content).length.toLocaleString('zh-CN')} 字符 · ${date(item.createdAt)}` }), node('button', { class: 'text-button', onclick: () => openReader(item) }, '查看文档', icon('arrow')))
  )));
  renderCounts();
}

function renderNotes() {
  const holder = $('#note-list');
  if (!state.notes.length) {
    holder.replaceChildren(emptyState('note', '有价值的发现，值得留下', '让 Agent 总结一个主题并保存为笔记；确认内容后，它就会出现在这里。', { label: '创建第一篇笔记', handler: () => usePrompt('总结 RAG 检索流程，保存为学习笔记') }));
    renderCounts();
    return;
  }
  holder.replaceChildren(...state.notes.map(item => node('article', { class: 'note-card' }, node('span', { class: 'starter-icon green' }, icon('note')), node('h3', { text: item.title }), node('span', { class: 'note-date', text: `${date(item.createdAt, true)} · 已审批保存` }), node('p', { class: 'note-preview', text: text(item.content) }), node('button', { class: 'text-button', onclick: () => openReader(item, 'note') }, '阅读笔记', icon('arrow')))));
  renderCounts();
}

function renderEvaluations() {
  const holder = $('#evaluation-results');
  if (!state.evaluations.length) {
    holder.replaceChildren(emptyState('eval', '把「应该可用」变成「已经验证」', '运行第一轮评测，查看每个检查项的真实结果。'));
    return;
  }
  holder.replaceChildren(...state.evaluations.slice(0, 10).map((evaluation, index) => node('article', { class: 'evaluation-card' },
    node('div', { class: 'evaluation-summary' }, node('div', {}, node('h3', { text: index === 0 ? '最近一次流程评测' : '历史评测' }), node('span', { class: 'evaluation-date', text: `${date(evaluation.createdAt, true)} · ${evaluation.provider === 'demo' ? '演示 Agent / 隔离数据' : evaluation.provider}` })), node('div', { class: 'evaluation-score' }, `${evaluation.passed}`, node('small', { text: `/ ${evaluation.total} 通过` }))),
    ...(evaluation.cases || []).map(item => node('div', { class: 'evaluation-case' }, node('span', { class: `case-mark${item.passed ? '' : ' failed'}` }, icon(item.passed ? 'check' : 'close')), node('div', {}, node('strong', { text: item.name }), node('p', { text: text(item.detail) })), node('span', { class: 'case-duration', text: Number.isFinite(item.durationMs) ? `${item.durationMs} ms` : '' })))
  )));
}

function stepIcon(type) {
  const lower = String(type).toLowerCase();
  if (/search|retriev/.test(lower)) return 'search';
  if (/approv|decision/.test(lower)) return 'shield';
  if (/note|save/.test(lower)) return 'note';
  if (/error|fail/.test(lower)) return 'close';
  if (/complete|finish|answer/.test(lower)) return 'check';
  if (/tool|read/.test(lower)) return 'file';
  return 'lab';
}

function renderTrace(run) {
  const holder = $('#trace-list');
  const steps = run?.steps || [];
  $('#trace-count').textContent = `${steps.length} 条`;
  if (!steps.length) {
    holder.replaceChildren(node('div', { class: 'trace-empty' }, node('span', { class: 'waiting-dot' }), node('strong', { text: run ? '任务已提交' : '等待任务开始' }), node('p', { text: run ? '正在等待第一条执行记录…' : '检索、工具调用和审批事件\n将在这里依次记录。' })));
    return;
  }
  const scrollAtBottom = holder.scrollHeight - holder.scrollTop - holder.clientHeight < 50;
  const opened = new Set($$('details[open]', holder).map(item => item.dataset.stepId));
  holder.replaceChildren(...steps.map(step => {
    const stepClass = /error|fail/.test(step.type) ? ' error' : /approv/.test(step.type) ? ' approval' : '';
    const content = node('div', { class: 'trace-step-content' }, node('h4', { text: step.title || step.type }), node('small', { text: [date(step.createdAt, true), Number.isFinite(step.durationMs) ? `${step.durationMs} ms` : ''].filter(Boolean).join(' · ') }));
    if (step.detail) {
      const detail = node('details', { class: 'trace-detail', 'data-step-id': step.id }, node('summary', { text: '查看操作详情' }), node('pre', { text: text(step.detail) }));
      if (opened.has(step.id)) detail.open = true;
      content.append(detail);
    }
    return node('div', { class: `trace-step${stepClass}` }, node('span', { class: 'trace-step-icon' }, icon(stepIcon(step.type))), content);
  }));
  if (scrollAtBottom) holder.scrollTop = holder.scrollHeight;
}

function renderApproval(run) {
  const pending = run.pendingApproval;
  const args = typeof pending.arguments === 'string' ? (() => { try { return JSON.parse(pending.arguments); } catch { return { content: pending.arguments }; } })() : pending.arguments || {};
  const approve = node('button', { class: 'primary-button', type: 'button', onclick: () => decideApproval(true) }, icon('check'), '批准并保存');
  const reject = node('button', { class: 'secondary-button', type: 'button', onclick: () => decideApproval(false) }, '拒绝写入');
  approve.disabled = state.approving;
  reject.disabled = state.approving;
  return node('section', { class: 'approval-card', 'aria-label': '笔记写入审批' }, node('h4', {}, icon('shield'), 'Agent 希望保存一篇笔记'), node('p', { text: '请检查以下内容。批准后将写入本地笔记；拒绝后继续执行，但不会保存。' }), node('div', { class: 'approval-preview' }, node('strong', { text: text(args.title || '未命名笔记') }), node('pre', { text: text(args.content || args) })), node('div', { class: 'approval-actions' }, reject, approve));
}

function renderRun() {
  const run = state.selectedRun;
  const status = $('#run-status');
  status.className = `pill${run ? ` ${run.status}` : ''}`;
  status.replaceChildren(node('span', { class: 'status-dot' }), run ? statuses[run.status] || run.status : '准备就绪');
  $('#copy-answer').hidden = !run?.answer;
  renderTrace(run);
  if (!run) {
    $('#answer-content').replaceChildren(node('div', { class: 'empty-answer' }, node('div', { class: 'empty-symbol' }, icon('lab'), node('span', { class: 'orbit-dot' })), node('h3', { text: '一个问题，开启一次探索' }), node('p', { text: '从上方输入任务，或选择一个示例。\n答案、引用和工具执行过程会出现在这里。' }), node('div', { class: 'empty-flow' }, node('span', {}, node('b', { text: '01' }), ' 检索知识'), node('i', { text: '→' }), node('span', {}, node('b', { text: '02' }), ' 调用工具'), node('i', { text: '→' }), node('span', {}, node('b', { text: '03' }), ' 生成答案'))));
    $('#answer-footer').replaceChildren(icon('shield'), node('span', { text: '写入笔记前始终需要你的审批' }));
    return;
  }
  const body = node('div', { class: 'answer-body' }, node('div', { class: 'run-question', text: run.question }));
  if (run.answer) body.append(node('div', { class: 'answer-text', text: text(run.answer) }));
  else if (run.status === 'failed') body.append(node('div', { class: 'answer-text', text: text(run.error || '执行未能完成。请查看右侧执行记录中的错误信息。') }));
  else if (run.status !== 'waiting_approval') body.append(node('div', { class: 'working-message' }, node('span', { class: 'loading-spinner', 'aria-hidden': 'true' }), 'Agent 正在检索知识与执行工具…'));
  if (run.citations?.length) {
    body.append(node('div', { class: 'citation-heading', text: `引用来源 · ${run.citations.length}` }), node('div', { class: 'citation-list' }, ...run.citations.map((citation, index) => node('button', { class: 'citation-button', title: text(citation.excerpt), onclick: () => {
      const item = state.documents.find(document => document.id === citation.documentId);
      if (item) openReader(item);
      else openReader({ title: citation.title, content: citation.excerpt || '原始文档已被删除，此处保留本次执行引用的摘要。', createdAt: run.createdAt });
    } }, icon('file'), `${index + 1}. ${citation.title}`))));
  }
  if (run.status === 'waiting_approval' && run.pendingApproval) body.append(renderApproval(run));
  $('#answer-content').replaceChildren(body);
  const usage = run.usage || {};
  const usageLabel = (run.provider || state.config.provider) === 'demo' ? '演示模式 · 无模型调用' : `${Number(usage.inputTokens || 0).toLocaleString('zh-CN')} 输入 / ${Number(usage.outputTokens || 0).toLocaleString('zh-CN')} 输出 tokens`;
  $('#answer-footer').replaceChildren(icon('shield'), node('div', { class: 'run-usage' }, node('span', { text: usageLabel }), node('span', { text: `${run.steps?.length || 0} 条执行记录` })));
}

function updateRun(run) {
  const index = state.runs.findIndex(item => item.id === run.id);
  if (index >= 0) state.runs[index] = run;
  else state.runs.unshift(run);
  if (state.selectedRun?.id === run.id) state.selectedRun = run;
  renderHistory();
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.runStream?.close();
  state.runStream = null;
  state.pollGeneration += 1;
}

async function handleRunUpdate(run, generation) {
  if (generation !== state.pollGeneration) return;
  updateRun(run);
  if (state.selectedRun?.id === run.id) renderRun();
  if (run.status === 'completed') {
    try {
      const { notes } = await api('/api/notes');
      if (generation === state.pollGeneration) { state.notes = notes; renderNotes(); }
    } catch (error) { if (generation === state.pollGeneration) toast(error.message, true); }
  }
}

// Prefer a live stream; if unavailable or interrupted, resume from the latest
// persisted run through the existing polling endpoint.
function watchRun(runId, generation = state.pollGeneration) {
  if (generation !== state.pollGeneration) return;
  if (typeof EventSource === 'undefined') { pollRun(runId, generation); return; }
  let stream;
  try { stream = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`); }
  catch { pollRun(runId, generation); return; }
  state.runStream = stream;
  stream.addEventListener('run', event => {
    if (generation !== state.pollGeneration || state.runStream !== stream) return;
    let run;
    try { const data = JSON.parse(event.data); run = data.run || data; }
    catch { stream.close(); state.runStream = null; pollRun(runId, generation); return; }
    if (!run || run.id !== runId || typeof run.status !== 'string') {
      stream.close(); state.runStream = null; pollRun(runId, generation); return;
    }
    void handleRunUpdate(run, generation);
    if (!['queued', 'running'].includes(run.status)) {
      stream.close();
      state.runStream = null;
    }
  });
  stream.onerror = () => {
    if (generation !== state.pollGeneration || state.runStream !== stream) return;
    stream.close();
    state.runStream = null;
    pollRun(runId, generation);
  };
}

function pollRun(runId, generation = state.pollGeneration, failures = 0) {
  if (generation !== state.pollGeneration) return;
  state.pollTimer = window.setTimeout(async () => {
    try {
      const { run } = await api(`/api/runs/${encodeURIComponent(runId)}`);
      if (generation !== state.pollGeneration) return;
      await handleRunUpdate(run, generation);
      if (['queued', 'running'].includes(run.status)) pollRun(runId, generation);
    } catch (error) {
      if (generation !== state.pollGeneration) return;
      if (failures < 4) pollRun(runId, generation, failures + 1);
      else toast(error.message, true);
    }
  }, failures ? 1800 : 650);
}

async function selectRun(id) {
  stopPolling();
  showView('workbench');
  const knownRun = state.runs.find(item => item.id === id);
  if (knownRun) { state.selectedRun = knownRun; renderHistory(); renderRun(); }
  const generation = state.pollGeneration;
  try {
    const { run } = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (generation !== state.pollGeneration) return;
    state.selectedRun = run;
    updateRun(run);
    renderRun();
    if (['queued', 'running'].includes(run.status)) watchRun(id, generation);
  } catch (error) { toast(error.message, true); }
}

function usePrompt(prompt) {
  showView('workbench');
  $('#question').value = prompt;
  $('#question').focus();
  $('#task-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitTask(event) {
  event.preventDefault();
  const question = $('#question').value.trim();
  if (!question || state.submitting) return;
  state.submitting = true;
  $('#submit-task').disabled = true;
  try {
    const { run } = await api('/api/runs', { method: 'POST', body: JSON.stringify({ question }) });
    stopPolling();
    state.selectedRun = run;
    updateRun(run);
    renderRun();
    $('#question').value = '';
    if (['queued', 'running'].includes(run.status)) watchRun(run.id);
  } catch (error) { toast(error.message, true); }
  finally { state.submitting = false; $('#submit-task').disabled = false; }
}

async function decideApproval(approved) {
  const selected = state.selectedRun;
  if (!selected?.pendingApproval || state.approving) return;
  state.approving = true;
  renderRun();
  try {
    const { run } = await api(`/api/runs/${encodeURIComponent(selected.id)}/approval`, { method: 'POST', body: JSON.stringify({ approved, approvalId: selected.pendingApproval.id }) });
    // The 202 response is a snapshot taken before the worker resumes. Hide the
    // consumed approval locally and watch even if that snapshot is still waiting.
    const continuing = { ...run, status: 'running', pendingApproval: null };
    updateRun(continuing);
    if (state.selectedRun?.id === run.id) { renderRun(); stopPolling(); watchRun(run.id); }
    toast(approved ? '已批准写入，Agent 将继续执行。' : '已拒绝写入，Agent 将继续执行。');
    const { notes } = await api('/api/notes');
    state.notes = notes;
    renderNotes();
  } catch (error) { toast(error.message, true); }
  finally { state.approving = false; renderRun(); }
}

async function saveDocument(event) {
  event.preventDefault();
  const title = $('#document-title').value.trim();
  const content = $('#document-content').value.trim();
  if (!title || !content) { toast('请填写文档标题和内容。', true); return; }
  if (content.length > 100000) { toast('文档超过 100,000 字符，请分成多篇添加。', true); return; }
  $('#save-document').disabled = true;
  try {
    const { document: item } = await api('/api/documents', { method: 'POST', body: JSON.stringify({ title, content }) });
    state.documents.unshift(item);
    renderDocuments();
    $('#document-dialog').close();
    toast('文档已添加，下一次任务即可检索。');
  } catch (error) { toast(error.message, true); }
  finally { $('#save-document').disabled = false; }
}

function confirmDelete(item) {
  state.deletingId = item.id;
  $('#delete-description').textContent = `即将删除「${item.title}」。`;
  $('#delete-dialog').showModal();
}

async function deleteDocument() {
  if (!state.deletingId) return;
  const id = state.deletingId;
  $('#confirm-delete').disabled = true;
  try {
    await api(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.documents = state.documents.filter(item => item.id !== id);
    state.deletingId = null;
    renderDocuments();
    $('#delete-dialog').close();
    toast('文档已删除。');
  } catch (error) { toast(error.message, true); }
  finally { $('#confirm-delete').disabled = false; }
}

async function runEvaluation() {
  if (state.evaluating) return;
  state.evaluating = true;
  const button = $('#run-evaluation');
  button.disabled = true;
  button.replaceChildren(node('span', { class: 'loading-spinner' }), '评测运行中');
  try {
    const { evaluation } = await api('/api/evaluations', { method: 'POST', body: '{}' });
    state.evaluations.unshift(evaluation);
    renderEvaluations();
    toast(`评测完成：${evaluation.passed} / ${evaluation.total} 项通过。`);
  } catch (error) { toast(error.message, true); }
  finally { state.evaluating = false; button.disabled = false; button.replaceChildren(icon('eval'), '运行评测'); }
}

async function initialize() {
  const requests = [
    ['/api/config', result => { state.config = result; renderConfig(); }],
    ['/api/documents', result => { state.documents = result.documents || []; renderDocuments(); }],
    ['/api/notes', result => { state.notes = result.notes || []; renderNotes(); }],
    ['/api/runs', result => { state.runs = result.runs || []; renderHistory(); }],
    ['/api/evaluations', result => { state.evaluations = result.evaluations || []; renderEvaluations(); }],
  ];
  const results = await Promise.allSettled(requests.map(async ([path, accept]) => accept(await api(path))));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) toast(failure.reason.message, true);
  renderCounts();
  const active = state.runs.find(run => ['queued', 'running', 'waiting_approval'].includes(run.status));
  if (active) { state.selectedRun = active; renderHistory(); renderRun(); if (active.status !== 'waiting_approval') watchRun(active.id); }
}

$$('svg').forEach(svg => { svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); });
$$('.panel-heading h3').forEach(heading => heading.setAttribute('aria-label', heading.textContent.trim()));
$$('.nav-item').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$$('.starter-card').forEach(button => button.addEventListener('click', () => usePrompt(button.dataset.prompt)));
$$('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } }));
$('#mobile-menu').addEventListener('click', () => { const open = $('#sidebar').classList.toggle('open'); $('#sidebar-backdrop').hidden = !open; $('#mobile-menu').setAttribute('aria-expanded', String(open)); });
$('#sidebar-backdrop').addEventListener('click', closeSidebar);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); });
$('#new-task').addEventListener('click', () => { stopPolling(); state.selectedRun = null; showView('workbench'); renderHistory(); renderRun(); $('#question').value = ''; $('#question').focus(); });
$('#task-form').addEventListener('submit', submitTask);
$('#question').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#task-form').requestSubmit(); } });
$('#add-document').addEventListener('click', openDocumentForm);
$('#document-form').addEventListener('submit', saveDocument);
$('#knowledge-search').addEventListener('input', renderDocuments);
$('#confirm-delete').addEventListener('click', deleteDocument);
$('#run-evaluation').addEventListener('click', runEvaluation);
$('#copy-answer').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(text(state.selectedRun?.answer)); toast('答案已复制。'); }
  catch { toast('复制失败，请在答案区域手动选择并复制。', true); }
});
$('#file-input').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!/\.(txt|md|markdown)$/i.test(file.name)) { toast('请选择 TXT 或 Markdown 文档。', true); event.target.value = ''; return; }
  if (file.size > 500000) { toast('文件过大，请选择小于 500 KB 的文档。', true); event.target.value = ''; return; }
  try {
    const content = await file.text();
    if (content.length > 100000) { toast('文档超过 100,000 字符，请分成多篇导入。', true); return; }
    $('#document-title').value = file.name.replace(/\.(txt|md|markdown)$/i, '').slice(0, 160);
    $('#document-content').value = content;
    toast('文件内容已载入，确认后点击保存。');
  } catch { toast('无法读取文件，请重试。', true); }
  event.target.value = '';
});
window.addEventListener('hashchange', () => showView(location.hash.slice(1), false));
window.addEventListener('online', () => initialize());
showView(location.hash.slice(1) || 'workbench', false);
renderRun();
renderNotes();
renderEvaluations();
initialize();
