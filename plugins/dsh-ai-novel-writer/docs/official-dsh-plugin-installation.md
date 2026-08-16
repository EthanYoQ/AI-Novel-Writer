# DeepSeek Harness 插件安装：官方流程与本机验证

> 调研基线：DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`，2026-08-16。本文只依据固定版本仓库中的官方 CLI、测试与内置 Cordis Skills，以及 DeepSeek Harness 官方 GitHub 仓库。

## 结论

DeepSeek Harness 提供的是两条用途不同的插件路径：

| 路径 | 适用场景 | 生命周期 | 推荐流程 |
| --- | --- | --- | --- |
| 动态 Cordis Plugin | 在正在运行的 Harness 中临时定义、试用或修复 Host/Client 能力 | 进程内；重启后消失 | 检查可用 provider → `cordis_define` 定义不可变 Package → `cordis_run` 激活精确 package ID → 等待审批或启动状态 |
| npm composition bundle | 把一组 Cordis patch 与依赖作为可安装产品能力长期装入某个 profile | 持久化在命名 profile 中 | 包声明 `dsh.bundle.patch` → 构建或打包 → `dsh plugin --profile <name> add <spec>` → CLI 更新 profile 依赖并调和 `dsh.profile.bundles` |

官方资料没有定义“只安装到某个 workspace”的项目级插件安装层。安装单位是 **profile**；项目 checkout 只是本地 npm spec 的来源，workspace 只是会话工作目录。因此，本项目的准确表述是“把插件安装到 `web` profile，并从项目 checkout 链接源码”，而不是“把插件安装到小说项目”。

## 动态 Cordis Plugin

官方开发 Skill 给出的顺序是：

1. 用 `cordis_inspect_list` 和 `cordis_inspect_query` 确认可挂载的 Host/Client providers 与现有 composition。
2. 向 `cordis_define` 提交普通 JavaScript Host/Client package。它只创建首个版本或追加新的不可变 Package，不会自动运行。
3. 使用返回的精确 Plugin ID 与 Package ID 调用 `cordis_run`。首次激活、重启和回滚使用 `run`；已运行插件切换版本使用 `update`。
4. 若状态是 `awaiting-approval` 或 `starting`，当前工具流程应结束并等待状态更新；这两个状态都不能当作成功。
5. 动态插件只用于临时、进程内能力。`cordis_mount` 同样在重启后消失，只适合探测；需要持久化的能力应进入 composition 文件、preset 或可安装 bundle。

这里的 Plugin 是稳定身份，Package 是不可变代码版本，Run 是一次激活尝试；三者不能混用。详见官方 [Cordis Plugin Development Skill](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md#L10-L33) 与 [Editing Cordis Compositions Skill](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md#L13-L35)。

## 可安装 npm composition bundle

可分发插件应是一个 npm package，并在 package manifest 中声明 `dsh.bundle.patch`。官方 CLI 的推荐使用方式是：

```powershell
dsh plugin --profile web add <package-or-git-spec>
dsh --profile web --dump-config
```

`dsh plugin` 是以目标 profile 目录为工作目录的 pnpm 转发器。成功安装后，它检查已安装依赖：声明 `dsh.bundle.patch` 的包会进入该 profile 的 `dsh.profile.bundles` 有序层；没有 bundle 声明的包仍是普通依赖并产生提示；删除依赖时对应 bundle 层也会退出。profile 目录中的 `package.json`、bundle 列表和自身 patch 共同决定最终 composition。参见官方 [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.md#plugin-management)、[中文 CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.zh.md#插件管理) 与 [plugin.ts](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/plugin.ts#L59-L157)。

对稳定安装，优先使用 registry、Git spec 或已经构建的 tarball。开发期可以使用本地 checkout，但 profile 中形成的是指向该 checkout 的依赖链接；移动、删除或未构建该目录会破坏 profile 加载。

## “项目级安装”的准确含义

命名 profile 位于 DSH home 下，profile 中的插件会作用于所有用该 profile 启动的会话，并不按 workspace 自动隔离。调用命令时所在目录有两个独立作用：

- 启动 Harness 时，它可成为会话的默认 workspace。
- 执行 `add .`、`add ../plugin`、`file:` 或 `link:` spec 时，它用于把相对依赖 spec 锚定成源目录。

所以本地源码链接表达的是“插件代码来自这个项目 checkout”，不是“插件只对这个项目可见”。若需要隔离，应创建单独命名 profile，而不是依赖 workspace 路径。

## Windows 含空格 checkout：文档与当前实现不一致

官方 reference 明确称相对 path spec 会相对于调用目录锚定，仓库测试也断言从 checkout 执行 `dsh plugin --profile <name> add .` 能安装并激活 bundle。[实现](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/plugin.ts#L93-L157) 确实先把 `.` 解析为绝对路径，但 Windows 分支随后以 `shell: true` 把参数交给 pnpm；当前测试使用的临时 checkout 路径不含空格，未覆盖重新分词风险。[对应 built-bin 测试](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/tests/built-bin.e2e.ts#L625-L657)。

在固定版本上，从 `C:\Vibe Coding Project\...\dsh-ai-novel-writer` 运行以下命令进行了隔离复现：

```powershell
dsh plugin --profile web add . --ignore-scripts
```

命令失败：pnpm 把绝对路径拆成 `C:/Vibe`、`Coding` 等多个参数，并尝试从 registry 获取名为 `Coding` 的包。结论是：**当前 Windows 实现不能可靠满足文档对含空格 checkout 的 `add .` 承诺。** 在修复参数边界并增加含空格 built-bin 测试前，可使用 registry/Git spec，或把已构建 tarball 放到不含空格的临时路径后安装。后者是本次调研给出的规避方式，不是官方文档承诺。本次为了验证开发期源码链接，使用了与资格 runner 相同的程序化 argv 包装：传给 DSH CLI 的 path argument 自身保留一层字面双引号，安装后 profile 记录为 `link:` 依赖。该做法证明了二次 shell 解析是失败点，但不应替代上游修复或作为普通用户命令发布。

## 本机验证事实

- 当前 `web` profile 的 `@ethanyoq/dsh-ai-novel-writer` 依赖实际链接到 `C:/Vibe Coding Project/AI Novel/.worktrees/codex-dsh-ai-novel-plugin/plugins/dsh-ai-novel-writer`，且 bundle 列表包含该插件。这证明 profile 可以从含空格的本地链接加载插件，也记录了本次程序化 argv 规避方式的结果；它不证明普通 shell 中的 `add .` 路径可用。
- 配置过的本机 DSH 已用 GLM-5.2 完成一次真实小说插件会话，说明模型、会话与已加载插件的运行链路能够工作。本事实不记录 API key、环境变量值或其他凭据。

## 一手来源

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [Cordis Plugin Development Skill（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md)
- [Editing Cordis Compositions Skill（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md)
- [CLI reference（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.md)
- [CLI 中文 reference（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.zh.md)
- [CLI plugin 实现（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/plugin.ts)
- [CLI built-bin 测试（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/tests/built-bin.e2e.ts)
