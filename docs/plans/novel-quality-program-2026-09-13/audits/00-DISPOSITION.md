# Program v2 独立对抗审计

状态：**Program v2 两轨独立复审均PASS，可按依赖派发。** v1首审的3个P1与3个实施阻断P2全部关闭；v2的17个合同/Spec文件经两轨复算hash一致。旧计划/Spec的PASS只覆盖旧范围，本次新默认、贡献者接入、Issue行政归档与发布顺序已另行受审。通过只表示计划可实施，不代表任何生产实现/模型/迁移/安装版/发布或Issue关闭已完成。

本轮基础事实由两名独立Sol/high agent只读调查；主线程编写整合计划，接下来由这两名审计者各自检查另一维度和完整接口，不能代替实现后的code-review。

审计对象：00–06文档、8个新Spec与dag.json；旧24Spec按05显式覆盖后合读。审计意见/裁决/复审原文分别保存；任何未关闭阻断不得写通过。

## 首审与修订

两轨均独立提出FAIL；没有把主线程希望的结果当结论。原文：[迁移/治理轨](migration-round-1.md)、[质量/前端轨](quality-round-1.md)。v1/v2全部17个合同/Spec的hash分别在MANIFEST-v1.json、MANIFEST-v2.json；原24Spec v3和三份旧主计划hash未变。

| 发现 | v2最小修订 | 当前状态 |
| --- | --- | --- |
| M-P2-1 产品canonical可能早关 | #187/#219/#221/#224保持open到发布门，child/PR不得替代，Refs不自动close；reopen/re-home先于移交 | Round 2 CLOSED |
| M-P2-2 M05误写live根 | 显式sourceSnapshot+staging capability、所有文件/DB/孤儿只在staging，S04 runner冻结前适配 | Round 2 CLOSED |
| M-P2-3 只核对3个installer | profile驱动精确资产集合（当前7）、hash/大小/run-attempt/sidecar/update引用，过期回S14D | Round 2 CLOSED |
| Q-P1-1 F04后early证据过期 | F05机读三子门，激活后同SHA三固定early双臂、原owner/原80帽、S13强依赖新receipt | Round 2 CLOSED |
| Q-P1-2 存储owner/默认时序 | renderer单JSON/单writer，skin仍main唯一源；mainReady后bootstrap/ack，无键unset，Preflight后激活再Final | Round 2 CLOSED |
| Q-P1-3 头像导出越界 | 删除正文导出附件，只保项目迁移/受控副本资产，不改export-service | Round 2 CLOSED |

另采纳两项质量建议：稳定BusinessSurface而非序列化undo仓库；固定production build/中文fixture/warm-up/交错样本/MAD/一次噪声重跑协议。迁移轨建议的隐私最小receipt和行政/发布分类不混用也写入合同；不引入新机器人、框架、付费签名或新增模型总预算。

## 独立复审原文

- [迁移/Issue/发布轨 Round 2](migration-round-2.md)：PASS，三项M阻断关闭。
- [质量/前端/可执行性轨 Round 2](quality-round-2.md)：PASS，Q1–Q3关闭，两项建议收敛，未发现新增阻断。

执行提醒：S00/原实验runner应把F05 completionRequires落实成Final与三份case receipt的字段级校验（candidate SHA/arm/targets/parity/实际命令），不能只在界面显示一句字符串；这是已有合同的实现要求，不新增节点或框架。

本地文档/依赖校验见[静态检查](../07-PACKAGE-CHECKS.md)。独立审计与静态检查均不替代开发后的code-review和产品测试。
