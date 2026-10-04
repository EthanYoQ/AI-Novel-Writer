# S06D 旧角色名单修复

实施基线为 `7101b6ef532462baa111306dc7b87186f4cc7d4d`。此片处理 S00 登记的最后一条默认旧生成入口，以及原本不调用模型的既有角色卡采用分支。本文与消费者表、最终独立收据共同记录 S06D 源码及局部确定性门，不替代后续真实模型和产品资格。

## 主进程与数据边界

- 模型修复读取实际 M02 数据库中的原始 Markdown、迁移状态、名单版本、身份版本、角色与关系事实哈希、类型和语言。原文按原始字节保留，不由 renderer 提供事实或生成任务。
- 原固定任务、JSON 语法修复任务与结构化替换提示词抽成共享纯函数。初始阶段最多三次请求；只有明确完成但 JSON 语法失败才进入一次语法修复阶段，该阶段最多三次。两阶段沿用同 run、root、model；替换始终基于本阶段原任务。未知发送、取消、过滤和语义校验失败不触发额外语法修复。
- 模型结果通过原名单 schema、身份唯一性和关系闭包验证后，只形成持久角色提议。候选在原 artifact 顺序内获得稳定 selection key；原 entry，包括完整 currentState，保存在 rawValue。静态采用不把候选当前状态冒充为定稿派生状态。
- 专属 stage 同事务保存提议和原 attempt effect。普通提议 stage 不能绕过此入口。明确批准继续走 ID 写入和同事务身份批准；全部暂不采用时拒绝把待修复名单伪装为已完成。
- 历史 stage 与批准 ACK 在当前来源或模型不可用时仍可读取。新 legacy 提议额外冻结实际身份批准的 payload/receipt 哈希、操作 ID 和创建身份结果；修改底层批准收据会使重放失败，不重新应用当前事实。
- 既有卡片采用不读取模型、不重写角色字段、别名、关系、动态值或原始 Markdown。作者明确操作只重建只读图谱，并将原请求、完整 ACK 保存在隔离命名空间的现有身份批准表中。当前事实哈希来自实际行，包含退役角色及状态 provenance；失败时投影和回执一起回滚。

## 当前验证

私有日志与哈希在任务 `.runtime/.cache/novel-quality-modernization/`。重叠计数不相加。

| 检查 | 证据 |
|---|---|
| 纯函数与原行为 | `s06d-legacy-pure-hashes.json`、`s06d-legacy-replacement-hashes.json`；最终四套 58 项通过，含实际 Base JSON 解析和中英文替换提示词对照 |
| 无模型来源与采用 | `legacy-roster-source-receipt.json`：12 项；独立 `legacy-roster-source-independent-review-receipt.json`：20 项实际 SQLite 探针通过 |
| 专属 owner | `legacy-owner-receipt.json`：12 项，含六次请求、旧 epoch、实际 ID 批准、候选动态状态保全和无模型采用；相邻回归 57 项 |
| 主集成者回归 | `s06d-legacy-root-initial-integration.log`：三套 54 项；批准收据补强后 `s06d-legacy-approval-root-regression.log`：16 项通过 |
| 主集成者边界回归 | `s06d-legacy-root-boundary-final.log`：七套 88 项通过，覆盖身份写入、旧定稿提议、图谱、批准及共享解析；i18n 检查通过 |
| 模型主流程独立审查 | `legacy-roster-main-independent-review-receipt.json`：proof/effect/CPB 七项与实际注册 IPC 22 项全部通过；13 个源码哈希与冻结状态一致 |
| Renderer 最终回归 | `s06d-legacy-renderer-hashes.json`：12 文件冻结；Node 26 项、三个实际 Chromium 文件 23 项通过；类型、定向 lint、差异检查通过 |
| 界面独立审查 | `legacy-roster-ui-independent-review-receipt.json`：私有 Node 五项、实际 Chromium 一项反例通过；另独立执行原 Node 26 项及 Chromium 23 项回归通过，最终 12/12 哈希匹配，无未关闭阻断；首次失败日志保留 |
| 最终默认消费者 | `s06d-consumer-coverage-final-current.json`：13 类默认入口核销通过；取消与跨项目修复后，最终 renderer 12/12 哈希匹配 |
| 主集成者最终构建 | `s06d-legacy-build-root-p2-fixed.log`：退出 0；全库 lint 加最终 renderer 变化 lint 退出 0；Vite 构建及 React act 提示保留，不宣称无警告 |

独立审查确认并修复了批准 ACK 只校验版本号的问题；修改 payload 哈希、批准操作或创建身份的反例已进入永久回归。最终注册 IPC 包括六次实际合成发送、跨五次会话的原候选与批准回执、逐阶段来源变化、两处事务末尾失败回滚、取消晚到、artifact 篡改/丢弃、通用入口旁路拒绝。界面验收仍单独记录，不能用以上主进程测试代替。

界面独审另外复现并修闭了两项 P2：读取历史或打开运行期间取消，仍可能调用 execute；ArchFileViewer 显示非当前项目时仍挂载当前项目的恢复面板。现在取消检查在新写入入口同步执行，已知运行只取消一次；非当前项目不读取、显示或取消另一项目的恢复运行。首次失败日志保留。主集成者最终构建发现的新增测试 mock 参数类型错误也已修正，重跑通过。

## 未取得的资格

真实模型仍为 0/80。合成响应、SQLite 和浏览器验证不等于实际模型质量、安装版 Electron、Writer 全动作、中文 IME、归档/WebDAV 或发布资格。

图谱依赖提交的 Windows CI [34742946487](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/34742946487) 有 350 套、3700 项通过、9 项跳过；整体仍失败于向量迁移 worker 在复制阶段以 `0xC0000409` 退出。新增精确 Node 22/Vitest fork 两种上下文探针均通过，但 native 操作没有重叠，不能排除并发压力；CI 没有提供匹配错误事件或堆栈。未修改 ABI、屏蔽测试或据此宣称修复。
