import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { OpenAIProvider, toOpenAIBody } from "../src/providers/openai";
import { Router } from "../src/router";
import type { ChatRequest } from "../src/types";

// 只测试实际配置、路由和请求转换函数,不会启动假模型服务或发送网络请求。
test("两家模型的别名与显式前缀路由到各自适配器", () => {
  const config = loadConfig({ DASHSCOPE_API_KEY: "test-qwen-key", QWEN_MODEL: "test-qwen",
    DEEPSEEK_KEY: "test-deepseek-key", DEEPSEEK_ID: "deepseek-flash" });
  const providers = new Map(config.providers.map((p) =>
    [p.id, new OpenAIProvider(p.baseUrl, p.apiKey, p.id)]));
  const router = new Router(providers, config.modelMap, config.defaultProvider);
  expect(router.resolve("qwen").provider.id).toBe("openai");
  expect(router.resolve("deepseek").provider.id).toBe("deepseek");
  expect(router.resolve("deepseek").upstreamModel).toBe("deepseek-flash");
  expect(router.resolve("deepseek/deepseek-flash")).toEqual(router.resolve("deepseek"));
});

const request: ChatRequest = {
  model: "test-model", messages: [{ role: "user", content: "你好" }], stream: true,
};

test("思考开关按厂商转换,保留 false,不混用扩展字段", () => {
  const deepseek = toOpenAIBody({ ...request, enableThinking: false }, "deepseek");
  expect(deepseek.thinking).toEqual({ type: "disabled" });
  expect(deepseek).not.toHaveProperty("enable_thinking");
  expect(toOpenAIBody({ ...request, enableThinking: true }, "deepseek").thinking)
    .toEqual({ type: "enabled" });
  const bailian = toOpenAIBody({ ...request, enableThinking: false }, "openai");
  expect(bailian.enable_thinking).toBe(false);
  expect(bailian).not.toHaveProperty("thinking");
  expect(toOpenAIBody(request, "deepseek")).not.toHaveProperty("thinking");
});
