// 管线位置:第 4 步 · 上游调用(参考实现)
// 职责:把 ChatRequest 发给 OpenAI,把它的响应(流式 SSE 或 JSON)
//       解析成统一的 StreamEvent 流。
import type { ChatRequest, Message, ModelInfo, StreamEvent, TextPart, Usage } from "../types"; // 引入网关内部的请求、消息、模型、事件、文本块和用量类型;type 表示只用于类型检查。
import type { Provider } from "./base"; // 引入供应商接口,约定每家供应商都要提供哪些能力。
import { readSSE } from "../translate/sse"; // 引入 SSE 解析函数,把 HTTP 响应的字节流拆成一条条事件的数据字符串。
import { UpstreamError } from "./errors";

interface OpenAIChunk { // 描述 OpenAI 单个流式响应片段的结构,这里只列出本实现会读取的字段。
  choices?: Array<{ // choices 是可选的候选回复数组;问号表示这个字段可能不存在。
    delta?: { content?: string }; // delta 表示本次新增的内容,content 是其中新增的一小段文本。
    finish_reason?: string | null; // 结束原因可能是字符串、null 或不存在;生成过程中通常还没有结束原因。
  }>; // 结束 choices 数组中单个候选回复的类型定义。
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null; // 可选的 token 用量:输入 token 数和输出 token 数,整个字段也可能为 null。
} // 结束流式片段类型定义。

interface OpenAICompletion { // 描述 OpenAI 非流式响应的结构:一次返回完整结果。
  choices?: Array<{ // 可选的候选回复数组,当前实现只读取第一条候选回复。
    message?: { content?: string | null }; // message 保存完整回复,其中的文本 content 可能为 null 或不存在。
    finish_reason?: string | null; // 记录这条完整回复为什么结束,例如正常结束或达到长度限制。
  }>; // 结束非流式候选回复的类型定义。
  usage?: { prompt_tokens?: number; completion_tokens?: number }; // 可选的输入和输出 token 用量,之后会转换成内部命名。
} // 结束非流式响应类型定义。

export class OpenAIProvider implements Provider { // 导出 OpenAI 供应商类;implements 要求这个类满足 Provider 接口。

  constructor( // 创建供应商对象时接收上游 API 地址和密钥;这里只保存配置,不会发送请求。
    private readonly baseUrl: string, // 自动创建并保存私有只读属性 baseUrl,例如 https://api.openai.com/v1。
    private readonly apiKey: string, // 自动创建并保存私有只读属性 apiKey,发送请求时用它进行身份认证。
    readonly id: string = "openai", // 同一类协议的不同实例,分别保留自己的供应商标识。
    private readonly proxyUrl?: string, // 从配置显式传入,无需依赖终端自动使用 macOS 系统代理。
  ) {} // 构造函数没有额外逻辑;参数属性已经完成配置保存。

  // [4a] 网络入口集中在这里:显式代理、连接期限、认证和 HTTP 错误统一处理。
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.apiKey}`);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init, headers, proxy: this.proxyUrl, signal: AbortSignal.timeout(45_000),
      });
    } catch (error) { throw UpstreamError.connection(this.id, error); }
    if (!response.ok) {
      await response.body?.cancel();
      throw UpstreamError.http(this.id, response.status);
    }
    return response;
  }

  private async readJSON(response: Response): Promise<unknown> {
    try { return await response.json(); }
    catch (error) {
      if (error instanceof SyntaxError) throw UpstreamError.protocol(this.id);
      throw UpstreamError.connection(this.id, error);
    }
  }

  async listModels(): Promise<ModelInfo[]> { // 异步获取模型列表;返回的 Promise 最终会得到内部 ModelInfo 数组。
    const res = await this.request("/models");
    const data = (await this.readJSON(res)) as { data?: Array<{ id: string }> } | null;
    if (!data || !Array.isArray(data.data) || data.data.some((m) => !m || typeof m.id !== "string")) {
      throw UpstreamError.protocol(this.id);
    }
    return data.data.map((m) => ({ id: `${this.id}/${m.id}`, provider: this.id, upstreamId: m.id })); // 转成内部模型信息:对外名称加 openai/ 前缀,同时保留供应商和上游原名。
  } // 结束模型列表方法。

  async *chat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> { // 异步生成器:逐个产出 StreamEvent,没有最终返回值,也不接收 next() 传入值;被消费时才开始执行。
    const body = toOpenAIBody(req, this.id); // 基础协议相同,厂商扩展字段按当前供应商转换。
    // canonical -> OpenAI 请求体,然后发上游。
    const res = await this.request("/chat/completions", {
      method: "POST", // 使用 POST 提交聊天请求。
      headers: { // 开始设置请求头,声明正文格式和身份凭据。
        "content-type": "application/json", // 告诉上游请求正文是 JSON。
      }, // 结束请求头配置。
      body: JSON.stringify(body), // 把 JavaScript 请求对象序列化成 JSON 字符串,作为 HTTP 请求正文。
    }); // 结束 fetch 调用,响应正文此时可能还没有全部接收完。

    if (req.stream) { // 根据内部请求的 stream 字段,选择按流式方式读取响应。
      if (!res.body) throw UpstreamError.protocol(this.id);
      try { yield* this.stream(res.body); }
      catch (error) {
        if (error instanceof UpstreamError) throw error;
        throw UpstreamError.connection(this.id, error);
      }
    } else { // stream 为 false 时,按一次性 JSON 响应处理。
      yield* this.nonStream(await this.readJSON(res));
    } // 结束流式与非流式的分支。
  } // 结束聊天入口方法。

  private async *stream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent, void, void> { // 私有异步生成器:把由 Uint8Array 字节块组成的响应流转换成内部事件流。
    // 逐块解析上游 SSE,把 OpenAI 的 delta 翻译成统一 StreamEvent。
    for await (const data of readSSE(body)) { // 异步读取 SSE 解析结果;每次 data 是一条事件的数据内容,不一定对应一个网络字节块。
      if (data === "[DONE]") break; // 遇到 OpenAI 的流结束标记就退出循环,这条标记不是 JSON。
      let chunk: OpenAIChunk;
      try { chunk = JSON.parse(data) as OpenAIChunk; }
      catch { throw UpstreamError.protocol(this.id); }
      if (!chunk || typeof chunk !== "object") throw UpstreamError.protocol(this.id);
      const choice = chunk.choices?.[0]; // 安全读取第一条候选回复;choices 不存在或数组为空时得到 undefined。
      if (!choice) continue; // 没有候选回复就跳过整个片段,因此只有 usage 而没有 choice 的片段也会在这里跳过。

      const text = choice.delta?.content; // 取出本次新增文本;delta 不存在时得到 undefined。
      if (text) yield { type: "text_delta", text }; // 有非空文本时产出文本增量事件,交给下游继续处理。
      if (chunk.usage) yield { type: "usage", usage: toUsage(chunk.usage) }; // 当前片段携带用量时,先转换字段名,再产出用量事件。
      if (choice.finish_reason) { // 当前候选回复出现非空结束原因,说明这条回复已经结束。
        yield { type: "done", finishReason: mapFinishReason(choice.finish_reason) }; // 把上游结束原因映射成内部约定,产出结束事件。
      } // 结束对结束原因的判断;循环仍会继续读取后续事件,直到流关闭或遇到 [DONE]。
    } // 结束 SSE 事件读取循环。
  } // 结束流式响应转换方法。

  private async *nonStream(json: unknown): AsyncGenerator<StreamEvent, void, void> { // 私有异步生成器:把完整 JSON 响应转成与流式响应相同的内部事件类型。
    const data = json as OpenAICompletion | null;
    const choice = data?.choices?.[0];
    if (!choice || !data || typeof choice.message?.content !== "string") throw UpstreamError.protocol(this.id);

    // 一次 JSON 响应也拆成统一事件流,让下游只有一套处理逻辑。
    const text = choice.message?.content; // 读取这条完整回复的文本,message 不存在时得到 undefined。
    if (text) yield { type: "text_delta", text }; // 有非空文本就作为一个文本增量事件产出,这里一个事件包含整段回复。
    if (data.usage) yield { type: "usage", usage: toUsage(data.usage) }; // 响应包含 token 用量时,转换为内部格式并产出用量事件。
    yield { type: "done", finishReason: mapFinishReason(choice.finish_reason) }; // 最后产出结束事件,让下游知道本次回复处理完毕。
  } // 结束非流式响应转换方法。
} // 结束 OpenAIProvider 类;下面是供这个类使用的转换辅助函数。

function toUsage(u: { prompt_tokens?: number; completion_tokens?: number }): Usage { // 将 OpenAI 的用量字段转换成内部 Usage 类型,输入字段都允许缺省。
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }; // prompt_tokens 对应输入用量,completion_tokens 对应输出用量;缺省值保留为 undefined。
} // 结束用量转换函数。

function mapFinishReason(r: string | null | undefined): "stop" | "length" | "tool_calls" { // 将可能缺省的上游结束原因收敛成内部支持的三种字符串之一。
  if (r === "tool_calls") return "tool_calls"; // 上游因需要调用工具而结束时,保留工具调用原因。
  if (r === "length") return "length"; // 上游因达到生成长度限制而结束时,保留长度限制原因。
  return "stop"; // 其余原因以及 null、undefined 都统一归为 stop,这是当前实现的默认映射。
} // 结束结束原因映射函数。

export function toOpenAIBody(req: ChatRequest, providerId = "openai"): Record<string, unknown> {
  const body: Record<string, unknown> = { // 创建请求对象,先填入模型、消息和是否流式这三个基础字段。
    model: req.model, // 使用路由层确定的上游模型名,例如去掉供应商前缀后的 gpt-4o-mini。
    messages: req.messages.map(toOpenAIMessage), // 逐条转换内部消息,生成 OpenAI 接口所需的 messages 数组。
    stream: req.stream, // 把流式开关传给上游,决定上游返回 SSE 流还是完整 JSON。
  }; // 结束基础请求对象的创建,下面按条件追加可选字段。
  if (req.tools?.length) body.tools = req.tools; // tools 存在且非空时,把工具定义原样放进请求。
  if (req.toolChoice) body.tool_choice = req.toolChoice; // 配置了工具选择策略时,把内部驼峰名称转换成 OpenAI 的下划线名称。
  if (req.temperature != null) body.temperature = req.temperature; // 温度既不是 null 也不是 undefined 时才传递;0 也会被保留。
  if (req.maxTokens != null) body.max_tokens = req.maxTokens; // 同样保留已提供的生成 token 上限,并把 maxTokens 改名为 max_tokens。
  // 同一个内部开关对应不同上游字段,避免把百炼字段原样发给 DeepSeek。
  if (req.enableThinking !== undefined) {
    if (providerId === "deepseek") body.thinking = { type: req.enableThinking ? "enabled" : "disabled" };
    else body.enable_thinking = req.enableThinking;
  }
  return body; // 返回准备好的 JavaScript 对象,交给 chat() 序列化后发送。
} // 结束请求体转换函数。

function toOpenAIMessage(m: Message): Record<string, unknown> { // 把一条内部消息转换为当前实现支持的 OpenAI 文本消息对象。
  if (typeof m.content === "string") return { role: m.role, content: m.content }; // 内容已经是字符串时直接返回角色和文本,不再处理内容块。
  const text = m.content // 内容是数组时,从内容块数组开始依次筛选、提取、拼接文本。
    .filter((p): p is TextPart => p.type === "text") // 只保留文本块;类型谓词 p is TextPart 让 TypeScript 知道后续可以读取 text 字段。
    .map((p) => p.text) // 逐个取出文本块中的字符串,形成字符串数组。
    .join(""); // 用空字符串连接全部文本片段,不会额外插入空格或换行。
  return { role: m.role, content: text }; // 返回原有角色和拼接后的纯文本;非文本内容块已在 filter 中被过滤。
} // 结束单条消息转换函数。
