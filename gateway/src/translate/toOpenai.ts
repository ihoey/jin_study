// 管线位置:第 5 步 · 响应出
// 职责:把统一的 StreamEvent 流翻译回 OpenAI 的流式 SSE / 非流式 JSON。
// 流式走 toOpenAIStream,非流式走 toOpenAIJSON。
import type { StreamEvent } from "../types"; // 引入内部流事件类型,用来区分文本增量、用量、结束等事件;导入只参与类型检查。

let counter = 0; // 模块内共享的计数器,每次生成响应 ID 时递增,减少同一毫秒内的 ID 冲突。

function genId(model: string): string { // 为一次聊天响应生成字符串 ID,把模型名、当前时间和计数器组合起来。
  counter += 1; // 每生成一个 ID 就把计数器加一,同一进程中的后续响应会使用不同序号。
  const slug = model.replace(/[^a-zA-Z0-9-]/g, ""); // 全局删除模型名中非英文字母、数字、连字符的字符,例如去掉斜杠和小数点。
  return `chatcmpl-${slug}-${Date.now()}-${counter}`; // 拼出响应 ID;Date.now() 是当前时间距 Unix 纪元的毫秒数。
} // 结束响应 ID 生成函数。

const created = (): number => Math.floor(Date.now() / 1000); // 定义时间戳函数:毫秒除以 1000 后向下取整,得到 OpenAI 响应使用的 Unix 秒数。

// canonical 事件流 -> OpenAI 流式 SSE(ReadableStream)。
export function toOpenAIStream( // 导出流式转换函数,把内部事件生成器包装成 HTTP 响应可使用的字节流。
  events: AsyncGenerator<StreamEvent>, // 输入的异步事件生成器,由 Provider.chat() 提供。
  model: string, // 客户端请求的模型名,写入返回数据中,可以与上游真实模型名不同。
): ReadableStream<Uint8Array> { // 返回可读字节流,每个字节块都用 Uint8Array 表示。
  const encoder = new TextEncoder(); // 创建 UTF-8 编码器,把 SSE 文本编码成要发送的字节。
  const id = genId(model); // 为本次响应生成一次 ID,同一条流中的所有数据块共用它。

  return new ReadableStream<Uint8Array>({ // 创建可读流,用下面的 start 回调向流中写入数据。
    async start(controller) { // 流创建时执行这个异步回调;controller 用于入队字节、关闭流或报告错误。
      try { // 包住读取和编码过程,发生异常时通知可读流的消费者。
        let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null; // 暂存最近收到的用量,初始尚无用量信息。
        for await (const ev of events) { // 逐个消费 Provider 产出的内部事件,同时驱动上游异步生成器执行。
          if (ev.type === "usage") { // 用量事件单独处理,先保存,不立即作为独立 SSE 数据块发出。
            usage = { prompt_tokens: ev.usage.inputTokens, completion_tokens: ev.usage.outputTokens }; // 将内部输入、输出 token 字段改为 OpenAI 的字段名。
            continue; // 当前用量事件处理完毕,直接读取下一个内部事件。
          } // 结束用量事件分支。
          const chunk = streamChunk(ev, model, id, usage); // 把其他事件转成 OpenAI 流式响应对象;不支持的事件会得到 null。
          if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)); // 对象先转 JSON,再加 SSE 的 data: 前缀和空行分隔,编码后放进输出流。
        } // 内部生成器结束后退出循环,仅收到 done 事件本身不会让这个循环提前退出。
        controller.enqueue(encoder.encode("data: [DONE]\n\n")); // 全部内部事件消费完成后,发送 OpenAI 风格的流结束标记。
        controller.close(); // 正常关闭输出流,消费者读完已入队的数据后会看到流结束。
      } catch (err) { // 捕获上游请求、事件读取、JSON 序列化等过程中抛出的异常。
        controller.error(err); // 将输出流标记为出错,把异常交给消费者,不再执行正常的结束流程。
      } // 结束正常输出和错误处理分支。
    }, // 结束 start 回调定义。
  }); // 结束可读流创建,将流对象返回给调用者。
} // 结束流式响应转换函数。

function streamChunk( // 把单个内部事件转换为一个 OpenAI 数据块,这里只组装对象,不做字节编码。
  ev: StreamEvent, // 当前要转换的内部事件,通过 type 字段决定处理方式。
  model: string, // 写入响应的客户端模型名。
  id: string, // 本次聊天响应的共享 ID,由 toOpenAIStream 传入。
  usage: { prompt_tokens?: number; completion_tokens?: number } | null, // 截至当前事件已经收到的 token 用量,没有收到时为 null。
): Record<string, unknown> | null { // 返回字符串键的响应对象,或者用 null 表示这类事件暂不输出。
  switch (ev.type) { // 按事件类型分支,TypeScript 也会据此缩小 ev 的具体类型。
    case "text_delta": // 文本增量事件,对应模型刚生成的一段新文本。
      return { // 创建包含文本增量的 OpenAI 数据块。
        id, // 属性简写,写入本次响应共用的 ID。
        object: "chat.completion.chunk", // OpenAI 约定的流式聊天数据块类型名称。
        created: created(), // 调用时间戳函数,记录这个数据块生成时的 Unix 秒数。
        model, // 把客户端请求的模型名放入响应。
        choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }], // 第 0 条候选回复新增文本;此时没有结束原因,所以填 null。
      }; // 返回文本数据块,结束当前函数调用。
    case "done": // 内部结束事件,表示本次回复已有结束原因。
      return { // 创建包含结束原因的 OpenAI 数据块。
        id, // 沿用同一条流的响应 ID。
        object: "chat.completion.chunk", // 结束数据块仍然属于流式聊天数据块。
        created: created(), // 记录结束数据块生成时的 Unix 秒数。
        model, // 沿用客户端请求的模型名。
        choices: [{ index: 0, delta: {}, finish_reason: ev.finishReason }], // 不再追加文本,用空 delta 搭配内部事件携带的结束原因。
        ...(usage ? { usage } : {}), // 如果结束事件之前已经收到用量,就把它附在此块;否则不添加 usage 字段。
      }; // 返回结束数据块,结束当前函数调用。
    default: // 其他事件类型暂时没有对应的数据块转换逻辑。
      return null; // 返回 null,让调用者跳过输出这个事件。
  } // 结束事件类型分支。
} // 结束单事件到数据块的转换函数。

// canonical 事件流 -> OpenAI 非流式 JSON 响应。
export async function toOpenAIJSON( // 导出非流式转换函数,等待内部事件全部处理完成后返回一个完整响应对象。
  events: AsyncGenerator<StreamEvent>, // 输入仍然是内部事件生成器,因此可与流式转换共用 Provider 接口。
  model: string, // 客户端请求的模型名,用在响应字段和生成响应 ID 时。
): Promise<Record<string, unknown>> { // 异步返回响应对象;真正的 JSON 序列化由 main.ts 中的 Response.json 完成。
  let text = ""; // 累积所有文本增量,初始回复内容为空字符串。
  let finishReason = "stop"; // 设置默认结束原因为 stop,收到 done 事件后再用实际原因覆盖。
  let usage: Record<string, number> = {}; // 暂存 OpenAI 格式的用量字段,尚未收到用量时保留空对象。

  for await (const ev of events) { // 持续消费内部事件,驱动上游生成器执行,直到生成器结束。
    if (ev.type === "text_delta") { // 收到文本增量时执行文本拼接。
      text += ev.text; // 按到达顺序把这一段新文本追加到完整回复末尾。
    } else if (ev.type === "usage") { // 收到用量事件时更新保存的 token 数。
      usage = { // 创建新的用量对象;如果有多个用量事件,后一个会覆盖前一个。
        prompt_tokens: ev.usage.inputTokens ?? 0, // 内部输入 token 数改名为 prompt_tokens,缺省时使用 0。
        completion_tokens: ev.usage.outputTokens ?? 0, // 内部输出 token 数改名为 completion_tokens,缺省时使用 0。
      }; // 结束并保存本次用量对象。
    } else if (ev.type === "done") { // 收到结束事件时更新结束原因。
      finishReason = ev.finishReason; // 使用 Provider 已映射好的结束原因,覆盖初始的 stop。
    } // 结束当前事件处理;其他事件类型不会改变这些累积变量。
  } // 结束事件消费循环,此时才能组装完整非流式响应。

  return { // 根据累积的文本、结束原因和用量生成完整响应对象。
    id: genId(model), // 为这次完整响应生成新的聊天 ID。
    object: "chat.completion", // OpenAI 约定的非流式聊天响应类型名称。
    created: created(), // 记录完整响应组装时的 Unix 秒数。
    model, // 返回客户端请求的模型名。
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }], // 返回第 0 条候选回复,角色为助手,内容为全部拼接文本,并附上结束原因。
    usage, // 返回最后收到的用量对象;从未收到用量事件时,这里仍是空对象。
  }; // 结束并返回完整响应对象。
} // 结束非流式响应转换函数。
