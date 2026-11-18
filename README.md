# 着眼 · Focus On

收集值得关注的信息，安排想做的事情，记录实际发生的生活。

本公开仓库保存产品代码、格式规范和合成测试资料。个人收藏、生活和财务记录保存在独立私有 `focus-on-vault`。当前交付是基础工具、本地授权写入闭环、日常查询、从本地资料派生的地点匹配、收藏地图和设计参考包，以及一份不常驻的本地事件日志。尚未提供应用界面、在线地理编码、私有远端写入、外部消息或已启用的 MCP/Dots 订阅。

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

日常查询只读 vault 文件。`--vault` 必须出现在命令行上，这些命令不读取 `FOCUS_VAULT_PATH`。查询不会把待办改成完成，也不会把财务草稿改成 confirmed。收藏检索只匹配资料库里的标题、标签、链接、归档状态、来源和正文，不会访问 URL。

```bash
bash scripts/bootstrap.sh focus inbox --vault examples/vault
bash scripts/bootstrap.sh focus search --vault examples/vault --query 餐厅
bash scripts/bootstrap.sh focus life --vault examples/vault --kind task
bash scripts/bootstrap.sh focus index --vault examples/vault --out .codex-work/tmp/index
bash scripts/bootstrap.sh focus accept --vault examples/vault
```

`index` 每次从 vault 文件重建查询索引。索引不是正式记录，不进入数据 snapshot；删掉索引文件不会丢失收藏或待办。`--check FILE` 把已保存的索引和这次重建结果比较，不一致就失败。`--out` 必须位于来源资料库之外，避免把查询结果写进收藏或收件箱目录。`accept` 用调用方给出的 `--vault` 做样本验收：文件是正式来源，索引、收件箱、收藏检索和生活事项都必须能从这些文件解释。公开仓库只对 `examples/vault` 运行这条验收。私人样本留在调用方本机，不复制进本仓库。

`backup` 把干净的本地 git 资料库打成不含远端地址的 bundle，并在存在本地录入账本时一并保存。资料库里的记录、正文、附件和收件箱文件必须已经提交且与 `HEAD` 一致；被忽略的请求不会被静默丢掉，备份会直接失败。`restore` 在新目录恢复该 bundle，核对 snapshot、`main` 和本地 ref 之后才返回。两个命令都拒绝 `github.com` 和 `focus-on-vault` 远端，也不执行 push。备份目录要放在本仓库之外，或放在 `.codex-work/tmp`；不要把私人备份提交到公开仓库。

```bash
bash scripts/bootstrap.sh focus backup --vault "$VAULT" --out .codex-work/tmp/backup
bash scripts/bootstrap.sh focus restore --backup .codex-work/tmp/backup --vault .codex-work/tmp/restored
```

地点、地图和参考包同样只读调用方传入的 `--vault`，不读取 `FOCUS_VAULT_PATH`。`match-place` 用资料库里已有坐标的地点，以及调用方给出的离线候选目录，提出候选。默认目录 `examples/context/place-candidates.json` 是合成占位坐标，不是实测地点。匹配结果里的 `confirmed` 固定为 false，命令不会访问网络地理编码。

`confirm-place` 把其中一个候选写成地点记录上的 `locationStatus: confirmed` 和坐标。没有 `--authorize place-confirm` 时它拒绝执行，资料库保持不变。`--authorize capture` 不能代替这个授权。`capture` 即使同时带上 `--authorize place-confirm`，也不能把地点直接写成 confirmed；确认只走 `confirm-place`，并且只复制当次匹配到的候选。地点已经是这个候选时，再次执行不会改写记录。之后如果确认了另一个候选，可以再确认原来的候选，这次会按当前记录新写一版并保留当前标题。写入复用本地 git 录入闭环，拒绝 `github.com` 和 `focus-on-vault` 远端，不推送，也不把财务草稿改成 confirmed。

```bash
bash scripts/bootstrap.sh focus places --vault examples/vault
bash scripts/bootstrap.sh focus match-place --vault examples/vault --place place_sample
bash scripts/bootstrap.sh focus map --vault examples/vault --out .codex-work/tmp/map
bash scripts/bootstrap.sh focus fragments --vault examples/vault --pack examples/context/reference-pack.json --out .codex-work/tmp/pack
# 在合成资料的临时本地 git 副本上确认。不要把 examples/vault 或私有远端当作写入目标。
bash scripts/bootstrap.sh focus confirm-place --vault "$VAULT" --place place_sample --candidate fixture_synth_hall --authorize place-confirm --out .codex-work/tmp/place
```

`map` 只给已经有坐标的地点生成点。没有坐标的地点和尚未连到这些地点的收藏进入 unplaced，不会被填上假坐标。GeoJSON 使用 `[longitude, latitude]`，并保留记录里的 WGS84 或 GCJ02，不做基准面换算。`fragments` 不带 `--pack` 时，只收集带有标签 `design` 的收藏；`--pack` 再按合成或调用方提供的片段包提取关联 Markdown。标签区分大小写。`--out` 必须位于来源资料库之外。

事件是另一份本地日志，不是资料库记录。`--vault` 和 `--state` 都必须出现在命令行上，这些命令不读取 `FOCUS_VAULT_PATH`。`--state` 要放在来源资料库之外，并且放在本仓库之外或 `.codex-work/tmp`。订阅、调度和投递不会把待办改成完成，也不会把财务草稿改成 confirmed。`events tools` 只描述进程内工具，`server` 为 disabled；`events plugins` 里的地图和 UI 界面保持 disabled。没有守护进程，也没有外部消息。

```bash
bash scripts/bootstrap.sh focus events tools
bash scripts/bootstrap.sh focus events plugins
bash scripts/bootstrap.sh focus events subscribe --vault examples/vault --state .codex-work/tmp/events --id sub_task --selector record --record task_sample --authorize events-subscribe
bash scripts/bootstrap.sh focus events schedule --vault examples/vault --state .codex-work/tmp/events --id sched_hour --subscription sub_task --every 3600 --start 2026-11-18T00:00:00Z --authorize events-schedule
bash scripts/bootstrap.sh focus events deliver --vault examples/vault --state .codex-work/tmp/events --authorize events-deliver --now 2026-11-18T00:00:00Z
bash scripts/bootstrap.sh focus events status --vault examples/vault --state .codex-work/tmp/events
```

`subscribe` 没有 `--authorize events-subscribe` 时拒绝写入。`schedule` 需要 `--authorize events-schedule`，`deliver` 和 `redeliver` 需要 `--authorize events-deliver`。这三个授权不能代替 `capture` 或 `place-confirm`。同一观察键或同一调度发生时间只保留一条投递；再次执行会标成 duplicate，不会另写一条。失败后按 60 秒起、每次翻倍、最长 3600 秒的间隔重试，最多 5 次。耗尽后状态留在日志里，自动投递不再调用处理函数；只有再次授权的 `redeliver` 才会重新尝试。一次调度补跑最多 8 个到期点。日志最多 50 个订阅、50 个调度和 100 条投递。事件日志不在 `backup` 里，恢复资料库不会带回 `--state`。

公共接口：`CaptureRequest`、`ChangeSet`、`ProcessingReceipt`、`RecordData`。查询索引、备份清单、地点列表、地点匹配、收藏地图、参考包、事件状态和插件目录是从这些记录或本地日志派生的 schemaVersion 1 文档。执行 `focus schemas` 导出 JSON Schema。

公开示例 manifest 的全零 validator SHA 是合成测试标记；正式私有资料库固定实际本体 commit，升级需单独验证。剪藏摘要与笔记可保存在按记录 ID 关联的 Markdown 中。

详见 [数据契约](docs/data-contract.md)、[本机/云端运行](docs/environments.md)、[Linear 配置](docs/linear.md)、[阶段路线图](ROADMAP.md)。本仓库尚未选择开源许可证。
