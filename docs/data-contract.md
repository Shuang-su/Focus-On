# Data contract v1

`src/contracts.ts` 是格式与 TypeScript 类型的共同来源。`focus schemas` 输出 manifest、record、captureRequest、changeSet 和 processingReceipt JSON Schema。共享字段为 schemaVersion、id、revision、title、createdAt、updatedAt、source、links；时间为带时区 ISO 8601。

支持 collection、note、task、plan、wishlist、finance_draft、entity、budget、subscription、attachment。结构化记录为 JSON，正文为关联 Markdown。原始请求以受控 JSON 保存在 inbox/requests，不能直接作为 shell、路径或 workflow 指令。

正式记录按 ID 关联。财务金额为非负安全整数 amountMinor、ISO 币种代码与 precision；类型区分 expense/income/transfer/refund。转账需要两个不同账户引用，退款需要原交易引用。首轮只接受 pending 草稿，不计算真实余额或自动确认。

验证读取 collections、notes、life、finance、entities、attachments-manifest 的 JSON，检查重复 ID、引用、版本及附件。读到 symlink 或越界路径即失败。snapshot 由 manifest、记录和被引用正文/已保存附件内容共同计算，跨操作系统一致。

请求保留 input.text 原文并固定 baseSnapshot。create ID 为 `rec_` + SHA256(vaultId + ':' + requestId + ':' + inputVersion + ':' + operationIndex) 的前24位。update 保持 ID、kind、createdAt，使用 expectedRevision 和 revision+1。请求重试复用 ID、分支、inputHash；变更基准变化则重新核对，不覆盖。使用原 --out 目录重试会自动读取原 ChangeSet，检测相同版本的输入变更；另一台机器应传 --previous 原 change-set.json。首次处理前必须保存请求版本，不能在跨机器交接中丢弃前次计划。

ChangeSet 包含相对数据路径、beforeHash/afterHash 和候选记录。ProcessingReceipt 的 planned、awaiting_merge、needs_input、failed 与 stored 表示处理状态。stored 必须 verified=true，并带有合并 commit。`plan` 只生成 planned/verified=false，不写资料库，也不接收正文或已保存附件。`capture` 在 `--authorize capture` 之后把同一请求版本写入本地 git 资料库：保存请求、本地 Issue、唯一分支和 PR、合并、读回，然后才写 stored。`--content` 中的正文和附件必须逐字节匹配；可读副本与 saved 附件没有内容时仍然拒绝。重试复用请求 ID、inputHash、分支、Issue 和 PR。基准或同版本输入冲突不覆盖原数据。合并成功但回执写入失败时，重试按原合并 commit 读回并补写回执，不新建记录。财务确认需要单独的 `--authorize finance-confirm`，格式 v1 仍只保存 pending，确认不会被执行。GitHub 远端写入和 Linear 同步不在本阶段启用。

校验器同时检查 inbox/requests 的 CaptureRequest 与重复请求版本、inbox/receipts 的回执。planner 会核对已保存的同一请求版本，输入变动未升版时报冲突。历史请求/回执不参与数据 snapshot，避免把基准哈希写入自身。
