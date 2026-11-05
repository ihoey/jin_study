// 管线位置:第 4 步 · 上游调用(参考实现)
// 职责:把 ChatRequest 发给 OpenAI,把它的响应(流式 SSE 或 JSON)
//       解析成统一的 StreamEvent 流。
import type { ChatRequest, Message, ModelInfo, StreamEvent, TextPart, Usage } from "../types";
import type { Provider } from "./base";
import { readSSE } from "../translate/sse";

interface OpenAIChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

interface OpenAICompletion {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAIProvider implements Provider {
  readonly id = "openai";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`list models failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data: Array<{ id: string }> };
    return data.data.map((m) => ({ id: `${this.id}/${m.id}`, provider: this.id, upstreamId: m.id }));
  }

  async *chat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const body = toOpenAIBody(req);
    // canonical -> OpenAI 请求体,然后发上游。
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`upstream error ${res.status}: ${await res.text()}`);

    if (req.stream) {
      yield* this.stream(res.body!);
    } else {
      yield* this.nonStream(await res.json());
    }
  }

  private async *stream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent, void, void> {
    // 逐块解析上游 SSE,把 OpenAI 的 delta 翻译成统一 StreamEvent。
    for await (const data of readSSE(body)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data) as OpenAIChunk;
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const text = choice.delta?.content;
      if (text) yield { type: "text_delta", text };
      if (chunk.usage) yield { type: "usage", usage: toUsage(chunk.usage) };
      if (choice.finish_reason) {
        yield { type: "done", finishReason: mapFinishReason(choice.finish_reason) };
      }
    }
  }

  private async *nonStream(json: unknown): AsyncGenerator<StreamEvent, void, void> {
    const data = json as OpenAICompletion;
    const choice = data.choices?.[0];
    if (!choice) throw new Error("upstream returned no choices");

    // 一次 JSON 响应也拆成统一事件流,让下游只有一套处理逻辑。
    const text = choice.message?.content;
    if (text) yield { type: "text_delta", text };
    if (data.usage) yield { type: "usage", usage: toUsage(data.usage) };
    yield { type: "done", finishReason: mapFinishReason(choice.finish_reason) };
  }
}

function toUsage(u: { prompt_tokens?: number; completion_tokens?: number }): Usage {
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
}

function mapFinishReason(r: string | null | undefined): "stop" | "length" | "tool_calls" {
  if (r === "tool_calls") return "tool_calls";
  if (r === "length") return "length";
  return "stop";
}

function toOpenAIBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(toOpenAIMessage),
    stream: req.stream,
  };
  if (req.tools?.length) body.tools = req.tools;
  if (req.toolChoice) body.tool_choice = req.toolChoice;
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.maxTokens != null) body.max_tokens = req.maxTokens;
  return body;
}

function toOpenAIMessage(m: Message): Record<string, unknown> {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  const text = m.content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
  return { role: m.role, content: text };
}
