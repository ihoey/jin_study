# 新增代码:按执行顺序理解为什么这样写

这次新增的功能可以放回“订餐中心”的例子里理解:先决定用哪家餐厅的地址和合作凭证,接单时检查订单是否合法,记录订单走到哪一步,最后区分“订单写错”和“餐厅调用失败”。联调脚本则扮演一个自动下单、检查结果并收尾的顾客。

本次注释覆盖 `config.ts`、`main.ts`、`fromOpenai.ts`、`types.ts`、`providers/openai.ts`、`examples/live-request.ts` 和 `tests/config.test.ts`。注释说明当前实现,没有修改这些文件的执行逻辑。

## 1. 启动时:先选择一套完整的上游配置

入口在 [config.ts](../src/config.ts) 的 `loadConfig()`。

```text
调用 loadConfig()
  → 读取端口
  → 分别读取 OPENAI_*、DASHSCOPE_*、DEEPSEEK_* 地址和密钥
  → 有密钥才注册对应供应商,三家可以同时存在
  → 根据条件建立 qwen 与 deepseek 别名
  → return 配置对象,回到 main.ts
```

**为什么地址和密钥一起选择?** 两套服务可能同时存在于环境中,必须使用同一分支的地址与密钥,避免把某个服务的凭据用到另一套地址。这是配置配对规则,不是对自定义地址进行权限验证。

**为什么函数增加 `env` 参数?** 正式调用 `loadConfig()` 时使用默认的 `process.env`;测试调用 `loadConfig({ ...假配置 })` 时只使用传入对象。这样测试不需要读取真实凭据,也不用修改进程环境。

**为什么删除地址末尾的 `/`?** Provider 后面会拼接 `/chat/completions`,提前移除末尾斜杠可以避免出现 `//chat/completions`。

**百炼现在叫什么?** 步骤 2 将它改为独立的 `bailian`,与 `openai`、`deepseek` 分别注册。三家按配置中的协议复用 `OpenAIChatProvider` 类,身份、地址和密钥各自独立。旧前缀兼容规则见 [步骤 2](07-step2-provider-protocol.md)。

比如设置了百炼密钥和 `QWEN_MODEL=某个模型`,就建立 `qwen → bailian/某个模型`,不受是否配置 OpenAI 影响。DeepSeek 建立 `deepseek → deepseek/真实模型`。Router 先查模型别名,再拆出供应商和模型名,最后处理旧供应商前缀兼容。

## 2. 收到聊天请求:先检查订单,再找供应商

[main.ts](../src/main.ts) 的新执行顺序是:

```text
req.json()                  把 HTTP 正文解析成 JSON 值
  → validateTextRequest()   检查结构和当前支持范围
  → trace("[1] ...")        校验通过后才记录模型和 stream
  → router.resolve()        找 Provider 与真实模型名
  → trace("[2] ...")
  → fromOpenAI()            整理成内部 ChatRequest
  → trace("[3] ...")
  → provider.chat()         取得惰性的异步生成器
  → trace("[4] ...")
  → 根据 stream 选择出口
      → trace("[5] ...") → 消费事件 → 真正调用上游
```

**为什么 JSON 解析后还要校验?** `[]`、`null`、`{"model":123}` 都可能是合法 JSON,但它们不是当前入口能处理的聊天请求。`req.json()` 解决语法解析,`validateTextRequest()` 解决字段结构和功能范围。

校验器在 [fromOpenai.ts](../src/translate/fromOpenai.ts) 中。它要求非空字符串模型名、非空消息数组,并逐条检查消息角色和字符串正文。当前还不支持工具或多模态内容,所以遇到这些字段直接拒绝整个请求,避免转换时丢失信息后仍假装处理成功。

```ts
validateTextRequest(raw);
// 只有上一行正常返回,才会执行这里。
const { provider, upstreamModel } = router.resolve(raw.model);
```

**什么时候退出校验器?** 任意检查失败就 `throw new TextRequestError(...)`,正常路径立即中断;全部检查通过则走到函数末尾,没有返回新对象,调用处继续下一行。

`asserts raw is TextRequest` 是给 TypeScript 的说明:“正常返回后,可把 raw 当成 TextRequest”。真正检查输入的是函数里的 `if` 和 `throw`,不是这句类型声明。

## 3. 扩展字段:为什么关闭思考的 false 不能丢

这次增加的字段经过三个位置:

```text
客户端请求                内部 ChatRequest            上游请求
enable_thinking: false → enableThinking: false → enable_thinking: false
        fromOpenAI() 完成第一次改名       toOpenAIBody() 改回协议字段名
```

`undefined`、`false`、`true` 是三种不同含义:

| 值 | 当前代码的处理 |
|---|---|
| `undefined` | 客户端没有提供这个字段,上游正文也不主动加它 |
| `false` | 明确传递关闭思考的要求 |
| `true` | 明确传递开启思考的要求 |

因此判断写成 `value !== undefined`。如果写成 `if (value)`,表示关闭的 `false` 就会被过滤掉,上游可能继续使用自己的默认行为。

`stream` 决定如何返回回答,`enableThinking` 是内部思考开关,二者互不替代。出口根据配置里的 `thinkingFormat` 转换,不依赖供应商 id。DeepSeek 默认使用 `thinking.type`,百炼默认使用 `enable_thinking`。当前尚未实现完整的思考内容转换。

## 4. 健康检查、流程日志和错误响应分别解决什么

| 新代码 | 做什么 | 为什么放在这里 |
|---|---|---|
| `hostname: "127.0.0.1"` | 指定本机监听地址 | 明确当前学习网关的监听范围 |
| `GET /health` | 立即返回 `{"status":"ok"}` | 单独确认网关能接请求,不需要密钥或上游可用 |
| `trace()` | `GATEWAY_DEBUG=1` 时打印检查点 | 用模型、供应商、消息条数观察执行顺序,不输出聊天正文和完整配置 |
| `error(error)` | 把请求处理异常包装成 JSON | 客户端能收到明确状态与错误类型,而非未经整理的内部错误 |

`trace()` 是普通函数,打印或跳过后就回到调用位置。看到 `[4]` 只说明拿到了生成器,看到 `[5]` 只说明即将消费事件,都不代表已经收到了模型回答。

当前错误回调的分支是:

```text
TextRequestError 或 SyntaxError
  → HTTP 400,invalid_request_error

其他交给错误回调处理的异常
  → HTTP 502,gateway_error
```

这里的 400 表示当前代码归类的请求问题,502 表示当前代码归类的路由或上游调用问题。调试时先遮盖已配置密钥的字面值再输出错误信息,客户端对其他异常只收到概括性提示。

当前已区分客户端 JSON 错误（400）和上游协议错误（502）,并用 `UpstreamError` 分类网络、认证、权限和超时。流式入口先获取首个事件再返回 HTTP 响应;已交出的正文流若发生错误,仍由 `toOpenAIStream()` 的 `controller.error()` 处理。变更见 [步骤 1](06-step1-real-models.md)。

## 5. 联调脚本:一个文件控制两个进程的配合

[live-request.ts](../examples/live-request.ts) 是客户端和进程管理脚本,模型转发仍由它启动的 `main.ts` 子进程完成。

```text
父进程 live-request.ts
  → 读取配置
  → Bun.spawn() 启动 main.ts 子进程
  → 从子进程日志取得实际监听地址
  → 向该地址发送 stream:false 请求,检查完整 JSON
  → 向该地址发送 stream:true 请求,检查 SSE
  → finally 中关闭子进程、等它退出、收集日志
```

**为什么端口设为 0?** 由系统分配临时端口,避免和手动运行的网关冲突。脚本等到日志中出现实际地址才发送请求,不会把“已经创建子进程”误认为“服务已准备好”。

**为什么有多层超时?** 每个客户端请求有 45 秒超时,上游 fetch 也有独立的 45 秒期限,子进程还有 110 秒的生命周期兜底。它们分别限制客户端等待、上游请求和联调进程。客户端取消仍未贯穿传递到上游,完整的取消传播将在后续步骤实现。

**为什么要同时检查文本、结束原因和 `[DONE]`?** HTTP 200 只能说明拿到了成功状态的响应,不能证明流已完整结束。本脚本还要求有非空回答和 `stop` 结束原因;流式还要求看到协议结束标记。

**什么时候退出?** 第一轮失败就进入 `catch`,不会自动继续第二轮或重试。两轮都通过才打印整体成功。无论成功或失败都进入 `finally`,取消定时器、结束临时网关并读完日志。失败时设置 `process.exitCode = 1`,让清理代码有机会执行后再退出。

## 6. 测试与运行命令的区别

`package.json` 是严格 JSON,本次没有往里面加入注释。新增脚本的含义在这里说明:

| 命令 | 运行什么 | 是否调用真实模型 |
|---|---|---|
| `bun run typecheck` | 项目本地的 `tsc --noEmit`,检查类型但不生成 JS | 否 |
| `bun test` | 配置、别名路由和思考参数转换用例 | 否 |
| `bun run test:live` | 上面讲的父子进程联调流程 | 是 |
| `bun run test:deepseek` | 同一父子进程流程,选择 deepseek 别名 | 是 |

本地测试使用测试凭据和模型名,验证配置配对、两家同时注册、别名路由与不同思考字段的转换。它们不验证真实模型回复或 HTTP 请求校验器,也不会启动模拟模型服务。

`tsconfig.json` 的 `include` 增加 `examples`、`tests`,目的是让类型检查同时覆盖业务代码、示例脚本和测试。把文件纳入类型检查并不会执行其中的请求。

阅读顺序建议:先看 `config.ts` 的配置选择,再看 `main.ts` 中调用校验器的位置,进入 `validateTextRequest()` 理解提前抛错,然后顺着思考开关的三段字段映射走一遍,最后再读联调脚本的 `try/catch/finally`。
