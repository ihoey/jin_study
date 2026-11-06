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
import { loadConfig } from "./config";
// 引入"供应商"这个类型(只用于标注类型,运行时不存在)。
import type { Provider } from "./providers/base";
// 引入具体的一家供应商实现:OpenAI。
import { OpenAIProvider } from "./providers/openai";
// 引入路由类(负责把模型名翻译成"哪家供应商 + 真实模型名")。
import { Router } from "./router";
// 引入翻译函数:把 OpenAI 格式的请求转成内部统一格式。
import { fromOpenAI } from "./translate/fromOpenai";
// 引入翻译函数:把内部事件流转回 OpenAI 的 JSON / 流式响应。
import { toOpenAIJSON, toOpenAIStream } from "./translate/toOpenai";

// 启动时只做一次:读配置 + 组装 Provider 列表 + 建路由。
const config = loadConfig(); // 程序一启动就读取一次配置(端口、密钥、模型映射等),像"上班先看排班表"。
console.log("[启动] 配置:", { port: config.port, providers: config.providers.map((p) => p.id), defaultProvider: config.defaultProvider }); // 打印启动配置,方便确认端口和供应商是否读对。

const providers = new Map<string, Provider>(); // 建一个空的供应商名册,键是供应商 id,值是对应的供应商对象。
for (const p of config.providers) { // 遍历配置里声明的每一个供应商。
  if (p.id === "openai") { // 目前只认识 id 为 "openai" 的这一家供应商。
    providers.set(p.id, new OpenAIProvider(p.baseUrl, p.apiKey)); // 用配置里的地址和密钥创建 OpenAI 供应商,并登记进名册。
  }
}

const router = new Router(providers, config.modelMap, config.defaultProvider); // 用"名册 + 模型别名表 + 默认供应商"建好通讯录。

const server = Bun.serve({ // 启动一个 HTTP 服务器,开始"接电话"。
  port: config.port, // 监听配置里指定的端口。
  async fetch(req) { // 每个进来的 HTTP 请求都会走这个函数(req 是请求对象)。
    const url = new URL(req.url); // 把请求的网址解析成结构,方便读取路径 pathname。

    if (req.method === "GET" && url.pathname === "/v1/models") { // 如果客户用 GET 获取模型列表。
      const models = await router.listModels(); // 汇总所有供应商提供的模型清单。
      return Response.json({ // 把清单包装成 JSON 返回给客户。
        object: "list", // OpenAI 规范里这个字段固定为 "list"。
        data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.provider })), // 把每个模型转成客户认识的格式。
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") { // 处理聊天请求
      const raw = (await req.json()) as Record<string, any>; // 读请求体里的 JSON,当成一个任意字段的对象。
      const requestedModel = String(raw.model ?? ""); // 取出客户要的模型名,没写就默认空字符串。
      // 打印客户要的模型名,便于观察。 requestedModel = openai/gpt-4o-mini

      // [2] 下面这句话是在问：“openai/gpt-4o-mini 应该找哪个供应商？发给供应商的模型名是什么？”
      const { provider, upstreamModel } = router.resolve(requestedModel); // 查通讯录,得到"哪家供应商 + 真实模型名"。
      // 打印查通讯录的结果,看路由解析对不对。[路由] provider = OpenAIProvider upstreamModel = gpt-4o-mini


      // [3] 把客户的话翻译成内部统一格式(统一请求对象)
      const chatReq = fromOpenAI(raw, upstreamModel); 
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

      if (chatReq.stream) { // 如果客户要求的是"边生成边返回"(流式)。
        // [5] 流式:一边消费 events,一边把 OpenAI SSE 写回客户端
        return new Response(toOpenAIStream(events, requestedModel), { // 把供应商的话一句句翻译、一句句往外传。
          headers: {
            "content-type": "text/event-stream", // 告诉客户:这是一条事件流(SSE)。
            "cache-control": "no-cache", // 禁止缓存,每条内容都是新的。
            connection: "keep-alive", // 连接保持打开,方便持续传话。
          },
        });
      }
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
      return Response.json(await toOpenAIJSON(events, requestedModel)); // 等供应商全部说完,合成一整句再一次性返回。
    }

    return new Response("not found", { status: 404 }); // 其他路径都不认识,返回 404"没有这个服务"。
  },
});

console.log(`gateway listening on http://127.0.0.1:${server.port}`); // 启动成功后打印一行日志,告诉你在哪能访问。


