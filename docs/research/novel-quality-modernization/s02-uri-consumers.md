# S02 资源消费者与权限验收

依赖S01 `7143d301313b95a2df572a3b17f1d459b48d5947`。完整生产路径、URI测试路径与共享接线登记见 `s02-uri-consumers.json`；当前为待独立审查，未提交。

| 消费者 | 适配与权限 |
| --- | --- |
| project-paths / resource-protocol | typed parser/formatter；core白名单、正整数DB ID、chapter/version/review定位、recovery候选；拒绝尾随垃圾、query/hash/编码穿越、原型字段；删除旧vela-protocol模块 |
| draft-index / draft-store | 新状态产生规范URI；正文读取只走集中领域router，角色只读投影不回旧charactersArch；合并仅规范draft+revision身份，移除宽松文件名/parseInt写入回退 |
| editor-store | 新tab与复开旧tab集中规范路径；按项目+类型+规范路径去重；迁移只改变地址，保留dirty正文、保存基准与revision；非法虚拟路径不进入编辑状态 |
| EditorArea / DraftEditor | 新draft/manuscript/recovery路由；draft保存使用typed ID；manuscript/已定稿/已归档只读，虚拟资源不降级成fs写入 |
| ArchFileViewer / WorldBuildingEditor | 新core URI，characters投影不可直接写；保存前验证资源白名单；dirty刷新门保留 |
| VersionHistory / NarrativeThreadEditor | 版本比较与定稿出处产生新引用，旧/新正文在diff中原样保留 |
| ProjectTree / ManuscriptGroup / sidebar-file-openers | 新书架与core/实体稿导航；旧引用在打开边界规范化；主进程项目租约继续授予DB访问，URI不是文件授权 |
| AIOutputPanel | 新recovery URI，只暴露已有候选，不自动正式写入 |
| chapter-workflow / workflow-draft-meta / batch-chapter-workflow | 旧URI读取经集中parser规范化；新元数据产生规范路径；状态变更/定稿不能从原legacy URI取得写权 |
| generate-draft / refine-draft / refine-from-review / review-chapter commands | 草稿/修订/审稿产出规范URI；直接DB ID路径经过formatter校验，未改生成预算或正文算法 |
| finalization-client | 只读取window.aiNovelAPI；旧会话拒绝；缺新桥接不借旧桥接写入 |

旧URI仅在集中parser作为输入可读。作者复开旧tab时生成规范引用后，正常作者动作可保存；不提供旧桥接/旧URI直接写fallback。物理`.vela`与prompts布局仍由S03/S04负责，此处没有提前迁磁盘、重写作者正文或修改真实小说。

实际验证：Node资源权限/桥接/dirty/merge等52项通过；最后dirty/merge三文件42项通过；生成/审修中文115项通过（21个英文测试未纳入该回归）；typecheck退出0；中文真实VersionHistory组件经新桥接比较两份正文，规范URI断言1项通过，端口63513。全部completion/IPC是fixture，模型调用0。按旧Spec先前运行的VersionHistory.locale两项为既有英文locale回归，不能代替此处中文场景证据；最终中文验收使用新增resource.browser文件。

一次失败记录：既有generate-draft mock返回`id: 'draft-1'`，与真实DB数字ID合同不一致，typed formatter拒绝。只把合成mock改为数字1，未放宽生产parser；之后中文115项通过。

主集成者接线：preload expose、window类型、ipc-client、current release smoke与升级后driver全部使用aiNovelAPI，缺失明确拒绝。旧安装版专用只读探针保留旧桥接作为资格工具例外，不是新应用fallback。此worker未修改main/App/preload/中央IPC/appearance或包配置；主线程已通知桥接实现完成，完整集成资格以其同SHA审查/测试为准。真实Electron/安装包与磁盘迁移未运行，不能用浏览器fixture冒充。

### 全量回归发现后的桥接夹具修正

四个路径见 JSON 的 `bridgeFixtureDeltaPaths`。原 `generation-budget` 三项实跑失败，记录的 `run.error` 为写作 Skill 快照无法加载，因为 `aiNovelAPI` 未就绪，步骤仍 pending。只为这四组既有工作流测试补显式合成桥接：用户 Skill 列表为空、项目 Skill 文件不存在、事件订阅可释放；未知 invoke 继续拒绝，结束后恢复全局对象。未修改生产 fallback、业务预算或 F01。

`pnpm exec vitest run src/stores/__tests__/workflow-store-generation-budget.test.ts src/stores/__tests__/workflow-store-pause.test.ts src/stores/__tests__/workflow-store-resource-conflict.test.ts src/services/workflows/__tests__/workflow-resource-claims.test.ts`：4 文件、37/37、exit 0。日志 `.runtime/.cache/novel-quality-modernization/s02-workflow-bridge-regression.log`。这批是既有兼容回归，包含原有英文夹具，不计入中文产品实验。
