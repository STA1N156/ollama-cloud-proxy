# Ollama Cloud Proxy

面向 Ollama Cloud 的 OpenAI 格式转发服务。支持多密钥公平轮询、流式工具调用透传、最新模型同步、每个密钥与模型的 Token 统计，以及一小时硬盘缓存账本生成的 `cached_tokens`。

> `cached_tokens` 是本转发层生成的展示与下游计费数据，不代表 Ollama Cloud 官方缓存，也不会减少 Ollama Cloud 官方额度。

## 功能

- `/v1/chat/completions`、`/v1/responses`、`/v1/completions`、`/v1/embeddings` 等 OpenAI 兼容转发
- SSE 流式响应、tools、`tool_choice`、vision、结构化输出和 reasoning 参数透传
- 多个 Ollama Cloud 密钥按模型公平轮询
- 401/403 自动停用，429 按 `Retry-After` 冷却，临时错误自动换钥重试
- 仅当 HTTP 400 响应包含 `Internal Server Error` 时额外重试两次，普通参数错误不会重试
- 从 `https://ollama.com/api/tags` 定时同步最新模型
- 跨模型、跨上游密钥、跨下游密钥的一小时提示词前缀命中
- SQLite WAL 持久化，密钥 AES-256-GCM 加密，缓存仅保存 HMAC 哈希
- `/admin` 管理后台与按密钥、模型统计的 Token 用量
- Docker、GHCR 构建工作流和 Zeabur Template YAML

## 快速开始

推荐 Node.js 24 LTS，最低支持 22.13；不需要安装第三方 npm 包。

```bash
npm start
```

打开 `http://localhost:8080/admin`，默认管理密钥为 `123456`。依次完成：

1. 添加 Ollama Cloud API Key。
2. 点击测试确认密钥有效。
3. 生成一个下游访问密钥并立即保存。
4. 将客户端 Base URL 设置为 `http://localhost:8080/v1`。

示例：

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer ocp_your_client_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss:120b",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

OpenAI SDK：

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-domain.example/v1',
  apiKey: 'ocp_your_client_key',
});

const response = await client.chat.completions.create({
  model: 'gpt-oss:120b',
  messages: [{ role: 'user', content: '你好' }],
});
```

## 缓存命中规则

缓存键包含 `instructions`、system/messages/input、tools、`response_format` 和图片内容，不包含模型名及任何密钥。

- 完整提示词相同：`cached_tokens` 等于本次真实 `prompt_tokens`。
- 当前请求在旧请求后继续追加消息：最长相同前缀命中。
- 同模型前缀优先使用历史 Token 观测值。
- 跨模型前缀按本次真实输入 Token 和前缀长度估算。
- 修改早期消息、工具定义、工具顺序、图片或输出 Schema 会从修改处开始失效。
- 只有成功完成的请求会写入缓存；命中后成功完成会刷新一小时有效期。

响应同时带有：

```text
X-Proxy-Cache: HIT | MISS
X-Proxy-Cache-Type: exact | prefix
X-Proxy-Cache-Source: proxy-simulated
```

Chat Completions 写入 `usage.prompt_tokens_details.cached_tokens`；Responses API 写入 `usage.input_tokens_details.cached_tokens`。流式 Chat Completions 只有在客户端设置 `stream_options.include_usage=true` 时才向下游发送最终 usage 数据块。

这两个字段是 New API 当前读取的标准缓存用量字段，因此把本服务配置为 New API 的 OpenAI 渠道时，命中量会进入 New API 的缓存 Token 计费流程。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `ADMIN_PASSWORD` | `123456` | `/admin` 登录密钥 |
| `PORT` | `8080` | HTTP 端口 |
| `DATA_DIR` | `./data` | SQLite、主密钥和缓存数据目录 |
| `OLLAMA_API_KEYS` | 空 | 可选，逗号或换行分隔的上游密钥 |
| `PROXY_API_KEYS` | 空 | 可选，逗号或换行分隔的下游密钥 |
| `ALLOW_ANONYMOUS` | `false` | 是否允许无下游密钥调用 |
| `CACHE_TTL` | `1h` | 缓存有效期 |
| `MAX_INFLIGHT_PER_KEY` | `32` | 单个上游密钥最大同时请求数 |
| `MODEL_SYNC_INTERVAL` | `10m` | 模型同步间隔 |
| `UPSTREAM_RETRIES` | `3` | 发送响应前最多尝试的不同密钥数 |
| `UPSTREAM_BASE_URL` | `https://ollama.com/v1` | OpenAI 兼容上游地址 |
| `MODEL_SYNC_URL` | `https://ollama.com/api/tags` | 模型列表地址 |
| `MAX_REQUEST_BYTES` | `33554432` | 最大请求体字节数 |

生产环境务必修改 `ADMIN_PASSWORD`。如果没有生成下游访问密钥且 `ALLOW_ANONYMOUS=false`，代理会拒绝 `/v1` 请求，避免公开消耗上游额度。

## Docker

```bash
docker build -t ollama-cloud-proxy .
docker run -d --name ollama-cloud-proxy \
  -p 8080:8080 \
  -e ADMIN_PASSWORD='change-me' \
  -v ollama-proxy-data:/data \
  ollama-cloud-proxy
```

容器以非 root 用户运行，`/data` 必须可写。

## Zeabur

最简单的方式是将本目录作为独立 GitHub 仓库推送，再在 Zeabur 选择 GitHub 项目。Zeabur 会识别根目录的 `Dockerfile`。

仓库内的 GitHub Actions 会发布：

```text
ghcr.io/<你的 GitHub 用户名>/ollama-cloud-proxy:latest
```

`zeabur-template.yaml` 当前使用 `ghcr.io/sta1n156/ollama-cloud-proxy:latest`。发布镜像后可直接导入模板并生成 Deploy Button；如果仓库所有者不同，请先替换镜像地址。

模板自动完成：

- HTTP 端口 8080
- `/data` 持久卷
- `ADMIN_PASSWORD=123456`
- `CACHE_TTL=1h`
- `ALLOW_ANONYMOUS=false`

Zeabur 挂载持久卷后，重新部署时会有短暂中断。如果需要多副本部署，应将 SQLite 缓存和统计迁移到共享数据库。

## 测试

```bash
npm test
```

测试覆盖缓存指纹、完整/前缀/跨模型命中、公平轮询、失效密钥剔除、401 换钥、工具参数透传，以及非流式和 SSE 流式 `cached_tokens` 注入。
