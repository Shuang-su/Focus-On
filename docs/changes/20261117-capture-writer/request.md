# Request (public, synthetic)

实现路线图第 2 项 Capture writer：授权入口、稳定请求、私有 Issue、唯一请求分支/PR、合并读回、已入库。补上重试、冲突恢复和回执回写。财务确认必须单独授权，且不能在录入时自动执行。

默认路径保持 plan。写入只在显式授权后发生。本阶段使用合成资料和本地 git，不把私人 vault、凭据或 Linear 标识写入公开仓库。GitHub↔Linear 同步、私有远端 live 写入、日报界面、地图和后台采集不在本项范围内。
