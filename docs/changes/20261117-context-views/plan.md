# Context views plan

1. 保留 `CaptureRequest`、`ChangeSet`、`ProcessingReceipt`、`RecordData` 和格式 v1。地点列表、地点匹配、收藏地图、片段包和参考包是派生文档，不进入 snapshot。
2. `places` 和 `match-place` 只读调用方传入的 `--vault`。匹配使用资料库里已有坐标的地点，以及一份离线候选目录。查询文本只做匹配。不调用网络地理编码，也不把候选写成 confirmed。
3. `confirm-place` 必须带 `--authorize place-confirm`。它只接受这次匹配到的候选，并通过本地 git 录入闭环更新该地点。`capture` 不能把地点写成 confirmed。重试复用同一请求，不重复增加 revision。
4. `map` 从已有坐标生成 GeoJSON 点位和静态视图。没有坐标的地点和未挂接的收藏保持 unplaced。坐标系原样保留，不换算。
5. `fragments` 按片段包里的 recordId 和标题提取收藏或笔记正文；没有片段包时只收集标签为 `design` 的收藏。结果写到来源资料库之外。
6. 测试使用 `examples/vault` 的临时副本和合成候选。指向 `github.com` 或 `focus-on-vault` 的确认和 push 在执行前拒绝。
