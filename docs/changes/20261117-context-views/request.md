# Request (public, synthetic)

实现路线图第 4 项 Context views：真实地点匹配与人工确认、收藏地图、设计片段与参考包。

正式记录仍以 vault 文件为准。匹配可以引用 vault 文件和合成候选，但把地点写成 confirmed 必须在同一次命令里显式授权。地图和参考包是从 vault 记录派生的本地视图，不是应用界面。格式保持 v1。命令使用调用方传入的 `--vault`，不读取 `FOCUS_VAULT_PATH`。本项不启用私有远端 push、GitHub↔Linear 同步、confirmed 账目、在线地理编码、应用界面、Circular Menu、MCP/事件或后台采集。
