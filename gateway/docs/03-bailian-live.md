# 百炼真实模型联调

本课通过本地网关调用真实百炼服务。请求顺序为:

```text
live-request.ts 或 curl（客户端）
  -> main.ts（本地网关）
  -> router.ts: qwen 别名解析为 .env 中的 QWEN_MODEL
  -> fromOpenAI(): 校验后的请求转换为 ChatRequest
  -> OpenAIChatProvider.chat(): 调用百炼的兼容接口
  -> toOpenAIJSON() / toOpenAIStream()
  -> 客户端
```

这里的 `OpenAIChatProvider` 是已有的 OpenAI 兼容协议实现,上游地址指向百炼时,实际调用百炼。

## 配置与运行

在 gateway 目录运行时,Bun 会自动加载 `.env`。代码读取以下变量,不需要改成另一套变量名:

- `DASHSCOPE_API_KEY`:百炼密钥。
- `DASHSCOPE_BASE_URL`:百炼兼容接口的基础地址。
- `QWEN_MODEL`:实际模型名。

百炼使用独立的 `bailian` 身份。即使同时配置 `OPENAI_API_KEY`,两家也会分别注册,`qwen` 别名始终指向百炼。地址和密钥按各自变量成对读取。

DeepSeek 在这两套配置之外独立注册,不会替换百炼配置。接入步骤见 [DeepSeek 说明](05-deepseek.md)。

一键验证:

```sh
bun run test:live
```

它启动临时网关,依次发送一次非流式和一次流式短请求,打印 HTTP 状态、回复与执行顺序,结束后关闭网关。出现失败会停止,不自动重试;它会调用真实模型。普通 `bun test` 仅校验配置解析,不发起模型请求。

也可以手动启动网关,然后用 curl 请求:

```sh
GATEWAY_DEBUG=1 bun run dev
```

另一个终端执行（默认端口 3425）:

```sh
curl -N http://127.0.0.1:3425/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen","messages":[{"role":"user","content":"请只回复：网关联调成功"}],"enable_thinking":false,"stream":true,"max_tokens":128}'
```

把 `stream` 改成 `false` 即可测试非流式。`enable_thinking:false` 用于本次短文本联调,不会开启完整 reasoning 转换。百炼支持的模型及思考参数以[官方深度思考文档](https://help.aliyun.com/zh/model-studio/deep-thinking)为准。

## 首次尝试与后续修复（2026-11-06）

已读取 `.env` 中的百炼配置,选定模型为 `qwen3.8-27b`,未打印密钥。请求经过了本地网关的 [1] 到 [5],但上游连接发生 `ECONNRESET`,客户端收到 HTTP 502。独立的无密钥 HTTPS 检查同样连接失败。

后续发现终端未使用已配置的 macOS 系统代理,增加 `GATEWAY_PROXY_URL` 后,百炼与 DeepSeek 的普通、流式真实请求均返回 HTTP 200,回复“网关联调成功”。详细原因与验收见 [步骤 1](06-step1-real-models.md)。

排查时先确认本机网络可以访问配置中的百炼地址。如果 HTTP 状态为 400/401/403/404,再根据百炼返回信息检查参数、凭据、地域和模型权限;当前连接错误没有收到这样的上游 HTTP 响应。`GATEWAY_DEBUG=1` 会在网关终端打印经过密钥遮盖的错误原因。
