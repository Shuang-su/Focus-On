# Context views completion

2026-11-17：公开仓库实现情境视图。格式保持 v1，记录接口仍是 CaptureRequest、ChangeSet、ProcessingReceipt、RecordData。地点列表、地点匹配、收藏地图、片段包和参考包是派生文档，schemaVersion 同为 1。

## 命令

- `focus places --vault PATH [--out DIR]`：列出地点及确认状态。缺省状态写成 `unset`，不会显示成 confirmed。
- `focus match-place --vault PATH --place ID [--query TEXT] [--candidates FILE] [--out DIR]`：提出候选。默认候选文件是 `examples/context/place-candidates.json`。结果里 `confirmed` 为 false，`geocoder` 为 disabled。
- `focus confirm-place --vault PATH --place ID --candidate ID --authorize place-confirm [--candidates FILE] [--query TEXT] [--out DIR]`：把当次匹配到的一个候选写入本地 git 资料库。
- `focus map --vault PATH [--out DIR]`：生成收藏地图。`--out` 同时写出 `collection-map.json` 和 `collection-map.geojson`。
- `focus fragments --vault PATH [--pack FILE] [--out DIR]`：生成参考包。不带 `--pack` 时只收集标签为 `design` 的收藏。
- 既有 `doctor`、`validate`、`plan`、`capture`、`confirm-finance`、`inbox`、`search`、`life`、`index`、`accept`、`backup`、`restore`、`schemas` 保留。`schemas` 增加 placeList、placeCandidateCatalog、placeMatch、collectionMap、fragmentPack、referencePack。

这些命令的 `--vault` 必须写在命令行上，不读取 `FOCUS_VAULT_PATH`。`plan` 和 `validate` 仍可按原有方式使用该环境变量。没有 `--authorize place-confirm` 时，`confirm-place` 拒绝写入。`--authorize capture` 不能确认地点。`capture` 即使同时带上 `--authorize place-confirm`，也不能把地点新写成 confirmed，也不能改掉已确认坐标。

## 匹配、地图与参考包

候选来自两类本地数据：vault 里其他已经有坐标的地点，以及离线候选目录。名称按规范化文本做分词相等或包含。查询字符串只作为文本。已确认的资料库地点比同名合成候选排得更前。没有坐标的地点不会成为候选，也不会在地图上得到假点。合成目录中的 0,0 和 0.5,-0.5 是占位坐标，evidence 写明它们不是实测地点。

确认只复制被选中的候选。evidence 带上候选 id 和来源。请求 id 由 vaultId、地点、候选和确认后的坐标决定。再次执行同一次确认会复用已保存请求，不把 revision 再加一。改已确认地点的标题仍走普通 `capture`，不改变坐标和确认状态。

收藏挂到地点上的条件是直接 links，或另一条记录同时连着该地点和该收藏。GeoJSON 坐标顺序是 `[longitude, latitude]`。WGS84 和 GCJ02 原样保留，不换算。参考包只摘录记录自己的 Markdown。`design` 标签区分大小写。派生结果的 `--out` 不能落在来源资料库内部。

## 验证

公开检查命令：

```bash
bash scripts/bootstrap.sh check
bash scripts/bootstrap.sh focus validate --vault examples/vault
```

`check` 包含构建、47 项测试、示例资料库校验和 `accept`。合成示例 snapshot 仍是 `801caa0c67dc26ccaf061b08fcfa75dd328d90b67911af5cf55d921b2e52cdce`。测试使用 `examples/vault` 的临时 git 副本和合成候选。Git 推送、`https://github.com/Shuang-su/focus-on-vault` 和 `git@github.com:Shuang-su/focus-on-vault.git` 在执行前被拒绝。匹配、地图、参考包和确认过程中没有调用网络地理编码。

## 验收缺口

- 本仓库没有运行私人 vault。真实地点要由调用方在本机执行 `focus match-place --vault <本地路径>`，并自行提供离线候选。公开 CI 只覆盖合成 `examples/vault` 和 `examples/context`。
- 已记录的 DEV-5 至 DEV-10 里，DEV-8 要求可重建的剪藏索引。日常使用阶段实现了检索，并因地图、设计片段和参考包未做而不把 DEV-8 标成完成。本次补上这三块，以及路线图第 4 项的地点确认。票据正文不在本仓库，因此这里只写 `relates to DEV-8`，不把 DEV-8 标成完成，也不新编票据编号。
- 对 https://github.com/Shuang-su/focus-on-vault 的真实 push、Issue 和 PR 仍未启用。
- GitHub↔Linear 同步仍关闭。`confirm-place` 只在本地 Issue 上映射 FOCUS 状态。
- `confirm-finance` 即使拿到 `--authorize finance-confirm` 也不会写成 confirmed。
- 没有在线地理编码，也没有 WGS84/GCJ02 换算。匹配不会自动确认。
- 应用界面、Circular Menu、MCP/事件和后台采集未实现。GitHub issues #2–#5 仍只是参考，没有被实现成产品界面。
