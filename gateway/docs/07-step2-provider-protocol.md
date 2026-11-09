# 步骤 2:供应商身份与协议分开（已完成）

## 目的

供应商回答“请求发给谁”,协议回答“怎样组织请求和解析回复”。百炼、DeepSeek 和 OpenAI 都能使用当前的 Chat Completions 适配器,但它们有各自的身份、地址、密钥与扩展参数。

此前百炼也叫 `openai`,而且添加 OpenAI 密钥会让百炼配置被跳过。现在三家独立注册,添加一家不会覆盖另一家。

## 1. 先看配置,再看组装

```text
[启动 1] config.ts:读取 .env
  -> bailian 配置:身份、协议、地址、密钥、思考参数格式
  -> deepseek 配置:身份、协议、地址、密钥、思考参数格式

[启动 2] providers/registry.ts:按 protocol 选择协议类
  -> 两个独立的 OpenAIChatProvider 实例

[请求 2] router.ts:按别名或供应商前缀找到实例
  -> qwen    -> bailian/配置中的真实模型名
  -> deepseek -> deepseek/配置中的真实模型名

[请求 4] 实例按配置调用上游
  -> 统一 ChatRequest 转换成上游请求
  -> 上游 JSON/SSE 转换成统一 StreamEvent
```

构造实例不会发送请求。真正的上游调用仍在消费 `chat()` 生成器时执行。

## 2. 三个字段分别解决什么

| 字段 | 例子 | 用途 |
|---|---|---|
| `id` | `bailian`、`deepseek`、`openai` | 路由、日志和模型目录使用的身份 |
| `protocol` | `openai-chat-completions` | 工厂选择哪一个协议实现 |
| `thinkingFormat` | `enable_thinking`、`thinking`、`unsupported` | 请求转换时采用哪一种思考参数格式 |

`providers/registry.ts` 只根据 `protocol` 创建实例,不根据供应商名称选类。`toOpenAIBody()` 只根据 `thinkingFormat` 转换思考开关,不判断供应商名字。以后一个叫 `custom-service` 的兼容上游也可以复用这些代码。

当前只有一种协议实现。新增兼容服务可以复用现有类;新增另一种协议则需要提供新的实现并注册到工厂。

## 3. 现有环境变量保持可用

| 供应商身份 | 密钥变量 | 地址变量 | 模型别名来源 |
|---|---|---|---|
| `bailian` | `DASHSCOPE_API_KEY` | `DASHSCOPE_BASE_URL` | `QWEN_MODEL` -> `qwen` |
| `deepseek` | `DEEPSEEK_KEY` 或 `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `DEEPSEEK_ID` 或 `DEEPSEEK_MODEL` -> `deepseek` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | 使用 `openai/真实模型名` |

三组变量同时存在时三家都会注册,每家地址和密钥成对保存。DeepSeek 两套变量共存时,非空的 `DEEPSEEK_KEY` 和 `DEEPSEEK_ID` 优先。网络仍沿用步骤 1 的 `GATEWAY_PROXY_URL`,本次未修改 `.env`。

未指定 `DEFAULT_PROVIDER` 时,依次选择已配置的 OpenAI、百炼、DeepSeek。也可显式指定 `bailian` 或 `deepseek`;显式默认值没有对应密钥时,启动即报错。

## 4. 路由兼容规则

- `qwen` 始终指向百炼;增加 OpenAI 密钥也不会改变它。
- `deepseek` 始终指向 DeepSeek。
- `bailian/模型名`、`deepseek/模型名`、`openai/模型名` 使用真实供应商身份。
- 未注册 OpenAI、但已配置百炼时,旧的 `openai/模型名` 和 `DEFAULT_PROVIDER=openai` 会兼容指向百炼。
- 配置了真实 OpenAI 后,`openai/模型名` 就指向 OpenAI;调用百炼应使用 `qwen` 或 `bailian/模型名`。

模型目录中的百炼条目现在以 `bailian/` 开头,便于与真实 OpenAI 区分。

## 5. 思考开关按配置转换

客户端仍使用 `enable_thinking`,内部仍为 `enableThinking`:

| 参数格式配置 | 上游字段 |
|---|---|
| `enable_thinking`（百炼默认） | `enable_thinking: false/true` |
| `thinking`（DeepSeek 默认） | `thinking: {type: "disabled"/"enabled"}` |
| `unsupported`（当前 OpenAI 配置） | 省略该字段正常调用;显式请求开关时返回 400 |

`unsupported` 是本网关当前适配能力的声明,不表示 OpenAI 模型都没有思考能力。以后需要支持相应模型的参数时,再添加明确的格式转换。

## 6. 验证结果与复验方法

```sh
bun run typecheck
bun test
bun run test:live
bun run test:deepseek
```

类型检查及 14 项本地测试通过。测试覆盖三家共存、凭据配对、旧前缀、别名稳定性、任意供应商 id 复用适配器、不支持协议与重复 id 的拒绝,以及不同思考参数的转换。不启动模拟模型服务。

2026-11-06 真实回归:百炼 `qwen3.8-27b`、DeepSeek `deepseek-flash` 的普通和流式请求均返回 HTTP 200,回复“网关联调成功”,正常以 stop 结束,流式包含 [DONE]。百炼日志中的身份现在是 `bailian`,客户端仍请求 `qwen`。

OpenAI 独立注册通过本地配置与路由测试,未调用真实 OpenAI 服务。下一步再完善 SSE 解析、流式用量、异常结束和取消传播。
