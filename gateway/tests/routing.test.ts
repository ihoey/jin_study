import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { toOpenAIBody } from "../src/providers/openai";
import { createProvider, createProviders } from "../src/providers/registry";
import { Router } from "../src/router";
import type { ChatRequest } from "../src/types";
import type { ProviderConfig } from "../src/config";
import { UpstreamError } from "../src/providers/errors";

// 测试使用实际工厂和路由,不会启动模拟服务或发送网络请求。
function buildRouter(env: Record<string, string>) {
  const config = loadConfig(env);
  return new Router(createProviders(config), config.modelMap, config.defaultProvider, config.providerAliases);
}

test("模型别名、真实前缀和旧百炼前缀都路由到独立供应商", () => {
  const router = buildRouter({ DASHSCOPE_API_KEY: "q-key", QWEN_MODEL: "test-qwen",
    DEEPSEEK_KEY: "d-key", DEEPSEEK_ID: "deepseek-flash" });
  const qwen = router.resolve("qwen");
  expect(qwen.provider.id).toBe("bailian");
  expect(qwen.provider.protocol).toBe("openai-chat-completions");
  expect(router.resolve("bailian/test-qwen")).toEqual(qwen);
  expect(router.resolve("openai/test-qwen")).toEqual(qwen);
  expect(router.resolve("test-qwen")).toEqual(qwen);
  expect(router.resolve("deepseek").provider.id).toBe("deepseek");
  expect(router.resolve("deepseek/deepseek-flash")).toEqual(router.resolve("deepseek"));
});

test("真实 OpenAI 注册后使用自己的前缀,qwen 仍固定走百炼", () => {
  const router = buildRouter({ OPENAI_API_KEY: "o-key", DASHSCOPE_API_KEY: "q-key", QWEN_MODEL: "test-qwen" });
  expect(router.resolve("openai/test-model").provider.id).toBe("openai");
  expect(router.resolve("qwen").provider.id).toBe("bailian");
  expect(() => router.resolve("missing/test-model")).toThrow("unknown provider");
  expect(router.resolve("constructor").upstreamModel).toBe("constructor");
  expect(() => router.resolve("toString/test-model")).toThrow("unknown provider");
});

const request: ChatRequest = {
  model: "test-model", messages: [{ role: "user", content: "你好" }], stream: true,
};

test("扩展参数取决于配置格式,不取决于供应商名称", () => {
  const custom = { id: "custom-service", thinkingFormat: "thinking" } as const;
  const body = toOpenAIBody({ ...request, enableThinking: false }, custom);
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(body).not.toHaveProperty("enable_thinking");
  expect(toOpenAIBody({ ...request, enableThinking: true }, custom).thinking).toEqual({ type: "enabled" });
  const bailian = toOpenAIBody({ ...request, enableThinking: false },
    { id: "another-service", thinkingFormat: "enable_thinking" });
  expect(bailian.enable_thinking).toBe(false);
  expect(bailian).not.toHaveProperty("thinking");
  expect(toOpenAIBody(request, custom)).not.toHaveProperty("thinking");
});

test("未支持的思考参数在发起网络调用前明确报错", () => {
  try {
    toOpenAIBody({ ...request, enableThinking: false }, { id: "openai", thinkingFormat: "unsupported" });
    throw new Error("应拒绝未支持的参数");
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(400);
  }
});

test("工厂通过协议创建适配器,任意供应商 id 均可复用", () => {
  const config: ProviderConfig = { id: "custom-service", protocol: "openai-chat-completions",
    thinkingFormat: "thinking", baseUrl: "https://example.com/v1", apiKey: "test-key" };
  expect(createProvider(config).id).toBe("custom-service");
  expect(createProvider(config).protocol).toBe(config.protocol);
  expect(() => createProvider({ ...config, protocol: "unknown" } as unknown as ProviderConfig)).toThrow("尚未支持");
  const gateway = loadConfig({});
  expect(() => createProviders({ ...gateway, providers: [config, config] })).toThrow("重复");
});
