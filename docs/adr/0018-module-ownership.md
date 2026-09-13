# Program v3 S01 模块与接线登记

| 模块/公共类型 | 业务owner | 接入位置与前置门 |
| --- | --- | --- |
| src/shared/generation-contract.ts：RootAction、GenerationRun、PhysicalAttempt、VisibleArtifact、RootBudget | S05/S07 | 主进程持久run/attempt/artifact；S06A–D消费同一根；事务reserve→dispatch→settle/unknown |
| src/shared/source-ref.ts：SourceRef、FrozenInputFingerprint、CandidateSource、ContextSnapshot | S05/S10A/B | 写/审/修共享上下文读边界；主进程当前源校验与候选保存收据 |
| src/shared/character-identity.ts：CharacterResolution、CharacterProposal、CharacterFieldSnapshot、DerivedCharacterPatch | S08/S09A/B/C | 身份ID及提议；S09B既有定稿outbox事务C16 CAS与来源序；F03/F04读投影 |
| src/shared/review-cycle.ts：ReviewFinding、ReviewCycle | S11 | 现有审修/合并/outbox；证据唯一定位、一次付费复核与作者waive授权 |
| src/shared/project-storage.ts：MigrationId、GlobalStorageLocators、MainReady、AppearanceProfile | S01/S03/S04/F01 | main启动全局门；S03 mainReady后F01 renderer hydration；main背景与renderer偏好分writer |
| 同文件TransferReadableAuthority、PortableExecutionHistory、PortableReceiptProjection | B01联合S04/S05/S09/S10/S12 | portable字段allowlist会签、来源映射、当前可读与旧执行冻结；不私增M06 |
| electron/migrations/registry.ts、runner.ts | S01 migration owner | 单一PRAGMA版本lane；probe/migrate/verify后由集成者独立fence，业务迁移由各owner提供 |
| database/main/App、IPC/preload/channels/client/types、package/lock/release | 主集成者 | 独占顺序接线，不由领域或migration worker越权修改 |

业务顺序：M00 S04→M01 S05→M02 S08→M03 S11→M04 S12→M05 F03。公共`MigrationId`只有业务标识；registry数字版本为唯一事实源，本文不再复制另一套数字表。

一次共享接线请求：先集成本类型与registry（不启用业务），后S03/S04提供已验证locator和物理迁移，依序安装真实M00–M05；S05把Run/Attempt/Artifact挂唯一持久ledger和IPC，S06改入口消费；S07接物理发送前reserve/dispatch及恢复未知预算；S08/S09将ID/字段CAS与sourceOrder接现有repository/outbox；S10/S11共用SourceRef和ReviewCycle；F01在mainReady后接appearance单writer；B01恢复以transfer receipt重建可读上下文并冻结旧执行。每次中心修改由主集成者串行实施，并在对应片重跑生产入口、故障与同SHA质量门。

S01纯fixture测试不替代这些调用点的实际集成。S00模板/协议/实验runner、inventory与作者资料保持各自owner；不向本模块塞入新的provider或迁移框架。
