# Roadmap

1. **Foundation**：双仓库、格式 v1、validator、dry-run planner、Mac/Linux 校验、Linear DEV/FOCUS 分工。
2. **Capture writer**：授权入口→稳定请求→私有 Issue→唯一请求分支/PR→合并读回→已入库；重试、冲突恢复与回写。财务确认单独授权。本地授权闭环已实现；私有仓库远端写入、GitHub↔Linear 同步和 confirmed 账目仍待单独启用。
3. **Daily use**：收件箱、收藏检索、生活事项及可重建查询索引；真实样本验收、备份恢复。本地只读查询、以 vault 文件为准的样本验收，以及本地 git bundle 备份恢复已实现。公开仓库只验收合成样本；真实资料必须由调用方传入 `--vault`，不能写入本仓库。私有远端写入、GitHub↔Linear 同步和 confirmed 账目仍未启用。
4. **Context views**：真实地点匹配与人工确认、收藏地图、设计片段与参考包。离线匹配从 vault 地点和合成候选目录提出地点，不访问地理编码网络。写成 confirmed 只能通过 `confirm-place --authorize place-confirm`，并且只能接受当次匹配到的候选。收藏地图导出 GeoJSON 点位和静态视图；设计片段与参考包从收藏、笔记和合成片段包生成。这些都是资料视图，不是应用界面。私有远端写入、GitHub↔Linear 同步、confirmed 账目和在线地理编码仍未启用。
5. **Events**：受限 MCP 工具、持久订阅、调度、事件重投与监控；地图/UI 作为可选插件界面。

正式记录以 vault 文件为准。录入请求完成与生活事项完成分别维护。预算不是支出，摘要不是原文备份，CI 成功不是 Codex/Dots 实测。
