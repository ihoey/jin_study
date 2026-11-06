# 步骤 1:跑通真实模型（已完成）

## 目的与结果

先证明现有网关能调用真实模型,再扩展工具和自动切换。2026-11-06 已通过四项真实验收:

| 模型 | 请求方式 | HTTP | 回复 | 结束 |
|---|---|---|---|---|
| 百炼 qwen3.8-27b | 非流式 | 200 | 网关联调成功 | stop |
| 百炼 qwen3.8-27b | 流式 | 200 | 网关联调成功 | stop + [DONE] |
| DeepSeek deepseek-flash | 非流式 | 200 | 网关联调成功 | stop |
| DeepSeek deepseek-flash | 流式 | 200 | 网关联调成功 | stop + [DONE] |

百炼流式收到 2 段文本增量,DeepSeek 收到 4 段;分段数量可能随请求变化。非流式用量分别为输入/输出 20/5 和 12/4 token。这些结果由真实上游返回,不是固定回复接口。

## 1. 为什么之前连接失败

系统代理检查发现 macOS 已配置 HTTP/HTTPS 代理 `127.0.0.1:7897`,但当前终端进程没有相应的代理环境变量。两个模型域名在本机解析为 `198.18.*` 地址,直连 HTTPS 时发生连接重置。

通过系统已配置的代理进行无密钥检查后,能收到上游 HTTP 响应。给网关显式配置同一代理后,原来的密钥、地址和模型 ID 均能正常调用。因此此次连接重置与网络路径有关,无需更换这些凭据或模型配置。

已在本机 `.env` 追加一项,原有密钥和其他配置保持原样:

```dotenv
GATEWAY_PROXY_URL=http://127.0.0.1:7897
```

这不是通用的固定代理端口,而是本机实际检查得到的配置。换机器时应填自己的 HTTP(S) 代理地址;不需要代理时删除该项或留空。没有设置时保留 Bun 默认的网络行为。TLS 证书校验仍然启用。

## 2. 按顺序看代码

```text
.env 的 GATEWAY_PROXY_URL
  -> config.ts:检查代理地址格式
  -> main.ts:将代理传给各个 Provider
  -> OpenAIProvider.request():显式代理 + 认证 + 45 秒请求期限
  -> 百炼或 DeepSeek
  -> 正常响应进入原有 JSON / SSE 转换
     失败则进入 UpstreamError 分类
```

首先看 `src/config.ts` 的 `proxyUrl`,它只描述网络路径。然后看 `src/providers/openai.ts` 新增的 `request()`,这是上游网络请求的集中入口;`readJSON()` 区分响应解析错误与网络错误。

最后看 `src/providers/errors.ts` 和 `main.ts` 的错误回调。错误对象只保留供应商、错误类别和状态码,不返回厂商原始正文或认证头。

## 3. 如何区分错误

| 错误类型 | 含义 | 网关状态 |
|---|---|---|
| invalid_request_error | 客户端 JSON 或字段错误 | 400 |
| network_error | 上游连接、DNS、TLS 或代理问题 | 502 |
| timeout_error | 上游超时 | 504 |
| authentication_error | 上游返回 401 | 502,附 upstream_status=401 |
| permission_error | 上游返回 403 | 502,附 upstream_status=403 |
| upstream_not_found | 上游模型或接口不存在 | 502,附 upstream_status=404 |
| upstream_parameter_error | 上游拒绝参数 | 502,附 upstream_status=400 |
| rate_limit_error | 上游限流或额度不足 | 502,附 upstream_status=429 |
| upstream_protocol_error | 上游返回的内容不符合协议 | 502 |

注意不能只凭上游 400 判断模型是否存在,它也可能表示该模型不支持某个参数;错误分类不会替厂商猜测确切原因。

流式请求会先获取第一个内部事件,然后才交出 HTTP 响应,所以连接或认证失败能返回正确的错误状态。已经开始输出后的异常、完整取消传播和 SSE 语义将在后续流式步骤完善。

## 4. 自己复验

在 gateway 目录执行:

```sh
bun run typecheck
bun test
bun run test:live
bun run test:deepseek
```

前两项不调用模型;后两项使用真实凭据,各发一条非流式和一条流式短请求。联调脚本在临时端口启动真实网关,使用完会关闭。

也可以启动常驻网关:

```sh
GATEWAY_DEBUG=1 bun run dev
```

另一个终端发送:

```sh
curl -N http://127.0.0.1:3425/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek","stream":true,"enable_thinking":false,"max_tokens":128,"messages":[{"role":"user","content":"请只回复：网关联调成功"}]}'
```

模型名换成 `qwen` 即可验证百炼。流式用量与完整 SSE 处理仍属于后续步骤,本次通过代表两家真实文本链路已经跑通。
