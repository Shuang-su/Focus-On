# Capture writer plan

1. 保留 `plan` 的现有契约：只输出 ChangeSet、差异和 planned 回执，不写资料库、不建 Issue/PR、不确认财务、不宣称 stored。
2. 新增 `capture`。缺少 `--authorize capture` 时拒绝，且不创建分支或记录。授权后的顺序是：校验稳定请求、本地 Issue、唯一 `capture/<requestId>/v<inputVersion>` 分支、唯一 PR、合并、读回、stored。
3. 重试复用请求 ID、inputHash、分支、Issue 和 PR。同版本输入变化或基准变化进入待补充，不覆盖已有记录。合并已成功但回执写入失败时，下一次重试按原合并 commit 补写回执，不新建记录。
4. 正文与 saved 附件由 `--content` 提供。`plan` 仍拒绝这两类内容。`capture` 在提交前核对字节，读回时再核对一次。
5. `confirm-finance` 接受单独的 `--authorize finance-confirm`，但格式 v1 不写 confirmed。录入财务草稿保持 pending。请求文本不能触发确认。
6. 本地 Issue 记录七个 FOCUS 状态名称，并标明 Linear 同步未启用。不调用 Linear，不推送 `github.com` 或 `focus-on-vault` 远端。
7. 测试覆盖成功路径、授权拒绝、重试、冲突恢复、回执恢复和财务确认守卫。验证仍使用 `examples/vault` 与临时本地仓库。
