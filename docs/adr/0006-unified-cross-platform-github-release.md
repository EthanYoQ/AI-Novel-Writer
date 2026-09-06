# 统一的跨平台 GitHub 正式 Release

状态：已由 [`0016-three-target-release-and-platform-update-actions.md`](0016-three-target-release-and-platform-update-actions.md) 取代。以下正文保留当时的 Windows + macOS ARM64 决定，不代表当前完整平台合同。

每个正式 GitHub Release 使用一个资产列表，同时陈列该版本的 Windows NSIS 安装程序及其 Windows 更新元数据、以及未签名的 macOS ARM64 DMG。两个平台的安装包只可由 GitHub Actions 构建和上传；本机不得构建或上传官方 Release 安装包。这样用户查看同一版本的 Release 时即可获得 Windows 与 macOS 安装包，而不必在不同 Release、标签或下载页之间寻找。

Windows 与 macOS 的分发边界保持不同。Windows 继续沿用既有正式 Release 更新契约：只消费 Windows 安装程序和 Windows 更新元数据，忽略 macOS DMG；`0005-github-hosted-windows-package-qualification.md` 所规定的 Windows 资格验证不被替代。macOS ARM64 DMG 不参与应用内更新，用户须从同一 Release 的资产列表手动下载新版；该 DMG 不做代码签名或公证，发布说明必须说明可能出现 Gatekeeper 提示。

macOS 云端资格构建与正式发布仍分离：资格构建只能生成临时 Actions Artifact，只有在 macOS 打包、装载后运行验证、Windows 更新隔离回归和产物校验均成功后，明确授权的 GitHub Actions 提升流程才可把同字节产物附加到正式 GitHub Release。该流程不得以本机上传、跳过安全文件系统验证或将 macOS 资产混入 Windows 更新链路替代这些门禁。

历史的 Windows-only 提升工作流不再保留；未来正式 Release 只能由同时验证两个平台 Artifact 的统一提升工作流创建，防止同一版本出现缺少 macOS 或 Windows 资产的正式发布。
