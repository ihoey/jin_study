// 上游错误只暴露结构化原因,不把厂商原始正文、请求头或密钥传给客户端。
export class UpstreamError extends Error {
  constructor(
    readonly provider: string,
    readonly code: string,
    message: string,
    readonly upstreamStatus?: number,
    readonly networkCode?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }

  get status(): number {
    if (this.code === "unsupported_parameter_error") return 400;
    return this.code === "timeout_error" ? 504 : 502;
  }

  toJSON() {
    return { error: { type: this.code, message: this.message, provider: this.provider,
      ...(this.upstreamStatus !== undefined ? { upstream_status: this.upstreamStatus } : {}),
      ...(this.networkCode ? { network_code: this.networkCode } : {}),
    } };
  }

  static http(provider: string, status: number): UpstreamError {
    const reasons: Record<number, [string, string]> = {
      400: ["upstream_parameter_error", "上游拒绝请求参数,请检查模型及参数支持情况。"],
      401: ["authentication_error", "上游认证失败,请检查对应供应商的密钥。"],
      403: ["permission_error", "上游拒绝访问,请检查账号或模型权限。"],
      404: ["upstream_not_found", "上游模型或接口不存在,请检查模型 ID 和基础地址。"],
      408: ["timeout_error", "上游请求超时。"],
      429: ["rate_limit_error", "上游限流或额度不足。"],
    };
    const [code, message] = reasons[status] ?? ["upstream_http_error", "上游服务返回失败状态。"];
    return new UpstreamError(provider, code, message, status);
  }

  static connection(provider: string, error: unknown): UpstreamError {
    const source = error as { name?: string; code?: string } | null;
    if (source?.name === "TimeoutError" || source?.code === "ETIMEDOUT") {
      return new UpstreamError(provider, "timeout_error", "连接上游超时,请检查网络或代理。");
    }
    // 只保留允许的错误码,不会把可能含代理凭据的异常 message 写进响应。
    const codes = ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"];
    const networkCode = source?.code && codes.includes(source.code) ? source.code : undefined;
    return new UpstreamError(provider, "network_error", "无法连接上游,请检查网络、DNS、TLS 或代理配置。",
      undefined, networkCode);
  }

  static protocol(provider: string): UpstreamError {
    return new UpstreamError(provider, "upstream_protocol_error", "上游返回的内容不符合预期协议。");
  }
}
