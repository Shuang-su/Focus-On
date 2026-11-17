# Request (public, synthetic)

实现路线图第 3 项 Daily use：收件箱、收藏检索、生活事项、可重建查询索引、真实样本验收，以及本地 git 资料库的备份恢复。

正式记录仍以 vault 文件为准。验收和查询使用调用方显式传入的 `--vault`，不读取 `FOCUS_VAULT_PATH`，也不把私人记录复制进公开仓库。格式保持 v1。默认的 `plan` 仍只生成计划。本项不启用私有远端 push、GitHub↔Linear 同步、confirmed 账目、地图、应用界面、Circular Menu、MCP/事件或后台采集。
