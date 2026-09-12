# AI-Novel-Writer 运行时补丁工具（脱敏版）

## 用途
本项目（`EthanYoQ/AI-Novel-Writer` 的 fork）的**源码修复已合入 `src/`**（见下方「四个修复」）。
如果你已经打包发布、不想重新构建，可用本目录的工具对 `app.asar` 直接打补丁，效果等价于源码修复。

> ⚠️ **隐私**：本目录**不包含任何** API Key、私有端点（如第三方代理 / 本地模型地址）、或个人项目路径。
> 所有本地路径都已参数化（`ASAR_PATH` / `EXTRACT_DIR` / `BACKUP_DIR` 等环境变量，或相对路径）。
> 本地含有密钥的调试脚本（例如 `test_json_mode.js`、`apply_model_config.js`、`set_llama_caps.js` 等）**未**纳入本仓库。

## 四个修复
| # | 症状 | 根因 | 源码修复 | 运行时补丁名 |
|---|------|------|----------|--------------|
| 1 | 自定义 OpenAI 兼容端点（自托管模型 / 第三方代理）无法声明结构化输出、用量上报等能力 | `resolveModelProfileCapabilities` 在无匹配内置 preset 时直接 `return undefined` | `src/shared/provider-presets.ts` | `custom-provider-capabilities` |
| 2 | 点击「AI 生成故事架构」报 *生成会话预算超过应用安全上限* | 字符架构预算（20min）对本地慢模型过短；放宽后仍须 ≤ 应用硬上限 G | `src/services/workflows/commands/base-command.ts` 的 `WORKFLOW_GENERATION_BUDGETS` + 测试断言 | `widen-runtime-budgets` |
| 3 | 模型用 `**第N章**` 加粗标题被标题解析器忽略 → 报 *缺失 N 章* | `ZH_CHAPTER_TITLE_RE` 不接受 `**` 加粗前缀 | `src/services/workflows/commands/architecture.command.ts` | `outline-heading-bold` |
| 4 | 续写时模型额外写出「后续概览」（`第21–30章`）被当作越界 → 整批失败 | `assertPlotOutlineTitleCoverage` 把批外标题视为错误 | 同上 `architecture.command.ts` | `outline-ignore-later-headings` |

应用级硬上限 `G`（由 `generation-harness` 执行，超出即抛 *生成会话预算超过应用安全上限*）：

```
G = { maxAttempts:32, maxRequestedOutputTokens:147456,
      maxRequestedOutputTokensPerAttempt:32768, deadlineMs:36e5 }
```

所有新预算均在该上限之内。

## 使用
需要 Node.js（无需额外依赖，全部使用 Node 内置模块）。

```bash
# 0) 指向你的 app.asar（默认 ./app.asar，可用环境变量覆盖）
export ASAR_PATH="C:/path/to/AI小说作家/resources/app.asar"

# 1) 先验证打包器能否无损还原（确认你的构建未被改坏）
node asar_patch.js verify ./app.asar.patched.verify

# 2) 应用补丁（自动先备份、自动做预算护栏检查；幂等）
node asar_patch.js apply

# 3) 出问题回滚
node asar_patch.js restore
```

`asar_patch.js` 的 `PATCHES` 表中每条都有 `mark`（已应用标记）和 `from`/`to`（精确锚点）。
锚点在目标构建中匹配次数 ≠ 1 时会**中止并拒绝写盘**，因此不会把 `app.asar` 写坏。

## ⚠️ 构建版本注意
`PATCHES` 里的 `arc` 字段（如 `dist/assets/index-CxbeuPBs.js`、`dist/assets/generation-harness-HLbxCy5z.js`、`dist-electron/main.js`）
是**特定构建产物名（含内容哈希）**。不同版本哈希会变化，届时 `from` 锚点可能不再命中——
脚本会安全中止，请用 `asar_tool.js` 的 `grep` / `extract` 重新定位新文件名与锚点后再打。
源码修复（`src/`）不受此限制，**重新构建即可**。

## 辅助脚本
- `asar_tool.js`：无依赖的 asar 列表 / 搜索 / 抽取（`list` / `grep` / `extract`）。
- `check_budget.js`：把渲染包里的预算与应用级硬上限 `G` 比对，防止「预算超限」。
- `verify_archive.js`：独立校验 asar 重写是否字节一致。
- `probe_heading.js` / `test_outline_fix.js`：本地验证标题解析与「越界忽略」逻辑
  （`test_outline_fix.js` 需要你自备 `./tmp/idx_installed.mjs` 与 `./sample-partial_arch.json`，**不提交**）。
