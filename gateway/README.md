# model-gateway

用 TypeScript + Bun 从零实现一个本地 LLM 网关(模型转换器),目标是对标 Magpie 的核心层:协议翻译 + 路由。

## 第一步:目的

写代码之前,先把三件事写清楚:要解决什么问题、边界在哪、怎么算成功。

### 要解决的问题

不同的 Agent 和不同的模型厂商讲不同的"方言":

- Agent 期望 OpenAI Chat Completions / Anthropic Messages / Gemini 等格式
- 每个厂商又有自己的请求结构、流式事件、工具调用和思考(reasoning)表达方式

直接对接意味着 Agent × 厂商 的组合爆炸,密钥散落各处,换模型要改代码。

### 目标(一句话)

做一个本地网关:统一入口收下 OpenAI 格式的请求,内部翻译成统一中间格式(canonical),再翻译成目标厂商格式发出;把厂商的流式响应翻译回 OpenAI 格式返回。

### 第一版边界(不做什么)

- 不做 GUI / 菜单栏,只做 HTTP 网关
- 不做隐私脱敏、额度监控、多账号轮换(那是 Magpie 的加分项,后面再学)
- 先支持 OpenAI(直通),再依次加 Anthropic、Gemini

### 验收标准

- `bun run dev` 能起服务
- `curl http://127.0.0.1:3425/v1/models` 列出模型
- `curl -N` 发起 `/v1/chat/completions` 能流式收到 OpenAI 格式回复
- 同一个请求换 Anthropic 后端,返回格式不变(第 4 步达成)

### 学习目标(比代码更重要)

吃透一份"模型调用契约":messages 的角色与内容块、tools 的 schema、流式 SSE 事件、reasoning 的表达。这是理解 Agent 的地基。

## 骨架

```text
gateway/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts            # Bun.serve 入口 + 路由
│   ├── types.ts           # 统一中间格式(canonical)
│   ├── config.ts          # 配置与密钥(环境变量)
│   ├── router.ts          # model -> provider 路由
│   ├── providers/
│   │   ├── base.ts        # Provider 抽象接口
│   │   └── openai.ts      # OpenAI 直通(骨架参考实现)
│   └── translate/
│       ├── sse.ts         # SSE 字节流解析
│       ├── fromOpenai.ts  # 原始 OpenAI 请求 -> canonical
│       └── toOpenai.ts    # canonical -> OpenAI 流 / JSON 响应
└── README.md
```

核心约定:所有 Provider 都吃 `ChatRequest`、吐 `StreamEvent` 流;加一个厂商 = 写两个翻译函数 + 一个 Provider 类。

## 运行

先装 Bun(需要网络):

```sh
curl -fsSL https://bun.sh/install | bash
```

然后:

```sh
cd gateway
bun install
OPENAI_API_KEY=sk-... bun run dev
```

测试:

```sh
curl http://127.0.0.1:3425/v1/models

curl -N http://127.0.0.1:3425/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## 路线图

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 目的 | ✅ 本文件 |
| 2 | 骨架 + OpenAI 直通 | ✅ |
| 3 | Provider 接口 + 路由 + 模型别名 | ✅ 骨架,别名表待填 |
| 4 | Anthropic 格式转换 | ⬜ |
| 5 | Gemini 格式转换 | ⬜ |
| 6 | 流式 SSE 翻译层 | ✅ 骨架,工具调用待补 |
| 7 | 工具调用 + reasoning 双向 | ⬜ |
| 8 | 故障转移与重试 | ⬜ |
| 9 | 配置 / 密钥 / CLI | ✅ 环境变量版 |
| 10 | golden 测试 | ⬜ |
