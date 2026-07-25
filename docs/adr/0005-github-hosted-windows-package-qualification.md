# GitHub 托管的 Windows 安装包资格验证

为避免本机经 VPN 上传大型安装包，Windows 安装包资格验证由仅支持手动触发的 GitHub-hosted Windows 工作流执行；该工作流永不创建或修改 Release，成功产物只作为保留七天的 Actions Artifact。工作流固定 Runner、Node、pnpm 与 Actions 版本，使用 frozen lockfile，执行现有完整 Windows release gate，并为安装包、更新元数据和环境生成 manifest 与 SHA-256。正式 Release 仍是独立且需要明确授权的流程，不得以跳过旧版本升级、原生模块、真实应用、安装器或错误窗烟测换取云端构建通过。
