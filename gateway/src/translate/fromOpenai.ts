import type { ChatRequest, Message } from "../types"; // 引入内部请求和消息类型;type 表示这些导入只参与类型检查。

// 管线位置:第 3 步 · 请求进
// 职责: 原始 OpenAI Chat Completions 请求体 -> 统一中间格式 ChatRequest。
// 骨架阶段只处理文本;图片 / 工具调用的翻译留到第 4、7 步。
export function fromOpenAI(raw: Record<string, any>, upstreamModel: string): ChatRequest { // 将原始请求和路由确定的上游模型名转换为统一请求;any 表示原始字段尚未经过严格类型约束。
  return { // 创建并返回内部 ChatRequest 对象,供各种 Provider 使用。
    model: upstreamModel, // 使用路由层解析后的真实上游模型名,而非客户端可能传入的别名或供应商前缀。
    stream: raw.stream === true, // 只有原始值严格等于布尔值 true 才启用流式;缺省、字符串 true 等都得到 false。
    messages: (raw.messages ?? []).map((m: any): Message => { // 消息缺省时使用空数组,否则逐条转换;这里假定传入的 messages 是数组。
      if (typeof m.content === "string") { // 判断这条消息的内容是否为普通文本字符串。
        return { role: m.role, content: m.content }; // 文本消息保留角色和内容,组成内部 Message 对象。
      } // 结束普通文本消息分支,非字符串内容继续走下面的处理。
      // 多模态 content 数组的翻译留到第 4 步。
      return { role: m.role, content: [] }; // 当前骨架尚未转换非字符串内容,只保留角色,把内容替换成空数组。
    }), // 结束单条消息的转换函数,map 的结果成为新的 messages 数组。
    ...(raw.tools ? { tools: raw.tools } : {}), // 对象展开:tools 为真值时加入 tools 字段,否则展开空对象、不添加字段。
    ...(raw.tool_choice ? { toolChoice: raw.tool_choice } : {}), // 存在有效工具策略时原样保留它的值,并把字段名从 tool_choice 改为内部的 toolChoice。
    ...(raw.temperature != null ? { temperature: raw.temperature } : {}), // 温度既非 null 也非 undefined 时才加入对象,因此数值 0 也会保留。
    ...(raw.max_tokens != null ? { maxTokens: raw.max_tokens } : {}), // 有 token 上限时将 max_tokens 改名为 maxTokens,同样保留数值 0。
  }; // 结束统一请求对象的创建并返回。
} // 结束 OpenAI 请求转内部请求的函数。
