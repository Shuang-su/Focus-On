# Daily use completion

2026-11-17：公开仓库实现本地日常使用。格式保持 v1，记录接口仍是 CaptureRequest、ChangeSet、ProcessingReceipt、RecordData。查询索引和备份清单是派生文档，schemaVersion 同为 1。

## 命令

- `focus inbox --vault PATH [--status STATUS] [--out DIR]`：列出入库请求。没有回执时状态为 `saved`。
- `focus search --vault PATH [--query TEXT] [--tag TAG] [--out DIR]`：检索收藏。`--query` 只作为文本。
- `focus life --vault PATH [--kind task|plan|wishlist] [--status STATUS] [--out DIR]`：列出生活事项。预算字段保持 `budget`。
- `focus index --vault PATH [--out DIR] [--check FILE]`：从文件重建查询索引，或核对已保存索引。
- `focus accept --vault PATH [--out DIR]`：按 vault 文件做样本验收。失败时退出码为 1。
- `focus backup --vault PATH --out DIR` 与 `focus restore --backup DIR --vault PATH`：备份和恢复本地 git 资料库。
- 既有 `doctor`、`validate`、`plan`、`capture`、`confirm-finance`、`schemas` 保留。`schemas` 增加 queryIndex 和 backupManifest。

这些新命令的 `--vault` 必须写在命令行上，不读取 `FOCUS_VAULT_PATH`。`plan` 和 `validate` 仍可按原有方式使用该环境变量。没有 `--authorize capture` 时，`capture` 继续拒绝写入。

## 文件与索引

收件箱、收藏检索和生活事项直接读 vault 文件。查询索引保存 vaultId、sourceSnapshot、记录路径、recordHash 和收件箱哈希，不保存为正式记录，也不改变 snapshot。`accept` 会重建索引两次，并核对磁盘上的记录字节、正文、生活事项状态和 stored 回执指向的记录。财务草稿仍必须是 pending。

备份清单只含 vaultId、snapshot、head、本地 refs 和是否保存了录入账本。恢复后的资料库没有 origin。snapshot 或 refs 不一致时，新目录会被删除，命令失败。工作区中的 vault 文件若没有以相同字节出现在 `HEAD`，包括被 gitignore 或 exclude 忽略的收件箱，备份会失败。日常命令的 `--out` 不能落在来源资料库内部。

## 验证

公开检查命令：

```bash
bash scripts/bootstrap.sh check
bash scripts/bootstrap.sh focus validate --vault examples/vault
bash scripts/bootstrap.sh focus accept --vault examples/vault
```

`check` 包含构建、43 项测试、示例资料库校验和 `accept`。合成示例 snapshot 仍是 `801caa0c67dc26ccaf061b08fcfa75dd328d90b67911af5cf55d921b2e52cdce`。同一份示例重建出的查询索引摘要是 `938a46c046c50ba759d603c0f5119ec30b95d1cf1b4e15840fafbcabde7f2676`。测试使用 `examples/vault` 的临时 git 副本。Git 推送、`https://github.com/Shuang-su/focus-on-vault` 和 `git@github.com:Shuang-su/focus-on-vault.git` 在执行前被拒绝。

## 验收缺口

- 本仓库没有运行私人 vault。真实样本要由调用方在本机执行 `focus accept --vault <本地路径>`。公开 CI 只覆盖合成 `examples/vault`。
- 已记录的 DEV-5 至 DEV-10 里没有单独的 Daily use 票据。DEV-6 仍是录入闭环。DEV-8 要求可重建的剪藏索引；本变更实现了按标签、来源、归档状态和正文检索，并让结果回到稳定 ID。地图、设计片段和参考包不在本次范围内，因此不把 DEV-8 标成完成。这里不新编票据编号。
- 对 https://github.com/Shuang-su/focus-on-vault 的真实 push、Issue 和 PR 仍未启用。
- GitHub↔Linear 同步仍关闭。日常查询不回写 FOCUS 状态。
- `confirm-finance` 即使拿到 `--authorize finance-confirm` 也不会写成 confirmed。
- 地图、应用界面、Circular Menu、MCP/事件和后台采集未实现。查询索引不是常驻服务，每次从文件重建。
