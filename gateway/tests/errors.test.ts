import { expect, test } from "bun:test";
import { UpstreamError } from "../src/providers/errors";

test("HTTP 认证、权限、模型地址与参数错误分别报告", () => {
  for (const [status, code] of [[400, "upstream_parameter_error"], [401, "authentication_error"],
    [403, "permission_error"], [404, "upstream_not_found"], [429, "rate_limit_error"]] as const) {
    const error = UpstreamError.http("deepseek", status);
    expect(error.toJSON().error.type).toBe(code);
    expect(error.toJSON().error.upstream_status).toBe(status);
    expect(error.status).toBe(502);
  }
});

test("网络错误保留错误码,不传播异常中可能出现的凭据", () => {
  const error = UpstreamError.connection("deepseek", {
    code: "ECONNRESET", message: "private-key-and-proxy-credentials",
  });
  expect(error.toJSON().error.network_code).toBe("ECONNRESET");
  expect(JSON.stringify(error.toJSON())).not.toContain("private-key");
  expect(UpstreamError.connection("deepseek", { code: "secret-value" }).networkCode).toBeUndefined();
});

test("超时返回 504,上游 JSON 解析失败归类为 502", () => {
  expect(UpstreamError.connection("openai", { name: "TimeoutError" }).status).toBe(504);
  expect(UpstreamError.http("openai", 408).status).toBe(504);
  const error = UpstreamError.protocol("openai");
  expect(error.status).toBe(502);
  expect(error.toJSON().error.type).toBe("upstream_protocol_error");
});
