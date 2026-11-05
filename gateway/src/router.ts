// 管线位置:第 2 步 · 路由
// 职责:把客户端要的模型名解析成 { provider, 上游模型名 }。
import type { ModelInfo } from "./types"; // 引入"模型信息"的类型定义(只用于类型标注)。
import type { Provider } from "./providers/base"; // 引入"供应商"的类型定义(只用于类型标注)。

export interface ResolvedRoute { // 定义"查到的结果"结构,像一张名片。
  provider: Provider; // 名片正面:由哪家供应商来服务。
  upstreamModel: string; // 名片背面:供应商那边的真实模型名。
}

export class Router { // 路由表,类比"前台通讯录"。
  constructor( // 构造函数:建通讯录时把三样东西塞进去。
    private readonly providers: ReadonlyMap<string, Provider>, // ①供应商名册(id -> 供应商对象),只读。
    private readonly modelMap: Readonly<Record<string, string>>, // ②别名表(客户叫法 -> 真实叫法),只读。
    private readonly defaultProvider: string, // ③默认供应商:客户没指定时找谁。
  ) {} // 函数体为空,只负责把上面的参数存成字段。

  resolve(model: string): ResolvedRoute { // 核心方法:把"客户要的名字"翻译成"名片"。
    const mapped = this.modelMap[model] ?? model; // 先查别名表;查不到就用原名(?? 表示"左边没有值就用右边")。

    // "provider/model" 或 "provider/model-version" 形式。
    const slash = mapped.indexOf("/"); // 看名字里有没有斜杠,并拿到斜杠的位置(没有则返回 -1)。
    if (slash > 0) { // 有斜杠且不在开头,说明客户点名了供应商。
      const providerId = mapped.slice(0, slash); // 斜杠前面的部分就是供应商 id。
      const provider = this.providers.get(providerId); // 去名册里找这家供应商。
      if (!provider) throw new Error(`unknown provider "${providerId}" for model "${model}"`); // 找不到就报错,像打给不存在的部门。
      return { provider, upstreamModel: mapped.slice(slash + 1) }; // 返回名片:供应商 + 斜杠后面的真实模型名。
    }

    // 裸模型名交给默认 provider。
    const provider = this.providers.get(this.defaultProvider); // 没斜杠,就找默认供应商。
    if (!provider) throw new Error(`no provider available for model "${model}"`); // 默认供应商也没配好,报错。
    return { provider, upstreamModel: mapped }; // 返回名片:默认供应商 + 名字原样当真实模型名。
  }

  async listModels(): Promise<ModelInfo[]> { // 把所有供应商的模型清单汇总成一张总表。
    const result: ModelInfo[] = []; // 准备一个空的结果列表。
    for (const provider of this.providers.values()) { // 逐个供应商问过去。
      result.push(...(await provider.listModels())); // 问一个,就把它返回的清单摊开(...)塞进总表。
    }
    return result; // 返回汇总好的总表。
  }
}
