// 管线位置:第 4 步内的小工具
// 职责:把上游 SSE 字节流切成一行行 "data: {...}" 负载字符串。
// 例:上游发来 data: {"choices":[...]} ,这里 yield 出 {"choices":[...]} 。
// 用标准 ReadableStream API 写,保证在 Bun 和 Node 下都能跑。
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> { // 导出异步生成器:接收由字节块组成的响应流,逐行产出 data: 后面的字符串。
  const reader = body.getReader(); // 获取流读取器并锁定这个流,后续通过 reader.read() 读取字节块。
  const decoder = new TextDecoder(); // 创建默认使用 UTF-8 的解码器,把网络字节转换成文本。
  let buffer = ""; // 保存尚未处理完的文本,用于拼接跨越多个网络字节块的一行数据。

  try { // 进入读取流程,配合 finally 确保退出时释放读取器的锁。
    for (;;) { // 创建没有固定次数的循环,持续读取,直到流结束或发生异常。
      const { done, value } = await reader.read(); // 异步读取下一个字节块;done 表示流是否结束,value 是本次读到的字节。
      if (done) break; // 流结束就退出循环;当前实现不会在这里处理 buffer 中没有换行的剩余文本。
      buffer += decoder.decode(value, { stream: true }); // 解码并追加文本;stream: true 保留跨字节块的不完整字符,例如被拆开的中文字符。

      const lines = buffer.split("\n"); // 按换行符拆成若干行;最后一段可能还没接收完整。
      buffer = lines.pop() ?? ""; // 取出最后一段留给下次拼接,其余段都是已经遇到换行符的完整行。
      for (const line of lines) { // 遍历本轮得到的完整文本行。
        const trimmed = line.trim(); // 去掉行首和行尾空白,也会去掉 CRLF 换行留下的回车符。
        if (trimmed.startsWith("data:")) { // 只处理以 data: 开头的行,空行和 event: 等其他行会被忽略。
          yield trimmed.slice("data:".length).trim(); // 去掉 data: 前缀和两侧空白,产出字符串;这里不解析 JSON,也不合并多行 data。
        } // 结束 data 行的判断。
      } // 结束完整行遍历。
    } // 结束字节流读取循环。
  } finally { // 正常结束、发生异常或消费者提前关闭生成器时,都会进入清理阶段。
    reader.releaseLock(); // 释放读取器对流的锁;这一步本身不会取消底层网络请求。
  } // 结束清理阶段。
} // 结束 SSE 数据行解析生成器。
