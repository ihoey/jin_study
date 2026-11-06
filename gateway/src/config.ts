// 管线位置:第 0 步 · 启动配置
// 职责:从环境变量读取端口、密钥、Provider 列表,交给 main.ts 组装。
export interface ProviderConfig { // 导出单个供应商的配置类型,供启动代码创建对应的 Provider 对象。
  id: string; // 供应商标识,例如 openai;路由层会用这个名称查找供应商。
  baseUrl: string; // 上游 API 的基础地址,例如 https://api.openai.com/v1。
  apiKey: string; // 访问上游接口时使用的密钥,由环境变量提供。
} // 结束单个供应商的配置类型定义。

export interface GatewayConfig { // 导出网关的完整配置类型,描述启动服务和建立路由所需的信息。
  port: number; // 网关 HTTP 服务监听的端口号。
  defaultProvider: string; // 客户端只传模型名、没有供应商前缀时,默认使用的供应商标识。
  providers: ProviderConfig[]; // 已配置的供应商列表,每一项都满足上面的 ProviderConfig 类型。
  // 前端模型名 -> "provider/upstreamModel" 的别名表,第 3 步实现。
  modelMap: Record<string, string>; // 模型别名映射表;Record<string, string> 表示键和值都是字符串。
} // 结束网关配置类型定义;接口只参与类型检查,不会创建运行时配置。

export function loadConfig(): GatewayConfig { // 导出读取配置的函数,调用时根据当前环境变量生成配置对象。
  const port = Number(process.env.GATEWAY_PORT ?? "3425"); // 环境变量未设置时使用默认端口 3425,再把字符串转成数字;这里没有额外验证端口是否合法。

  const providers: ProviderConfig[] = []; // 先创建空的供应商配置数组,后面只加入满足配置条件的供应商。
  if (process.env.OPENAI_API_KEY) { // 只有密钥是非空字符串时才启用 OpenAI 供应商;未设置或空字符串都会跳过。
    providers.push({ // 向供应商列表追加一份 OpenAI 配置,此处还不会发送上游请求。
      id: "openai", // 将供应商标识固定为 openai,与启动代码和路由层约定一致。
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", // 优先使用自定义上游地址,变量缺省时使用 OpenAI 官方地址。
      apiKey: process.env.OPENAI_API_KEY, // 保存刚刚确认存在的密钥,供 Provider 构造函数使用。
    }); // 结束配置对象,完成一次数组追加。
  } // 结束 OpenAI 供应商的启用判断。

  return { // 返回组装完成的配置,由 main.ts 用来启动网关。
    port, // 属性简写,等价于 port: port,使用上面读取的端口。
    defaultProvider: process.env.DEFAULT_PROVIDER ?? providers[0]?.id ?? "openai", // 依次选择环境变量、首个已配置供应商、字符串 openai;这个默认值本身不会创建供应商。
    providers, // 返回已启用的供应商列表;没有提供密钥时,它可能是空数组。
    modelMap: {}, // 当前使用空别名表,因此路由层会直接按客户端传入的模型名解析。
  }; // 结束并返回 GatewayConfig 对象。
} // 结束配置读取函数。
