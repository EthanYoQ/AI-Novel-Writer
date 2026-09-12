# S06A 中央集成证据

日期：2026-09-13。S05 依赖为 `5c5069673af4d2ef3f8c3e57ac9133e96a898255`；整合基线为 S08 提交 `ee4111e0927593956e3ff59b60ef07a07402a199`。本文件描述结构化入口接线的完成范围；完整 Program、模型质量、安装与发布仍未完成。

## 实际接线

- 五类命令的生产默认路径使用主进程 owner。配置、架构多阶段、目录、资料提取、单字段和文风均冻结实际来源；语义阶段共享 root。未把注入旧 driver 的测试当作生产路径证明。
- 显式作者空指导保留为空字符串，区别于缺项。资料文件名与原文可逆封装，内部 ID 不携带文件名或路径。
- 可见组合由主进程按明确 artifact 顺序重算，校验原始身份、revision/hash、终态和追加进展；仅 stop/length 可以成为自动续写种子。原始候选从不被拼接结果覆盖。
- 正式 core、synopsis、目录与导入 style effect 在写入事务内重建完整来源。synopsis 另保留既有 expected CAS；已有 operation 重读不会再次覆盖作者后来的修改。
- 目录进度随正式蓝图原子提交；显式 operation/child-run 链指定剩余范围。前章作为读取依赖继续冻结，正式范围独立受 remainingRange 限制。重启或续接不清空原预算。
- 作者在生成期间新写的配置/文风会阻止旧结果提交；若修改发生在保存等待期间，已提交字段成为保存基准，新输入仍保留为草稿。导入 style 使用唯一原 effect 回调，未增加第二次 core 写。
- 世界观/大纲首次候选可查看复制，确认组合才可继续；UI 展示的 exact handle 与工厂执行时重读的检查点必须相同。

## 分项验证

| 验证 | 结果与范围 |
|---|---|
| 最终相关 Node 集成 | 17 文件：370 通过、3 失败；失败均为下述 S09 旧名称消费者，不声称整套通过 |
| 实际注册生成/数据库 IPC | 7/7；真实项目 authority 与 canonical SQLite，包含 core/template 变更拒写、同事务源读取、synopsis CAS |
| 主 owner 最新回归 | 26/26；包括目录同预算重启、原子回滚、耗尽额度、来源/续接身份损坏与非法组合终态 |
| 文风并发/资料真实绑定/草稿 store | 独立最终增量 30/30；4 个普通/custom 文风并发反例、3 个真实资料 binding、23 个 store 用例 |
| 中文 Chromium | 世界观/大纲 8/8，目录等启动界面 16/16；合计 24 个相关浏览器用例 |
| 类型与翻译覆盖 | 最终 typecheck、check:i18n 均退出 0 |
| 全库 lint | `pnpm exec eslint . --ext 'ts,tsx' --report-unused-disable-directives --max-warnings 0` 退出 0；Windows 包装命令曾退出 255，另一次未引用扩展参数被传为 `ts tsx` 导致未匹配文件，原日志保留，未把这两次计作通过 |
| 构建 | renderer 与 Electron 源码构建退出 0；后续改动另经类型与针对性测试，不将此构建称为最终安装包 |
| 独立审查 | 52 个代码/测试文件按最后字节 hash 封存；目录范围、资料名称、进度 epoch、文风并发问题均有原反例和修后复验 |

独立审查收据位于私有 `.runtime/.cache/novel-quality-modernization/review-s06a-complete-scope.json`，SHA256 `3b42eddc3fdb0b4f1468eeceee8625ec36210bc76f543193619d03a358ff5e22`。各窄测计数存在重叠，不累计冒充唯一测试总数。合成 provider/IPC 不计作真实模型；累计真实请求仍为 **0/80**。

## 保留的失败与后续门禁

1. `import-run-receipt` 中两条蓝图角色同步与一条全局导入事实用例仍触发 `CHARACTER_ID_WRITE_REQUIRED`。M02 已进入 schema 3，旧 name-only 入口不可绕过；S09 接入 ID/proposal/approval 后再验，未降 schema 或跳过测试。
2. 已准备的导入 style receipt 保存旧 generation handle，跨项目重开后会被 epoch 门禁拒绝；显式 resume 后旧 receipt 仍不匹配新 handle。该 S06D 恢复边界已独立复现，保持拒写，不删 guard。
3. 200 章合成意图在现 32 请求预算下只可能完成连续前缀；保存 1–160、保留 161–200 未完成的测试不称为 200 章成功。后续 S07 校准不得倒置成 renderer 私有额度。
4. 云端 native vector 崩溃仍未定因。诊断提交 `5aead50d6dc466462002e3ed9b7ba77bba2f9937` 的 CI 34722726825（不含 S06A/M02）记录向量 worker `0xC0000409`，另 42 项超时；没有异常参数或 faulting module，不能由退出码推定具体内存错误。下一窄诊断与本片分开提交。
5. Writer 153 动作、真实模型质量、native IME、portable/WebDAV、安装资格、合并、tag、Release 和 Issue 关闭均不由本片测试替代。

冻结计划文件保持原字节；测试截图、日志、模型凭据、作者数据及机器绝对路径未纳入提交。
