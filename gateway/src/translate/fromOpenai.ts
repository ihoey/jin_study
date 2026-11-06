import type { ChatRequest, Message } from "../types"; // 引入内部请求和消息类型;type 表示这些导入只参与类型检查。

export class TextRequestError extends Error {} // 给入口校验错误一个独立类型,main.ts 就能通过 instanceof 把它识别为客户端请求问题。

interface TextRequest extends Record<string, unknown> { // 描述通过校验后的请求;允许附带其他未知字段,但本接口明确列出的字段才有具体类型。
  model: string; // 必须提供模型名,路由层稍后才能查找供应商和真实模型。
  messages: { role: "system" | "user" | "assistant"; content: string }[]; // 当前入口只接收这三种角色的纯文本消息,不接收内容块数组。
  stream?: boolean; // 可选的响应方式开关,true 为流式;问号表示允许不传。
  temperature?: number; // 可选的采样温度,具体允许范围由下面的运行时校验限制。
  max_tokens?: number; // 可选的生成 token 上限;入口保留客户端协议的下划线字段名。
  enable_thinking?: boolean; // 可选的百炼思考开关,false 有明确意义,不能被当成“没传”。
} // 结束已校验请求的类型定义;接口本身不会检查网络输入。

// 第二步的支持范围是纯文本。明确拒绝尚未实现的内容,避免悄悄丢掉图片或工具结果。
// 这个函数只验证、不转换、不访问上游:任一检查失败就 throw,后面的路由和模型调用都不会执行。
// asserts 只告诉 TypeScript“正常返回后可以相信这些字段类型”;真正的保证来自函数里的逐项检查。
export function validateTextRequest(raw: unknown): asserts raw is TextRequest { // 接收尚不可信的网络输入;通过后不返回新对象,而是收窄调用处 raw 的类型。
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { // 先排除字符串、数字、null 和数组,后面才可以安全地按对象检查字段。
    throw new TextRequestError("请求体必须是 JSON 对象。"); // 抛出入口错误,立即退出函数并交给 main.ts 的错误回调处理。
  } // 结束最外层结构校验,通过后继续检查字段。
  const body = raw as Record<string, unknown>; // 将已确认是对象的输入视为字典;每个字段仍是 unknown,需要继续逐项判断。
  if (typeof body.model !== "string" || !body.model.trim()) { // 模型必须为字符串且不能全是空白;trim 只用于判断,不会修改原字符串。
    throw new TextRequestError("model 必须是非空字符串。"); // 模型名无效时提前失败,避免稍后在路由层得到难懂的错误。
  } // 模型检查通过,继续检查消息集合。
  if (!Array.isArray(body.messages) || body.messages.length === 0) { // 要求消息是非空数组;空数组无法提供本次需要处理的对话内容。
    throw new TextRequestError("messages 必须是非空数组。"); // 消息集合无效时结束校验,不会进入下面的遍历。
  } // 通过后才能逐条读取消息。
  for (const message of body.messages) { // 每条消息都要验证;for 循环只在所有消息都通过后才正常结束。
    if (typeof message !== "object" || message === null || // || 从左向右短路判断,先排除不能读取消息字段的值。
        !["system", "user", "assistant"].includes(message.role) || // 只接收当前文本课程支持的角色;例如 tool 角色会被拒绝。
        typeof message.content !== "string" || "tool_calls" in message) { // 要求正文为字符串,并拒绝带工具调用字段的消息,避免转换时悄悄丢信息。
      throw new TextRequestError("当前仅支持 system/user/assistant 角色的纯文本消息。"); // 任意一条消息不支持就拒绝整个请求,而不是丢掉它后继续调用上游。
    } // 当前消息校验通过后,循环自动进入下一条。
  } // 所有消息都合法,继续检查请求级的可选参数。
  if (body.tools !== undefined || body.tool_choice !== undefined) { // 只要显式提供工具配置就拒绝,包括空数组或 null;工具完整转换尚未实现。
    throw new TextRequestError("工具调用将在后续课程实现。"); // 明确反馈功能边界,避免客户端误以为工具已被上游正确处理。
  } // 工具字段检查结束。
  if (body.stream !== undefined && typeof body.stream !== "boolean") { // 没传 stream 可以,传了就必须是布尔值;字符串 "true" 不会被自动转换。
    throw new TextRequestError("stream 必须是布尔值。"); // 拒绝类型不匹配的响应方式开关。
  } // stream 合法时继续检查思考开关。
  if (body.enable_thinking !== undefined && typeof body.enable_thinking !== "boolean") { // 区分未传、true、false 三种情况,同时拒绝字符串和 null 等其他值。
    throw new TextRequestError("enable_thinking 必须是布尔值。"); // 避免把错误类型的扩展参数发给上游。
  } // 思考开关校验结束。
  if (body.temperature !== undefined && (typeof body.temperature !== "number" || // 可不传温度;显式提供时必须先确定为数值。
      !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) { // 再要求它是有限数且落在当前入口约定的 0～2 范围内,这是本地校验策略。
    throw new TextRequestError("temperature 必须是 0 到 2 之间的数值。"); // 本地先报参数错误,避免为无效请求调用上游。
  } // 温度检查通过;数值 0 属于有效输入。
  if (body.max_tokens !== undefined && (typeof body.max_tokens !== "number" || // token 上限可以省略,显式提供时必须是数值。
      !Number.isInteger(body.max_tokens) || body.max_tokens <= 0)) { // 再要求为正整数,排除小数、0、负数和非有限值。
    throw new TextRequestError("max_tokens 必须是正整数。"); // 无效的生成上限在入口被拒绝。
  } // 结束最后一项参数校验。
} // 正常走到这里表示校验通过;没有返回值,调用者继续下一行,raw 的类型已被收窄。

// 管线位置:第 3 步 · 请求进
// 职责: 原始 OpenAI Chat Completions 请求体 -> 统一中间格式 ChatRequest。
// 骨架阶段只处理文本;图片 / 工具调用的翻译留到第 4、7 步。
export function fromOpenAI(raw: TextRequest, upstreamModel: string): ChatRequest { // 接收已验证的文本请求,只负责字段转换;用路由确定的真实模型名构造内部请求。
  return { // 创建并返回内部 ChatRequest 对象,供各种 Provider 使用。
    model: upstreamModel, // 使用路由层解析后的真实上游模型名,而非客户端可能传入的别名或供应商前缀。
    stream: raw.stream === true, // 只有原始值严格等于布尔值 true 才启用流式;缺省、字符串 true 等都得到 false。
    ...(raw.enable_thinking !== undefined ? { enableThinking: raw.enable_thinking } : {}), // 只在客户端传入时添加字段;用 !== undefined 才能保留表示关闭思考的 false。
    // 入口已经验证为纯文本;这里只做转换,保留每一条消息的角色和正文。
    messages: raw.messages.map((m): Message => ({ role: m.role, content: m.content })), // 校验器已保证数组和正文类型,这里逐条创建内部消息,无需再次猜测内容格式。
    ...(raw.temperature != null ? { temperature: raw.temperature } : {}), // 温度既非 null 也非 undefined 时才加入对象,因此数值 0 也会保留。
    ...(raw.max_tokens != null ? { maxTokens: raw.max_tokens } : {}), // 有 token 上限时将 max_tokens 改名为 maxTokens,同样保留数值 0。
  }; // 结束统一请求对象的创建并返回。
} // 结束 OpenAI 请求转内部请求的函数。
