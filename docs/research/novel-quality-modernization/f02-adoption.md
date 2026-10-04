# F02 写手外壳采用记录

依赖：S02 `d72c13db638f1f2d87db3230e985411566139fca`；F01 `e2af35966adae4754b18ac7553544a618fa3dc34`。状态：实现待独立审查，未提交。完整机器清单见 [f02-adoption.json](f02-adoption.json)。

采用书房结构：标题栏、书脊导航、资料/纸面/助手分栏、任务区、状态区、概览与书架。未复制业务 store、command、IPC 或整个目录。100 个 donor UI 差异文件逐一记录原字节哈希、处置原因、目标 slot；其中本片范围35个，其他业务文件交F04。153个必需动作保留接线位置，均为reserved-not-business-accepted，不是F05 PASS。

新增路径精确记录于 JSON ownedPaths：ShellV2、TitleBarV2、SpineNav、WriterPortal、WelcomePageV2、writer-shell.css和专属browser test。未新增图片/字体。梅花、seal44/100、YiShan许可未确认，使用现有lucide BookOpen/FolderOpen/Plus和无图纸面替代。工序与保存态由props提供，无缓存或假数据。

## 中央接线

App 按 F01 选择壳，默认激活仍受 F05 门约束。ShellV2 传同一 Sidebar/EditorArea/AIPanel/AIOutputPanel/BottomPanel/StatusBar，保留启动、背景、更新和全局对话框；titleBar/rail/rightRail可先复用现有生产组件，tabs额外slot可选。sidebarOpen/aiPanelOpen/bottomOpen由外部控制，隐藏不卸载输入。CSS组件相对import，只作用writer-shell/portal，无需index.css覆盖。

F04将TitleBarV2 actions/model/stages/extraControls/windowControls、SpineNav items和Welcome只读props接业务。Welcome overview明确loading/empty/unavailable/ready，数字未知为待读取，六工序不倒推完成。书架保留preview/open两个动作；准确二次点击/dirty守卫由F04接共享业务。

备份action无handler显示不可用原因；Welcome backup slot注入状态。B01/B02尚未完成，U16 NOT RUN、发布NO-GO，不能将注入接口算备份实现。

## 证据

- 中文browser：`pnpm exec vitest run --config vitest.browser.config.ts src/components/layout/v2/__tests__/writer-shell.browser.tsx`，端口63513，9/9、exit0。四颜色portal与Classic样式隔离、三空态无旧尾句/假数字、键盘Enter/焦点、隐藏后正文/助手输入保留、窄窗提示。是组件证据，不是完整两壳/Electron业务等价。
- `pnpm run typecheck`、`pnpm run check:i18n`、`pnpm exec eslint src/components/layout/v2 src/components/pages/v2 --max-warnings 0` 均exit0。
- 模型调用0；安装包、备份及U01–U16完整业务NOT RUN。
- 截图在仓库 `.runtime/.cache/novel-quality-modernization/f02-{light,paper,galaxy,dark,narrow}.png`；已查看纸色截图确认布局和portal可读。日志f02-browser.log。

首次Vite依赖预构建重载出现React hook错误，缓存稳定复跑通过；截图路径曾多一级遭Vite拒绝，修为仓库内缓存后通过。分栏库异步测量仍输出act测试警告，日志未隐藏，不冒充产品复现。

本片无项目外目录。早期图片另在专属测试目录的.runtime与__screenshots__，仅可重建测试产物，不加入发布/提交；自动审批拒绝清理调用，交主集成者统一处理。

独立审查两项P2已修：字体使用F01唯一`--font-sans`；tabs与portal按钮配套前景/背景/边框。四颜色9/9复跑，逐一检查实际computed font-family（shell/portal/按钮）以及按钮文字对比度≥4.5，Classic隔离继续通过。已重看dark截图，按钮文字可读。
