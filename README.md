# 着眼 · Focus On

收集值得关注的信息，安排想做的事情，记录实际发生的生活。

本公开仓库保存产品代码、格式规范和合成测试资料。个人收藏、生活和财务记录保存在独立私有 `focus-on-vault`。当前交付是基础工具和本地授权写入闭环，尚未提供地图、应用界面、私有远端写入或后台自动采集。

## 开始使用

需要 macOS arm64 或 Linux x64/arm64、Git、Bash、curl、tar。安装占用项目本地缓存，不改变全局 Node 默认版本。

```bash
bash scripts/bootstrap.sh check
bash scripts/bootstrap.sh focus doctor
bash scripts/bootstrap.sh focus validate --vault examples/vault
bash scripts/bootstrap.sh focus plan --request examples/requests/create-task.json --vault examples/vault --out .codex-work/tmp/demo
```

Bootstrap 使用 Node 24.21.0、pnpm 10.18.3 和冻结的锁文件；Node 下载校验官方 SHA256。若环境已经配置同版本 Node/pnpm，可直接 `pnpm install --frozen-lockfile --store-dir .codex-work/cache/pnpm && pnpm check`。

`plan` 只输出变更计划、差异文件和 `planned` 回执。它不会写入数据仓库、创建 Issue/PR、确认账目或宣称正式入库。生成的新记录 ID由资料库 ID、请求 ID、输入版本和操作顺序确定。修改请求版本后需要生成相应新 ID；更新记录需匹配 revision 和完整资料库 snapshot。

`capture` 是显式写入入口。没有 `--authorize capture` 时它拒绝执行，资料库保持不变。授权后，它只对本地 git 资料库完成：保存稳定请求、本地 Issue、唯一 `capture/<requestId>/v<inputVersion>` 分支和 PR、合并、读回，然后才写 `stored` 回执。重试复用同一请求 ID、分支、Issue 和 PR。基准或同版本输入冲突进入待补充，不覆盖已有记录。合并已经成功但回执写入失败时，重试沿原合并 commit 补写回执，不新建记录。正文和已保存附件要通过 `--content` 提供，并在读回时逐字节核对。

```bash
# 将合成资料复制成独立的本地 git 资料库后再写入。不要把私有 vault 远端当作写入目标。
bash scripts/bootstrap.sh focus capture --request examples/requests/create-task.json --vault "$VAULT" --authorize capture --out .codex-work/tmp/capture
```

`confirm-finance` 只接受单独的 `--authorize finance-confirm`，并且不会把账目写成 confirmed。格式版本仍为 1，财务记录只保持 pending。GitHub 远端推送和 Linear 同步尚未启用；Issue 上的 FOCUS 状态只是本地映射。

公共接口：`CaptureRequest`、`ChangeSet`、`ProcessingReceipt`、`RecordData`。执行 `focus schemas` 导出 JSON Schema。

公开示例 manifest 的全零 validator SHA 是合成测试标记；正式私有资料库固定实际本体 commit，升级需单独验证。剪藏摘要与笔记可保存在按记录 ID 关联的 Markdown 中。

详见 [数据契约](docs/data-contract.md)、[本机/云端运行](docs/environments.md)、[Linear 配置](docs/linear.md)、[阶段路线图](ROADMAP.md)。本仓库尚未选择开源许可证。
