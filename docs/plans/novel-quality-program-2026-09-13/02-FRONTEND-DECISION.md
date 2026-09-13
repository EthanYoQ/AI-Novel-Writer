# 新前端：技术判定、现态覆盖与默认门

## 1. 基线与边界

donor：用户提供的 Frontend-1.1.0/AI-Novel-Writer-1.1.0。当前业务工作树HEAD为731bda13ff9197d0abefaa353139df1359ce75cb，与取证时origin/master 2264390d6fb8b052cc14736d544df0cc74516649同树。v1.1.0为879f83521414f66019488462830c3134c77dc4f8。开工前必须再核对，不用陈旧本地master。

源码比较范围为src、electron、scripts、test、public、.storybook：donor保留v1.1.0的791个文件（734相同/57变化）另69新增；对当前HEAD是726相同/67变化/67 donor-only/2 current-only。**这是文件差异覆盖，不是860个文件全部逐行审查。** S00继续把变更逐项处置，核心代码按原S00/S13覆盖要求执行。package/锁文件/构建配置另列，不假称在上述计数中。

不需要换语言重写：src/main.tsx创建React root；App用ui-version-store选择ShellV2或旧壳，ShellV2接收已有sidebar/editor/aiPanel/bottom React节点。index.html不能单独复制来代替应用。

## 2. 15项覆盖状态

“静态链”只证明源码上按钮/handler/store/IPC或service存在；本轮未做Electron项目运行和真实模型测试。

| 能力 | 当前证据 | 集成与验收责任 |
| --- | --- | --- |
| 外壳/外观选择 | 静态三层，renderer-only实际可切经典 | F01/F02/F05；避免Classic外壳与classic背景ID混淆 |
| 新建/打开/最近项目 | 静态链存在，但切项目清旧稿有阻断 | F04统一未保存门；F05两壳所有切换入口 |
| 保存/正文编辑 | 共用编辑器，donor另改CodeMirror选择/IME/字体 | F04保留现有保存和ledger，中文真实输入法/撤销/选择验证 |
| 故事架构/单独大纲范围 | totalChapters与本次from/to已静态存在，大书默认1–20 | 保留范围式，不另添outlineChapterCount；S06A/F04验证可见范围/续批 |
| 世界观候选恢复 | donor缺当前world_building_partial_result/恢复授权链 | 严禁回滚当前恢复；S06A/F04生产入口三方适配 |
| 当前章上下文 | donor缺synopsisForDraftChapter | 保留最新投影并进入S10B来源编译，不换回全书塞入 |
| 批量写作 | 按章workflow链，已有1–10批量边界 | S06B/F04/F05；待审/自动定稿、失败不越到下章、冻结模型 |
| 角色卡导入/编辑 | 当前PR#212新增能力必须保留 | S09/F04/F05；输入保留、错误可见、项目隔离 |
| 关系图 | v1/v2投影同一事实，但新图按姓名布局需ID适配 | F04接S09；改名重名、只读与破坏性“删除全部角色”明确 |
| 角色头像 | UI→typed IPC→controller→DB/file链存在 | F03；.vela路径、姓名hash、文件/DB失败与孤儿资源需修 |
| 审稿/修稿/定稿 | 静态生产链存在 | S11/F04；merge≠resolved、no-op不绿、失败印章/重试可见 |
| 写作Skill | inspect/install/bind/uninstall与冻结链存在 | F04/F05；用实际生产入口和合法合成Skill，不运行Skill脚本 |
| 模型参数 | contextWindow/maxOutput/temperature/reasoning链存在 | S07/F04/F05；请求receipt验证，不能宣称任意top-p等均支持 |
| 设置/日志/诊断 | renderer-only设置可开，#224仍有open PR/CI问题 | F04/F05；侧栏/状态栏入口、tab状态、脱敏复制/错误内容 |
| 备份按钮 | 明确disabled/no-op，旧界面也未提供完整可用备份 | 不新增备份系统；移除发布UI占位，保留已实现导出能力 |

“独立大纲章数”采用已有**本次生成范围**满足用户任务，不做与全书总章数相冲突的新持久默认字段。显示本次会生成几章、从哪章开始和已完成范围；不自动生成200章。只有用户另明确需要长期独立规划数量，才另立需求。

## 3. 已知阻断与来源

- **切换作品丢稿的高风险静态反例**：donor EditorArea.tsx:185–205切作品后clearProjectTabs；editor-store.ts:405–422删除tabs/save handlers/draftLedgers；project-store.ts:448–476只处理运行中workflow。现有窗口exit guard不覆盖这一入口。本轮未在真实项目触发，不能写成已运行复现，但此链足以阻止无条件接入。
- **旧版本覆盖**：donor没有最新world-building候选重校验和generate-draft按章synopsis投影。直接目录复制会回滚已修问题。
- **头像跨层与Vela**：character-avatar-controller.ts:178–321注册完整，但commit先写文件后写DB；名称hash路径与新ID/新根不一致，不能当CSS素材直接拷入。
- **标签/图谱语义**：“清空图谱”实际删除角色，必须清楚说删除角色而不是重置布局；重置布局不得删除事实。
- **默认/字体**：贡献者fontDefaultsVersion重设字体不能吞掉作者显式偏好；无外壳偏好时用写手默认，字体值仍迁移保留。

## 4. 本轮实际界面检查与限制

Product Design audit用于强制分开“看见界面”与“功能已实现”。只起renderer-only Vite，未加载Electron main/preload、未注入mock IPC、未使用作者目录或密钥。临时服务仅127.0.0.1，结束后已停止，浏览器viewport恢复。

实际看到：首页和主导航；设置八个类别；外观中四种颜色、墨纸书斋/经典切换、经典/手绘幻想/自定义图片；选择经典后旧壳出现。逻辑viewport为1366×900；初始窄面板截图不代表桌面最小宽度缺陷。

保存了原始截图并检查本地文件：画面可确认布局，但文字细节模糊，**不作为像素、对比度或易读性通过证据**。AX文字证明选项/状态存在；renderer没有IPC而产生的拒绝符合本次环境限制，不据此判定桌面白屏Bug。未捕获含项目的书架/正文/角色图，未跑安装版、模型、保存/恢复/输入法。后续F05须替换为清晰安装环境证据，不拿这次预览充数。

## 5. 默认放行

只有F05覆盖表每个必须功能在两壳均有对应入口、权限和成功/失败动作，S14A独立review通过、S14B/C/D达到门槛，R01才发布Writer默认。功能入口可重新编排，不要求按钮同一位置；移除无实现占位不算丢功能。任何已实现能力未接上，默认门NO-GO；不以“新壳更好看”豁免。

Classic始终可切回同一新内核；它不是启动旧Vela实现/旧数据格式的降级开关。

