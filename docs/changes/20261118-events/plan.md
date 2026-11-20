# Events plan

1. 保留 `CaptureRequest`、`ChangeSet`、`ProcessingReceipt`、`RecordData` 和格式 v1。事件订阅、调度、投递、监控、工具目录和插件目录是 schemaVersion 1 的本地文档，不进入 snapshot。
2. 工具目录固定 `transport: local` 和 `server: disabled`。可调用的名字是静态列表。参数不能改 vault、state、命令或插件路径。`capture`、财务确认和地点确认不在列表里。
3. `--state` 保存订阅、调度和投递。它必须位于来源资料库之外，并且位于仓库外或 `.codex-work/tmp`。状态文件绑定 `vaultId`。同一订阅 id 和同一选择器再次执行不另建一条；选择器不同则拒绝覆盖。
4. `events deliver` 只在带 `--authorize events-deliver` 时跑一轮。它不常驻。同一幂等键再次遇到记为 duplicate。失败最多 5 次，间隔从 60 秒翻倍到最长 3600 秒。耗尽后自动投递停止，日志保留错误。显式 `redeliver` 才重新尝试。一次调度补跑最多 8 个到期点。
5. 地图和 UI 只出现在插件目录，`activation` 固定为 disabled。投递不写 vault，不改生活事项状态，不确认财务，不推送远端，不调用 Linear，也不发送外部消息。
6. 测试使用 `examples/vault` 的临时副本和临时状态目录。公开检查不访问私有 vault。
