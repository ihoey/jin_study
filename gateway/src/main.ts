// ============================================================================
// 数据流总览 —— 读代码按 [1] -> [5] 的顺序走:
//
//   客户端请求(OpenAI 格式)
//     |
//     v
//   [1] main.ts         收 HTTP 请求,按 path 分发
//     |
//     v
//   [2] router.ts       模型名 -> { provider, 上游模型名 }
//     |
//     v
//   [3] fromOpenai.ts   原始 OpenAI JSON -> 统一中间格式 ChatRequest
//     |
//     v
//   [4] providers/*.ts  把 ChatRequest 发给上游,把响应解析成 StreamEvent 流
//     |
//     v
//   [5] toOpenai.ts     把 StreamEvent 流翻译回 OpenAI SSE / JSON 返回
//     |
//     v
//   客户端收到 OpenAI 格式响应
// ============================================================================

// 引入"读配置"的函数(从 ./config 文件里拿 loadConfig)。
import { loadConfig } from "./config"; // 启动时调用配置读取函数,随后建立供应商和路由。
// 引入启动装配函数,入口只负责组装,不指定某家供应商的具体类。
import { createProviders } from "./providers/registry"; // 按配置中的协议创建各家适配器实例。
import { UpstreamError } from "./providers/errors";
// 引入路由类(负责把模型名翻译成"哪家供应商 + 真实模型名")。
import { Router } from "./router"; // Router 根据客户端模型名查找供应商对象和上游模型名。
// 引入翻译函数:把 OpenAI 格式的请求转成内部统一格式。
import { fromOpenAI, TextRequestError, validateTextRequest } from "./translate/fromOpenai"; // 分别用于字段转换、识别请求错误和执行运行时校验。
// 引入翻译函数:把内部事件流转回 OpenAI 的 JSON / 流式响应。
import { toOpenAIJSON, toOpenAIStream } from "./translate/toOpenai"; // 两个出口共享内部事件,分别生成完整 JSON 和流式响应正文。

// 打开 GATEWAY_DEBUG=1 后观察执行顺序;日志只记录结构,不打印消息和密钥。
function trace(step: string, details?: Record<string, unknown>): void { // 把重复的调试开关封装成函数;可选 details 只放结构信息,函数本身不参与路由。
  if (process.env.GATEWAY_DEBUG === "1") console.log(step, details ?? ""); // 只有值恰好为字符串 1 才打印;没有附加信息时打印空字符串,避免出现 undefined。
} // 打印或跳过后立即返回调用位置;不会终止请求,也不会等待模型响应。

// 启动时只做一次:读配置 + 组装 Provider 列表 + 建路由。
const config = loadConfig(); // 程序一启动就读取一次配置(端口、密钥、模型映射等),像"上班先看排班表"。
console.log("[启动] 配置:", { port: config.port, providers: config.providers.map((p) => p.id), defaultProvider: config.defaultProvider }); // 打印启动配置,方便确认端口和供应商是否读对。

const providers = createProviders(config); // [启动 2] 配置 -> 独立适配器实例,此时不会请求上游。
const router = new Router(providers, config.modelMap, config.defaultProvider, config.providerAliases);

const server = Bun.serve({ // 启动一个 HTTP 服务器,开始"接电话"。
  hostname: "127.0.0.1", // 本地学习网关只监听本机。
  port: config.port, // 监听配置里指定的端口。
  async fetch(req) { // 每个进来的 HTTP 请求都会走这个函数(req 是请求对象)。
    const url = new URL(req.url); // 把请求的网址解析成结构,方便读取路径 pathname。

    // 健康检查只检查网关是否启动,不会请求上游。
    if (req.method === "GET" && url.pathname === "/health") { // 只匹配本地存活检查,让联调或人工检查可以与真实模型调用分开。
      return Response.json({ status: "ok" }); // 立即结束本次请求;即使没有配置供应商,网关启动后也能正常返回这里。
    } // 不匹配健康检查时,继续判断后面的模型列表和聊天路径。

    if (req.method === "GET" && url.pathname === "/v1/models") { // 如果客户用 GET 获取模型列表。
      const models = await router.listModels(); // 汇总所有供应商提供的模型清单。
      return Response.json({ // 把清单包装成 JSON 返回给客户。
        object: "list", // OpenAI 规范里这个字段固定为 "list"。
        data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.provider })), // 把每个模型转成客户认识的格式。
      }); // 组装完模型目录后返回 HTTP 响应,不再执行下面的聊天分支。
    } // 仅路径或方法不匹配时才从这里继续向下判断。

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") { // 处理聊天请求
      let raw: unknown;
      try { raw = await req.json(); }
      catch { throw new TextRequestError("请求体必须是合法 JSON。"); }
      // JSON 解析成功不代表结构正确;先验证,再交给路由和翻译层。
      validateTextRequest(raw); // 正常返回才说明结构满足当前文本入口;校验失败就抛错,后面的路由和上游请求都跳过。
      const requestedModel = String(raw.model ?? ""); // 保留客户端模型名用于路由和响应;校验已保证其为非空字符串,原有兜底写法仍保留。
      trace("[1] 收到聊天请求", { model: requestedModel, stream: raw.stream === true }); // 这条日志在校验成功后打印,只记录模型和返回方式,不输出消息正文。
      // 打印客户要的模型名,便于观察。 requestedModel = openai/gpt-4o-mini

      // [2] 下面这句话是在问：“openai/gpt-4o-mini 应该找哪个供应商？发给供应商的模型名是什么？”
      const { provider, upstreamModel } = router.resolve(requestedModel); // 查通讯录,得到"哪家供应商 + 真实模型名"。
      trace("[2] 路由完成", { provider: provider.id, upstreamModel }); // 查看 qwen 等别名最终指向哪个供应商和真实模型,不打印供应商对象中的密钥。
      // 打印查通讯录的结果,看路由解析对不对。[路由] provider = OpenAIProvider upstreamModel = gpt-4o-mini


      // [3] 把客户的话翻译成内部统一格式(统一请求对象)
      const chatReq = fromOpenAI(raw, upstreamModel); // 校验和路由通过后,把外部字段整理成统一请求,供 Provider 消费。
      trace("[3] 请求转换完成", { messageCount: chatReq.messages.length }); // 只打印消息条数,可确认转换执行到了这里,同时不输出对话内容。
      /**
      [转换] chatReq = {
        "model": "gpt-4o-mini",
        "stream": true,
        "messages": [
          {
            "role": "user",
            "content": "你好"
          }
        ]
      } 
      */
      // console.log("[转换] chatReq =", JSON.stringify(chatReq, null, 2)); // 完整打印转换后的请求,方便观察字段。

      // [4] 关键:chat() 返回的是"惰性"异步生成器,此刻还没发任何网络请求。
      //     真正的上游调用发生在下面 [5] 开始 for-await 消费 events 的时候。
      const events = provider.chat(chatReq); // 先"预约"一次对话,得到一叠"待读的回话记录",但还没真正开始读。
      trace("[4] 已取得事件生成器,消费时开始请求上游"); // 这个检查点不表示上游调用已完成;异步生成器被 for await 消费后才开始执行请求代码。

      if (chatReq.stream) { // 如果客户要求的是"边生成边返回"(流式)。
        trace("[5] 开始消费事件并输出 SSE"); // 即将由流式出口驱动生成器;打印此行也不表示模型已经生成了第一个事件。
        // 先驱动上游取得首个事件,让连接/认证失败可以返回真实的 HTTP 错误状态。
        const first = await events.next();
        if (first.done) throw UpstreamError.protocol(provider.id);
        async function* readyEvents() {
          try { yield first.value; yield* events; }
          finally { await events.return(undefined); }
        }
        // [5] 流式:一边消费 events,一边把 OpenAI SSE 写回客户端
        return new Response(toOpenAIStream(readyEvents(), requestedModel), {
          headers: { // 告诉客户端按事件流读取,让响应正文能在后续陆续发送。
            "content-type": "text/event-stream", // 告诉客户:这是一条事件流(SSE)。
            "cache-control": "no-cache", // 禁止缓存,每条内容都是新的。
            connection: "keep-alive", // 连接保持打开,方便持续传话。
          }, // 结束流式响应头配置。
        }); // 返回的是带可读正文流的 Response;本次 fetch 回调返回后,流仍可继续产出数据。
      } // stream 为 false 时跳过上面的 return,继续进入完整 JSON 出口。
      // [5] 非流式:把所有 events 聚合成一个 OpenAI JSON 响应
      /**toOpenAIJSON =>return {
          model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: text
            },
            finish_reason: finishReason
          }],
          usage
        }; */
      trace("[5] 开始消费事件并聚合 JSON"); // JSON 出口同样通过 for await 触发上游请求,然后等待事件全部消费完毕。
      return Response.json(await toOpenAIJSON(events, requestedModel)); // 等供应商全部说完,合成一整句再一次性返回。
    } // 聊天路径正常执行后会在对应出口 return;请求处理函数不会再走到下面的 404。

    return new Response("not found", { status: 404 }); // 其他路径都不认识,返回 404"没有这个服务"。
  }, // 结束每次 HTTP 请求使用的 fetch 回调;异常可交给下面的 Bun 错误回调。
  // 这里只处理返回 HTTP 响应之前的异常;流开始后的错误仍由流处理。
  error(error) { // Bun 在请求处理抛错或拒绝且尚可返回替代响应时调用这里;已交出的响应流使用自己的错误处理。
    // 调试时显示失败原因,先遮盖配置中的密钥;客户端仍只收到简短错误。
    if (process.env.GATEWAY_DEBUG === "1") { // 调试模式才输出服务端失败原因,避免普通运行时打印大量内部信息。
      let message = error.message; // 取异常信息字符串准备脱敏,不直接打印完整异常对象。
      for (const p of config.providers) message = message.replaceAll(p.apiKey, "[REDACTED]"); // 逐个替换已配置密钥的字面值,防止它们原样出现在这条错误日志里。
      console.error("[错误]", message); // 输出处理后的原因到 stderr,联调脚本会单独收集这一路日志。
    } // 错误日志分支结束,随后无论是否调试都要构造客户端响应。
    if (error instanceof UpstreamError) return Response.json(error.toJSON(), { status: error.status });
    const badRequest = error instanceof TextRequestError;
    return Response.json({ error: { // 保持统一的 error 外壳,让客户端能通过 HTTP 状态和错误类型识别失败。
      message: badRequest ? error.message : "路由或上游调用失败,请检查供应商配置。", // 入口类错误反馈具体提示;其他错误用概括信息,不把上游原始错误正文直接发给客户端。
      type: badRequest ? "invalid_request_error" : "gateway_error", // 客户端请求问题与网关调用问题使用不同的分类字符串。
    } }, { status: badRequest ? 400 : 502 }); // 当前策略用 400 表示请求错误、502 表示其他调用错误;return 结束错误回调并交回替代响应。
  }, // 结束网关错误回调。
}); // 完成 HTTP 服务创建,继续打印实际监听地址;这里本身不会启动聊天请求。

console.log(`gateway listening on http://127.0.0.1:${server.port}`); // 启动成功后打印一行日志,告诉你在哪能访问。


