# DeepSeek Harness 插件安装：官方流程与本机验证

> 调研基线：DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`，2026-08-16。本文只依据固定版本仓库中的官方 CLI、测试与内置 Cordis Skills，以及 DeepSeek Harness 官方 GitHub 仓库。

## 结论

DeepSeek Harness 提供的是两条用途不同的插件路径：

| 路径 | 适用场景 | 生命周期 | 推荐流程 |
| --- | --- | --- | --- |
| 动态 Cordis Plugin | 在正在运行的 Harness 中临时定义、试用或修复 Host/Client 能力 | 进程内；重启后消失 | 检查可用 provider → `cordis_define` 定义不可变 Package → `cordis_run` 激活精确 package ID → 等待审批或启动状态 |
| npm composition bundle | 把一组 Cordis patch 与依赖作为可安装产品能力长期装入某个 profile | 持久化在命名 profile 中 | 包声明 `dsh.bundle.patch` → 构建或打包 → `dsh plugin --profile <name> add <spec>` → CLI 更新 profile 依赖并调和 `dsh.profile.bundles` |

官方资料没有定义“只安装到某个 workspace”的项目级插件安装层。安装单位是 **profile**；项目 checkout 只是本地 npm spec 的来源，workspace 只是会话工作目录。因此，本项目的准确表述是“把插件安装到 `web` profile，并从项目 checkout 链接源码”，而不是“把插件安装到小说项目”。

## 官方构建资料应该怎样使用

官方源码中的完整入门教程不是 `cordis-plugin-development` Skill。两者服务于不同的开发方式：

- [Your first plugin](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/develop/basic/index.md) 从 TypeScript `apply(ctx)` 模块开始，用 `--patch` overlay 把本地源码加载进 Web UI，并说明 effect 清理、依赖注入与三种插件形式。
- [Build a tool](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/develop/basic/tool.md) 说明 `defineTool` 的参数 schema、规范返回值与模型渲染。
- [Plugin configuration](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/develop/basic/config.md) 要求以同名 Schemastery `Config` 导出验证部署配置，禁止把可调参数写死在实现中。
- [Package and install a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/develop/basic/publish.md) 把前面的本地模块封装为声明 `dsh.bundle.patch` 的 npm 组合包，并用 `dsh plugin add` 安装进 profile。

因此，未来维护本项目时应按“源码模块与 `--patch` 快速验证 → 工具、Host、Client 和配置测试 → npm 组合包 → profile 安装验证”的顺序理解官方教程。`cordis-plugin-development` 则用于 DSH 正在运行时的 plain JavaScript 动态 Package 探索，不取代 TypeScript 源码、构建、测试、打包和持久安装流程。

## 官方构建 Skill 的项目级安装

固定版本官方 `cordis` Preset 只附带两项构建相关 Skill：

| Skill | 官方用途 | 本项目用途 |
| --- | --- | --- |
| `cordis-plugin-development` | 通过 Inspect、`cordis_define` 和 `cordis_run` 开发进程内动态 Host/Client Package | 探索或验证实时 Slot、Service、Event、Tool 与主题接口；不能作为持久插件交付方式 |
| `editing-cordis-compositions` | 创建、修改和验证 Cordis composition 或 agent preset | 决定 Host 与 agent plane、校验 preset 挂载及避免服务 realm 冲突 |

DSH 对项目级 Skill 有明确的一手约定。[`dsh-skill-filesystem`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill-filesystem/README.md#discovery) 以最近的 `.git` 祖先作为项目根，并依次扫描：

1. `<projectRoot>/.dsh/skills`，来源 `project-dsh`，rank 100；
2. `<projectRoot>/.agents/skills`，来源 `project-agents`，rank 200。

本项目不随插件或桌面应用分发这两份官方 Skill 副本。开发时应在固定版本的 DeepSeek Harness checkout 中读取原文，或按上游说明安装到用户级 `~/.dsh/skills`；发布包只包含插件实现、preset、许可证与说明文件。固定基线为 DSH commit `47f943859bef60e4160492346772ded9b24f765a`：

| Skill | 源文件与项目副本 SHA-256 |
| --- | --- |
| `cordis-plugin-development` | `01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa` |
| `editing-cordis-compositions` | `8e3081ec066ffe07097e2b9c610c39dca831c7f6bb34dc53f1536be85606e604` |

此前验证曾用官方 provider 在开发 worktree 中加载这两项 Skill。以后升级开发基线时，应重新审查新 DSH commit 中的原文、更新本节 commit 与哈希，并重复 provider 发现、正文加载和 `git diff --check`；不要在项目内保留悄悄分叉的副本。

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

官方发布教程还规定了 Git 安装的构建差异：Git spec 拉取的是源码，不会自动运行普通 `build`。TypeScript 包必须提供自包含的 `prepare`，且 pnpm 10 需要用户在目标 profile 的 `pnpm-workspace.yaml` 中显式允许该安装期构建。允许 `prepare` 等同于允许包代码在 agent 沙箱之外运行，因此应固定 Git commit。若不需要安装期执行代码，应优先交付已包含 `lib/` 的 npm 版本或 `pnpm pack` tarball。

## “项目级安装”的准确含义

命名 profile 位于 DSH home 下，profile 中的插件会作用于所有用该 profile 启动的会话，并不按 workspace 自动隔离。调用命令时所在目录有两个独立作用：

- 启动 Harness 时，它可成为会话的默认 workspace。
- 执行 `add .`、`add ../plugin`、`file:` 或 `link:` spec 时，它用于把相对依赖 spec 锚定成源目录。

所以本地源码链接表达的是“插件代码来自这个项目 checkout”，不是“插件只对这个项目可见”。若需要隔离，应创建单独命名 profile，而不是依赖 workspace 路径。

## Windows 含空格 checkout：固定版本观察

官方 reference 明确称相对 path spec 会相对于调用目录锚定，仓库测试也断言从 checkout 执行 `dsh plugin --profile <name> add .` 能安装并激活 bundle。[实现](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/plugin.ts#L93-L157) 确实先把 `.` 解析为绝对路径，但 Windows 分支随后以 `shell: true` 把参数交给 pnpm；当前测试使用的临时 checkout 路径不含空格，未覆盖重新分词风险。[对应 built-bin 测试](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/tests/built-bin.e2e.ts#L625-L657)。

在上文固定的 DeepSeek Harness 版本上，从路径含空格的 checkout 运行以下命令进行了隔离复现：

```powershell
dsh plugin --profile web add . --ignore-scripts
```

命令失败：pnpm 把绝对路径按空格拆成多个参数，并尝试从 registry 获取其中的片段。该固定版本的 Windows 实现因此不能可靠满足文档对含空格 checkout 的 `add .` 承诺。在上游修复参数边界并增加含空格 built-bin 测试前，可使用 registry/Git spec，或把已构建 tarball 放到不含空格的临时路径后安装。后者是观察时的规避方式，不是官方文档承诺。资格 runner 使用程序化 argv 包装验证了 `link:` 依赖可以加载，但该包装不应作为普通用户命令发布。

## 历史验证边界

2026-08-24 的隔离验证证明，程序化 argv 包装可以从含空格路径加载本地 `link:` 插件，并可完成一次配置在线模型的小说插件会话。该结果只证明当时固定版本和隔离 profile 的链路，不代表当前本机 profile、Worktree 路径或上游 CLI 行为；普通 shell 的 `add .` 仍须按上一节单独验证。

## 一手来源

- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方插件入门教程（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/develop/basic/index.md)
- [官方工具构建教程（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/develop/basic/tool.md)
- [官方插件配置教程（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/develop/basic/config.md)
- [官方打包与安装教程（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/user/develop/basic/publish.md)
- [Cordis Plugin Development Skill（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md)
- [Editing Cordis Compositions Skill（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md)
- [本地 Skill provider 说明（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill-filesystem/README.md)
- [Skills subsystem 说明（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/skills.md)
- [CLI reference（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.md)
- [CLI 中文 reference（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.zh.md)
- [CLI plugin 实现（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/plugin.ts)
- [CLI built-bin 测试（固定版本）](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/tests/built-bin.e2e.ts)
