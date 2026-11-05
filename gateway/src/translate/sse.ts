// 管线位置:第 4 步内的小工具
// 职责:把上游 SSE 字节流切成一行行 "data: {...}" 负载字符串。
// 例:上游发来 data: {"choices":[...]} ,这里 yield 出 {"choices":[...]} 。
// 用标准 ReadableStream API 写,保证在 Bun 和 Node 下都能跑。
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          yield trimmed.slice("data:".length).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
