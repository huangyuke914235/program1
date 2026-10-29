# 本地 HTTP API

默认地址为 `http://127.0.0.1:3000`。请求和返回使用 JSON；POST 请求需设置 `Content-Type: application/json`。接口面向本地单用户使用，没有用户身份体系。浏览器请求要求同源。

## 接口列表

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 服务状态与版本 |
| GET | `/api/config` | 当前 provider、模型名和执行上限；不含 API Key |
| GET | `/api/documents` | 文档列表与正文 |
| POST | `/api/documents` | 新增文档，参数 `{title, content}` |
| DELETE | `/api/documents/:id` | 删除文档 |
| GET | `/api/runs` | 最近 100 条运行记录 |
| POST | `/api/runs` | 创建任务，参数 `{question}`，返回 HTTP 202 |
| GET | `/api/runs/:id` | 查询任务状态、结果、记录与待审批动作 |
| POST | `/api/runs/:id/approval` | 提交 `{approved, approvalId}`，返回 HTTP 202 |
| GET | `/api/notes` | 已保存笔记 |
| GET | `/api/evaluations` | 最近 20 次评测报告 |
| POST | `/api/evaluations` | 传入 `{}`，执行并保存演示评测 |

列表分别包装为 `{documents: [...]}`、`{runs: [...]}`、`{notes: [...]}` 和 `{evaluations: [...]}`。单个文档或运行返回 `{document: {...}}` 或 `{run: {...}}`。

## 创建任务

```http
POST /api/runs
Content-Type: application/json

{"question":"总结 RAG 检索流程，保存为学习笔记"}
```

服务器先返回 `{run: {...}}`，再异步执行。按返回的运行 ID 查询 `/api/runs/:id`。`queued` 和 `running` 表示仍在执行；`waiting_approval` 表示等待用户；`completed` 或 `failed` 表示本轮结束。

公开运行记录包含 `id`、`question`、`status`、`createdAt`、`updatedAt`、`answer`、`citations`、`steps`、`usage` 和 `pendingApproval`。内部 provider 上下文不通过接口返回。

## 提交审批

等待审批时，`pendingApproval` 提供当前动作的 ID、工具名和参数。先展示 `arguments.title` 与 `arguments.content`，再提交用户的决定：

```http
POST /api/runs/运行ID/approval
Content-Type: application/json

{"approved":true,"approvalId":"当前pendingApproval.id"}
```

拒绝时将 `approved` 设为 `false`。批准和拒绝后都继续查询运行状态；202 只代表已接收决定，不代表任务已经完成。过期或重复审批返回 409。

## 评测报告

```http
POST /api/evaluations
Content-Type: application/json

{}
```

返回 `{evaluation: {id, createdAt, provider, passed, total, cases}}`。每个用例包括 `name`、`passed`、`detail` 和 `durationMs`。内置评测始终使用 demo provider，与服务器的真实模型设置无关。

## 参数和错误

任务长度为 1–4000 字符，文档标题为 1–160 字符，文档正文为 1–100000 字符；纯空白输入无效。请求体上限为 384 KiB。同一时间最多执行 3 个任务。每次运行共享 12 步预算，模型请求与工具动作各消耗一步，暂停等待审批不会重复消耗步骤。

错误统一返回 `{error: "可读的错误信息"}`，常见状态如下：

| 状态 | 含义 |
| --- | --- |
| 400 | 无效 JSON、参数或类型 |
| 403 | 不允许的来源或 Host |
| 404 | 资源或接口不存在 |
| 409 | 审批过期、状态冲突或已有评测在运行 |
| 413 | 请求体过大 |
| 415 | 请求缺少 JSON Content-Type |
| 429 | 正在执行的任务数量达到上限 |
| 500 | 服务内部错误 |
