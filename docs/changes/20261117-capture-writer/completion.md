# Capture writer completion

2026-11-17：公开仓库实现本地授权录入闭环。格式保持 v1，公共接口仍是 CaptureRequest、ChangeSet、ProcessingReceipt、RecordData。

## 命令

- `focus plan`：只读计划，回执为 planned / verified=false。
- `focus capture --request FILE --vault PATH --authorize capture [--content DIR] [--out DIR] [--previous FILE]`：本地写入入口。
- `focus confirm-finance --request FILE --vault PATH --authorize finance-confirm`：承认单独授权，但不写 confirmed。
- 既有 `doctor`、`validate`、`schemas` 保留。

## 授权与闭环

`--authorize capture` 才会写入。写入目标必须是干净的本地 `main` git 资料库。流程保存请求版本，建立本地 Issue 和唯一分支/PR，合并后读回 main，然后把回执写成 stored。读回核对记录哈希、业务状态、正文和附件字节。关闭录入状态不会把待办改成 done，也不会把财务草稿改成 confirmed。

重试复用同一 requestId、inputVersion、inputHash、分支、Issue 和 PR。基准变化、同版本输入变化，或分支上已有不同内容时拒绝覆盖。合并后的回执写入失败会停在待核验；再次执行同一请求时按原 merge commit 补写回执。

FOCUS 状态在本地映射为待处理、处理中、待补充、待合并、待核验、已入库、已取消。映射记录 `linear.sync=disabled`。没有 Linear 凭据或真实 Issue URL。

## 验证

公开检查命令：

```bash
bash scripts/bootstrap.sh check
bash scripts/bootstrap.sh focus validate --vault examples/vault
```

`check` 包含构建、30 项测试和示例资料库校验。测试使用 `examples/vault` 的临时 git 副本。Git 推送和指向 `focus-on-vault` 的远端在执行前被拒绝。

## 留到后续 live 启用

- 对 https://github.com/Shuang-su/focus-on-vault 的真实 push、Issue 和 PR。
- GitHub↔Linear 双向同步，以及用合成请求在 FOCUS 做在线路由验收。
- 把 finance_draft 写成 confirmed。当前命令即使拿到 `--authorize finance-confirm` 也不会改状态。
- 日报/收件箱、地图、Circular Menu、MCP/事件和后台采集。
