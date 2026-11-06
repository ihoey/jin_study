import { expect, test } from "bun:test"; // 使用 Bun 自带的测试注册函数和断言,普通 bun test 会发现这个测试文件。
import { loadConfig } from "../src/config"; // 只导入纯配置读取逻辑,不会导入 main.ts 或启动 HTTP 服务。

// 测试只给函数传入假数据,结果不受本机 .env 中真实密钥影响,也不发送上游请求。
test("百炼变量被读取,qwen 别名映射到配置的真实模型", () => { // 验证只配置百炼时,同一套地址与密钥能够生成已有适配器的配置。
  const config = loadConfig({ DASHSCOPE_API_KEY: "fake-bailian-key", // 显式传入假的百炼密钥,而不是使用默认的 process.env。
    DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1/", // 刻意在地址末尾加斜杠,同时检查地址规范化逻辑。
    QWEN_MODEL: "test-qwen" }); // 使用假模型名,测试别名映射是否保留用户选择的真实名称。
  expect(config.providers[0]).toEqual({ id: "openai", apiKey: "fake-bailian-key", // 深度比较整个配置项,确认复用 openai 注册标识且密钥来源正确。
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }); // 期望地址末尾斜杠被移除,避免后续拼接口路径时出现双斜杠。
  expect(config.modelMap.qwen).toBe("openai/test-qwen"); // qwen 应映射成 Router 能解析的 供应商/模型名,而不是直接保留 qwen。
}); // 结束第一个配置用例;断言失败会由测试运行器报告。

test("两组凭据同时存在时,地址与密钥成对选取,不混用", () => { // 验证优先级和配置配对:两套变量共存时也不能交叉取值。
  const config = loadConfig({ OPENAI_API_KEY: "fake-openai-key", // 非空 OpenAI 密钥应使选择逻辑进入 OPENAI_* 分支。
    DASHSCOPE_API_KEY: "fake-bailian-key", DASHSCOPE_BASE_URL: "https://example.com/v1", // 同时放入另一套假密钥和不同地址,用来暴露错误混搭。
    QWEN_MODEL: "test-qwen" }); // 即使存在百炼模型名,选择 OPENAI_* 时也不应启用 qwen 别名。
  expect(config.providers[0]?.apiKey).toBe("fake-openai-key"); // 供应商应使用优先级更高的 OpenAI 密钥。
  expect(config.providers[0]?.baseUrl).toBe("https://api.openai.com/v1"); // 没有 OPENAI_BASE_URL 时用同分支的默认地址,不能退回 DASHSCOPE_BASE_URL。
  expect(config.modelMap).toEqual({}); // 关闭百炼别名映射,防止 qwen 无意间被路由到这次选择的其他上游。
}); // 结束第二个配置用例;这两个用例只证明配置选择,不证明真实上游调用成功。

test("百炼与 DeepSeek 同时注册,分别保存凭据和模型别名", () => {
  const config = loadConfig({ DASHSCOPE_API_KEY: "test-qwen-key", QWEN_MODEL: "test-qwen",
    DEEPSEEK_KEY: "test-deepseek-key", DEEPSEEK_ID: "deepseek-flash" });
  expect(config.providers.map((p) => p.id)).toEqual(["openai", "deepseek"]);
  expect(config.providers[1]).toEqual({ id: "deepseek", baseUrl: "https://api.deepseek.com",
    apiKey: "test-deepseek-key" });
  expect(config.modelMap).toEqual({ qwen: "openai/test-qwen", deepseek: "deepseek/deepseek-flash" });
  expect(config.defaultProvider).toBe("openai");
});

test("只配置 DeepSeek 时可作为默认上游,并兼容标准变量名", () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "test-model",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1/" });
  expect(config.defaultProvider).toBe("deepseek");
  expect(config.providers[0]?.baseUrl).toBe("https://api.deepseek.com/v1");
  expect(config.modelMap.deepseek).toBe("deepseek/test-model");
});

test("缺少密钥不注册上游,也不创建无法使用的别名", () => {
  const config = loadConfig({ DEEPSEEK_ID: "test-model", QWEN_MODEL: "test-qwen" });
  expect(config.providers).toEqual([]);
  expect(config.modelMap).toEqual({});
});

test("上游代理显式启用,空配置保持默认网络行为", () => {
  expect(loadConfig({}).proxyUrl).toBeUndefined();
  expect(loadConfig({ GATEWAY_PROXY_URL: "  " }).proxyUrl).toBeUndefined();
  expect(loadConfig({ GATEWAY_PROXY_URL: "http://127.0.0.1:7897" }).proxyUrl)
    .toBe("http://127.0.0.1:7897");
  expect(() => loadConfig({ GATEWAY_PROXY_URL: "file:///tmp/proxy" })).toThrow();
});
