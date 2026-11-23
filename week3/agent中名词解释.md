## state（状态机）
state（状态机）本身是一个对象，不是单纯一个字符串字段；字符串枚举只是它里面的一个核心字段。
// 示例 Zod / Pydantic 结构
type TaskState = {
  // ✅ 核心枚举：主状态（大家口语说的那个state字段）
  status: "idle" | "running" | "waiting_approval" | "completed" | "aborted" | "timeout";

  // 状态变迁元信息
  statusUpdatedAt: number;       // 上一次状态变更时间戳
  statusReason: string;          // 变更原因：need_approval / user_cancel / budget_exhaust
  prevStatus: TaskStatus;        // 上一个状态，方便回溯、防非法跳转

  // 状态机约束规则（权限/锁）
  locked: boolean;               // 是否锁住，禁止并发变迁
  allowedNextStatus: TaskStatus[]; // 合法下一跳，用来做状态机校验（防止乱跳）

  // 关联快照指针（和Checkpoint、审批联动）
  pendingApprovalId?: string;    // 如果是 waiting_approval，指向待审批动作ID
  activeCheckpointId?: string;   // 当前绑定的检查点ID
};

#### 区分3层
1. **status（字符串枚举）**：只是 `running / waiting_approval`，是 State 对象里的**一个属性**
2. **State 对象**：承载状态值 + 变迁元数据 + 跳转约束，属于**任务顶层状态**，跨轮次长期保存在 Checkpoint 里
3. **状态机引擎（State Machine）**：是操作这个对象的逻辑，**不是数据** 负责校验状态不能跳
   - 输入：当前 State 对象 + 事件（tool_done /user_approve/timeout）
   - 输出：新 State 对象 + 校验是否允许跳转
   - 比如：`waiting_approval` 不能直接跳到 `completed`，必须先到 `running`


## checkpoint
是恢复快照，存【续跑这个任务必须的全部状态】，不存完整的审计流水，不存全量的历史消息。只存当前现场
设计策略：大对象（Evidence、Plan 本体）尽量**存索引引用**，避免快照膨胀；只有小的、必须立刻恢复的才内嵌。

```
/**
 * Checkpoint 完整快照结构
 * 会话唯一，默认维护一份 active 快照；审批断点会锁定独立快照
 */
type Checkpoint = {
  // ========== 快照元信息（快照自身标识） ==========
  checkpointId: string;               // 快照唯一ID
  sessionId: string;                    // 归属会话ID
  createdAt: number;                   // 快照生成时间戳
  triggerReason:
    | "init"
    | "after_tool_call"
    | "waiting_approval"
    | "timeout"
    | "user_abort"
    | "manual_save";
  prevCheckpointId?: string;            // 上一个快照ID（做快照链时用，单活跃模式可空）
  version: string;                      // 快照结构版本，用于兼容升级

  // ========== 任务状态机 State 对象（你刚才问的重点） ==========
  state: {
    status: "idle" | "running" | "waiting_approval" | "completed" | "aborted" | "timeout";
    statusUpdatedAt: number;
    statusReason: string;
    prevStatus?: string;
    locked: boolean;
    allowedNextStatus: string[];
    pendingApprovalId?: string;         // 待审批动作ID，waiting_approval 才有
    activeCheckpointId?: string;
  };

  // ========== 执行上下文快照（本轮/当前运行现场，内存上下文冻结后的副本） ==========
  executionContext: {
    messageChainSnapshot: Array<{
      role: "user" | "assistant" | "tool";
      content: string;
      toolCallId?: string;
      toolResultId?: string;
    }>;
    currentPlanStepId?: string;          // 当前正在执行的plan步骤ID
    tokenBudget: {
      used: number;
      max: number;
    };
    turnBudget: {
      used: number;
      max: number;
    };
    abortSignalMark: boolean;            // 是否已经标记中断
    // 本轮临时变量，只存恢复必须的，大量临时计算值不进快照
  };

  // ========== Plan 计划：存引用，不存全量历史计划 ==========
  planRef: {
    planId: string;
    stepList: Array<{
      stepId: string;
      title: string;
      status: "pending" | "doing" | "success" | "failed";
      evidenceIds: string[];             // 本步骤绑定的证据ID列表
    }>;
  };

  // ========== Evidence 证据：只存索引，证据本体独立在证据库 ==========
  evidenceRefs: string[];               // 所有当前生效证据ID数组

  // ========== 工作区 & 环境指纹（恢复校验核心，防现场不一致） ==========
  workspaceFingerprint: {
    root: string;
    fileHashMap: Record<string, string>; // 关键文件路径 -> sha256
    uncommittedPatch?: string;           // 未提交补丁摘要（审批场景）
  };

  // ========== 待审批动作（只有进入 waiting_approval 才填充） ==========
  pendingApproval?: {
    approvalId: string;
    toolName: string;
    toolArguments: Record<string, any>;
    fingerprint: string;
    description: string;
  };

  // ========== 沙箱/权限策略快照（恢复时要复用相同权限） ==========
  sandboxPolicy: {
    readAllow: string[];
    writeAllow: string[];
    networkAllow: boolean;
  };

  // ========== 审计关联：只记录本次快照事件ID，不塞完整审计日志 ==========
  relatedAuditEventId: string;
};

```
**恢复时加载顺序**

1. 加载 Checkpoint JSON
2. 读取 state，校验状态机跳转合法性
3. 读取 workspaceFingerprint，比对磁盘真实文件，校验现场是否一致
4. 通过 planRef /evidenceRefs 拉取计划和证据
5. 用 executionContext 重建内存里新的执行上下文、消息链、预算
6. 重建沙箱策略，交给 Loop 继续跑

## 现场是什么
现场 = 执行动作对应外部真实资源状态，不是内存里state,不是checkpoint快照  
分为3块:工作区资源、未决动作。授权&证据
1. **工作区资源（文件、目录、产物）**
   - 文件：源码、配置、生成报告、补丁、日志，文件是否存在、内容、md5、修改时间
   - 目录：是否创建、权限
   - 沙箱侧：进程、端口、服务是否还在运行
2. **未决动作（in-flight /pending 副作用）**
   - 已经发出去但没收到最终回执的调用：外部 API、数据库写、Git push、提交工单
   - 有没有幂等 ID、事务 ID、操作流水号可以查询
3. **证据与授权上下文**
   - 证据：之前拿到的查询结果、文件摘要、接口返回数据，现在是否还成立
   - 授权：token、临时权限、HITL 审批、资源访问权限有没有过期
> 
> 一句话：Checkpoint 是 “我以为当时是什么样”；现场是 “现在真实是什么样”。

#### 怎么核对
前提：超时。断开，结果模糊-》结果不明，进入核对现场。只能是**只读，幂等，无副作用**

#### 核对现场不等于恢复校验
- 核对现场是单次动作中断后，立刻查当前动作有没有落地：只查关联本次动作的资源
- 恢复校验：隔很久从checkpoint重启任务，批量校验全部旧证据，全部授权，整个工作区，范围更大

## 证据&授权
- **证据（evidence）**：Agent 做决策的事实依据；存在 **证据池 evidence pool**，跟着 checkpoint 一起持久化
- **授权（authorization）**：能不能执行某个动作的权限、审批许可；存在 **上下文 / 审批记录**，也会写入 checkpoint，但它本身不属于证据，是执行动作的准入条件
#### 一、证据 evidence：在哪里体现？

证据池里放的，是**已经确认过的事实材料**，Agent 靠它推理、规划、判断能不能继续往下走：
✅ 例子（Coding Agent）

- 文件哈希、文件 diff、目录列表
- 接口查询返回结果、命令行输出
- 之前探查现场得到的 probe 结果
- 人工审批给出的结论
- 工具返回的结构化数据

**存储位置**：
Checkpoint 快照里单独一块 `evidence: Evidence[]`，每条证据有：

- id
- 内容摘要
- 生成时间
- 来源（tool/probe/human）
- 有效期（可选）

**什么时候校验证据**

1. 核对现场（阶段 2）：新增一条探查结果，作为新证据加入证据池
2. 任务恢复（阶段 4）：遍历旧证据，判断是否失效：
   - 文件证据：文件已经被外部改动 → 证据失效，剔除
   - 临时查询结果：时效性很强（比如接口配额、版本列表）→ 过期失效
   - 证据失效之后，Agent 不能再拿这条证据做推理，需要重新探查获取新证据

> 
> 面试一句话：证据是 Agent 的 “记忆事实”，恢复的时候要淘汰过期事实，防止基于过时信息做错误规划。
#### 二、授权 authorization：在哪里体现？

授权是**执行动作的许可凭证**，不是事实。
✅ 例子

- API token、密钥、临时访问凭证
- HITL 人工审批记录（“允许修改这个文件”、“允许执行 shell”）
- 资源访问范围、沙箱白名单路径权限
- 角色权限、工具调用许可

**存储位置**：
放在 checkpoint 的 `context.auth`，不进 evidence 证据池（权限≠事实）；
授权记录本身也会写入审计日志。

**什么时候校验授权**

1. 每次调用工具前（前置拦截）：校验当前是否有对应授权
2. 【阶段 4 恢复的时候重点校验】：
   - token 过期、临时审批时效到期、人工许可只一次性生效
   → 授权失效，即便证据没问题，动作也不能执行，需要重新申请 HITL 审批或者刷新凭证
3. 核对现场（阶段 2）：探查动作本身也需要读权限，探查失败有可能不是资源不存在，而是**授权不足**（很容易踩坑）

## 真实执行层
## 真实执行层包含哪些（按 Coding Agent 场景）

1. **沙箱内执行单元**

> 
> 特点：一旦启动，它自己不感知上层 JS/Python 的 AbortSignal，如果你不杀进程、不终止容器，它会跑完。
   - 正在运行的 Shell / 进程（npm install、编译脚本、git 命令）
   - 文件写入、补丁写入、目录修改操作
   - 沙箱容器本身、容器内子进程
2. **模型远端请求流**

> 
> 只在本地把 response 扔掉没用，要发中断信号给网关 / 模型服务，停止推理、停止计费。
   - 正在进行的流式 LLM 请求（SSE /stream）
   - 还在排队、正在后端推理的模型调用
3. **外部第三方工具调用**

> 
> 部分外部 API 支持 cancel/rollback；不支持的，至少要记录【取消发出时动作是否已经提交】，留给后续核对现场。
   - 向外发出的 HTTP API（创建工单、云资源、Git push）
   - 数据库事务、消息队列投递
4. **子 Agent / 嵌套 Harness 实例（HITL 审批之后拉起的子任务）**

> 
> 取消信号要向下透传给所有子 Harness，不能只停在父层。
   - 子 Loop、子 Planning 任务、并行工具组

✅ 对比上层（不属于真实执行层）：

- Agent Loop、Planning 模块、Harness 状态机、Checkpoint、证据池、日志模块
这些只是**调度和记录层**，它们负责发取消指令，但本身不会产生副作用。

AbortSignal 是**传递取消信号的载体**，不等于真实执行层。 
- 在 TS 里：Harness 收到 cancel，触发 signal.abort；
- 如果工具 Runtime 只是监听 signal、不再回调，但是没有杀掉沙箱进程 → **依然没有传到真实执行层**。
