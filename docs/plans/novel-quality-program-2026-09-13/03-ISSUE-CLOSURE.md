# Issue 收敛方案：关闭不等于修复

快照：2026-09-13 00:05 +08:00，EthanYoQ/AI-Novel-Writer，open Issue 10个（排除PR）。已读取正文、评论、label、关联PR/Release。**本轮未关闭或留言。**用户报告的“经常/每次可复现”是报告证据，不是本轮实测通过。

## 1. 逐项承接

| 当前Issue | 事实/当前可关性 | 后续完整责任与关闭门 |
| --- | --- | --- |
| [#199](https://github.com/EthanYoQ/AI-Novel-Writer/issues/199) 长篇大纲范围恢复 | PR#201进入v1.1.0；可completed | G01刷新有无反例；说明实测范围1–20后重开接21–40，不声称200章全验 |
| [#205](https://github.com/EthanYoQ/AI-Novel-Writer/issues/205) continuity v2规格 | PR#208进入v1.1.0；可completed | G01按原规格闭环，不扩大成文学质量/角色完全无漂移承诺 |
| [#211](https://github.com/EthanYoQ/AI-Novel-Writer/issues/211) 图谱保存/角色导入 | PR#212合并master，v1.1.0不含；原Issue只要求代码交付 | G01可按该明确边界completed，必须写“代码合并、尚未发布”；F04保留其成果 |
| [#187](https://github.com/EthanYoQ/AI-Novel-Writer/issues/187) 输出上限 | v1.1.0发布后有复现反馈；#229仅部分、未发布 | S05–S07/S10、S14B/C；各工作流症状承接到canonical后可归档旧项，否则保留，不能completed |
| [#191](https://github.com/EthanYoQ/AI-Novel-Writer/issues/191) 自动人物卡 | 已有导入部分；“随剧情更新”未完全承接 | S08–S09/S10/F04：推断→提议→作者批量采用，不能覆盖作者事实；保留全部子诉求映射才可归档 |
| [#219](https://github.com/EthanYoQ/AI-Novel-Writer/issues/219) 图谱无主角 | 有报告，未发具体信息请求；原因未确定 | S00复现/诊断→S06A/S09/F04；未确认不得强归因角色身份；无复现则缺信息流程 |
| [#221](https://github.com/EthanYoQ/AI-Novel-Writer/issues/221) 多余角色与跨章重复 | 已给1.1.0、Windows、Qwen、步骤/截图 | S09管角色准入；S10B管证据/复述；两症状都承接和验收，不能只修一半关原单 |
| [#222](https://github.com/EthanYoQ/AI-Novel-Writer/issues/222) ActivityBar残留 | PR#223未合并，master文件仍在 | S13唯一删除owner，当前消费者/动态入口为零及回归；源码清理Issue按代码边界completed |
| [#224](https://github.com/EthanYoQ/AI-Novel-Writer/issues/224) 设置白屏 | PR#225未合并，Windows CI失败 | F04/F05保留双入口、默认tab、关闭重开、状态同步与内容；不能以新壳替换就关 |
| [#213](https://github.com/EthanYoQ/AI-Novel-Writer/issues/213) 云存档 | 明确长期规划；本轮未实现 | 保留open，不拿缺日志关闭，不塞入本轮云同步/凭据/跨设备架构 |

当前直接有关闭依据3个；直接符合“请求信息仍不回”的0个。其余7个目前不能无依据关闭。清理目标是**旧追踪完整移交**，不是隐藏未修Bug或强制达到9/10关闭。

## 2. G01：先已完成，再承接归档

执行前逐项重新读state/updatedAt/全部新评论/PR状态及发布包含关系。任何新反例或scope变化使该条暂停，重判；不能使用本页快照批量关单。

完成项逐条发简短证据说明后close，保留comment URL与API回执。对#187/#191/#219/#221/#222/#224：
1. 优先保留现有Issue作为canonical；确需统一到新的实施Issue时，先建对应Spec任务（或复用确切已有任务），每个原始症状逐条链接到有owner、验收门、Blocked by的open successor。
2. 原Issue与successor双向链接，公开原报告关键诊断/失败范围，保留原作者反馈入口。只引用仓库公开证据，不上传小说/密钥/本地原始日志。
3. 完整覆盖且successor仍open，才可将原项按“重复追踪/已转入”行政归档；理由用not_planned（API语义）并明确“本问题未宣称修复，请在后继Issue补充”。只关联PR、总计划或空白Epic不够。
4. scope有遗漏、作者新增反例或没有真正successor则保持open。不是为了关一个Issue而创建一个空壳Issue。
5. 若根因仍不明且已有报告步骤，实施Issue可以先承担复现调查，但不得标ready-for-agent修复或声称已复现；确认Bug后才修。
6. #187/#219/#221/#224的successor必须是**产品问题canonical**，继承G02安装版/公开Release/新反例门并一直保持open；可另有代码child，但child关闭不能让产品问题消失。PR用Refs链接产品canonical，禁止Fixes/Closes自动在merge时关闭它。原单已归档而child关闭、尚未发布时，产品canonical仍必须open，否则台账为blocked并先reopen原单或re-home。GitHub多次写入非原子：先确认完整新canonical open并双向链接，再关闭/缩scope旧canonical；失败保留或先reopen原项，不允许零open间隙。
7. #187承接表显式保留review-chapter、chapter-blueprint-directory、chapter-blueprint-directory:compact-single及v1.1.0后仍复现四项；每项有调查/验收owner，#229或世界观局部修复不得替代。#191的自动化改为提议/批准是本计划产品裁决，不宣称已经实现“无需确认自动覆盖作者信息”；未采用部分公开说明，feature子诉求不得伪装成用户Bug completed。

## 3. 缺信息关闭

用户授权的是“已经请求补充、到现在仍没补”的事实条件，不是把所有缺日志问题直接关。目前没有符合项。

未来请求应一次写清：软件版本/平台、provider与model原名、max output/reasoning等非密钥参数、操作路径/最小中文样例、脱敏诊断、实际/期望结果；明确不要上传Key/整本真实小说。能从本机合成例自行复现则不等用户回复。

新请求由G01写明7个自然日截止时间；到期无人补充且仍不能复现，G02可not_planned关闭，欢迎信息齐备后reopen。不能仅看updatedAt；emoji/机器人评论不代替补齐，具有实质信息的回复必须重判。无需反复催问或新增定时自动关单机器人。

## 4. G02：发布后的完成门

用户Bug默认：重现/根因→修复实际SHA→相关生产/中文场景→适用安装版→实际公开Release包含该SHA→无新反例，才completed。内部代码任务(#211/#222)按已公开的较窄合同执行并披露未发布。

行政归档的旧Issue不计入“已修复”；其产品canonical successor在G02发布门之前必须open，实施child可按代码边界关闭。发现canonical提前关闭/被删/缩scope，先reopen或完整re-home，不能等待计划末尾才补。总规格不因为拆完/票少了自动关闭，#213继续长期保留。报告四栏：已发布解决、代码完成未发布、承接归档未解决、缺信息关闭未证实。
