# S06D 剧情树与叙事候选持久恢复

实施基线为 `2267579d56e3cf456b6ea4d5233d73ce7bb91930`，对应 Draft PR #230。本片覆盖剧情树、叙事计划候选和事件候选；旧角色修复仍阻断 S06D/S07。冻结 Plan/Spec 不变。

## 实际行为

- 主进程以实际蓝图、定稿、叙事计划与确认事件构建固定任务。Renderer 只提交选择器，不能指定生成正文、来源或任务。原模型、来源、时间与任务保存在同一运行中，重开可回读原候选及回执。
- 每个动作只有一次实际生成请求；重复执行读取原请求。未知发送、取消、length 与无效候选保留原始输出，不自动重新请求。剧情树保留原严格解析、规范化和确定性派生规则，派生时间取冻结上下文。
- 计划和事件仅在作者确认候选索引后写入，候选删除或恢复不会重新编号。主进程从原 artifact 派生候选，在同一 SQLite 事务写业务结果与原 attempt 回执；重复确认回读原 ACK。
- 连续确认事件前，先核实本次已保存事件的完整当前行，再排除这些事件对原输入状态的影响。外部事件、作者修改、定稿身份与修订变化仍阻止新写入。历史 ACK 不重新应用数据，也不依赖后来默认模型。
- 剧情树保存同时比较来源版本与原快照哈希。旧 renderer 直接保存接口拒绝写入；手工编辑叙事计划和确认作者事件继续使用原业务入口。
- 通用生成新建/执行不能进入这三个专属操作，也不能从图谱 root 派生通用子任务。已保存回执封存生成结果修改；通用 restart 不能复制旧上下文身份到新运行。

## 验证记录

私有证据位于任务 `.runtime/.cache/novel-quality-modernization/`。计数有重叠，不相加。

| 检查 | 实际结果 |
|---|---|
| 主进程实际 SQLite | `graph-owner-receipt.json`：11 项通过；邻接四套 47 项通过 |
| 来源与绑定 | `s06d-graph-binding-source-root-final.log`：36 项通过，含合法修订号 0、错误章节拒绝、修订变化与连续计划确认 |
| Renderer | `s06d-graph-renderer-hashes.json`：Node 64 项、Chromium 34 项通过；类型和 lint 通过 |
| 主集成者复跑 | `s06d-graph-root-integration.log`：七套 133 项通过，包含实际注册 IPC 原回归 |
| 独立审查 | `graph-effects-independent-final.log`：17 项实际 SQLite 探针；`graph-main-independent-final.log`：18 项实际注册 IPC / file SQLite，全部通过 |
| 全局检查 | `s06d-graph-lint-root.log` 与 `s06d-graph-build-root.log` 退出 0；Vite 原有构建警告保留 |

独立审查已发现并修复定稿章节缺少核对、修订号未冻结，以及本次已确认事件的章节标题变化被排除的问题。最终 IPC 实测包括旧 epoch 到第三、第四次会话的原 ACK、模型删除后的零写回读、并发重复索引只写一次、连续确认第二候选、来源修订变化拒写、旧直接保存零写拒绝，以及手工作者入口仍可使用。首轮曾将修订号 0 错当无效；按现有定稿生产流程纠正测试期望并保留失败日志，没有把旧通用来源校验的不一致引入图谱入口。

## 未完成资格

真实模型调用仍为 0/80；合成 dispatch、SQLite 和 Chromium 测试不能代替模型质量、实际 Electron 安装、Writer 全动作、中文 IME、portable/WebDAV 或发布资格。

基线提交的 Windows CI [34741939767](https://github.com/EthanYoQ/AI-Novel-Writer/actions/runs/34741939767) 有 347 个测试文件、3666 项测试通过，9 项跳过；整体失败于向量迁移 worker 在 `copy-enter` 后以 `0xC0000409` 退出。此轮没有普通断言失败或超时失败，但原 native 根因仍未确认，未屏蔽测试或扩大超时。
