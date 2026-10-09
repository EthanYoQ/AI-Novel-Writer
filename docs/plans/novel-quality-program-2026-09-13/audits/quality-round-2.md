# 独立对抗计划审计：质量与可执行性 Round 2

审计者：独立质量轨（Sol/high）  
日期：2026-09-13  
范围：只复审 Program v1→v2 的有界增量，逐项关闭 Round 1 的 Q1–Q3、两项 P2 与迁移轨三项 P2；未重做全仓源码调查，未运行模型、Electron、安装版、代码测试或发布。

## Verdict：PASS

Program v2 已具备安全派发条件。Round 1 的三个 P1 均已关闭，未发现修订之间新增的 P0/P1 阻断。此 PASS 只表示计划/Spec/调度合同可以实施，不表示任何代码、真实模型、安装版、迁移、视觉或发布门已经通过。

`audits/MANIFEST-v2.json` 所列 17 个文件与当前字节 SHA-256 全部一致（17/17）；本轮所审对象因此可复现锁定。

## 逐项关闭

### Q1 / 原 P1-1：F04 后 early receipt 失效 — 已关闭

- `01-MASTER-PLAN.md:30-33` 固定了 F04/F05 后的顺序：F05 Preflight → 集成者激活发布默认 → 同一集成 SHA 的 Final 与三道 post-UI early 复验；S13 之后才退出 Vela，相关入口/参数再变更则旧资格不继承。
- `04-EXECUTION-MATRIX.md:31-33,53,58` 将 F05 子门置于 F04 后，保留原 S07/S10B/S11 owner，且 S13 必须消费新的 post-UI receipt。
- `dag.json:185-246` 已提供可调度结构：`preflight`、`activate-release-default`、`post-ui-requalification`，三案例 selector/owner、共享 80 次物理调用、`postUiIntegrationSha` 均明确；`S13.requiredGates` 强引用 `F05.post-ui-requalification`。
- `specs/F05.md:10-12` 要求 Final 与三份 receipt 绑定同一第 6 步集成 SHA；每个 owner 重建 candidate manifest，先跑真实双目标零模型 dry-run/parity，再跑原固定中文两臂案例。mock、旧 PASS、历史单臂均不得替代；失败/复核计入原 80 次，总量不足只能 blocked/inconclusive，且不替代 S14B 的 18 章最终双臂。

反例复核：若 F04 漏传恢复参数、重复 dispatch 或改变审修选择，F04 前的 early PASS 已不能让 S13 放行。若 F05 后乃至 S13 又改到相关入口/参数，`01:32`、C14（`05-INTEGRATION-CONTRACT.md:63-65`）明确要求在冻结前重新资格，不能把旧 receipt 换绑到新 SHA。

### Q2 / 原 P1-2：外观迁移 owner 与 Writer 默认时序 — 已关闭

- C10 的逐键表（`05-INTEGRATION-CONTRACT.md:11-21`）把两个 renderer legacy key、canonical `ai-novel-writer-appearance`、main SkinService、唯一 writer 和实施 owner 分开：F01 直接拥有 theme/ui-version hydration 适配，S03 只拥有 main 全局/skin 迁移，主集成者只做 App/IPC 启动接线。
- 启动顺序唯一：S03 发 `mainReady` 后，F01 在业务 hydration/initTheme 前执行 `pending → migrated | blocked`；旧 userData/partition/origin 保留到 read-back ack。canonical JSON 一次 `setItem` 后回读确认，未 ack 不删旧键，重启可幂等继续；损坏/不可用/skin 失败保留原值并安全回 Classic，不写默认。
- background skin 仍由 main SkinService 单写；renderer JSON 不镜像 skin。组合快照只携 `profileRevision` 与 `skinRevision`，明确不声称跨进程原子 generation。
- 无 shell 键只记录 `unset`。Preflight 通过后才由集成者把发布策略设为 Writer；它不写入 `shellPreference`，显式 Classic/Writer 始终优先。默认激活后才取 Final/post-UI 的同一 SHA，S14A 只核验，不再晚改（C10:21、`specs/F01.md:8-14`、`specs/F05.md:10-12`、`dag.json:199-216`）。

反例复核：旧主题/字体恰好等于默认值时仍按作者显式值迁移；无壳字段不会在 F05 前被物化为 Writer；main skin 加载失败也不能借 fallback 绕过 C08 或覆盖作者偏好。各路径已有唯一 owner 与对应 storage fixture，Sol 切片可执行。

### Q3 / 原 P1-3：头像附件扩张正文导出 — 已关闭

`05-INTEGRATION-CONTRACT.md:49-51` 与 `specs/F03.md:9-13` 将 M05 限定为 S04 提供的 `sourceSnapshot/stagingTargetRoot`、项目迁移和受控项目副本/导入；现有 merged-md/split-md/txt 明确只含正文，不改 export-service/ExportDialog、不增加头像附件、不发明备份格式。F03 可在其资产 service/repository/M05 与一个共享接线请求内完成。

### 原 P2-1：稳定 BusinessSurface / 不造 undo 仓库 — 已采纳

C11（`05-INTEGRATION-CONTRACT.md:27-33`）和 `specs/F04.md:6-17` 优先保持同一 BusinessSurface/EditorArea 的稳定 React owner/key，仅切 chrome/layout；明确禁止通过永久挂载所有页面或新建 CodeMirror undo 序列化仓库规避问题，并覆盖 IME composition、selection/undo、未发送助手输入及项目转换门。没有形成新的跨页状态平台。

### 原 P2-2：20% 性能线缺测量协议 — 已采纳

`specs/F05.md:16` 已冻结：production build、同机同分辨率/缩放/字体、3000/200000 中文单位两份合成文档、Classic/Writer 交错、3 次 warm-up 后各 7 个样本、DOM 完成后的下一绘制帧计时、原始样本/median/MAD；`MAD/median > 10%` 或后台负载不一致最多按同协议重跑一次，仍不稳定为 inconclusive。S00 负责预注册并复用既有 runner，不引入 benchmark 平台。

### 迁移轨 P2：三项均已关闭

1. **产品 canonical 持续 open。** `03-ISSUE-CLOSURE.md:24-33,43-47`、`specs/G01.md:7-13` 与 `specs/G02.md:5-11` 要求 #187/#219/#221/#224 的产品 canonical 保持 open 到公开发布门；child、PR 或行政归档不能替代，任何零 open 间隙须先 reopen/re-home。
2. **M05 staging-only。** C13（`05-INTEGRATION-CONTRACT.md:45-51`）与 `specs/F03.md:5-13` 禁止 M05 读取默认 runtime/canonical locator；文件、DB 引用和孤儿清单只写 S04 staging，`target-installed` 前 live canonical 零创建/零写，S14A 前由 S04 的 `project-migration-acceptance` 覆盖注入失败和原字节保全。
3. **精确发布资产集合。** `specs/R01.md:8-13` 按冻结 `.release/release-profile.json` 验证当前 7 项精确名称/platform/role/hashPolicy、workflow artifact、update metadata 与 tag/subjectSha；缺项、额外旧项、错误 sidecar 或过期 artifact 均不合格，R01 不允许重建或替换被测字节。

## 非阻断实施提醒

- `dag.json` 已足够表达调度硬依赖；实际 runner 仍须把 `completionRequires` 落成对 Final 和三份 case receipt 的字段级校验，不能只把该字符串展示在报告中。这是 S00/原执行协议已经分配的实施验收，不需要为此新增节点或再造一套门框架。
- PASS 不豁免执行时的 fail-closed：任一 receipt 缺 SHA/arm/target/driver、两目标相同、预算不足、性能样本不稳定、迁移触碰 live root 或平台产物不齐，都只能 blocked/inconclusive/NO-GO。

## 结论

本轮增量没有削弱旧 C01–C09、18 章最终样本、80 次物理调用总帽、双目标、逐请求证据或 S14A `subjectSha` 冻结规则。Program v2 可按现有 32 节点 DAG 与所有权表派发给 Sol/high；后续是否完成必须以实际代码、测试、真实模型、升级、安装版和发布 receipt 分层报告。
