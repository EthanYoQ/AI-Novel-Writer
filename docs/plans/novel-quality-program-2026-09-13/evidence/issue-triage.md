# AI-Novel-Writer open Issue 现态清点

快照时间：2026-09-13 00:05（Asia/Shanghai）  
仓库：[EthanYoQ/AI-Novel-Writer](https://github.com/EthanYoQ/AI-Novel-Writer)  
范围：全部 **10** 个当前 open Issue，已排除 PR；读取了正文、全部评论、labels、`updatedAt`、timeline 关联、相关 PR 和最新 Release。未执行评论、关闭、建 Issue、改 label 等 GitHub 写操作。

## 结论先行

- 可建议现在按 `completed` 收敛：**#199、#205、#211**。
  - #199、#205 的修复已进入 **v1.1.0**。
  - #211 只在 `master` 合并，**不在 v1.1.0，尚未发布**；其 Issue 自身把完成边界定义为交付 PR、不发布。如果团队采用“发布后才关用户 Bug”的口径，则把它延至下一版，但不能把它说成已发布。
- 暂不应关闭：**#187、#191、#213、#219、#221、#222、#224**。
- 当前没有任何 Issue 符合“维护者已明确请求补充、长期未答”的关闭条件。没有 open Issue 带 `needs-info`；`needs-triage` 仅表示等待维护者评估，不能冒充已发出的信息请求。
- 当前也没有可安全直接按 `duplicate` 或 `not planned` 关闭的项。#191 虽被回复“合并入其他需求”，但未指向覆盖全部诉求的 canonical Issue，直接关闭会遗失“随情节自动补充角色信息”。

## 逐项裁决

| Issue | 真正最后补充 / 信息请求 | 当前分类 | 建议与理由 |
| --- | --- | --- | --- |
| [#187 输出达到最大长度](https://github.com/EthanYoQ/AI-Novel-Writer/issues/187) | 2026-09-12，用户在 v1.1.0 发布后回复“还是会复现”；没有维护者信息请求 | active-reproducible；已发布修复尝试被新反馈否定；PR #229 仅代码且仅覆盖部分场景 | **保留。** #229 明说不解决全部场景且尚未发布。它应继续作为跨工作流长度/截断 canonical，不能按 completed 关。 |
| [#191 文本自动生成人物卡](https://github.com/EthanYoQ/AI-Novel-Writer/issues/191) | 2026-09-04，维护者说“合并入其他需求”，未给 canonical 链接；未请求信息 | feature；partial-code；duplicate-claim-unresolved | **保留。** PR #212 的粘贴/文件导入尚未发布，且没有覆盖“随情节推进自动新增关键信息”。若决定不做自动更新，才可说明产品决策后按 `not planned` 关；否则必须先链接完整替代 tracker。 |
| [#199 长篇大纲范围与恢复](https://github.com/EthanYoQ/AI-Novel-Writer/issues/199) | 只有完整 Issue 正文，无后续反例；正文中的“模型参数待补”不是发给 reporter 的信息请求 | known-fix-published | **按 `completed` 关闭。** PR #201 已合并并包含在 v1.1.0；Release 明列“按指定章节范围分批生成、中断恢复”。关闭说明要保留只实测 1–20→重开→21–40，未宣称完整 200 章。 |
| [#205 continuity Plan v2](https://github.com/EthanYoQ/AI-Novel-Writer/issues/205) | 2026-09-08 维护者追加逐项目标审稿/UI/验证边界；无信息请求 | known-fix-published；internal implementation tracker | **按 `completed` 关闭。** PR #208 的 merge SHA 就是 v1.1.0 Release target。不能借此宣称文学质量、字数或完全无漂移。 |
| [#211 角色图谱保存/角色卡导入](https://github.com/EthanYoQ/AI-Novel-Writer/issues/211) | 只有已确认、已定界的维护者正文；无信息请求 | known-fix-code-only | **按 `completed` 关闭，但必须写“master 已合并、v1.1.0 未包含”。** PR #212 已合并且 Issue 原定边界就是不发布；若项目坚持 release-gated closure，则保留到下一版。新角色/UI 计划必须保住只读图谱、错误可见、输入保留、项目隔离。 |
| [#213 云存档](https://github.com/EthanYoQ/AI-Novel-Writer/issues/213) | 2026-09-09 社区补充 WebDAV；维护者此前明确“暂不 Close，长期规划”；无信息请求 | feature；long-term-roadmap | **保留。** 没有实现、重复或放弃证据。若纳入未来计划，要先解决凭据隔离、跨设备冲突/CAS 和作者数据覆盖风险；不应顺带塞入本次皮肤/Vela 清理。 |
| [#219 角色图谱频繁无主角](https://github.com/EthanYoQ/AI-Novel-Writer/issues/219) | 来源 Discussion #215；最后是维护者确认建 Issue，未请求诊断 | active-reproducible；diagnostics-needed-not-requested | **保留并先请求信息。** 需要版本、provider/model、实际 finish reason、安全诊断和重试差异；发出具体请求并加 `needs-info` 后，才开始等待期。角色 prompt、解析、身份歧义和持久化都可能是根因，不能靠某一个调整冒充修复。 |
| [#221 多余角色 + 跨章重复](https://github.com/EthanYoQ/AI-Novel-Writer/issues/221) | 2026-09-11 正文已给 1.1.0/Windows/Qwen、经常复现、步骤和截图；没有信息请求 | active-reproducible；multi-symptom | **保留。** 先请求脱敏诊断；再按“角色准入/持久化”和“上下文/重复正文”拆成两个 canonical tracker（若根因不同）。拆分前不得只修一个症状就关原 Issue。 |
| [#222 删除 ActivityBar](https://github.com/EthanYoQ/AI-Novel-Writer/issues/222) | 正文已充分定界；无信息请求 | dead-code；open-pr-unmerged | **保留到集成完成。** PR #223 尚未合并、无 CI；当前 `master` 仍有 `ActivityBar.tsx` 和注释引用。把它纳入全量死代码 wave，验证静态/动态消费者为零后按 `completed` 关。若弃用 PR #223，只关闭 PR，不要丢掉 Issue 验收。 |
| [#224 设置弹窗白屏](https://github.com/EthanYoQ/AI-Novel-Writer/issues/224) | 正文给 Windows/main/pnpm dev、每次复现、两步操作和截图；没有信息请求 | active-reproducible；open-pr-failing | **保留并接入新皮肤验收。** PR #225 尚未合并且 Windows CI 失败。即使新皮肤取代旧补丁，也必须验证左侧栏/状态栏两个入口、默认 tab、重开/状态同步和真实内容渲染后再按 `completed` 关。 |

## 建议写进大计划的 Issue 关闭门

1. **关闭动作必须是计划末端 wave，而不是开工清单。** 每项先绑定 canonical Issue → 实现 SHA/PR → 运行证据 → 发布状态，再给 `completed` / `not planned` 理由；本轮不执行 GitHub 写入。
2. **“缺信息关闭”采用事实门：** 必须存在维护者的具体、脱敏、可回答请求和 `needs-info` 起始时间；reporter 在约定等待期无回复，且维护者不能自行复现，才可 `not planned`。旧日期、空日志栏或 `needs-triage` 均不够。
3. **新皮肤的 canonical 验收至少保留 #224。** 皮肤替换不能以“旧实现被删除”为完成；两个设置入口、默认面板、状态同步、内容加载和失败可见性都要跑。
4. **角色/上下文/审稿调整至少保留 #187、#191、#219、#221 的未决范围。** 特别是 #221 的两个症状要分开出证据；#191 的作者字段与模型推断必须分层，未确认推断不能自动覆盖。
5. **死代码清理绑定 #222。** 其 open PR 与大计划共享 `ActivityBar` 文件所有权，实施时选唯一 owner；不要并行合并 PR #223 与皮肤 wave 后再解决冲突。
6. **关闭说明不得混淆状态：** #199/#205 是 `released in v1.1.0`；#211 和 #187 的 PR #229 是 `merged after v1.1.0 / not released`；#222/#224 仍是 open PR，且 #224 CI 失败。

## 风险与 canonical 保留表

- **必须保留为 open canonical：** #187（跨工作流长度/截断）、#191（角色卡完整自动化诉求）、#213（云存档长期路线）、#219（无主角/角色图谱生成失败）、#221（额外角色与重复正文，拆分前）、#222（ActivityBar 死代码）、#224（设置入口白屏）。
- **关闭后以交付证据承接：** #199 → PR #201 + v1.1.0；#205 → PR #208 + v1.1.0；#211 → PR #212 + 下一版 release checklist。
- **没有可直接使用 `not planned` 的项。** 若产品决定不做 #191 的自动进展更新或 #213 云存档，应记录明确决策和替代路径后再关，而不是用“长期未更新”代替产品判断。

结构化逐项证据见同目录 `issue-inventory.json`。

