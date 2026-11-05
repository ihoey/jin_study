import type { ChatRequest, Message } from "../types";

// 管线位置:第 3 步 · 请求进
// 职责: 原始 OpenAI Chat Completions 请求体 -> 统一中间格式 ChatRequest。
// 骨架阶段只处理文本;图片 / 工具调用的翻译留到第 4、7 步。
export function fromOpenAI(raw: Record<string, any>, upstreamModel: string): ChatRequest {
  return {
    model: upstreamModel,
    stream: raw.stream === true,
    messages: (raw.messages ?? []).map((m: any): Message => {
      if (typeof m.content === "string") {
        return { role: m.role, content: m.content };
      }
      // 多模态 content 数组的翻译留到第 4 步。
      return { role: m.role, content: [] };
    }),
    ...(raw.tools ? { tools: raw.tools } : {}),
    ...(raw.tool_choice ? { toolChoice: raw.tool_choice } : {}),
    ...(raw.temperature != null ? { temperature: raw.temperature } : {}),
    ...(raw.max_tokens != null ? { maxTokens: raw.max_tokens } : {}),
  };
}
