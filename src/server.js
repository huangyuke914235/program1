import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { createRun, advanceRun } from './agent/engine.js';
import { createProvider } from './agent/providers.js';
import { runEvaluation } from './evaluation.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const httpError = (status, message) => Object.assign(new Error(message), { status });
const publicRun = run => {
  const { state, ...safe } = run;
  return safe;
};
function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw httpError(400, `${field} 必须为 1–${max} 个字符`);
  return value.trim();
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw httpError(415, '请求需要 application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 384 * 1024) throw httpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'JSON 格式错误'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw httpError(400, '请求体必须为 JSON 对象');
  return data;
}

export function createApp({ config = readConfig(), store = new Store(join(config.dataDir, 'agent-lab.sqlite')), provider = createProvider(config) } = {}) {
  store.recoverInterruptedRuns();
  const active = new Map();
  let evaluationActive = false;
  let closing;
  function launch(run, decision) {
    const approvalId = run.pendingApproval?.id;
    const task = Promise.resolve().then(() => advanceRun(run, {
      provider, documents: store.documents(), maxSteps: config.maxSteps,
      saveNote: note => store.saveNote(note, `${run.id}:${approvalId || 'note'}`),
      persist: current => store.saveRun(current), decision,
    })).catch(error => {
      run.status = 'failed';
      run.error = config.apiKey ? String(error.message).split(config.apiKey).join('[redacted]') : String(error.message);
      run.updatedAt = new Date().toISOString();
      store.saveRun(run);
    }).finally(() => active.delete(run.id));
    active.set(run.id, task);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      const host = new URL(`http://${req.headers.host || 'localhost'}`).hostname.replace(/^\[|\]$/g, '');
      if (!['127.0.0.1', 'localhost', '::1', config.host].includes(host) || host === '0.0.0.0') throw httpError(403, '不允许的 Host');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw httpError(403, '仅允许同源请求');
      const path = requestUrl.pathname;
      const method = req.method;
      if (method === 'GET' && path === '/api/health') return json(200, { status: 'ok', version: '1.0.0' });
      if (method === 'GET' && path === '/api/config') return json(200, { provider: config.provider, model: config.provider === 'demo' ? 'deterministic-demo' : config.model, maxSteps: config.maxSteps });
      if (method === 'GET' && path === '/api/documents') return json(200, { documents: store.documents() });
      if (method === 'POST' && path === '/api/documents') {
        const input = await body(req);
        return json(201, { document: store.addDocument({ title: text(input.title, '标题', 160), content: text(input.content, '内容', 100000) }) });
      }
      const docMatch = path.match(/^\/api\/documents\/([^/]+)$/);
      if (method === 'DELETE' && docMatch) {
        if (!store.deleteDocument(decodeURIComponent(docMatch[1]))) throw httpError(404, '文档不存在');
        return json(200, {});
      }
      if (method === 'GET' && path === '/api/runs') return json(200, { runs: store.runs().map(publicRun) });
      if (method === 'POST' && path === '/api/runs') {
        const input = await body(req);
        if (active.size >= 3) throw httpError(429, '最多同时运行 3 个任务，请稍后重试');
        const run = createRun(text(input.question, '任务', 4000), config.provider);
        store.saveRun(run);
        json(202, { run: publicRun(run) });
        launch(run);
        return;
      }
      const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/approval)?$/);
      if (runMatch) {
        let run = store.run(decodeURIComponent(runMatch[1]));
        if (!run) throw httpError(404, '运行记录不存在');
        if (method === 'GET' && !runMatch[2]) return json(200, { run: publicRun(run) });
        if (method === 'POST' && runMatch[2]) {
          const input = await body(req);
          // Parsing can yield while another request completes this approval.
          // Reload immediately before the synchronous validation/claim section.
          run = store.run(decodeURIComponent(runMatch[1]));
          if (!run) throw httpError(404, '运行记录不存在');
          if (typeof input.approved !== 'boolean' || typeof input.approvalId !== 'string') throw httpError(400, '需要 approved 布尔值和 approvalId');
          if (active.has(run.id) || run.status !== 'waiting_approval' || run.pendingApproval?.id !== input.approvalId) throw httpError(409, '审批已处理或已过期，请刷新运行记录');
          if (run.provider && run.provider !== config.provider) throw httpError(409, '请切回原模型模式再处理本次审批');
          if (active.size >= 3) throw httpError(429, '最多同时运行 3 个任务，请稍后重试');
          json(202, { run: publicRun(run) });
          launch(run, input.approved);
          return;
        }
      }
      if (method === 'GET' && path === '/api/notes') return json(200, { notes: store.notes() });
      if (method === 'GET' && path === '/api/evaluations') return json(200, { evaluations: store.evaluations() });
      if (method === 'POST' && path === '/api/evaluations') {
        await body(req);
        if (evaluationActive) throw httpError(409, '评测正在运行');
        evaluationActive = true;
        try {
          const evaluation = await runEvaluation();
          store.saveEvaluation(evaluation);
          return json(200, { evaluation });
        } finally { evaluationActive = false; }
      }
      if (path.startsWith('/api/')) throw httpError(404, '接口不存在');
      if (method !== 'GET' && method !== 'HEAD') throw httpError(405, '不支持的请求方法');
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (!/^[a-zA-Z0-9_-]+\.(html|js|css|svg|png)$/.test(file)) throw httpError(404, '文件不存在');
      let data;
      try { data = await readFile(join(publicDir, file)); } catch (error) { if (error.code === 'ENOENT') throw httpError(404, '文件不存在'); throw error; }
      res.writeHead(200, { 'Content-Type': mime[extname(file)] });
      res.end(method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : '服务器暂时无法处理请求' });
      else res.end();
    }
  });
  return { server, store, close() {
    closing ||= (async () => {
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      await Promise.allSettled([...active.values()]);
      store.close();
    })();
    return closing;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = readConfig();
    const app = createApp({ config });
    app.server.listen(config.port, config.host, () => console.log(`Agent Lab · ${config.provider} mode · http://${config.host}:${app.server.address().port}`));
    app.server.on('error', error => { console.error(error.message); process.exitCode = 1; app.store.close(); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
