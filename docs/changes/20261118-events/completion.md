# Events completion

2026-11-18：公开仓库实现本地事件日志。格式保持 v1，记录接口仍是 CaptureRequest、ChangeSet、ProcessingReceipt、RecordData。事件订阅、调度、投递、状态文件、监控、工具目录、插件目录和投递结果是派生或本地文档，schemaVersion 同为 1。

## 命令

- `focus events tools`：列出进程内工具。`server` 为 disabled。
- `focus events plugins`：列出 map 和 ui 两个视图界面。`activation` 为 disabled。
- `focus events subscribe --vault PATH --state DIR --id ID --selector record|inbox|life [--record ID] --authorize events-subscribe`：保存订阅。
- `focus events pause-subscription` 与 `resume-subscription`：暂停或恢复订阅，授权仍是 `events-subscribe`。
- `focus events schedule --vault PATH --state DIR --id ID --subscription ID --every SECONDS --start ISO --authorize events-schedule`：保存固定间隔调度。
- `focus events pause-schedule` 与 `resume-schedule`：暂停或恢复调度，授权仍是 `events-schedule`。
- `focus events deliver --vault PATH --state DIR --authorize events-deliver [--now ISO]`：跑一轮本地投递。
- `focus events redeliver --vault PATH --state DIR --delivery ID --authorize events-deliver [--now ISO]`：对一条未完成投递再试一次。已经 delivered 的记为 duplicate。
- `focus events status --vault PATH --state DIR`：查看计数、失败和最近投递。
- `focus events call --tool NAME --vault PATH [--state DIR] [--args JSON] [--authorize GRANT] [--now ISO]`：按目录调用一个工具。
- 既有 `doctor`、`validate`、`plan`、`capture`、`confirm-finance`、`confirm-place`、`places`、`match-place`、`map`、`fragments`、`inbox`、`search`、`life`、`index`、`accept`、`backup`、`restore`、`schemas` 保留。`schemas` 增加 eventSubscription、eventSchedule、eventDelivery、eventState、eventMonitor、eventToolCatalog、pluginCatalog、eventDeliveryRun。

这些命令的 `--vault` 必须写在命令行上，不读取 `FOCUS_VAULT_PATH`。没有对应授权时，订阅、调度和投递拒绝写入。`events-subscribe` 不能确认地点，也不能代替 `capture`。`finance-confirm` 出现在事件命令上仍然不会写成 confirmed。

## 日志、重试与观察

状态文件是 `--state/state.json`。它记录 vaultId、订阅、调度和投递，并固定 daemon、externalDelivery、pluginActivation 为 disabled。订阅只能写入 journal。观察分三种：一条记录、收件箱、生活事项。收件箱观察保留回执状态，生活事项观察保留 task、plan、wishlist 的当前状态。投递结果里的 vaultWrite、lifeStatusChanged、financeConfirmed 和 externalDelivery 都固定为 false。

幂等键相同的投递只保留一条。处理成功后再次执行标为 duplicate。失败进入 retry，最多 5 次；间隔从 60 秒翻倍，最长 3600 秒。第 5 次失败后是 exhausted，自动轮次不再调用处理函数。`redeliver` 在订阅和调度仍为 active 时再试一次。暂停的订阅不会产生新观察，也不会自动重试。调度一次最多补 8 个到期点。日志上限是 50 个订阅、50 个调度、100 条投递；满了就拒绝新投递，不删旧记录。

命令行没有处理函数参数，因此默认 journal 会把投递记为成功。失败重试由库内同一个尝试函数覆盖；测试传入会失败的处理函数。这不是一条可从命令行指向外部程序的通道。

`--state` 不能放在来源资料库内，也不能放在仓库里 `.codex-work/tmp` 以外的位置。状态文件若是 symlink，命令拒绝并保留链接目标。`vaultId` 不一致时拒绝覆盖。无效 JSON 也拒绝覆盖。事件日志不在 `backup` / `restore` 的 bundle 里。

## 验证

公开检查命令：

```bash
bash scripts/bootstrap.sh check
bash scripts/bootstrap.sh focus validate --vault examples/vault
bash scripts/bootstrap.sh focus accept --vault examples/vault
```

`check` 包含构建、61 项测试、示例资料库校验和 `accept`。合成示例 snapshot 仍是 `801caa0c67dc26ccaf061b08fcfa75dd328d90b67911af5cf55d921b2e52cdce`。查询索引摘要仍是 `938a46c046c50ba759d603c0f5119ec30b95d1cf1b4e15840fafbcabde7f2676`。测试使用 `examples/vault` 的临时副本、临时 git 资料库和临时 `--state`。覆盖进程重启后的订阅、重复投递、失败退避、耗尽后的显式重投、授权、`FOCUS_VAULT_PATH`、输出路径、symlink 和跨 vaultId 隔离。Git 推送、`https://github.com/Shuang-su/focus-on-vault` 在执行前被拒绝。工具调用没有访问网络地理编码，也没有启用插件。

## 验收缺口

- 本仓库没有运行私人 vault。真实资料上的事件日志要由调用方在本机传入 `--vault` 和自己的 `--state`。公开 CI 只覆盖合成 `examples/vault`。
- 已记录的 DEV-5 至 DEV-10 里没有单独的 Events 票据。这里不新编票据编号，也不把既有票据标成完成。
- 对 https://github.com/Shuang-su/focus-on-vault 的真实 push、Issue 和 PR 仍未启用。
- GitHub↔Linear 同步仍关闭。事件命令不回写 FOCUS 状态。
- `confirm-finance` 即使拿到 `--authorize finance-confirm` 也不会写成 confirmed。
- 没有在线地理编码，也没有外部消息。地图和 UI 没有实现成界面；插件目录保持 disabled。GitHub issues #2–#5 仍只是参考。
- 没有常驻进程，没有用户级守护进程，也没有已启用的 MCP 服务或 Dots 调度。命令行默认 journal 不会自己失败；有界重试由同一套投递函数和测试里的失败处理函数覆盖。
- 事件日志不随 vault backup 带走。CI 成功不是 Codex 或 Dots 的实测验收。
