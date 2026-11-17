# Daily use plan

1. 保留 `plan` 和 `capture` 的现有契约。`CaptureRequest`、`ChangeSet`、`ProcessingReceipt`、`RecordData` 保持格式 v1。查询和验收不写正式记录，也不把财务草稿改成 confirmed。
2. `inbox` 从 `inbox/requests` 与 `inbox/receipts` 列出请求。没有回执时视图状态为 `saved`。回执哈希必须对上已保存请求，重复回执版本记为校验错误。请求和回执继续不进入数据 snapshot。
3. `search` 只检索 collection 的标题、标签、链接、归档状态、来源和关联 Markdown。查询文本只做匹配，不当作命令或路径。`life` 列出 task、plan、wishlist，并保持文件里的业务状态。预购预算仍叫 budget。
4. `index` 每次从 vault 文件重建查询索引。索引记录 sourceSnapshot 和 recordHash，可以删除后重建，不进入 snapshot。`--check` 比较已保存索引和这次重建；不一致就失败。
5. `accept --vault PATH` 以该目录的文件为正式来源，重建索引并核对收件箱、收藏、生活事项和 pending 财务草稿。公开验收只用合成 `examples/vault`。真实样本由调用方在本地提供路径。
6. `backup` 导出干净本地 `main` 的 git bundle 和可选录入账本。`restore` 克隆到新目录，移除 origin，并核对 snapshot、HEAD 和 refs。两个命令拒绝 `github.com` 与 `focus-on-vault` 远端，不执行 push。备份不写入仓库跟踪路径，除非落在 `.codex-work/tmp`。
7. 测试使用 `examples/vault` 的临时副本。指向私有 vault 远端的备份、恢复和 push 在执行前拒绝。
