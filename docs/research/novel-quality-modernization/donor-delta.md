# S00 三方事实台账

当前基线与 origin/master 为 `2264390d6fb8b052cc14736d544df0cc74516649`，v1.1.0 为 `879f83521414f66019488462830c3134c77dc4f8`。PR #229 已合并，交接修复已包含，不能重复移植。

`donor-delta.json` 列出全量路径与三方原字节 SHA256；`differences` 逐文件给出分类、owner、采取方向、功能动作候选映射和门。相同文件只说明无需复制，不是行为验收。映射是保守待测覆盖范围，owner 必须按真实入口逐动作落实；不能把宽泛映射当 PASS。

`inventory.json` 将 Vela 词法行清单与 CodeGraph 真实调用路径分开。没有文件被判定可删除；ActivityBar 的 outgoing calls 不证明它有 incoming consumer，也不证明零消费者。S13 仍需完整 import/dynamic/barrel/glob/Storybook/build 核销。

`asset-disposition.json` 分类 C09 全部必需类别，包含 prompts、Skill/绑定、partial_arch、canonical LanceDB 全文、多代向量、MCP、skin/update、donor 头像/缓存/偏好及便携归档。S01 仍须签署逐字段便携 allowlist；S04/F03 用隔离 fixture 验证实际对象。未扫描作者数据，不能声称所有作者目录已迁移。

许可待核验素材为新增 plum-blossom 背景、两个 seal 图片与 YiShanBeiZhuanTi 字体。现有字体 notices 列出四个其他字体家族，不能推定覆盖该新增字体。F02 核验或同功能合规替代；不据此删除头像/界面功能。

历史 donor-feature-union 说明中的备份占位处置已被 Program v3 C17/C18/U16 覆盖：B01/B02/F04 仍须实现完整手动备份/恢复。原冻结证据未改。

本切片仅运行文件哈希/JSON检查、CodeGraph源码查询及 GitHub 只读刷新；未运行中文模型、Electron、浏览器、迁移或安装包验收。GitHub Issue 全部仍 open；具体 PR/Release 状态见 issue-baseline.json。

重算：在项目根以 Python 运行 inventory-generate.py 并通过 --donor 指定获准只读 donor 根；然后运行 inventory-finalize.py（依赖本地私有只读 receipts）。输出中不记录绝对路径；原始 receipts 位于项目 .runtime/.cache/novel-quality-modernization，不提交。
