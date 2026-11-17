# Data contract v1

`src/contracts.ts` 是格式与 TypeScript 类型的共同来源。`focus schemas` 输出 manifest、record、captureRequest、changeSet 和 processingReceipt JSON Schema。共享字段为 schemaVersion、id、revision、title、createdAt、updatedAt、source、links；时间为带时区 ISO 8601。

支持 collection、note、task、plan、wishlist、finance_draft、entity、budget、subscription、attachment。结构化记录为 JSON，正文为关联 Markdown。原始请求以受控 JSON 保存在 inbox/requests，不能直接作为 shell、路径或 workflow 指令。

正式记录按 ID 关联。财务金额为非负安全整数 amountMinor、ISO 币种代码与 precision；类型区分 expense/income/transfer/refund。转账需要两个不同账户引用，退款需要原交易引用。首轮只接受 pending 草稿，不计算真实余额或自动确认。

验证读取 collections、notes、life、finance、entities、attachments-manifest 的 JSON，检查重复 ID、引用、版本及附件。读到 symlink 或越界路径即失败。snapshot 由 manifest、记录和被引用正文/已保存附件内容共同计算，跨操作系统一致。

请求保留 input.text 原文并固定 baseSnapshot。create ID 为 `rec_` + SHA256(vaultId + ':' + requestId + ':' + inputVersion + ':' + operationIndex) 的前24位。update 保持 ID、kind、createdAt，使用 expectedRevision 和 revision+1。请求重试复用 ID、分支、inputHash；变更基准变化则重新核对，不覆盖。使用原 --out 目录重试会自动读取原 ChangeSet，检测相同版本的输入变更；另一台机器应传 --previous 原 change-set.json。首次处理前必须保存请求版本，不能在跨机器交接中丢弃前次计划。

ChangeSet 包含相对数据路径、beforeHash/afterHash 和候选记录。ProcessingReceipt 的 planned、awaiting_merge、needs_input、failed 与 stored 表示处理状态。stored 必须 verified=true，并带有合并 commit。`plan` 只生成 planned/verified=false，不写资料库，也不接收正文或已保存附件。`capture` 在 `--authorize capture` 之后把同一请求版本写入本地 git 资料库：保存请求、本地 Issue、唯一分支和 PR、合并、读回，然后才写 stored。`--content` 中的正文和附件必须逐字节匹配；可读副本与 saved 附件没有内容时仍然拒绝。重试复用请求 ID、inputHash、分支、Issue 和 PR。基准或同版本输入冲突不覆盖原数据。合并成功但回执写入失败时，重试按原合并 commit 读回并补写回执，不新建记录。财务确认需要单独的 `--authorize finance-confirm`，格式 v1 仍只保存 pending，确认不会被执行。GitHub 远端写入和 Linear 同步不在本阶段启用。

校验器同时检查 inbox/requests 的 CaptureRequest 与重复请求版本、inbox/receipts 的回执。同一请求版本的回执只能有一份，而且 `inputHash` 必须等于该请求的 canonical SHA256。planner 会核对已保存的同一请求版本，输入变动未升版时报冲突。历史请求/回执不参与数据 snapshot，避免把基准哈希写入自身。

## Daily use

格式版本仍是 1。`CaptureRequest`、`ChangeSet`、`ProcessingReceipt`、`RecordData` 不改变。收件箱、收藏检索和生活事项直接读 vault 文件：收件箱来自 `inbox/requests` 与 `inbox/receipts`，没有回执时视图状态是 `saved`，这个状态不属于 ProcessingReceipt。收藏检索只覆盖 collection，匹配标题、标签、URL、归档状态、来源和关联 Markdown。生活事项只覆盖 task、plan、wishlist；预购里的 `budget` 是预算，不是支出。待办完成和录入回执完成仍然分开。

查询索引由 `focus index` 从当前文件重建，schema 为 `queryIndex`。它记录 vaultId、sourceSnapshot、每条记录的路径和 recordHash，以及收件箱版本和回执哈希。索引可以删除后重建，不写入 snapshot，也不能代替正式记录。`focus index --check` 发现已保存索引和文件不一致时拒绝，并要求按 vault 重建。

`focus accept --vault PATH` 是样本验收。它只使用该路径里的文件：校验记录，重建两次索引并要求结果相同，再核对索引哈希、收件箱、收藏检索、生活事项状态和 pending 财务草稿。验收不修改资料库。公开 CI 对合成 `examples/vault` 运行；真实样本由调用方在本地传入自己的 vault，不把私人记录放进公开仓库。

`backupManifest` 也是 schemaVersion 1 的派生文档，字段只有 vaultId、snapshot、head、本地 refs 和是否包含录入账本。清单不记录绝对路径或远端 URL。`backup` 要求干净的本地 `main`，并拒绝带有 `github.com` 或 `focus-on-vault` 远端的资料库。工作区里的 manifest、记录、正文、附件和 inbox 文件必须与 `HEAD` 的字节一致；被 `.gitignore` 或 exclude 忽略、因而不会进入 bundle 的请求和回执会导致备份失败，避免恢复后静默丢掉收件箱。`restore` 只从本地 bundle 克隆到新目录，移除 origin，再核对 snapshot、HEAD 和 refs。网络写入仍然关闭。日常命令的 `--out` 必须位于来源资料库之外，派生的查询结果不能写进正式记录目录。
