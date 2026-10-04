# Issue实质解决：先修复/增强，后按证据关闭

最新读取快照：2026-09-12T16:58:39Z，EthanYoQ/AI-Novel-Writer，开放Issue 10个（排除PR）。[调查](evidence/issue-scope.md)与[快照](evidence/issue-snapshot.json)为证据输入，不是关单授权或本轮复现记录。

## 1. 对用户纠正的执行解释

“全部可关”指原问题已得到真实解决。v2的行政承接归档、超时关闭和云存档排除已取消；不能通过新开后继、改标签、只关代码child、要求切经典或缺日志来减少问题数。确需拆子任务可用Refs互链，原产品Issue持续open到自身验收完成，不用Fixes/Closes在merge时自动关闭未发布用户问题。

用户报告不是低可信的“不会用”默认值，也不是已经实测的Bug。能用合成例验证就先复现；证实缺陷再最小修复；无法复现则查请求参数/源/解析/保存/错误入口并一次明确所缺信息，状态为待核实/blocked，不冒充解决。

## 2. 10项具体交付

| Issue | 当前事实与实施owner | 逐项完成门 |
| --- | --- | --- |
| [#187](https://github.com/EthanYoQ/AI-Novel-Writer/issues/187) 输出上限 | 最新反馈仍复现，#229部分合并未发布；S05–S07/S10，集成者联合验收 | review-chapter、chapter-blueprint-directory、compact-single、最新反馈场景逐项：实际请求/有效预算、截断候选、恢复/重开、失败可见；真实模型证据受总帽，适用安装版/Release。不能用一次世界观修复关闭全部。 |
| [#191](https://github.com/EthanYoQ/AI-Novel-Writer/issues/191) 自动角色卡与随剧情补充 | 可行增强；S09A导入、S09B自动派生、S09C/F04交互 | 文本/大纲/世界观→可编辑候选→接受/拒绝；定稿后非冲突derived自动更新、作者冲突才提议；ID/来源/幂等/重启/过期/切项目都通过且发布。 |
| [#199](https://github.com/EthanYoQ/AI-Novel-Writer/issues/199) 大纲范围/截断恢复 | #201进入v1.1.0，关闭复核候选；G01、S06A | 原范围/未完成结果/续批/取消/切项目/源变化/损坏checkpoint/UI全部有已发布证据，无新反例才关；已证明1–20再21–40不冒充200章单次全验。 |
| [#205](https://github.com/EthanYoQ/AI-Novel-Writer/issues/205) 连续性v2 | #208进入v1.1.0，关闭复核候选；G01、S10/S11 | 按原规格核对author/derived、候选/定稿、来源确定性与逐目标审稿；不得扩大为所有文学质量无退化承诺。 |
| [#211](https://github.com/EthanYoQ/AI-Novel-Writer/issues/211) 图谱保存/角色导入 | #212合并晚于v1.1.0；S09/F04 | v3按真实产品交付门：协议路径、只读图、保存失败保稿、上传确认/候选/项目隔离在Writer/Classic复验，包含修复的公开安装产物后关。撤销v2仅代码合并即可关的建议。 |
| [#213](https://github.com/EthanYoQ/AI-Novel-Writer/issues/213) 云存档 | 可行增强尚无实现；B01/B02、F04/F05 | 一个WebDAV协议的手动备份/恢复新副本；全资产含头像、两个隔离profile、凭据/重启绑定/分叉/中断/损坏/版本/原稿保护，真实打包入口和受控服务通过，限制披露并发布。Gitee是建议而非必须双实现。 |
| [#219](https://github.com/EthanYoQ/AI-Novel-Writer/issues/219) 未生成主角 | 有活跃报告、原因未证实；S00定位→S06A/S09/F04 | 区分模型遗漏/解析/身份/落盘/刷新；正例主角、别名/重名、截断/格式错/恢复重开；不能伪造主角或删除约束绕过。真实提供商路径证据与发布后关；无法确认则保留。 |
| [#221](https://github.com/EthanYoQ/AI-Novel-Writer/issues/221) 多余角色+跨章重复 | 报告有1.1.0/Windows/Qwen/步骤；S09与S10B，集成者联合owner | 两症状分别及联合验证，原第三章→第四章边界用合成既有前三章复现；身份准入/前章上下文、重复测量+人工核对。未经授权不新增Qwen密钥/调用；仅获准模型不能验证提供商特有问题时记阻塞，不能写Qwen已通过。 |
| [#222](https://github.com/EthanYoQ/AI-Novel-Writer/issues/222) ActivityBar残留 | #223开放未合并；S13唯一owner | 当前运行/测试/Storybook/构建消费者零、删除/相关注释、检查与review通过并合并。纯内部代码清理可按此窄门关，不必伪造产品Release。 |
| [#224](https://github.com/EthanYoQ/AI-Novel-Writer/issues/224) 设置白屏 | #225开放、Windows CI失败；F04/F05 | Writer及Classic两设置入口、默认/深链tab、真实内容、关闭重开/切项目/状态同步；相关CI、打包Windows与实际公开发布通过后关。 |

目前只是#199/#205有已发布关闭复核依据，不是“已经确认可关”。未请求信息仍不回复的符合项为0。各项若最新入口已修复，补齐必要复验就跳过重复实现。

## 3. 原因/证据/关闭字段

每Issue记录：原症状清单、报告证据、当前复现pass/fail/not-run、原因/未确定处、唯一验收owner、代码SHA、产品入口/fixture、覆盖平台/模型、相关Release/产物、未完成与新反例。功能多子诉求不得只满足一半。

- **产品完成**：全部症状修复或增强实际可用→相关检查/独立review→中文生产/安装场景→公开Release包含实际SHA→fresh-read无否定结果的新反馈，才completed。
- **代码完成未发布**：如#211现态，明确列出，产品Issue保持open。
- **已实现且非Bug**：确有实际操作/结果证据，说明原预期为什么已满足后可按事实结案；若同时暴露可行操作改进，完成或保留对应增强，不把“用户不会用”作先验。
- **信息不足/环境缺失/未复现**：保留open与一次具体信息请求；不得到7天或任意日期自动关。无依据不设ready-for-agent修复，也不算通过。
- **产品明确拒绝**：本轮不预先拒绝#191/#213。只有另有可追溯产品裁决才可诚实not_planned，不能当清单清空工具；整体“全部增强完成”不得计入被拒绝项目。

## 4. 操作安全

本轮没有GitHub写入。后续主线程逐项fresh-read→核对证据与授权→脱敏说明→close→回读stateReason/comment URL；worker只准备稿件。原稿/密钥/私有路径/原始日志不上GitHub。错误关单透明更正/reopen，不删除报告。

G01与开发并行完成调查/清单，已经解决的项可在有明确执行授权后逐项收尾；G02在R01后结案产品项。未发布或无信息阻塞只影响对应Issue，不让开发Agent长期轮询。最终分列：已发布解决、代码完成未发布、调查/缺信息、增强未完成；不用“已行政移交”计成功。
