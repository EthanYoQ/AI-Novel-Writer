# 安装包产品名改为「书童」，设置目录与安装位置沿用旧标识

2026-10-20 提议。同日维护者在三种方案中选了 C：用户看得到的名字全部改成书童，但不搬数据。

状态：已接受。

## 决定

`electron-builder.json5` 的 `productName` 从 `AI小说作家` 改为 `书童`。改名后，Windows 上的 exe 文件、任务管理器里的进程描述、卸载程序文件名、macOS 的 `.app` 名称、菜单栏标题和 Dock 名称都显示「书童」。PR #444 已把快捷方式名和「应用和功能」里的名称改为「书童 Pagekin」，本次不再改动这两项。

以下标识保持不变：

- `appId`（`com.ai-novel-writer.app`）。NSIS 的注册表键和卸载项键都由它派生。
- `package.json` 的 `name`（`ai-novel-writer`）。Electron 用它决定设置目录，NSIS 用它决定默认安装目录和更新缓存目录。
- 全局数据目录（由 `resolveGlobalDataRoots` 解析，见下文），以及更新使用的仓库地址。
- 安装包文件名。它本来就由 `nsis.artifactName` 和 `mac.artifactName` 写死为 ASCII 名称，与 `productName` 无关。

`electron/main.ts` 在没有 `--user-data-dir` 参数时，把 userData 显式设为 `<appData>/ai-novel-writer`。这个路径与现在的实际位置完全相同，作用是让设置目录今后不再随任何名字变化。

## 调研结论

### 设置目录从来不是 `%APPDATA%\AI小说作家`

任务书原先假设 Electron 的默认 userData 由 `productName` 决定、现为 `%APPDATA%\AI小说作家`。取证结果与此不符：

1. electron-builder 不会把 `productName` 写进 asar 里的 `package.json`。`app-builder-lib/out/fileTransformer.js` 的 `modifyMainPackageJson` 只合并 `extraMetadata`，本项目没有配置 `extraMetadata`。
2. 解开 v1.3.0 正式安装包（sha512 与 Release 的 `latest.yml` 一致）后，`resources/app.asar` 里的 `package.json` 只有 `name: "ai-novel-writer"`，没有 `productName`。
3. Electron 启动时按 `package.json` 的 `productName`，再按 `name`，设置 `app.name`，默认 userData 为 `appData` 加 `app.name`。用 `--inspect-brk` 在 1.3.0 主脚本第一行停住后读取，结果是 `app.getName()` 等于 `ai-novel-writer`。
4. 维护者本机有 `%APPDATA%\ai-novel-writer\.updaterId`（electron-updater 只在打包版里写这个文件），没有 `%APPDATA%\AI小说作家` 目录。

所以打包版的设置目录一直是 `%APPDATA%\ai-novel-writer`（macOS 为 `~/Library/Application Support/ai-novel-writer`）。外观偏好存在渲染进程的 localStorage 里，位于这个目录下。全局数据目录的默认名也是 `ai-novel-writer`，与 userData 撞名，所以 `resolveGlobalDataRoots` 实际把它放在 `ai-novel-writer-data`。这个行为在开发模式和打包版里相同，本次不变。

如果按原任务书写 `app.setPath('userData', '%APPDATA%\AI小说作家')`，所有老用户都会切到一个空目录，外观偏好、`import-source-identity.secret` 等都会「丢失」。本 ADR 改为固定到真实的旧位置。

改名不影响下列依赖：

- 单实例锁：Electron 按 userData 路径加锁。显式设置发生在 `configureSingleInstanceRuntime` 调用 `requestSingleInstanceLock` 之前，路径与旧版一致，新旧版本仍然互斥。
- `--user-data-dir`：显式参数优先，仍走原来的分支。发布冒烟测试都使用这个参数。
- 自动更新缓存：electron-updater 使用 `app-update.yml` 里的 `updaterCacheDirName: ai-novel-writer-updater`。这个值由 `package.json` 的 `name` 生成。`.updaterId` 写在 userData 里，路径也不变。
- Windows AppUserModelID：Electron 二进制里的默认格式是 `electron.app.` 加 `app.name`，`app.name` 不变，所以它也不变。启动时是否实际设置了这个值，没有在本机核实。

### NSIS 升级沿用旧安装目录，不会出现两份安装

以下结论来自 app-builder-lib 26.15.3 的 NSIS 模板：

- 安装目录名：`targetUtil.js` 的 `getWindowsInstallationDirName` 只在 `productFilename` 匹配 `/^[-_+0-9a-zA-Z .]+$/` 时使用产品名，否则使用 `package.json` 的 `name`。`AI小说作家` 和 `书童` 都不匹配，所以新装的默认目录始终是 `%LOCALAPPDATA%\Programs\ai-novel-writer`。
- 升级时：`multiUser.nsh` 先从 `HKCU\Software\<由 appId 生成的 GUID>` 读取 `InstallLocation`，有值就沿用。这个键由 `appId` 生成，改名后不变。
- 卸载项：`UNINSTALL_APP_KEY` 同样是 GUID，所以只有一个卸载项。安装时会覆盖 `DisplayName` 和 `UninstallString`，后者指向 `Uninstall 书童.exe`。
- 旧程序文件：新安装程序先用注册表里的 `UninstallString` 运行旧卸载程序，参数是 `/S /KEEP_APP_DATA --updated`。旧卸载程序删除整个安装目录，包括 `AI小说作家.exe`，再解压新文件。`--updated` 保证不删除应用数据。
- 快捷方式分两种情况，都不会残留：
  - 新 exe 名尚不存在，所以 `keepShortcuts` 判为 false，`--keep-shortcuts` 不会传给旧卸载程序。旧卸载程序按注册表里自己记录的 `ShortcutName` 删除旧的开始菜单和桌面快捷方式，新安装程序再创建 `书童 Pagekin.lnk`。手动运行安装包和应用内更新（带 `--updated`）都走这条路径。
  - 这次升级之后，exe 名不再变化，以后的升级会走 `Rename` 分支，原地改名或保留快捷方式。
- 进程检测：NSIS 用 PowerShell 按 `$INSTDIR` 路径前缀查找运行中的进程，与 exe 名无关。PowerShell 不可用时，回退到按 exe 名调用 `tasklist`。此时新安装程序查找 `书童.exe`，旧卸载程序查找 `AI小说作家.exe`，两边合起来仍能发现正在运行的旧版本。

因此不需要自定义 NSIS include。

### 中文文件名的兼容性，以及为什么选「书童」而不是「书童 Pagekin」

exe 和 `.app` 使用中文名已在 1.3.0 及更早版本中经过验证（`AI小说作家.exe`、`AI小说作家.app`），NSIS Unicode、7z、electron-updater、DMG 都能正常处理。安装包本身仍是 ASCII 文件名，下载链接和 `latest.yml` 不受影响。

「书童 Pagekin」会让文件名多出空格，并混用中英文两种文字。发布门禁要按字面逐字比对 NSIS 生成的命令行，例如 `tasklist /FI "IMAGENAME eq …"` 和 `findstr /C:"\"…\""`；四十多个脚本还会拼接 exe 路径。空格会增加这些地方的引号风险。中英双名已经体现在 PR #444 的快捷方式名和卸载显示名里。如果以后希望 macOS Dock 显示英文名，可以单独设置 `mac.extendInfo.CFBundleDisplayName`，不用改文件名。

## 后果

- 发布、冒烟和验收脚本要同时识别新旧两个名字。凡是可能遇到旧版本的地方（升级测试中的旧 exe、旧卸载程序、进程白名单、NSIS 进程检测命令、上一版便携包）都接受 `书童` 和 `AI小说作家`。只验证本次构建产物的地方要求新名字。名字统一定义在 `scripts/product-identity.mjs`，PowerShell 脚本中的对应列表要与它保持一致。
- 从 1.3.0 及更早版本升级时，旧的桌面和开始菜单快捷方式会被删掉再新建。曾经手动删掉桌面快捷方式的用户，升级后会重新看到它，仅此一次。
- 已知影响：用户固定到任务栏的旧图标指向 `AI小说作家.exe`，升级后会失效，需要重新固定。NSIS 无法在不读取 `.lnk` 目标的情况下安全地改写它们。如果用 PowerShell 改写，安装过程会多出发布门禁监控的白名单之外的进程。本次不处理，记为后续事项。
- 显式运行 `Uninstall 书童.exe --delete-app-data` 时，NSIS 删除 `$APPDATA\ai-novel-writer` 和 `$APPDATA\书童`。改名前删的是 `$APPDATA\ai-novel-writer` 和 `$APPDATA\AI小说作家`，后者本来就不存在，所以实际效果不变。`deleteAppDataOnUninstall` 为 false，普通卸载不删除数据。
- macOS 默认菜单里的「关于」「退出」等菜单项使用 `app.name`，显示为 `ai-novel-writer`，改名前后都是这样。要让这些菜单项也显示书童，需要自定义应用菜单，不在本次范围内。
- `linux.artifactName` 仍由 `${productName}` 生成，会变为 `书童-Linux-<版本>.AppImage`。项目目前不发布 Linux 版本。
- macOS 的 `.app` 名称、菜单栏标题和 Dock 名称都来自 `productName`，无法在本机构建或验证。下一次发布前，macOS 打包与 DMG 验收会覆盖这些项。
