# LLM Agent 结构化输出、校验体系与自修复机制

---

## 一、内容概要

核心围绕"如何让大模型输出可靠的结构化数据，并在进入 Agent Loop 之前完成校验"这一主线展开。讲解者从 OpenAI 原生结构化输出讲起，逐步深入到校验体系设计、模型自修复（Repair Loop）、异常分类处理、缓存降级，最后以一个知识库 Agent 为例总结最小闭环设计。

---

## 二、详细内容（按主题整理）

### 2.1 OpenAI 原生结构化输出

讲解者首先对比了两种结构化输出方式：

- **方式一：通过 Prompt + Pydantic 写结构化输出**（之前已讲过）
- **方式二：OpenAI 模型原生的 Structured Outputs**（API 层接收 Schema）

**原生结构化输出的用法**非常简单：在 API 调用时直接声明 `response_format` 为对应的 Pydantic 模型（如 `agent_decision`），SDK 会根据 Pydantic 模型自动生成 JSON Schema 并传给模型，同时自动把返回结果解析成 Python 对象。

**但原生结构化输出不是万无一失的**，需要特别注意：

1. **拒答（Refusal）**：模型可能因为安全策略拒绝回答，此时不会返回符合 Schema 的对象。
2. **输出达到上限（max_tokens）**：生成被截断时，JSON 不完整，无法解析。
3. **调用方必须自己检查请求是否正常完成**——原生结构化输出只提高了"生成结构的合规率"，但：
   - 不替你判断答案是否真实；
   - 不替你判断当前动作是否允许执行；
   - 使用不同模型时，仍需统一的校验层。

> **核心结论**：结构化输出解决的是"格式正确"问题，业务正确性仍需应用层校验。

---

### 2.2 校验体系设计

校验信息放在哪里？建议通过 **模型 Adapter 层** 把校验逻辑置于"模型返回"与"Agent Loop"之间。

#### 校验返回的数据结构

- 校验失败时：`decision` 为空，通过 `errors`（iso）字段保存错误位置、错误类型和错误说明。
- 校验成功时：返回完整的 decision 对象。

#### 三层校验边界

| 校验层次 | 校验内容 | 示例 |
|---|---|---|
| **第一层：语法校验** | JSON 格式是否正确 | 引号是否配对、括号是否闭合 |
| **第二层：字段校验** | 字段是否缺失、类型是否正确、是否存在定义外的动作 | 缺少 `query` 字段、`action` 不在允许列表内 |
| **第三层：业务校验** | 业务语义是否完整 | `finish` 动作但没有答案（空 answer） |

**关键原则**：任何一层校验不通过，都不能让结果进入最终的 Agent Loop。错误信息必须保留在失败层，处理完成后才能进入 Loop 执行。

---

### 2.3 模型自修复（Repair Loop）

校验失败后，可以把错误信息**反馈给模型**，让模型自己修正——这就是所谓的"自修复"或"自进化"。

#### 实现逻辑

把上一轮的输出 + 具体错误原因，放入下一轮的 Prompt 中：

> "上一轮校验出现错误：[具体错误位置和原因]。请保持原语义不变，仅修正 JSON 语法、字段类型和字段值，返回修正后的结果。"

#### 为什么有效

- 笼统地说"格式不对请重试"，模型效果很差；
- **必须告诉模型具体哪里错了、为什么错**，模型才能精准修复；
- 这就是"有效纠错"——有边界的修复。

#### 修复时的关键约束

1. **只改最小范围**：原始内容保持不变，只修正出错的语法和字段。避免模型在修复时"顺手"修改其他地方，产生副作用。
   - 类比：Coding Agent 改代码时经常只改错的地方，但会怀疑其他地方也不合理而一并修改——实际上那些可能是为了解决其他遗留问题故意写的。
2. **记录每次失败的原因**：避免模型连续犯同一个错误。
3. **设置最大修复次数**：讲解者示例中 `max_repair = 2`，即第一次生成 + 最多 2 轮修复 = 总共调用 3 次大模型。
4. **修复次数与正常调用次数要分开计数**：防止多执行一轮。
5. **达到修复预算上限仍失败**：抛出完整的异常记录，交由人工处理。

#### 哪些错误适合让模型修复？

| 错误类型 | 处理方式 | 原因 |
|---|---|---|
| 字段缺失 | ✅ 返回校验错误，让模型修 | 模型可以补全 |
| 类型错误 | ✅ 返回校验错误，让模型修 | 模型可以调整 |
| 字段组合冲突 | ✅ 返回校验错误，让模型修 | 模型可以重新组合 |
| 网络超时 / 限流 | ❌ 不适合喂给模型 | 用退避重试（有边界的） |
| 权限不足 | ❌ 不适合喂给模型 | 立即请求用户授权 |
| 知识库不可用 | ❌ 不适合喂给模型 | 停止服务、切换服务器或转人工 |

---

### 2.4 异常降级与缓存回退

修不了的时候怎么办？需要区分成功、降级、失败三种状态。

#### 状态设计

通过 `decision_result` 类来定义：

- **状态字段**：`OK`（模型合法决策）、`model_failed`（模型层失败）、`failed`（模型成功但执行层无结果）
- **来源字段**：标记结果来自哪里（实时生成 / 缓存等）

#### 缓存降级的适用条件

**缓存可以作为合法降级的情况**：操作对象处于**只读状态**。

> 示例：用 Agent 做 PPT。已经生成了 20 页 PPT，用户说"删掉第 10、11 页"。在模型真正执行删除操作之前（只是下了结构化指令），前面的 PPT 内容是只读的——这时候如果模型删错了（比如把第 15 页删成了第 17 页），可以回退到上一个缓存版本。

**缓存不能用的情况**：操作已经写下来了（非只读状态）。

> 示例：PPT 真的被删掉并进入了回收站，这时候回退不了，必须重新生成。

#### 版本与协议

引入缓存功能时，通常会带**协议版本号**，避免旧缓存与新代码不兼容。讲解者提到 GenSpark 的 PPT Agent 就是通过草稿箱 + 版本历史来实现"时光倒流"和恢复的。

---

### 2.5 完整的串联：修复 + 缓存 + 失败

把上述模块组合起来，整个处理逻辑变成：

```
1. 模型生成 → 校验
2. 校验失败？→ 有限次数内修复（Repair Loop）
3. 修复成功？→ 进入 Agent Loop
4. 修复失败？→ 检查是否有上一版本的缓存可用
5. 缓存可用？→ 使用缓存降级
6. 缓存不可用？→ 返回失败，人工处理
```

---

### 2.6 Schema 设计前的 5 个关键业务问题

设计输出 Schema 之前，先想清楚 5 个问题：

1. **谁**消费我们的输出？
2. 这个输出**决定了什么**？
3. **允许哪些动作**？
4. 每种动作**需要哪些数据**？
5. **失败了之后**怎么处理？

#### 示例：知识库 Agent

- **消费方**：下游的搜索和回答程序
- **动作**：`search_document`（搜索文档）、`finish`（结束回答）
- **数据**：`query`（搜索词）、`answer`（最终答案）
- **失败处理**：最多修复 2 次；读取失败时回退到上一版本缓存
- **字段设计**：只需要 `action`、`query`、`answer` 三个核心字段，足够下游消费即可，不用追求复杂。

---

### 2.7 标准最小 Loop 的两层校验

| 层次 | 校验什么 | 谁来做 |
|---|---|---|
| **外层：结构校验** | 字段结构是否正确、类型是否正确、协议是否符合 | 程序（Pydantic / Schema） |
| **内层：业务校验** | 内容是否真实、查询是否合理、用户是否有权限 | 业务逻辑 / 权限系统 |

**核心价值**：确保 Loop 在**工具调用之前**就停下来。如果结构化信息传错了，工具执行时必然拿到错误的参数，就像函数传了 4 个参数却需要 5 个一样——必然出错。提前拦住，避免跑了 8 小时才发现第一步就错了。

---

### 2.8 总结：Agent 开发工程师需要掌握什么

1. **能区分"合法的 JSON"和"符合业务协议的 JSON"**：
   - 合法的 = 语法正确
   - 符合业务 = 语法正确 + 内容正确 + 格式正确 + 类型正确 + 填充数据正确
2. **掌握工具**：Python 生态中用 Pydantic 生成 Schema、校验数据、创建对象。
3. **理解为什么原生结构化输出仍需处理拒答、截断和业务错误**。
4. **能区分不同错误类型**：格式错误、网络错误、权限错误——不能用一种重试机制全部兜住。
5. **保证未通过校验的输出不会触发工具调用**。

> **讲解者观点**：现在 Agent 开发的难度上升了——不是让模型输出一段长得像 JSON 的文本就行了，而是要让程序在进入 Loop 之前，确定动作字段、业务规则、重试预算、计划失败处理都是对的，并且你还得验证这个结果。

---

## 三、技术真实性验证报告

> 以下内容基于联网搜索，对录音中提到的关键技术点逐一核验。

### 验证结论总览

| 录音中的技术点 | 真实性 | 验证来源 |
|---|---|---|
| OpenAI 原生结构化输出（response_format 传 JSON Schema） | ✅ 属实 | OpenAI 官方 2024 年 8 月发布博客 |
| 拒答（refusal）和 max_tokens 截断导致无法解析 | ✅ 属实 | OpenAI 官方文档"Limitations and restrictions"章节 |
| Pydantic 生成 Schema + 校验 + 创建对象 | ✅ 属实 | Pydantic AI 官方框架 |
| 自修复 = 把具体错误反馈给模型 + 限制修改范围 | ✅ 属实 | CRITIC (ICLR 2024)、Reflexion 模式、多篇工程实践文章 |
| max_repair=2，总共调用 3 次 | ✅ 符合行业最佳实践 | 多篇文章指出 2 次重试性价比最高，3 次以上边际收益骤降 |
| 异常分类处理（网络超时/权限不足/知识库不可用） | ✅ 属实 | 标准工程模式，与 retry/fallback 设计一致 |
| GenSpark PPT Agent 的版本历史 / 草稿箱 / 回滚 | ✅ 属实 | GenSpark 官网及多篇评测确认有 History 面板、版本快照、undo/redo |
| 两层校验（结构层 + 业务层） | ✅ 属实 | Pydantic 校验层次 + 行业通用架构 |
| 只读操作可缓存降级，写操作不可回退 | ✅ 属实 | 标准工程设计模式 |

### 关键验证细节

#### 1. OpenAI Structured Outputs（官方确认）

OpenAI 于 2024 年 8 月 6 日发布 Structured Outputs 功能，通过 `response_format: {type: "json_schema", json_schema: {name, strict, schema}}` 传入。官方文档明确列出局限性：

> "The model can fail to follow the schema if the model chooses to refuse an unsafe request. If it chooses to refuse, the return message will have the `refusal` boolean set to true."
>
> "The model can fail to follow the schema if the generation reaches `max_tokens` or another stop condition before finishing."

这与录音中说的"拒达（拒答）或者输出达到指定的上限的时候，仍然可能得不到可用的这个解析对象"**完全一致**。

["https://openai.com/index/introducing-structured-outputs-in-the-api/"]

#### 2. Pydantic AI 框架

Pydantic 官方推出了 **Pydantic AI** 框架，专门用于构建类型安全的 AI Agent：

- 用 Pydantic `BaseModel` 定义输出类型；
- `Agent(model, output_type=Sentiment)` 一行声明；
- 自动生成 JSON Schema、自动校验返回、自动转成 Python 对象。

与录音中描述的"pandantic（Pydantic）能够生成我们的 Schema、校验我们的数据和创建 Python 对象"**高度吻合**。

["https://pydantic.dev/docs/ai/overview"]

#### 3. 自修复 / Repair Loop 的学术与工业验证

- **CRITIC 论文（ICLR 2024）**：提出"生成 → 工具校验 → 基于反馈修正"的循环模式，与录音描述的 Repair Loop 原理一致。
- **Reflexion 模式**：通过语言反馈进行自我修正，是 Agent 自修复的经典范式。
- **工程实践共识**：多篇文章指出"Self-correction is just a retry with a better error message"——自修复本质上就是带着详细错误信息的重试。
- **重试次数**：业界普遍推荐 2-3 次重试上限，"Two retries captures most of the lift; three doubles your cost and latency for ~1% extra success"——与录音中 `max_repair=2`（共 3 次调用）的建议一致。

["https://proceedings.iclr.cc/paper_files/paper/2024/file/fef126561bbf9d4467dbb8d27334b8fe-Paper-Conference.pdf","https://www.aitoolpipelines.com/articles/self-correcting-llm-agent-n8n","https://www.bestaiweb.ai/how-to-implement-retry-fallback-and-self-correction-loops-in-ai-agents-in-2026/"]

#### 4. GenSpark AI Slides 版本历史

GenSpark 确实提供 AI Slides 功能，并且：

- 有 History 面板，记录手动编辑和 AI 编辑的版本快照；
- 支持 Undo / Redo；
- 自动创建 Save Points（保存点），可以回滚到任意之前的版本；
- 2026 年 8 月的更新中进一步强化了版本管理能力。

与录音中举的"做 PPT 的 Agent，有草稿箱、有版本，可以通过版本控制实现时光倒流和恢复"**完全对应**。

["https://www.genspark.ai/zh-cn/business","https://getalai.com/de/blog/genspark-alternatives"]

---

## 四、参考来源

1. OpenAI. *Introducing Structured Outputs in the API*. 2024-08-06.
2. Pydantic. *Pydantic AI Documentation*. https://pydantic.dev/docs/ai/overview
3. Microsoft Azure. *How to use structured outputs with Azure OpenAI*.
4. CRITIC: Large Language Models Can Self-Correct with Tool-Interactive Critiquing. ICLR 2024.
5. Genspark. *AI Slides & History Panel*. 官方产品页.
6. *Retry, Fallback & Self-Correction in AI Agents*. Best AI Web, 2026.
7. *How to Build a Self-Correcting LLM Agent Workflow*. AI Tool Pipelines, 2026.

---

*文档生成时间：2026-11-03*
