# Roadmap

1. **Foundation**：双仓库、格式 v1、validator、dry-run planner、Mac/Linux 校验、Linear DEV/FOCUS 分工。
2. **Capture writer**：授权入口→稳定请求→私有 Issue→唯一请求分支/PR→合并读回→已入库；重试、冲突恢复与回写。财务确认单独授权。本地授权闭环已实现；私有仓库远端写入、GitHub↔Linear 同步和 confirmed 账目仍待单独启用。
3. **Daily use**：收件箱、收藏检索、生活事项及可重建查询索引；真实样本验收、备份恢复。本地只读查询、以 vault 文件为准的样本验收，以及本地 git bundle 备份恢复已实现。公开仓库只验收合成样本；真实资料必须由调用方传入 `--vault`，不能写入本仓库。私有远端写入、GitHub↔Linear 同步和 confirmed 账目仍未启用。
4. **Context views**：真实地点匹配与人工确认、收藏地图、设计片段与参考包。
5. **Events**：受限 MCP 工具、持久订阅、调度、事件重投与监控；地图/UI 作为可选插件界面。

正式记录以 vault 文件为准。录入请求完成与生活事项完成分别维护。预算不是支出，摘要不是原文备份，CI 成功不是 Codex/Dots 实测。
