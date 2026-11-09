// 启动装配步骤:配置决定使用哪个协议实现;供应商名称不参与适配器选择。
import type { GatewayConfig, ProviderConfig } from "../config";
import type { Provider } from "./base";
import { OpenAIChatProvider } from "./openai";

export function createProvider(config: ProviderConfig, proxyUrl?: string): Provider {
  switch (config.protocol) {
    case "openai-chat-completions": return new OpenAIChatProvider(config, proxyUrl);
    default: throw new Error("供应商配置了尚未支持的协议。");
  }
}

export function createProviders(config: GatewayConfig): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  for (const item of config.providers) {
    if (providers.has(item.id)) throw new Error("供应商 id 重复。");
    providers.set(item.id, createProvider(item, config.proxyUrl));
  }
  return providers;
}
