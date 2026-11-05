# Agent 结构化输出：JSON Schema 校验与 Harness 工程实践

> 基于 2026-11-03 技术分享录音整理，经联网核查并补充解释。

---

## 一、为什么需要结构化输出

### 1.1 Prompt 的局限性

**核心认知**：Prompt 只能"表达期望"，不能代替程序"验收结果"。

- 大模型本质上是概率生成模型，即使你在 prompt 里反复强调"请输出 JSON"，它仍可能输出：
  - 带 markdown 代码块包裹的 JSON（` ```json ... ``` `）
  - 前后附带解释性文字
  - 字段名拼写错误、字段缺失或多余
  - 类型不匹配（把字符串 `"123"` 当作数字传过来）
- 不能依赖 Agent "随机输出"恰好合规——**偶发正确不等于可靠**。

### 1.2 自然语言解析的隐性风险

直接解析模型输出的自然语言来判断动作，是 Agent 开发中最危险的反模式之一：

> "最危险的是什么？就是它压根不报错，但选的动作或工具选错了。"

典型场景（录音中举例）：用户问"差旅报销需要什么材料"，你用关键字匹配判断调用哪个工具：
- 如果 prompt 里写的是"报销材料"，模型输出"差旅需要的单据"——关键字匹配不上，工具选错；
- 更糟的是程序不报错，只是默默调用了错误的工具，产出一个看似合理但完全无效的结果。

**结论**：必须用结构化输出（JSON）明确动作类型和参数，让程序走确定性分支，而不是靠模糊的自然语言解析。

---

## 二、结构化输出的核心流程

一个完整的结构化输出管线需要做 **四件事**：

| 步骤 | 职责 | 说明 |
|------|------|------|
| ① 定义 JSON 输出协议 | 约定字段、类型、约束 | 告诉模型"你应该长什么样" |
| ② 进入循环前校验输入 | 前置检查 | 确保每轮输入上下文本身合法 |
| ③ 字段缺失时的重写修复 | 纠错重试 | 校验失败后把错误信息回传模型，让它自我修正 |
| ④ 输出失败时的停止与降级 | 兜底策略 | 重试 N 次仍失败 → 停止 / 降级 / 报错 |

### 2.1 什么是 Harness 工程

> "一个 LLM 是大脑，套上 Harness 才是工程师。"

**Harness**（约束外壳）指围绕大模型的外层工程逻辑，负责三件事：

1. **验证（Validate）**：用 JSON Schema / Pydantic 校验模型输出是否合规
2. **拒绝（Reject）**：不合规的输出直接拒收，不进入下游执行
3. **恢复（Recover）**：把错误信息回传模型，触发自我修正重试

结构化输出模块就是模型输出与程序执行之间的**边界接口**——模型随便说，Harness 负责把它变成可信的数据。

---

## 三、Pydantic：结构化输出的核心工具

### 3.1 为什么是 Pydantic

录音中提到的"Pythonic 工具"就是 **Pydantic**。它解决了一个多端一致性问题：

在 Agent 开发中，你需要维护三份"长得像但其实不同"的东西：
- **JSON Schema**（给模型看的协议）
- **Python 类**（给程序用的数据结构）
- **解析校验代码**（把字符串变成对象的逻辑）

如果三份手写，人眼看一致但程序识别完全不同——Schema 改了代码没改，类加了字段 Schema 没同步，必出 bug。

**Pydantic 的价值**：让一份 Python 类定义同时承担四个职责：

```
类型定义 → Schema 生成 → 输出校验 → 反序列化
```

一份定义，处处同步，杜绝三方漂移。

### 3.2 一个最小例子

假设 Agent 需要判断下一步是"搜索"还是"结束回答"，定义如下：

```python
from pydantic import BaseModel, ConfigDict, field_validator
from typing import Literal, Optional

class AgentDecision(BaseModel):
    # 开启严格模式 + 禁止额外字段
    model_config = ConfigDict(strict=True, extra="forbid")

    # ① 字段类型约束：action 只能是 search 或 finish
    action: Literal["search", "finish"]
    # query 为搜索词，answer 为最终答案
    query: Optional[str] = None
    answer: Optional[str] = None
```

### 3.3 三层校验约束规则

录音中提到的三层校验，对应 Pydantic 的三种校验机制：

#### 第一层：字段类型约束
- 用 `Literal["search", "finish"]` 把动作限制为枚举值，模型不能自创 `navigate`、`click` 等动作
- 字段类型用 `Optional[str]` 明确"字符串或空值"

#### 第二层：字段本身规则约束
- 限制查询词长度、答案长度（用 `Field(max_length=...)`）
- `extra="forbid"`：**禁止模型临时添加字段**（如突然多输出一个 `reason` 字段）
- `strict=True`：**开启严格模式**，校验出错立即报错，不自动兼容错误

> 录音原话："校验不对，那就是你前面传的不对，前面去改，而不是我在后边去兼容它。"
>
> 这句话的工程含义是：**拒绝静默容错**。Pydantic 默认宽松模式会尝试类型强制转换（比如把字符串 `"123"` 转成整数 123），但在 Agent 场景下，这种"善意"的转换会掩盖模型的输出错误。严格模式下类型不匹配直接报错，问题暴露在前面，而不是被下游默默吞掉。

#### 第三层：跨字段条件约束
- 当 `action == "finish"` 时，`answer` 字段必须有值，否则判定为输出不合法
- 用 `@model_validator` 实现：

```python
from pydantic import model_validator

class AgentDecision(BaseModel):
    action: Literal["search", "finish"]
    query: Optional[str] = None
    answer: Optional[str] = None

    @model_validator(mode="after")
    def check_finish_has_answer(self):
        if self.action == "finish" and not self.answer:
            raise ValueError("finish 动作必须提供 answer 字段")
        if self.action == "search" and not self.query:
            raise ValueError("search 动作必须提供 query 字段")
        return self
```

---

## 四、Schema 生成与 JSON 校验

### 4.1 从类生成 JSON Schema

**不用手写 Schema 文件**——实例化类后调用 `model_json_schema()` 即可：

```python
schema = AgentDecision.model_json_schema()
print(schema)
# 输出标准 JSON Schema，可直接传给 OpenAI response_format 或 Azure 等
```

**好处**：Schema 永远和类定义同步，不会出现"改了类忘改 Schema"的问题。

### 4.2 校验 JSON 并生成 Python 对象

```python
from pydantic import ValidationError

try:
    decision = AgentDecision.model_validate_json(
        '{"action": "search", "query": "差旅报销材料"}'
    )
    # ↑ 一行完成三件事：
    #   1. JSON 字符串解析
    #   2. 全部规则校验（类型、枚举、跨字段约束）
    #   3. 生成 AgentDecision Python 对象
    print(decision.action)   # "search"
    print(decision.query)    # "差旅报销材料"
except ValidationError as e:
    print(e.errors())  # 详细错误信息
```

---

## 五、校验异常的处理

### 5.1 异常捕获

用 `try...except ValidationError` 包裹校验调用，Pydantic 会输出结构化的错误详情：

```python
try:
    decision = AgentDecision.model_validate_json(raw_output)
except ValidationError as e:
    # e.errors() 返回错误列表，每条包含：
    # - loc: 错误发生位置（哪个字段）
    # - type: 错误类型（missing / extra_forbidden / literal_error 等）
    # - msg: 人类可读的错误原因
    # - input: 模型实际传进来的值
    for err in e.errors():
        print(f"字段 {err['loc']}: {err['msg']} (收到: {err['input']})")
```

### 5.2 异常信息的工程价值

Pydantic 的错误信息不是"校验失败"一句话，而是精确定位：

| 错误场景 | 错误类型 | 含义 |
|----------|----------|------|
| 字段缺失 | `missing` | 模型忘了输出某个必填字段 |
| 动作越界 | `literal_error` | action 不是 search/finish，自创了新动作 |
| 类型错误 | `string_type` | 该传字符串传了数字/布尔值 |
| finish 无答案 | 自定义 validator | 跨字段约束违反 |
| 多余字段 | `extra_forbidden` | 模型临时加了没定义的字段 |

**核心优势**：无需复现原始上下文就能知道哪里错了——错误信息本身就是调试线索。

---

## 六、进阶：自动重试与自我修正

### 6.1 Instructor 模式

录音中提到的"校验失败后重写修复"，在业界已经有成熟的开源实现——**Instructor** 库。

工作流程：

```
LLM 输出 → Pydantic 校验 → 通过？
                            ├─ 是 → 返回结构化对象
                            └─ 否 → 把 ValidationError 格式化成自然语言
                                    → 追加到对话历史
                                    → 重新调用 LLM
                                    → 再校验...（最多 max_retries 次）
```

Instructor 的核心思路：**模型不知道自己错在哪，你得把错误告诉它**。

典型的重试 prompt 片段：

```
上次输出校验失败，错误信息：
- 字段 answer: 当 action=finish 时必须提供（收到: null）
请修正后重新输出。
```

大多数模型在第一次收到错误反馈后就能自我修正，**生产环境自校正率可达 90% 以上**。

### 6.2 重试策略建议

- **有限重试**：通常不超过 3 次——如果 3 次都不对，大概率是 Schema 设计有歧义或任务本身太模糊，继续重试只是烧钱
- **指数退避**：每次重试间隔递增（0.5s → 1s → 2s），避免触发 API 限流
- **明确失败**：超过重试上限后要果断停止，走降级路径（返回兜底结果 / 转人工 / 报错退出）

---

## 七、与主流平台结构化输出的关系

录音中讲的是"手动用 Pydantic 校验"的路线，实际上各大 LLM 平台也提供了原生的结构化输出能力：

| 平台 | 方式 | 说明 |
|------|------|------|
| OpenAI | `response_format={"type": "json_schema", ...}` | 模型原生保证输出合规 JSON |
| Azure OpenAI | `JsonSchemaFormat(schema=Graph.model_json_schema())` | 与 Pydantic 配合 |
| 阿里云百炼 | JSON Schema 模式 | 确保输出标准 JSON |
| Anthropic | Tool Use / Tool Calling | 通过工具调用实现结构化 |

**关键认知**：即使平台提供了原生结构化输出，**你仍然需要在程序侧用 Pydantic 再校验一遍**——因为：
1. 原生结构化输出的 Schema 表达能力有限（复杂跨字段约束支持不好）
2. 不同平台的严格程度不同，不能完全信任
3. 防御性编程：多一层校验，少一次线上事故

Pydantic 是你自己掌控的最后一道防线，不依赖任何平台特性。

---

## 八、金句回顾

> 「Prompt 只能表达一个期望，不能替我们的程序去验收结果。」

—— 结构化输出的根本动机：把"相信模型"变成"验证模型"。

> 「最危险的是它压根不报错，但选的动作或工具选错了。」

—— 隐性错误比显性错误更可怕。自然语言解析的静默失败是 Agent 可靠性的头号杀手。

> 「校验不对，那就是前面传的不对，前面去改，而不是我在后边去兼容它。」

—— 严格模式的设计哲学：错误要尽早暴露、在源头修复，不要用下游的兼容性掩盖上游的输出质量问题。

---

## 九、术语速查

| 术语 | 含义 |
|------|------|
| **JSON Schema** | 描述 JSON 数据结构的规范，定义字段、类型、约束 |
| **Pydantic** | Python 数据校验库，用类型注解定义模型并自动校验 |
| **model_json_schema()** | Pydantic v2 方法，从模型类生成 JSON Schema |
| **model_validate_json()** | Pydantic v2 方法，校验 JSON 字符串并生成模型实例 |
| **strict mode** | Pydantic 严格模式，不做类型强制转换，类型不匹配直接报错 |
| **extra="forbid"** | Pydantic 配置，禁止模型接收未定义的额外字段 |
| **ValidationError** | Pydantic 校验失败时抛出的异常，包含详细错误列表 |
| **Harness** | 围绕 LLM 的外层工程，负责验证、拒绝、恢复模型输出 |
| **Instructor** | 开源库，封装了 Pydantic 校验 + 自动重试的结构化输出模式 |
| **Literal** | Python typing 类型，限定取值只能是指定的几个字面量 |
