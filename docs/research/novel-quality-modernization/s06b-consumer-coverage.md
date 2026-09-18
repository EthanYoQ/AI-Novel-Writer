# S06B 正文与批量入口接线

依赖：S06A `852226db8058f171b98cee40d39bdcddb4f6be3a`。早期实施使用 Astra/Medium；用户随后解除固定限制，后续子代理按复杂度分配且最低 Terra/Xhigh，新增知识库和恢复流程复审使用 Astra/Xhigh。本文件保留消费者初始接线与回归口径；最终准备快照、恢复修复、四项独立复审和桌面 IPC 验收见 `s06b-s09a-integration-evidence.md`。真实模型调用 0，实验总帽仍 80。

| 入口 | 生产接线 | 恢复与拒绝边界 |
| --- | --- | --- |
| `GenerateDraftCommand` 默认依赖 | main-issued handle → `generation:execute`；初始/续写/唯一无进展恢复同 root | 900/2000/3000 仍用原 `countDraftUnits`、长度与前章重演检查；不再调用 renderer provider |
| 正文可见组合 | 纯 `draft-visible-v1`；每次明确 artifact IDs、文本 hash 经 main 核验 | 原 raw artifacts 不改；低增量 length 片段不进入 acknowledged composition |
| 正文保存 | `generation:commit-draft`；版本、依赖与事务由 main 推导 | 不走 next-version/create 分拆写；本地作者配置变化拒绝，已有候选保留 |
| 单章重启 | exact handle → `generation:read-context` | 作者输入与 source IDs 必须相同；承接已用续写轮数/唯一恢复次数；stop 足长只重试保存；已保存 ACK 丢失读原历史 receipt，不 resume 新写 |
| 批量待审 | `begin-batch` / 每章 `read-batch` / child `batchId` | 只读 main progress；同 lineage 的直接前驱以 draft ID/version/hash 重读；无 closure 候选账本 |
| 批量自动定稿 | 原 FinalizationSnapshot、outbox、后处理；main progress 核验 | saved-but-unfinalized 不再生成；已有 finalizationId 只重试原 publication/outbox 和后处理，确认后才能推进 |
| 输出面板 | `generation:list` / `list-batches` / exact `read-context` | 显式片段选择顺序；不猜 latest；只允许 main `compositionEligible === true` 的片段，status 本身不授权；其余片段及未落盘尾巴可复制；批量只按选中 batchId 重读原范围 |
| workflow store | UI 调度及 main cancel intent；`requiresConfirmation` 执行前等作者确认 | 自动模式也不自动采用；取消与重复确认不会执行采用；main adapter 共用取消 promise，关闭 runtime 后仍可请求 root cancel |

## 已落中央接线

主集成者拥有 `generation-owner-contract.ts`、workflow main helper、主进程 owner/source-binding/draft-effects：draft/compose/read-context/batch DTO、同 root 预算、原子 guarded draft commit、原始 source 校验、批量 child nonce、exact pending run/finalization、关闭后取消回调。

本片拥有纯 `draft-visible-text.ts` 和恢复 helper；未修改 review/refine。原注入 legacy driver 仅保留既有确定性单测兼容，不作为已迁生产证据。自动定稿后处理的既有业务实现保留，其后续领域迁移仍由对应片负责，不能由本片合成 fixture 宣称真实模型全链路通过。

## 验证

- 正文专属 106/106：含实际默认 facade/typed transport 合成 IPC、900/2000/3000、低增量不 ack、作者本地改稿、stop/length 恢复、旧 epoch 保存 ACK 丢失不新发。
- 批量专属 20/20：两模式、直接前驱、重建 workflow 跳过已保存章且保持原 root、outbox-only 恢复。
- store pause 24/24、generation-budget 3/3：确认/取消安全边界与原预算回归。
- Chromium 输出面板 11/11（原失败展示 9 + 明确选择 2）；既有批量完成模式 8/8（中文/英文树、编辑器、待审/定稿、前章尾部与冻结模型）。浏览器端口由 OS 分配，未改全局配置。
- `pnpm exec tsc --noEmit` exit 0；owned 文件 ESLint exit 0；`pnpm check:i18n` exit 0。

浏览器旧 fixture 首轮 7/8 失败，明确拒绝 `generation:begin-batch`；已将合成 backend 改为 main facade/组合/原子提交，保留原产品断言。失败截图保留在该测试自动截图目录；未把旧 fixture 错误解释为生产通过。

复审修复：真实主进程将 `finishReason=length` 投影为 `status=failed`，仅按 completed 选择会阻断 composition ACK 丢失后的恢复。中央现投影持久资格 `compositionEligible`；UI/helper 严格要求 true，不按 failed 一概放行。实际 Chromium 2/2 验证 stop/completed 与 length/failed 的有资格片段可显式组合；无资格 failed 和缺证据 completed 均禁选，直接 helper 调用也在 compose 前拒绝。日志 `s06b-length-recovery-browser.log`。

局部日志：`.runtime/.cache/novel-quality-modernization/s06b-owned-node.log`、`s06b-batch-browser.log`。这些只含合成测试，无密钥与真实小说。主进程真实 SQLite/source guard 的独立测试、全量回归、实际 Electron 与最终审查结论由主集成者另记；本文不替代这些门槛。
