// 管线位置:第 5 步 · 响应出
// 职责:把统一的 StreamEvent 流翻译回 OpenAI 的流式 SSE / 非流式 JSON。
// 流式走 toOpenAIStream,非流式走 toOpenAIJSON。
import type { StreamEvent } from "../types";

let counter = 0;

function genId(model: string): string {
  counter += 1;
  const slug = model.replace(/[^a-zA-Z0-9-]/g, "");
  return `chatcmpl-${slug}-${Date.now()}-${counter}`;
}

const created = (): number => Math.floor(Date.now() / 1000);

// canonical 事件流 -> OpenAI 流式 SSE(ReadableStream)。
export function toOpenAIStream(
  events: AsyncGenerator<StreamEvent>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = genId(model);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
        for await (const ev of events) {
          if (ev.type === "usage") {
            usage = { prompt_tokens: ev.usage.inputTokens, completion_tokens: ev.usage.outputTokens };
            continue;
          }
          const chunk = streamChunk(ev, model, id, usage);
          if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

function streamChunk(
  ev: StreamEvent,
  model: string,
  id: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | null,
): Record<string, unknown> | null {
  switch (ev.type) {
    case "text_delta":
      return {
        id,
        object: "chat.completion.chunk",
        created: created(),
        model,
        choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }],
      };
    case "done":
      return {
        id,
        object: "chat.completion.chunk",
        created: created(),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: ev.finishReason }],
        ...(usage ? { usage } : {}),
      };
    default:
      return null;
  }
}

// canonical 事件流 -> OpenAI 非流式 JSON 响应。
export async function toOpenAIJSON(
  events: AsyncGenerator<StreamEvent>,
  model: string,
): Promise<Record<string, unknown>> {
  let text = "";
  let finishReason = "stop";
  let usage: Record<string, number> = {};

  for await (const ev of events) {
    if (ev.type === "text_delta") {
      text += ev.text;
    } else if (ev.type === "usage") {
      usage = {
        prompt_tokens: ev.usage.inputTokens ?? 0,
        completion_tokens: ev.usage.outputTokens ?? 0,
      };
    } else if (ev.type === "done") {
      finishReason = ev.finishReason;
    }
  }

  return {
    id: genId(model),
    object: "chat.completion",
    created: created(),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
    usage,
  };
}
