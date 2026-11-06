// 管线位置:第 0 步 · 启动配置
// 职责:从环境变量读取端口、密钥、Provider 列表,交给 main.ts 组装。
export interface ProviderConfig { // 导出单个供应商的配置类型,供启动代码创建对应的 Provider 对象。
  id: string; // 供应商标识,例如 openai;路由层会用这个名称查找供应商。
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
} // 结束网关配置类型定义;接口只参与类型检查,不会创建运行时配置。

// 执行顺序:确定端口 → 注册原有上游 → 独立注册 DeepSeek → 设置别名 → 返回。
// env 是可替换的输入:正式启动时不传参数,测试时传假配置,同一个函数就能用于两种场景。
export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig { // 默认参数使用进程环境;Record 允许变量存在且为字符串,也允许变量未设置。
  // 默认读 Bun 已加载的 .env;测试可传入独立配置,不会碰真实凭据。
  const port = Number(env.GATEWAY_PORT ?? "3425"); // 环境变量是字符串,先转成数字;联调脚本传入 0 时,监听端口由系统分配。
  const proxyUrl = env.GATEWAY_PROXY_URL?.trim() || undefined;
  if (proxyUrl) {
    const proxy = new URL(proxyUrl);
    if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("GATEWAY_PROXY_URL 必须是 HTTP(S) 代理地址。");
  }

  const providers: ProviderConfig[] = []; // 先创建空的供应商配置数组,后面只加入满足配置条件的供应商。
  // OpenAI 兼容协议也可以连接百炼。成对选择地址和密钥,避免把百炼密钥发往其他服务。
  const useOpenAI = Boolean(env.OPENAI_API_KEY); // 非空 OPENAI_API_KEY 优先:两套凭据同时存在时,本次只启用 OPENAI_* 这一套。
  const apiKey = useOpenAI ? env.OPENAI_API_KEY : env.DASHSCOPE_API_KEY; // 按刚才的选择取密钥,不要与另一套服务的地址混搭。
  const baseUrl = useOpenAI // 地址必须沿用与 apiKey 相同的选择条件;这里是在选一个上游,并未同时注册两家供应商。
    ? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1" // 选择 OPENAI_* 时,缺省地址指向 OpenAI;自定义地址仍按调用者配置使用。
    : env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"; // 否则选百炼兼容地址,复用已有的 Chat Completions 适配代码。
  if (apiKey) { // 确实有选中的密钥才追加配置;两组都没设置时,网关仍能启动,但供应商列表为空。
    providers.push({ // 向供应商列表追加一份 OpenAI 配置,此处还不会发送上游请求。
      id: "openai", // 这里是当前适配器的注册标识;连接百炼时仍叫 openai,不表示一定请求 OpenAI 官方服务。
      baseUrl: baseUrl.replace(/\/+$/, ""), // 删除地址末尾一个或多个斜杠,避免后面拼接 /chat/completions 时出现双斜杠。
      apiKey, // 属性简写,保存同一分支选出的密钥;此处不验证密钥是否有权限。
    }); // 结束配置对象,完成一次数组追加。
  } // 结束当前 OpenAI 兼容供应商的启用判断。

  // DeepSeek 独立注册,不会覆盖百炼的地址或密钥。兼容你已有的 KEY/ID 命名。
  const deepseekKey = env.DEEPSEEK_KEY || env.DEEPSEEK_API_KEY;
  const deepseekModel = env.DEEPSEEK_ID || env.DEEPSEEK_MODEL;
  if (deepseekKey) {
    providers.push({
      id: "deepseek",
      baseUrl: (env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, ""),
      apiKey: deepseekKey,
    });
  }

  // 别名只指向已注册的供应商。最终的真实模型名仍由 .env 决定。
  const modelMap: Record<string, string> = {};
  if (apiKey && !useOpenAI && env.QWEN_MODEL) modelMap.qwen = `openai/${env.QWEN_MODEL}`;
  if (deepseekKey && deepseekModel) modelMap.deepseek = `deepseek/${deepseekModel}`;

  return { // 返回组装完成的配置,由 main.ts 用来启动网关。
    proxyUrl,
    port, // 属性简写,等价于 port: port,使用上面读取的端口。
    defaultProvider: env.DEFAULT_PROVIDER ?? providers[0]?.id ?? "openai", // 依次选择环境变量、首个已配置供应商、字符串 openai;这个默认值本身不会创建供应商。
    providers, // 返回已启用的供应商列表;没有提供密钥时,它可能是空数组。
    modelMap,
  }; // 结束并返回 GatewayConfig 对象。
} // 结束配置读取函数。
