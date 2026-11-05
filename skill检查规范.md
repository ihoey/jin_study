你是资深前端架构与代码审查员。请审查用户级 Skill：

/Users/mujin/.codex/skills/diantou-project-norms/

必须逐字阅读以下三个文件：
- SKILL.md
- references/project-norms.md
- agents/openai.yaml

背景约束：
- 该 Skill 适用于 /Users/mujin/Projects/diantou 下的所有当前及未来项目，是共享规范基线。
- 规范不进入 Git 仓库、不写全局指令。
- 项目级 AGENTS.md、项目级 Skill、用户本轮明确要求，优先级高于本 Skill。
- 当前 Skill 以 react-cli / dcp-design-react 微应用模板为基线，但目录下可能有不同技术栈的项目。

请完成以下五项审查：

1. 内部冲突
   - 各条目之间是否互相矛盾，例如“路由一律懒加载”与“public 路由静态引入”。
   - 表述强度是否一致，例如“最好增加 tds-”与“必须增加 tds-”。

2. 与项目实现是否一致
   - 对照实际代码核实路径、常量、环境变量、命令、组件名。
   - 重点核对以下已发现的可疑点：
     a. config/app.conf.js 主应用 name 默认值（app 还是 dms）
     b. package.json engines 与流水线 Node 版本
     c. src/assets/css/variables.less 中主题 CSS 变量名
     d. src/modules/*/api/server.js 的实际请求前缀写法
     e. src/modules/test/routes/index.route.js 的 public 路由和 chunk 名
     f. src/modules/framework/pages/setting/index.jsx 的全局 less 导入
   - 每条差异必须给出：规范原文位置、项目文件及行号、证据、建议改法。

3. 逻辑合理性
   - 是否把模板约定误写成所有项目通用规则。
   - 是否有缺失的适用条件、例外或边界说明。
   - 每条规则是否可执行、可验证，是否包含无法证实的绝对判断。

4. 覆盖度
   - 找出缺失的基础规则，例如：
     - 状态管理组织
     - Mock 数据开关
     - 错误处理与空态
     - 安全（token、密码、日志、URL）
     - 命名与目录
     - 提交前验证流程
     - 生成目录与依赖锁文件
     - 发布与流水线边界

5. 提示词质量
   - description 是否精准且能正确路由。
   - SKILL.md 是否做到渐进式披露，不把细节堆在入口。
   - agents/openai.yaml 与 SKILL.md 是否一致。

输出要求：
- 先给 findings，按严重程度排序，每条带 `文件:行号`。
- 每条 finding 给出“建议新表述”，可直接复制使用。
- 最后列出“剩余风险 / 无法确认项”。
- 全程只输出审查结果，不修改任何文件。