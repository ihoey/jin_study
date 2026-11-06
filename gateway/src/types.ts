// 管线位置:第 0 步 · 坐标系(最先看)
// 职责:定义统一中间格式(canonical)。所有 Provider 的输入(ChatRequest)
// 和输出(StreamEvent)都收敛到这一套类型;前端(OpenAI/Anthropic/Gemini)
// 各写一次"进"和"出"的翻译,Provider 只认 canonical。

// 下面都是类型约定,在运行前供 TypeScript 检查代码使用;外部 JSON 仍要由 validateTextRequest 在运行时校验。
// 定义图片、工具等类型是为了后续扩展,不等于当前 HTTP 入口已经允许这些内容。
export type Role = "system" | "user" | "assistant"; // 统一消息角色只允许这三个字符串,避免各处随意拼写。

export interface TextPart { // 一条消息中的文本内容块。
  type: "text"; // 固定标签,让处理代码能根据 type 判断这是文本块。
  text: string; // 这个内容块实际包含的文本。
} // 结束文本块定义。

export interface ImagePart { // 为图片内容预留的内部结构,当前纯文本入口尚不接收它。
  type: "image"; // 图片块的类型标签。
  url?: string; // 可选的远程图片地址。
  data?: string; // 可选的图片数据字符串,具体编码由后续适配逻辑约定。
  mediaType?: string; // 可选的媒体类型,例如 image/png。
} // 结束图片块定义;这些可选字段本身不会执行图片加载。

export interface ThinkingPart { // 为对话中保留的思考内容预留结构。
  type: "thinking"; // 使用独立标签,使思考内容与最终回答文本可以分别处理。
  thinking: string; // 供应商明确提供的思考文本,完整转换链路后续实现。
} // 结束思考块定义。

export interface ToolCallPart { // 描述模型发起的一次工具调用,不是在这里执行工具。
  type: "tool_call"; // 工具调用块的标签。
  id: string; // 调用标识,之后用来匹配工具结果。
  name: string; // 模型希望调用的工具名。
  arguments: string; // 工具参数的字符串形式,流式接收时可能由多个片段拼成。
} // 结束工具调用块定义。

export interface ToolResultPart { // 描述工具执行后返回给模型的结果。
  type: "tool_result"; // 工具结果块的标签,与发起调用的 tool_call 区分。
  toolCallId: string; // 指向原工具调用的 id,防止多次工具调用的结果混淆。
  content: string; // 工具返回的结果文本。
} // 结束工具结果块定义。

export type ContentPart = // 联合类型:一个内容块可以属于下面任意一种,根据各自 type 字段区分。
  | TextPart // 普通文本。
  | ImagePart // 图片。
  | ThinkingPart // 思考内容。
  | ToolCallPart // 工具调用。
  | ToolResultPart; // 工具执行结果;分号结束整个联合类型定义。

export interface Message { // 网关内部的一条消息,由角色和内容组成。
  role: Role; // 使用上面约定的统一角色类型。
  content: string | ContentPart[]; // 简单消息可以直接用字符串,复杂消息可用多个内容块;当前入口只接收字符串。
} // 结束统一消息定义。

export interface FunctionTool { // 为函数工具描述预留类型,告诉模型有哪些工具可调用。
  type: "function"; // 固定声明为函数类型工具。
  function: { // 函数工具的具体描述,这是数据结构,不是 JavaScript 函数体。
    name: string; // 工具名称,用于与工具调用中的 name 对应。
    description: string; // 工具用途说明,帮助模型判断何时使用。
    parameters: Record<string, unknown>; // 参数描述对象,用于承载 JSON Schema 等信息。
  }; // 结束函数描述对象的类型。
} // 结束函数工具定义;当前请求校验仍会拒绝 tools 字段。

export interface ChatRequest { // Provider 接收的统一内部请求,外部协议字段在转换函数中映射到这里。
  // model 是"发往上游"的模型名(路由解析后写入),客户端请求的原始名由 main.ts 单独保存。
  model: string; // 上游实际模型名,例如 qwen 别名解析后的具体名称。
  messages: Message[]; // 转换好的统一消息数组,由 Provider 再构造成上游请求。
  tools?: FunctionTool[]; // 可选工具定义,预留给后续完整的工具适配。
  toolChoice?: string | Record<string, unknown>; // 可选工具选择策略,兼容字符串和对象形式。
  temperature?: number; // 可选温度;入口和出口同名,无需改名。
  maxTokens?: number; // 内部使用驼峰命名,转换上游请求时再映射为 max_tokens。
  // 内部思考开关:适配器分别转换成百炼 enable_thinking 或 DeepSeek thinking。
  enableThinking?: boolean; // 三种含义:undefined 不发送这个扩展参数,true 开启,false 关闭;不能用真假判断过滤掉 false。
  stream: boolean; // 决定本次流式还是非流式调用及返回路径;即使关闭思考,也仍可选择流式输出文本。
} // 结束统一请求类型定义。

export interface Usage { // 统一 token 用量字段,避免出口依赖每家上游自己的字段名。
  inputTokens?: number; // 输入 token 用量,上游未提供时可省略。
  outputTokens?: number; // 输出 token 用量,上游未提供时可省略。
} // 结束用量定义。

export type FinishReason = "stop" | "length" | "tool_calls" | "error"; // 内部约定的结束原因:正常结束、长度限制、工具调用或错误。

export type StreamEvent = // Provider 逐个 yield 的内部事件;客户端是否按 SSE 接收,由出口另行决定。
  | { type: "text_delta"; text: string } // 新增一段最终回答文本,出口可以累积或立刻发送。
  | { type: "thinking_delta"; thinking: string } // 新增思考文本,预留给后续 reasoning 转换。
  | { type: "tool_call_start"; id: string; name: string } // 工具调用开始,给出 id 和名称。
  | { type: "tool_call_delta"; id: string; arguments: string } // 某个工具调用新增一段参数字符串。
  | { type: "tool_call_end"; id: string } // 对应 id 的工具调用参数输出结束。
  | { type: "usage"; usage: Usage } // 上游报告用量,与文本增量分开处理。
  | { type: "done"; finishReason: FinishReason }; // 模型回复结束事件;这只是一个事件值,生成器执行完毕才会结束 for await。

export interface ModelInfo { // 模型目录中使用的统一条目,供 /v1/models 输出。
  id: string; // 客户端可使用的完整模型标识,例如 openai/某个模型。
  provider: string; // 模型所属供应商的内部注册 id。
  upstreamId: string; // 上游原始模型名,用于与对外完整标识区分。
} // 结束模型目录条目定义。
