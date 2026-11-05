// 管线位置:第 0 步 · 启动配置
// 职责:从环境变量读取端口、密钥、Provider 列表,交给 main.ts 组装。
export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
}

export interface GatewayConfig {
  port: number;
  defaultProvider: string;
  providers: ProviderConfig[];
  // 前端模型名 -> "provider/upstreamModel" 的别名表,第 3 步实现。
  modelMap: Record<string, string>;
}

export function loadConfig(): GatewayConfig {
  const port = Number(process.env.GATEWAY_PORT ?? "3425");

  const providers: ProviderConfig[] = [];
  if (process.env.OPENAI_API_KEY) {
    providers.push({
      id: "openai",
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return {
    port,
    defaultProvider: process.env.DEFAULT_PROVIDER ?? providers[0]?.id ?? "openai",
    providers,
    modelMap: {},
  };
}
