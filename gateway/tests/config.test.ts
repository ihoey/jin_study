import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

// 测试配置不来自 .env,不执行网络请求。
test("百炼独立注册,协议、参数格式和 qwen 别名均显式配置", () => {
  const config = loadConfig({ DASHSCOPE_API_KEY: "test-bailian-key",
    DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1/", QWEN_MODEL: "test-qwen" });
  expect(config.providers[0]).toEqual({ id: "bailian", protocol: "openai-chat-completions",
    thinkingFormat: "enable_thinking", apiKey: "test-bailian-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
  expect(config.modelMap.qwen).toBe("bailian/test-qwen");
  expect(config.defaultProvider).toBe("bailian");
});

test("三家同时注册,地址密钥成对保存,增加 OpenAI 不会关闭 qwen", () => {
  const config = loadConfig({ OPENAI_API_KEY: "test-openai-key", DASHSCOPE_API_KEY: "test-bailian-key",
    QWEN_MODEL: "test-qwen", DEEPSEEK_KEY: "test-deepseek-key", DEEPSEEK_ID: "deepseek-flash" });
  expect(config.providers.map((p) => p.id)).toEqual(["openai", "bailian", "deepseek"]);
  expect(config.providers.map((p) => p.apiKey)).toEqual(["test-openai-key", "test-bailian-key", "test-deepseek-key"]);
  expect(config.providers.map((p) => p.baseUrl)).toEqual([
    "https://api.openai.com/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://api.deepseek.com",
  ]);
  expect(config.modelMap).toEqual({ qwen: "bailian/test-qwen", deepseek: "deepseek/deepseek-flash" });
  expect(config.defaultProvider).toBe("openai");
  expect(config.providerAliases).toEqual({});
});

test("DeepSeek 变量保持兼容,自定义地址移除末尾斜杠", () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "test-model",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1/" });
  expect(config.defaultProvider).toBe("deepseek");
  expect(config.providers[0]?.baseUrl).toBe("https://api.deepseek.com/v1");
  expect(config.providers[0]?.thinkingFormat).toBe("thinking");
  expect(config.modelMap.deepseek).toBe("deepseek/test-model");
  const preferred = loadConfig({ DEEPSEEK_KEY: "preferred-key", DEEPSEEK_API_KEY: "other-key",
    DEEPSEEK_ID: "preferred-model", DEEPSEEK_MODEL: "other-model" });
  expect(preferred.providers[0]?.apiKey).toBe("preferred-key");
  expect(preferred.modelMap.deepseek).toBe("deepseek/preferred-model");
});

test("旧 openai 默认值兼容百炼,显式默认值必须指向已注册供应商", () => {
  const config = loadConfig({ DASHSCOPE_API_KEY: "test-key", DEFAULT_PROVIDER: "openai" });
  expect(config.defaultProvider).toBe("bailian");
  expect(config.providerAliases).toEqual({ openai: "bailian" });
  expect(loadConfig({ DASHSCOPE_API_KEY: "q-key", DEEPSEEK_KEY: "d-key",
    DEFAULT_PROVIDER: "deepseek" }).defaultProvider).toBe("deepseek");
  expect(() => loadConfig({ DEFAULT_PROVIDER: "missing" })).toThrow("未注册");
});

test("缺少密钥不注册供应商,也不创建模型别名", () => {
  const config = loadConfig({ DEEPSEEK_ID: "test-model", QWEN_MODEL: "test-qwen" });
  expect(config.providers).toEqual([]);
  expect(config.modelMap).toEqual({});
  expect(config.providerAliases).toEqual({});
});

test("代理显式启用,空配置保留默认网络行为", () => {
  expect(loadConfig({}).proxyUrl).toBeUndefined();
  expect(loadConfig({ GATEWAY_PROXY_URL: "  " }).proxyUrl).toBeUndefined();
  expect(loadConfig({ GATEWAY_PROXY_URL: "http://127.0.0.1:7897" }).proxyUrl)
    .toBe("http://127.0.0.1:7897");
  expect(() => loadConfig({ GATEWAY_PROXY_URL: "file:///tmp/proxy" })).toThrow();
});
