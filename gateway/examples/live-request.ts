// 手动运行 bun run test:live 调用真实模型;普通 bun test 只校验配置解析。
// Bun 在 gateway 目录运行时自动加载 .env,密钥只由网关发给配置的上游。
import { fileURLToPath } from "node:url"; // 将当前模块的 file: URL 转成系统文件路径,保证从其他目录启动脚本也能定位 gateway。
import { loadConfig } from "../src/config"; // 复用服务端配置选择规则,让脚本知道当前能使用的模型别名。
import { readSSE } from "../src/translate/sse"; // 复用 SSE 数据行解析器,这次是在客户端一侧读取网关返回的流。

// 本脚本是联调的总控制者:启动一个子进程做网关,自己作为客户端发送请求,最后回收子进程。
const config = loadConfig(); // 默认读取当前进程环境;这里只得到配置数据,不会因此调用模型。
// 命令行可传 qwen 或 deepseek;不传时优先使用已配置的 qwen。
const model = process.argv[2] ?? (config.modelMap.qwen ? "qwen" : "deepseek");
const mapped = config.modelMap[model];
if (!mapped) throw new Error(`请先配置 ${model} 对应的密钥和模型 ID。`);
console.log("真实联调模型:", mapped); // 只打印供应商和模型名,不展示密钥。

// [A] 启动网关入口。端口设为 0,由系统分配,避免与已运行的网关冲突。
const gateway = Bun.spawn([process.execPath, "src/main.ts"], { // 用当前 Bun 可执行文件启动网关子进程,其余代码仍在脚本这个父进程中执行。
  cwd: fileURLToPath(new URL("..", import.meta.url)), // 相对脚本定位 gateway 根目录,让 src/main.ts 和 .env 的查找位置一致。
  env: { ...process.env, GATEWAY_PORT: "0", GATEWAY_DEBUG: "1" }, // 别名已指定供应商,无需覆盖默认路由。
  stdout: "pipe", stderr: "pipe", // 把正常日志和错误日志分别接入管道,供父进程读取而不是直接混入终端。
}); // 创建子进程后立即得到控制对象,不代表网关已经监听成功。
const reader = gateway.stdout.getReader(); // 获取网关 stdout 的读取器,稍后从启动日志中识别系统实际分配的端口。
const decoder = new TextDecoder(); // 把子进程日志字节解码成文本,用于匹配监听地址和最终展示流程。
// 防止启动或网络异常时留下联调进程。
const deadline = setTimeout(() => gateway.kill(), 110_000); // 为子进程设 110 秒兜底期限,即使启动或网络阶段卡住,也会尝试结束临时网关。
let logs = ""; // 持续累积 stdout,启动时用于找地址,结束时用于展示请求经过了哪些检查点。
try { // 启动等待和两次真实请求共用一个 try,任一阶段失败就转入 catch,最后仍执行 finally。
  let baseUrl = ""; // 地址尚未确定,因为端口 0 要由操作系统在监听时分配。
  while (!baseUrl) { // 只要还没从日志里找到监听地址,就继续等待子进程输出。
    const { value, done } = await reader.read(); // 读取下一段启动日志;等待期间并不会反复向网关试发聊天请求。
    if (done) throw new Error("网关启动失败。"); // 日志流已结束却没拿到地址,说明不能继续,直接抛错退出等待。
    logs += decoder.decode(value, { stream: true }); // 拼接可能被拆成多个字节块的日志,保留不完整字符以供下次解码。
    baseUrl = logs.match(/gateway listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? ""; // 从实际启动成功行提取地址;匹配失败仍为空,下一轮继续等。
  } // 地址非空才退出等待,此时脚本知道该向哪个本地端口发请求。

  // [B] 客户端请求本地网关,网关按模型别名选择百炼或 DeepSeek。
  for (const stream of [false, true]) { // 依次验证非流式和流式,第一轮失败就抛错,不会自动重试或执行第二轮。
    const response = await fetch(`${baseUrl}/v1/chat/completions`, { // 这是脚本这个客户端请求本地网关,上游调用发生在网关子进程内部。
      method: "POST", headers: { "content-type": "application/json" }, // 聊天入口要求 POST 和 JSON 正文,不需要在这次本地请求中携带上游密钥。
      signal: AbortSignal.timeout(45_000), // 每次客户端请求最多等待 45 秒;它取消客户端请求,当前网关尚未把取消信号传递给上游 fetch。
      body: JSON.stringify({ model, stream, enable_thinking: false, max_tokens: 128, // 固定短回复、限制输出长度、显式关闭思考,便于观察两种返回方式的基本链路。
        messages: [{ role: "user", content: "请只回复：网关联调成功" }] }), // 发送一条明确的短文本请求;先转成 JSON 字符串再作为 HTTP 正文。
    }); // 等待拿到本地网关响应对象;流式正文此时可能仍在继续到达。
    console.log(stream ? "流式 HTTP:" : "非流式 HTTP:", response.status); // 打印本轮返回方式和状态码,区分哪一条调用链失败。
    if (!response.ok) {
      // 网关只返回安全的结构化原因,例如 network_error / authentication_error。
      console.error("网关错误:", await response.json());
      throw new Error("真实请求失败。");
    }

    // [C] 非流式读完整 JSON;流式逐个读取 SSE,检查文本、结束原因和结束标记。
    let text = ""; // 两种返回方式都把最终回答保存到同一个变量,便于执行相同的完成检查。
    let finishReason: string | null = null; // 初始还没有看到结束原因,不能仅凭 HTTP 200 就认为模型回复完整。
    if (!stream) { // 非流式需要等完整 JSON,然后一次读取 message.content。
      const data = await response.json() as { // 解析完整响应,as 只提供 TypeScript 类型提示,不会额外验证服务端字段。
        choices: { message: { content: string }; finish_reason: string }[]; // 声明本脚本要读取的回复文本和结束原因。
        usage?: unknown; // 用量字段只用于展示,此处没有对其内部结构作进一步约束。
      }; // 结束响应类型声明,等待解析完成后得到 data。
      text = data.choices[0]?.message.content ?? ""; // 读取第一条回复,候选回复缺失时先保留空文本,稍后统一判失败。
      finishReason = data.choices[0]?.finish_reason ?? null; // 保存第一条候选回复的结束原因,缺失则仍为 null。
      console.log("用量:", data.usage); // 展示非流式响应报告的 token 用量,不额外查询上游。
    } else { // 流式响应按 SSE 数据行逐个处理,而不是调用 response.json() 等整包 JSON。
      if (!response.body) throw new Error("缺少流式响应正文。"); // 先检查正文流存在,否则无法使用 readSSE 读取。
      let done = false; // 独立记录是否真的看到了协议结束标记,连接断开本身不代表正常结束。
      let chunks = 0; // 统计包含非空文本的片段数,用于观察一段回答被分成多少次传递。
      for await (const payload of readSSE(response.body)) { // 复用解析器读取网关发回的 data 内容,一次循环处理一个数据行。
        if (payload === "[DONE]") { done = true; break; } // 结束标记不是 JSON,要先判断再解析;记录后退出循环。
        const data = JSON.parse(payload) as { // 普通数据行解析为响应块,供后面提取增量和结束原因。
          choices: { delta: { content?: string }; finish_reason?: string | null }[]; // 文本增量和结束原因都允许缺省,因为不同数据块负责的信息不同。
        }; // 结束当前响应块的类型声明。
        const choice = data.choices[0]; // 当前示例只读取第 0 条候选回复。
        if (choice?.delta.content) { text += choice.delta.content; chunks++; } // 收到非空文本就按顺序拼接,同时累计文本片段数。
        if (choice?.finish_reason) finishReason = choice.finish_reason; // 结束原因可能单独出现在无文本的数据块中,所以独立判断。
      } // 看见 [DONE] 或响应流结束后离开循环;异常则直接跳到外层 catch。
      if (!done) throw new Error("流未正常结束,缺少 [DONE]。"); // 已读到部分文字仍不算成功,还必须有正常的协议结束标记。
      console.log("文本增量数:", chunks, "结束标记:", done); // 展示流式传输确实产生了片段,并报告结束标记是否到达。
    } // 两个解析分支完成后,都使用下面相同的结果检查。
    if (!text || finishReason !== "stop") throw new Error("回复为空或未正常完成。"); // 本联调只接受非空且正常 stop 的短回复,长度截断等情况也视为未通过。
    console.log("模型回复:", text, "结束原因:", finishReason); // 打印这一轮的模型回答和结束原因,便于人工核对。
  } // 两次请求都成功才会完整走完循环。
  console.log("真实模型的非流式与流式联调均通过。"); // 只有非流式和流式都满足检查条件,才打印整体成功。
} catch { // 任一阶段抛错都进入这里;不再发送后续请求,随后仍会执行 finally 回收网关。
  // 不打印可能包含请求凭据的底层网络异常或完整响应。
  console.error("真实联调未通过;检查上面的 HTTP 状态、配置和模型权限。"); // 客户端脚本输出概括性错误,具体网关错误由下面收集的 stderr 展示。
  process.exitCode = 1; // 设置失败退出码但不立即强制退出,保证后面的 finally 仍能执行清理。
} finally { // 无论成功、失败还是超时,都执行下面的子进程回收流程。
  clearTimeout(deadline); // 取消尚未触发的兜底定时器,避免联调结束后仍有额外计时任务。
  gateway.kill(); // 结束本脚本创建的临时网关,不影响用户另外启动的网关进程。
  await gateway.exited; // 等子进程真正退出,再读取管道中的剩余数据,确认生命周期收尾。
  const errors = await new Response(gateway.stderr).text(); // 将子进程 stderr 管道读成完整文本,包含网关错误回调输出的日志。
  if (errors) console.error(errors); // stderr 有内容才打印,其已配置密钥的遮盖由服务端错误日志代码完成。
  // 子进程退出后读取剩余流程日志,展示 [1] 到 [5],不包含正文或密钥。
  for (;;) { // 继续读取启动阶段之后尚未读走的 stdout,直到子进程管道完全结束。
    const { value, done } = await reader.read(); // 每次取得一段剩余日志字节或结束状态。
    if (done) break; // 管道已经读完,退出清理阶段的日志循环。
    logs += decoder.decode(value, { stream: true }); // 将请求期间产生的 [1]～[5] 日志追加到已有启动日志后面。
  } // 退出循环意味着 stdout 已消费完毕。
  reader.releaseLock(); // 释放日志读取器的锁,完成管道读取的清理。
  console.log("网关执行顺序:\n" + logs); // 最后展示完整 stdout,让人对照 main.ts 中的执行检查点。
} // 清理结束后脚本自然退出,由 exitCode 表示联调是否成功。
