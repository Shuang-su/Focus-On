# Linear preparation and routing

研发使用 Development (`DEV`)，私人录入使用 Focus On (`FOCUS`)。DEV 是原 SPA Team 的改名，保留 Team UUID、既有任务和状态。FOCUS 是本轮新建 Team，旧草案 key LIFE 已按用户要求改名；Team UUID 与处理状态不变。具体接入 ID 与实际设置保存在私有 vault。

| Context | Repository | Behavior |
|---|---|---|
| DEV | Metaflow | 保留原规划的双向 Issue 同步目标，启用待验收 |
| DEV / Focus On — 基础建设 | public focus-on | 研发 PR 用 `relates to DEV-n`；可选 GitHub → DEV 单向 Issue 同步 |
| FOCUS / Focus On | private focus-on-vault | 私人录入请求的双向 Issue 同步目标，启用待验收 |

FOCUS 状态：待处理(unstarted/default)、处理中(started)、待补充(backlog)、待合并(started)、待核验(started)、已入库(completed)、已取消(canceled)。保留内置 Duplicate。合并先进入待核验；写入器读回 main 后才能回写已入库。待办、预购、地点与账目业务状态保存在数据文件。已关闭父任务、子任务及长期未更新请求的自动关闭。

GitHub 原生集成允许多个仓库向同一 Team 单向同步，但每个 Team 同时只有一个双向同步仓库。DEV 双向目标为 Metaflow；启用后在 Linear 新建的 DEV Issue 会进入 Metaflow，Project 名称不改变目标。Focus On 本体研发 Issue 应从公开 GitHub 仓库创建，再单向同步或人工关联到 DEV，不能假设在 DEV 的 Focus On Project 新建 Issue 会自动进入 focus-on。现有 DEV-5 至 DEV-10 在启用前建立，不会自动同步历史 Issue。[Linear 官方说明](https://linear.app/docs/github)

仅追加明确仓库授权，保护已有授权；私人内容不得出现在公开仓库的 Issue、PR 或 Linkbacks。普通 Team 对工作区成员可见，私有 vault 不等于 Linear 隐私隔离。本轮完成 Team 设置及准备材料，GitHub Issue 同步尚未启用。

## Acceptance

1. 读回工作区、Team UUID/key、Project 和每个状态，检查 DEV 双向目标为 Metaflow，只有 FOCUS 指向私有 vault。
2. 在后续启用验收中，用标记 synthetic 的录入请求在 FOCUS 创建测试 Issue，确认私有 GitHub Issue 内容与标识。检查公开仓库没有该内容。
3. PR 关联后检查待合并/待核验；只有 main 内容读回一致后才能关闭录入请求。
4. 重试复用请求 ID；关闭录入请求不会改动生活任务状态。本地 writer 用合成资料覆盖这一条；真实 FOCUS 路由仍待同步启用后验收。

原生同步和 writer 的实际开通分别记录。本地 writer 已能完成录入闭环；它不调用 Linear，也不启用 GitHub Issue 同步。[Official GitHub integration](https://linear.app/docs/github)

## Writer state hook

`capture` 在本地 Issue 上记录 FOCUS 状态名称。`linear.sync` 固定为 `disabled`，不保存 Team UUID、密钥或真实 Linear URL。

| 写入阶段 | 本地 FOCUS 状态 | 回执 |
|---|---|---|
| 请求已保存、Issue 已建立 | 待处理 | 尚未 stored |
| 唯一请求分支已提交 | 处理中 | 尚未 stored |
| 唯一 PR 已建立、等待合并 | 待合并 | 尚未 stored |
| 已合并、等待读回 | 待核验 | 尚未 stored |
| main 读回一致并写回执 | 已入库 | stored / verified=true |
| 基准或输入冲突 | 待补充 | 不写 stored，不覆盖数据 |
| 请求中止 | 已取消 | 保留名称；writer 不自动取消生活事项 |

准备材料里的 PR 打开、审阅、合并映射仍是未启用的 Linear 工作流。writer 只有在 main 读回成功后才把本地状态写成已入库。关闭录入 Issue 不修改待办、预购或财务业务状态。

日常查询不改变这张表。`inbox`、`search`、`life`、`index` 和 `accept` 只读 vault 文件，不回写 FOCUS 状态，也不调用 Linear。录入回执里的 stored 和生活事项里的 done 仍然是两套状态。

`places`、`match-place`、`map` 和 `fragments` 同样不回写 FOCUS 状态。`confirm-place` 复用本地录入闭环，因此会在本地 Issue 上走同一张状态表，并把 `linear.sync` 保持为 disabled。它不调用 Linear。地点的 confirmed 写在地点记录里，不改变待办、预购或财务状态。

`events` 不回写 FOCUS 状态，也不调用 Linear。录入回执里的 stored 和生活事项里的 done 仍然是两套状态；事件日志可以分别观察它们，但投递不会把其中一套写成另一套。
