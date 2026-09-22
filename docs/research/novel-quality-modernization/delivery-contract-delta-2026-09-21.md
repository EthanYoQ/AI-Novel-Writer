# Program v3 现行交付合同 delta

生效：2026-09-21，经用户采纳。此文件只替代下列冲突条款；冻结 Spec、DAG、manifest 与历史实验回执保持原样。其余功能、安全、样本、逐请求记账和三目标资格义务继续有效。执行规则见 [`docs/agents/delivery.md`](../../agents/delivery.md)。

## 顺序和汇合门

| 冻结载体 | 现行替代条款 |
| --- | --- |
| v3 `specs/F05.md` §7–8、`04-EXECUTION-MATRIX.md` F05/S13 行与第 67–69 行、`05-INTEGRATION-CONTRACT.md` 第 21、67、137 行、`dag.json` 的 `F05.post-ui-requalification` 和 S13 `requiredGates` | F05 先完成全部确定性 Preflight，再由主线程激活 Writer 发布默认值并完成确定性 Final；三份 post-UI 模型子门明确记作**待最终资格**，此时 F05 整体不得写 PASS。随后 S13 清理、S14A 集成审查/必要全量回归/候选冻结，再在冻结候选上执行 post-UI。S13 的执行先决条件是 F05 确定性 Final，原 DAG 的三份 post-UI 先决条件不适用。最终汇合门要求三份 post-UI、S14B、S14C、S14D 所需同候选资格齐全，缺任一项不得发布。冻结 DAG 只记录原规划，不是现行任务调度器。 |
| 旧内核 `specs/S13.md` §依赖与 §实施步骤、v3 F05 的同 `postUiIntegrationSha` 要求 | S13 仍核对三项 early 历史门，但不等待 post-UI；其行为变更须在 S14A 冻结前合入。post-UI 绑定 S14A 实际候选 code/artifact/driver SHA。旧 early 或 F05 确定性回执不能代填 post-UI。 |
| 旧内核 `specs/S14A.md` §实施步骤、S14B §实施步骤、S14C §实施步骤、S14D §实施步骤、v3 R01 §输入 | S14A 进行一次必要的全量回归、独立集成审查和候选冻结。post-UI 与 S14B 共用配置核验和双臂零模型 dry-run；S14C 可在隔离 profile/数据下并行。S14D 汇合真实包资格；R01 只准备或在明确授权下执行精确产物发布。 |

post-UI 与最终实验只有在固定案例的触发条件、断言、双臂产物和独立评审完整覆盖时，才可复用同一实际样本；未覆盖的固定案例仍执行。每个复用决定记录 case ID、双方原始 receipt、各断言对应和实际 `testedSha`。不得挑优、删除失败、追溯改判，或用模拟结果代替真实模型。candidate 字数为 ±30%；baseline、历史结果及其他性能百分比不变。80 是计划分配额，不是全局硬帽；每次真实发送、失败、unknown 与重试继续逐请求记账。

## 证据层与失效

冻结 `feature-union.json` 的 153 个 action、Writer 必需入口和逐 action 断言不变。其旧 `requiredEvidenceLevels` 由现行 [`feature-evidence-levels.json`](feature-evidence-levels.json) 在 execution 检查时覆盖：普通展示/导航可由真实组件浏览器证明；IPC、持久化、文件授权、恢复、凭据、IME、窗口、原生模块和安装包保持必要的 Electron/打包证据。同回执可含多个不同 step，不得用不相关 action 的同一步冒充。未测、null、内部直接调用或 Classic 回执不能填 Writer 动作。

## Writer 唯一产品界面

用户于 2026-09-21 决定 Writer 是最终产品的唯一主界面。本节取代冻结 `02-FRONTEND-DECISION.md` §5、`09-FEATURE-UNION.md` 的双壳结果等价、`specs/F05.md` §1/4/6/18、`specs/S13.md` 的 Classic 长期回切/全面双壳验收，以及 R01 文案中的经典回切承诺；冻结文件和历史回执不改写。`feature-union.json` 的 `classicExpectation` 是旧计划字段，不再作为执行资格门。

- F05 的 153 个必需动作继续全部从 Writer 实际入口验收。普通功能与开发演示在测试 profile 明确选择 Writer，并在操作前断言当前 shell 为 Writer；旧默认启动、v1/v2 偏好迁移只进入专门迁移场景，不代填 Writer 动作。测试 profile 选择不等于发布默认激活；正式 `RELEASE_DEFAULT_SHELL` 仍待确定性 Preflight 全过后修改，并单独验证 unset/new install。
- 冻结清单中的 U02.A02 专测旧壳偏好迁移至 Writer；U02.A07 原“Writer 回切 Classic 不丢状态”由旧偏好迁移后的 **Writer 项目与编辑状态保全**替代。两项只在隔离的迁移场景验收，动作编号仍须逐项留证，旧计划标签保留原样；不得以正式产品中的 Classic 回切控件或普通 Writer 测试代填。现行机器资格字段为 `feature-evidence-levels.json` 的 `migrationScenarios` 与回执 `evidence.migrationScenario`。
- 停止新增 Classic 专属功能和对当前候选作全面双壳共同业务比较。共享 store、command、IPC、编辑器及其他业务组件继续复用，不因旧目录名重写。旧项目、数据、主题/字体/缩放/图片皮肤与壳偏好的必要迁移仍须验证；历史 Classic baseline 在隔离环境保留，不能以当前候选的 Classic UI 冒充历史 baseline。S13 只清理确认无消费者的 Classic 专属入口和分支，不移除迁移、恢复或共享业务。
- 冻结编辑器性能协议的 3000/200000 单位、3 次预热、7 次有效样本、IME 精确性、绝对响应阈值与相对 20% 上限仍有效；当前候选只在 Writer 测量。Classic 基线从隔离历史环境取得，保留其实际 `testedSha`、原始样本和回执，按同设备/视口/字体条件比较；不要求当前候选 Classic UI 参与交错验收，不追溯改写历史结果。现行机器执行输入由 `feature-evidence-levels.json` 指定。
- R01 只描述实际交付的 Writer 功能和迁移边界；不得宣称 Classic 可长期回切。外观图片皮肤名 `classic` 仍指图片，不是旧界面壳。

旧内核 S14A §4、S14B §5、S14C §4、S14D §4 与 v3 R01 §2/7 中“任意 tracked 改动使全部资格失效”由实际影响判断取代。保留原 `testedSha` 和实际差异；只有变更触及被测行为、配置、driver、原生/构建环境或证据消费者时，才重验相应层和受影响回归。纯文档不重跑产品实验；新包必须核验新产物的构建来源、安装/启动、hash 和精确资产集合。无证据证明可沿用时状态为未资格，不能只用相同版本号或 diff 直觉继承。

feature-union execution checker 对旧 `testedSha` 仅接受逐 action 的 `evidence.reuseDecision={testedSha,changedPaths,differences,reason}`；缺路径、差异、理由或 SHA 不符仍拒绝。checker 只验证声明形状，审查者必须核对实际差异及消费者后才能接受沿用，不得以填写字段代替影响判断。

确定性状态/故障矩阵在适当 service/repository 层注入；真实进程中断覆盖恢复语义不同的关键提交点，数量由协议而定。旧二进制拒写/受控副本、SQLite/WAL、文件锁、safeStorage、真实 IME、native ABI 与 Windows x64/macOS ARM64/macOS x64 安装资格仍须实测。S14D 与 R01 对精确云端产物、来源和授权的要求继续有效。

## 执行输入与证据保留

- `feature-evidence-levels.json` 是现行 action 层级输入；execution checker 必须读取它，冻结 manifest 不回写。冻结 DAG/规划检查只证明旧合同内部一致性，不是现行依赖 PASS。
- `quality-protocol.md` 解释现行顺序和样本复用；`protocol.json` 的固定案例、字数 revision 与物理账本语义保持现状。若实际执行器需新字段，在候选冻结前按消费者最小改动并重新核验，不为文档变更重冻历史目标。
- 唯一当前检查点记录实际 HEAD、剩余必交项、测试与资格层次、阻断和下一步。历史 handoff 及原始失败只作其 `testedSha` 对应的证据，不当作当前 PASS。
