// 管线位置:第 0 步 · 坐标系(最先看)
// 职责:定义统一中间格式(canonical)。所有 Provider 的输入(ChatRequest)
// 和输出(StreamEvent)都收敛到这一套类型;前端(OpenAI/Anthropic/Gemini)
// 各写一次"进"和"出"的翻译,Provider 只认 canonical。

export type Role = "system" | "user" | "assistant";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  url?: string;
  data?: string;
  mediaType?: string;
}

export interface ThinkingPart {
  type: "thinking";
  thinking: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  content: string;
}

export type ContentPart =
  | TextPart
  | ImagePart
  | ThinkingPart
  | ToolCallPart
  | ToolResultPart;

export interface Message {
  role: Role;
  content: string | ContentPart[];
}

export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  // model 是"发往上游"的模型名(路由解析后写入),客户端请求的原始名由 main.ts 单独保存。
  model: string;
  messages: Message[];
  tools?: FunctionTool[];
  toolChoice?: string | Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "error";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; arguments: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: FinishReason };

export interface ModelInfo {
  id: string;
  provider: string;
  upstreamId: string;
}
