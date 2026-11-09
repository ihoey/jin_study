// 管线位置:第 4 步 · Provider 契约
// 职责:定义 Provider 接口。加一个新厂商 = 新建一个实现该接口的类,
//       chat() 吐统一的 StreamEvent 流,别的地方不用改。
import type { ChatRequest, ModelInfo, StreamEvent } from "../types";
import type { UpstreamProtocol } from "../config";

export interface Provider {
  readonly id: string;
  readonly protocol: UpstreamProtocol;
  listModels(): Promise<ModelInfo[]>;
  // 所有 Provider 的 chat() 都吐统一的 StreamEvent 流,不管上游是不是流式。
  chat(req: ChatRequest): AsyncGenerator<StreamEvent>;
}
