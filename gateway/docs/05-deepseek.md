# 接入 DeepSeek:同一套协议,两家独立上游

你的 `.env` 已有 `DEEPSEEK_KEY` 和 `DEEPSEEK_ID`,代码直接读取它们。当前模型配置为 `deepseek-flash`,无需改名。

## 1. 配置如何进入代码

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_KEY` | DeepSeek 密钥,也兼容 `DEEPSEEK_API_KEY` |
| `DEEPSEEK_ID` | 真实模型 ID,也兼容 `DEEPSEEK_MODEL` |
| `DEEPSEEK_BASE_URL` | 可选,默认 `https://api.deepseek.com` |

如果两套命名同时存在,非空的 `DEEPSEEK_KEY`、`DEEPSEEK_ID` 优先。

`loadConfig()` 仍按原规则选择 OpenAI 或百炼作为 `openai` 配置项,然后单独追加 `deepseek` 配置项。两家分别保存自己的地址与密钥。没有密钥时不注册该上游,有密钥和模型 ID 时才创建别名。

现在你这份配置对应的路由为:

```text
model="qwen"     -> openai 实例   -> 百炼 / QWEN_MODEL
model="deepseek" -> deepseek 实例 -> DeepSeek / DEEPSEEK_ID
```

默认上游仍优先使用原有配置。显式模型别名会选定对应上游,不受默认值影响;只配置 DeepSeek 时,它成为默认上游。

## 2. 按执行顺序看改动

1. `src/config.ts`:独立读取 DeepSeek 配置,注册上游,创建 `deepseek` 别名。
2. `src/main.ts`:遍历所有配置,为每个上游创建一个 `OpenAIProvider` 实例。
3. `src/providers/openai.ts`:构造函数接收上游 `id`,让同一协议实现拥有不同身份。
4. `src/router.ts`:原有路由无需改动,将 `deepseek` 拆解为供应商与真实模型名。
5. `toOpenAIBody()`:把内部思考开关转换成当前上游要求的字段。

DeepSeek 使用 OpenAI 兼容的 Chat Completions 协议,因此可以复用请求、文本回复和 SSE 转换。基础地址与接口说明见 [DeepSeek 官方首次调用文档](https://api-docs.deepseek.com/zh-cn/)。

## 3. 启动与请求

在 gateway 目录启动:

```sh
GATEWAY_DEBUG=1 bun run dev
```

另一个终端发送:

```sh
curl -N http://127.0.0.1:3425/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek","messages":[{"role":"user","content":"你好"}],"stream":true,"enable_thinking":false,"max_tokens":128}'
```

把 `model` 改为 `qwen` 就选择百炼。也可以传 `deepseek/deepseek-flash` 显式指定供应商与模型;别名的好处是以后只改 `.env` 中的模型 ID,客户端仍使用 `deepseek`。

当前网关统一接收 `enable_thinking` 开关,内部命名为 `enableThinking`,发送上游时再转换:

| 上游 | 关闭思考时的上游请求字段 |
|---|---|
| 百炼 | `"enable_thinking": false` |
| DeepSeek | `"thinking": {"type":"disabled"}` |

这是本网关入口的约定,直接调用 DeepSeek 时应使用其原生字段。参数转换依据 [DeepSeek 思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)。当前只转换开关并返回最终文本,完整 reasoning 与工具调用仍待实现。

## 4. 验证

```sh
bun run typecheck
bun test
bun run test:deepseek
```

前两项检查类型和配置、别名路由、思考参数转换,不启动模拟服务、不调用真实模型。第三项使用 `.env` 凭据,通过临时网关依次测试非流式和流式;失败即停止。原有 `bun run test:live` 默认优先测试 qwen,没有 qwen 别名时选择 DeepSeek。

2026-11-06 最终验收:显式配置本机系统代理后,DeepSeek 普通和流式请求均返回 HTTP 200,回复“网关联调成功”,以 stop 正常结束;流式另有 [DONE] 标记。首次连接重置的原因和解决方法见 [步骤 1](06-step1-real-models.md)。
