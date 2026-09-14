# Ollama Cloud Proxy

面向 Ollama Cloud 和外部 OpenAI 兼容 API 的转发服务。支持多通道模型路由、公平轮询、流式工具调用透传、模型同步和 Token 统计。后台可切换基础本地前缀缓存与上游官方缓存，默认开启本地缓存，有效期 10 分钟。

> 本地缓存生成用于展示与下游计费的模拟 `cached_tokens`，不会减少上游实际用量。关闭缓存总开关后，直接透传上游官方缓存用量；第三方通道使用本地缓存还需开启密钥页的“代理缓存”。

## 功能

- `/v1/chat/completions`、`/v1/responses`、`/v1/completions`、`/v1/embeddings` 等 OpenAI 兼容转发
- SSE 流式响应、tools、`tool_choice`、vision、结构化输出和 `reasoning_content` 思考字段兼容
- 可在后台导入多个 OpenAI 兼容 API 地址与加密密钥，按实际模型自动路由；Ollama 密钥按官方周额度或月额度智能均摊
- 401/403 自动停用，429 按 `Retry-After` 冷却，临时错误自动换钥重试
- 仅当 HTTP 400 响应包含 `Internal Server Error` 时额外重试两次，普通参数错误不会重试
- 同时兼容 Ollama `/api/tags` 与 OpenAI `/v1/models`，后台按 API 地址分组，下游返回全部可用模型
- 基础本地缓存支持跨模型、跨上游密钥、跨下游密钥的提示词前缀命中，默认 10 分钟，后台可修改有效期
- 每个下游访问密钥可独立设置输出 Token 减速器，`0` 表示不限速
- 每个下游访问密钥可独立启用来源白名单，默认不启用；支持 RP-Hub 源站和 Codex Router
- 外部 API 可逐个选择直接透传上游缓存，或使用代理缓存替换上游 `cached_tokens`；错误仍不重试并原样透传
- SQLite WAL 持久化，密钥 AES-256-GCM 加密，缓存仅保存 HMAC 哈希
- 用量与密钥健康状态由工作线程批量落盘，流式首字不等待 SQLite 写入
- `/admin` 管理后台、Ollama 额度走势、按密钥与模型汇总、下游密钥累计用量和统计清理
- Docker、GHCR 构建工作流和 Zeabur Template YAML

## 快速开始

推荐 Node.js 24 LTS，最低支持 22.13；不需要安装第三方 npm 包。

```bash
npm start
```

打开 `http://localhost:8080/admin`，默认管理密钥为 `123456`。依次完成：

1. 输入通道名称、OpenAI 兼容 Base URL 和 API Key，导入一个或多个上游通道。
2. 点击测试确认密钥有效。
3. 生成一个下游访问密钥并立即保存。
4. 将客户端 Base URL 设置为 `http://localhost:8080/v1`。

新版本会加密保存新生成的下游访问密钥，管理员可以在密钥页再次复制。旧版本只保存了不可逆哈希，升级后原有密钥仍可使用，但需要重新生成才能在后台复制。

Ollama Cloud 密钥默认是 `MAX`（权重5、单密钥并发10），可在密钥表中改为 `PRO`（权重1、单密钥并发3）。服务每2分钟读取一次官方额度：旧格式使用 5 小时和周额度，新格式使用月额度；混合使用时按各自周期的已用百分比智能均摊，用量相差不超过1个百分点时按模型恢复 MAX/PRO 的5:1分配。账号冷却、暂停或达到固定并发上限时会临时绕开，外部 OpenAI API 不限并发且不参与额度均摊。

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

后台“缓存”页面提供本地缓存总开关。开启后 Ollama Cloud 使用基础前缀缓存；关闭后所有通道的新请求跳过本地缓存计算、查询和写入，`usage` 中的官方缓存字段原样透传，官方未返回的缓存字段不会凭空补充。请求始终按额度均摊和模型权重路由，不绑定会话。

第三方 OpenAI 兼容通道默认透传上游 usage，可在密钥页逐个开启“代理缓存”，仅在总开关开启时生效。使用本地缓存时，以代理计算的 `cached_tokens` 替换上游缓存统计，保留其他 usage 字段；不进行 RP 分块。缓存键包含 `instructions`、system/messages/input、tools、`response_format` 和图片内容，不包含模型名及任何密钥。以下规则适用于启用本地缓存的请求：

- 完整提示词相同：`cached_tokens` 等于本次真实 `prompt_tokens`。
- 当前请求在旧请求后继续追加消息：最长相同前缀命中。
- 同模型前缀优先使用历史 Token 观测值。
- 跨模型前缀按本次真实输入 Token 和前缀长度估算。
- 修改早期消息、工具定义、工具顺序、图片或输出 Schema 会从修改处开始失效。
- 只有成功完成的请求会写入缓存；命中后成功完成会按设置的时长刷新有效期。

响应同时带有：

```text
X-Proxy-Cache: HIT | MISS
X-Proxy-Cache-Type: exact | prefix
X-Proxy-Cache-Source: proxy-simulated
```

关闭总开关，或第三方通道未开启“代理缓存”时，返回 `X-Proxy-Cache: BYPASS` 和 `X-Proxy-Cache-Source: upstream`。`BYPASS` 仅表示跳过本地缓存，不代表官方缓存未命中；具体命中量以响应中的 `usage` 为准。

本地缓存在 Chat Completions 写入 `usage.prompt_tokens_details.cached_tokens`，在 Responses API 写入 `usage.input_tokens_details.cached_tokens`。流式 Chat Completions 会请求上游返回 usage 用于累计统计，但只有客户端设置 `stream_options.include_usage=true` 时才向下游发送最终 usage 数据块。

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
| `MODEL_SYNC_INTERVAL` | `10m` | 模型同步间隔 |
| `QUOTA_SYNC_INTERVAL` | `2m` | Ollama 官方额度刷新间隔 |
| `QUOTA_SYNC_URL` | `https://ollama.com/api/usage` | Ollama 官方额度接口 |
| `UPSTREAM_RETRIES` | `10` | 发送响应前最多尝试的不同密钥数，最高10 |
| `UPSTREAM_BASE_URL` | `https://ollama.com/v1` | OpenAI 兼容上游地址 |
| `MODEL_SYNC_URL` | `https://ollama.com/api/tags` | 模型列表地址 |
| `MAX_REQUEST_BYTES` | `33554432` | 最大请求体字节数 |

生产环境务必修改 `ADMIN_PASSWORD`。如果没有生成下游访问密钥且 `ALLOW_ANONYMOUS=false`，代理会拒绝 `/v1` 请求，避免公开消耗上游额度。

Token 减速器设置在管理后台的“下游访问密钥”列表中，对 Ollama Cloud 和所有外部 API 通道统一生效。开启后，流式正文和思考文字收到一段就逐字发送，不等待整条回复生成完；设置 `10` 约为每 0.1 秒一个 Unicode 字符，并非精确的模型 token/s。工具参数、多候选结果、多模态及带 token 概率的复杂片段保留原结构，仍按片段减速；最终 usage、结束标记和缓存回报保持原有逻辑。设为 `0` 时跳过字数统计、拆字和限速计时，直接透传；非流式响应仍按完成 token 数延迟整包返回。逐字发送会增加开启减速时的数据包和传输字节数；上游停顿时无法凭空补字，下游中转或页面缓冲也可能把多个字合并显示。

后台“缓存”页面支持开启/关闭本地缓存、设置有效期和清空缓存账本。默认开启、有效期 10 分钟，可设置 1 分钟到 7 天；设置保存在 SQLite 中，重启不丢失，保存后对新请求生效，进行中的请求保持原缓存处理方式。修改时长只影响新写入或再次命中的数据，既有前缀按原有效期自然淘汰。旧环境变量 `CACHE_TTL` 不再使用，以后台设置为准。

基础缓存仍在独立工作线程中处理，空间上限 512 MB。不恢复粘性路由和 RP 分块；升级会删除旧 RP 分块数据与相关设置，保留基础前缀账本及第三方密钥的代理缓存开关。关闭总开关不会删除现有缓存，但其仍会正常过期。

统计写入会在工作线程中批量处理，只保存下游密钥累计用量，不保存逐条请求或小时模型明细。升级后会汇总旧明细中的下游累计用量，再删除旧统计表。缓存命中计算使用独立缓存账本，不受此调整影响。额度页面根据最近多次成功刷新后的用量走势估算耗尽时间，刷新数据不足或额度没有增长时显示“暂无法估算”。

上游密钥状态只在转发、模型同步或后台测试收到 HTTP `403`、`429` 时标记“异常”：403 停止自动分配，可通过密钥测试成功恢复；429 按 `Retry-After` 冷却，缺省 30 秒。其他 HTTP 错误、网络错误、超时或取消请求不再改变密钥状态，也不清除已有的 403/429 异常；成功请求或检测会恢复“健康”。原有请求重试次数与第三方错误透传规则不变。升级会清除旧规则留下的其他错误状态，密钥本身和用量数据不受影响。

白名单同样设置在“下游访问密钥”列表中。启用后，请求满足以下任一条件即可通过，否则返回 403：

- `Origin` 是 `https://sta1n156.github.io`、`https://api.sta1n.site` 或 `https://cdn.sta1n.cn`
- `User-Agent` 符合 `codex-router/xxxxx`

也可以选择“白名单 + 3/5/10/15/20/25/30/35/40 并发”。请求仍需先通过上述白名单，同一个下游密钥超过所选并发数时会立即返回 HTTP 503，不会进入排队。

经过 New API 中转时，需要在对应渠道的“请求头覆盖”中配置：

```json
{
  "Origin": "{client_header:Origin}"
}
```

这会把浏览器发给 New API 的原始来源继续传给本代理。New API 后台主动执行渠道测试时没有浏览器来源，因此测试按钮可能显示 403，但来自白名单的真实请求可以正常使用。白名单能阻止其他普通网页，不能防止脚本主动伪造请求头。

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
- `ALLOW_ANONYMOUS=false`

Zeabur 挂载持久卷后，重新部署时会有短暂中断。如果需要多副本部署，应将 SQLite 缓存和统计迁移到共享数据库。
