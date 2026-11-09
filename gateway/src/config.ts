// 管线位置:第 0 步 · 启动配置
// 职责:从环境变量读取端口、密钥、Provider 列表,交给 main.ts 组装。
export type UpstreamProtocol = "openai-chat-completions";
export type ThinkingFormat = "enable_thinking" | "thinking" | "unsupported";

export interface ProviderConfig { // 供应商身份、通信协议和扩展参数是三个独立的配置。
  id: string; // 供应商标识,例如 openai;路由层会用这个名称查找供应商。
  protocol: UpstreamProtocol;
  thinkingFormat: ThinkingFormat;
  baseUrl: string; // 上游 API 的基础地址,例如 https://api.openai.com/v1。
  apiKey: string; // 访问上游接口时使用的密钥,由环境变量提供。
} // 结束单个供应商的配置类型定义。

export interface GatewayConfig { // 导出网关的完整配置类型,描述启动服务和建立路由所需的信息。
  proxyUrl?: string; // Bun 的上游 fetch 使用此代理;本地客户端到网关的请求仍然直连。
  port: number; // 网关 HTTP 服务监听的端口号。
  defaultProvider: string; // 客户端只传模型名、没有供应商前缀时,默认使用的供应商标识。
  providers: ProviderConfig[]; // 已配置的供应商列表,每一项都满足上面的 ProviderConfig 类型。
  // 客户端模型别名 -> "provider/upstreamModel",交给 Router 解析。
  modelMap: Record<string, string>; // 模型别名映射表;Record<string, string> 表示键和值都是字符串。
  providerAliases: Record<string, string>; // 仅用于旧供应商前缀兼容,不创建重复供应商或重复发送请求。
} // 结束网关配置类型定义;接口只参与类型检查,不会创建运行时配置。

// 执行顺序:读网络配置 → 分别注册三家供应商 → 建立模型/旧前缀别名 → 选择默认供应商。
// env 是可替换的输入:正式启动时不传参数,测试时传假配置,同一个函数就能用于两种场景。
export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig { // 默认参数使用进程环境;Record 允许变量存在且为字符串,也允许变量未设置。
  // 默认读 Bun 已加载的 .env;测试可传入独立配置,不会碰真实凭据。
  const port = Number(env.GATEWAY_PORT ?? "3425"); // 环境变量是字符串,先转成数字;联调脚本传入 0 时,监听端口由系统分配。
  const proxyUrl = env.GATEWAY_PROXY_URL?.trim() || undefined;
  if (proxyUrl) {
    const proxy = new URL(proxyUrl);
    if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("GATEWAY_PROXY_URL 必须是 HTTP(S) 代理地址。");
  }

  // 每一项使用自己的地址和密钥;三组变量同时存在时,三家都会注册。
  const candidates: ProviderConfig[] = [
    { id: "openai", protocol: "openai-chat-completions", thinkingFormat: "unsupported",
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY ?? "" },
    { id: "bailian", protocol: "openai-chat-completions", thinkingFormat: "enable_thinking",
      baseUrl: env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: env.DASHSCOPE_API_KEY ?? "" },
    { id: "deepseek", protocol: "openai-chat-completions", thinkingFormat: "thinking",
      baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: env.DEEPSEEK_KEY || env.DEEPSEEK_API_KEY || "" },
  ];
  const providers = candidates.filter((p) => p.apiKey.trim()).map((p) => ({
    ...p, baseUrl: p.baseUrl.trim().replace(/\/+$/, ""), apiKey: p.apiKey.trim(),
  }));
  const registered = new Set(providers.map((p) => p.id));

  // 模型别名始终指向真实供应商,不会因增加另一家的密钥而改变指向。
  const modelMap: Record<string, string> = {};
  const deepseekModel = (env.DEEPSEEK_ID || env.DEEPSEEK_MODEL)?.trim();
  if (registered.has("bailian") && env.QWEN_MODEL?.trim()) modelMap.qwen = `bailian/${env.QWEN_MODEL.trim()}`;
  if (registered.has("deepseek") && deepseekModel) modelMap.deepseek = `deepseek/${deepseekModel}`;

  // 旧版百炼叫 openai。没有真实 openai 配置时,保留旧前缀和默认供应商写法。
  const providerAliases: Record<string, string> = {};
  if (!registered.has("openai") && registered.has("bailian")) providerAliases.openai = "bailian";
  const requestedDefault = env.DEFAULT_PROVIDER?.trim();
  const defaultProvider = requestedDefault
    ? providerAliases[requestedDefault] ?? requestedDefault
    : providers[0]?.id ?? "openai";
  if (requestedDefault && !registered.has(defaultProvider)) {
    throw new Error("DEFAULT_PROVIDER 指向未注册的供应商,请检查对应密钥配置。");
  }

  return { // 返回组装完成的配置,由 main.ts 用来启动网关。
    proxyUrl,
    port, // 属性简写,等价于 port: port,使用上面读取的端口。
    defaultProvider,
    providers, // 返回已启用的供应商列表;没有提供密钥时,它可能是空数组。
    modelMap,
    providerAliases,
  }; // 结束并返回 GatewayConfig 对象。
} // 结束配置读取函数。
