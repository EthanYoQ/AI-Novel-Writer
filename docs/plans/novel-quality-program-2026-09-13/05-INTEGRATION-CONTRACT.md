# Program新增合同与旧Spec覆盖

继承 [C01–C09](../novel-quality-modernization/03-CONTRACTS-AND-GATES.md) 与 [Spec v3执行合同](../novel-quality-modernization/05-SOL-EXECUTION.md)。此页为显式增量，不重开已经裁决的根预算/恢复/来源/角色/审修问题。

## C10：一个业务内核、两个外壳

不建第二套业务store、IPC、provider、生成/审稿/定稿或迁移逻辑。复用贡献者ui-version分层。renderer持久AppearanceProfile只包含shellPreference(unset/classic/writer)、colorTheme/zoom/fonts、revision/origin；main SkinService仍独占backgroundSkin，组合只读AppearanceSnapshot携带profileRevision与skinRevision，**不虚构跨进程原子generation，也不重复持久化background选择**。可纯CSS复用的样式不重复改TS；必须调整DOM的组件通过共享presenter/slots/action props使用同一业务组件。

### 存储/启动的唯一所有权

| 源/进程 | canonical target | 唯一writer/实施owner |
| --- | --- | --- |
| renderer localStorage ai-novel-writer-theme（theme/zoom/writingFont/uiFont及donor fontDefaultsVersion） | renderer ai-novel-writer-appearance单JSON的颜色/字体字段；fontDefaultsVersion只作来源，不强换字体 | F01 appearance bootstrap/store；theme-store移除旧persist写入，只作同源投影/动作适配 |
| renderer localStorage ai-novel-writer-ui-version | 同JSON shellPreference与来源，缺键为unset | F01；ui-version-store不再另写旧键 |
| main SkinService旧配置/图片根 | S03 canonical app-data内既有SkinService state/资源 | main SkinService唯一writer，S03迁移；F01只读取带revision快照，不回写镜像 |

S03先完成main全局/skin迁移并发mainReady；然后F01在App业务hydration/initTheme之前进入appearance pending→migrated或blocked。S03不声称已迁完renderer localStorage；root App启动接线由主集成者落地，F01直接拥有theme/ui-version hydration文件。保留旧Electron userData/partition/file-origin直至renderer读取兼容键并ack，不解析LevelDB、不另开带模型权限的迁移窗口。

F01仅在mainReady+skin快照可用、旧键读取/校验完成后一次setItem提交canonical JSON并read-back ack；失败保留旧键/旧字节，不先删旧键。崩溃前无ack可重复，成功后canonical revision/legacyImportCompleted为权威，不再自动回灌旧键；清旧已确认偏好键由S13在ack后执行。localStorage不可用/损坏或skin失败为blocked，安全Classic和说明、不写默认；项目写权限仍服从C08全局门，不由外观fallback绕过。

发布默认独立于作者shellPreference：F01缺键只保存unset；开发安全默认Classic，显式预览Writer不等于发布默认。F05.Preflight准入receipt后，主集成者激活releaseDefaultShell=writer，再取得集成SHA做F05.Final及post-UI三门。失败不发布且记录NO-GO；S14A只核验既有激活状态，不能晚改默认还沿用旧early receipt。显式Classic/Writer优先于releaseDefault，默认值绝不被记为作者主动选择。

经典只保证能力/作者选择不倒退，不承诺逐像素冻结老bug。写手不等于自动获得更多写权限。外壳切换不是项目切换，不取消任务/清空候选/更换model session/预算root。

## C11：状态连续、可回经典、真实可见

- dirty正文/表单、CodeMirror选区/撤销/中文输入组合、未发送助手输入，不因外壳选择丢失。切换时不能保持的临时状态先保存安全草稿或给保存/丢弃/取消；取消则外壳和项目均不变。
- 项目切换同理，不能先清tab再询问；在真正成功切换后才清理旧session视图；旧异步回包/首页统计/头像不得渗入新项目。
- 优先保持同一BusinessSurface/EditorArea处于稳定React owner/key，只切chrome/layout；不以所有页面永久挂载解决问题，也不新增CodeMirror undo序列化仓库。只对确实无法保挂的少量状态显式保存。切项目同样保护未发送助手输入。
- loading、保存失败、未定稿候选、处理中、取消、原稿冲突必须可见且有原操作入口。印章等展示不能把“处理中”显示成“已保存/已定稿”。
- Writer失败回Classic只切外观，不回旧schema/旧DB/旧API；启动偏好损坏/未知值可用Classic安全外壳并提示，保留损坏原值，不默认覆盖正常作者选择。
- no-shell老版本保持unset，只有F05准入激活后的发布默认才解析为Writer；有明确v1/v2选择按classic/writer迁移；颜色/背景/字体即使与旧默认相同也视为要保留，不能由fontDefaultsVersion批量强换。
- 测试旧classic背景ID与新Classic外壳不互相覆盖，自定义图片丢失只回无图背景，不改变外壳/字号。

## C12：贡献者增量逐项处置

S00建立current-master / v1.1.0 / donor三方manifest。每个不同文件归类：纯外观复用、接口适配、行为变化、持久资产/schema、测试/工具、陈旧上游、拒收/待核实。每个非纯外观项有owner、源路径/哈希、采用/修改/拒绝理由、测试门。文件相同只证明无需移植该文件，不证明行为全等。

贡献者说明、截图、测试数量均为来源声明；本轮实际renderer-only检查另列。PR#212/#223/#225/#229按最新状态决定复用哪一个实现，不并行接入互斥补丁。新UI不能把旧upstream版本的command/store拷贝回来。未知来源素材/字体先核验许可与归属，不将Vela署名按字符串清零；图标沿用lucide，不新增Emoji/手写SVG图标。

## C13：头像、图谱与缓存

donor新增头像不是皮肤资源而是作者项目资产。名字hash文件不能作为稳定身份：F03以S08稳定character_id绑定，显示改名不移错图；旧图按旧DB明确关联迁移，冲突/多义/文件无记录保全并待确认，禁止猜名字拼合。

C07在M04后增加唯一 **M05(character-assets，由F03提供)**，具体整数由S01统一分配；S04 staging始终跑同一registry到当时目标版本，最终发布迁移到M05。不得直接照搬donor database.ts/ALTER TABLE补丁绕开probe。若已有可复用资产结构无需新增表，M05作为受控验证/映射迁移记录；不另建registry。

S00/S04资产表必须识别donor characters.avatar、.vela/avatars及已有标准库变体；已知fixture fingerprint才进入转换，未知fork只做隔离副本/待确认，不自动补列“修好”。所有头像原字节/引用保全，重新绑定与正式角色变更保持事务边界；取消选择不落库，失败不删除既有头像。复用已有文件grant/魔数/大小检查，不扩任意文件路径权限，不扫描真实作者头像。

运行期asset commit与迁移期M05是两个显式入口。M05只能收S04已验证sourceSnapshot/stagingTargetRoot capability，禁止解析默认runtime/canonical locator；文件、DB引用、孤儿清单只写staging，target-installed之前不创建live .ai-novel资产，不改/删来源。文件/引用集合与源/目标字节hash进入S04 journal/receipt，源/staging DB和文件句柄verified后关闭再cutover。S08身份转换保留S04旧资产关联→新ID的确定/歧义映射，不因M02删旧列丢掉后续M05依据。

F03交S04 runner一个明确适配请求：S14A冻结前project-migration-acceptance覆盖最终M05、known donor/unknown fork、名字碰撞、DB/文件/journal注入及原字节保全。迁移中任一注入失败都证明legacy-isolated前live canonical零创建/零写，只留下任务staging；不能在S14C冻结后才补tracked runner。项目迁移/受控副本要保头像引用，正文merged-md/split-md/txt不新增头像附件，不借此开发备份格式。

关系图仅为ID关系投影，布局权重不成为小说事实或新prompt来源，保留已有关系自定义/AI提议/只读来源界限。S09身份歧义不能被F04图形布局的first-match重新引入。

首页vela:overview:<path>等缓存若含正文尾句/绝对路径按潜在私密数据处理：不公开、不记诊断，不跨项目串读；新缓存以projectId+revision为键只存最少统计，不持久化正文摘句。需要显示尾句时从当前授权项目即时读；旧尾句缓存识别后退出活跃读取并清理其已确认缓存键，不能按vela前缀删其他作者资料。字体/外壳偏好、恢复候选不是可随便清除的overview缓存。

## C14：前端/质量/发布证据

F05以同一candidate内核、同一合成fixture比较Classic/Writer动作→命令→参数→落盘/失败行为；所有必须能力两外壳都覆盖。四颜色与背景用关键页面pairwise检查可读性/portal，不为每个颜色再跑全套模型生成。不运行英文产品场景，只保翻译键完整性。

界面关键验收必须使用中文、真实组件/入口/IPC接缝；mock仅可证明mock覆盖的边界。至少实际Electron新建→配置→指定范围大纲→保存/恢复→正文编辑→审修/合并→定稿→重开/导出，以及图谱/角色导入/Skill/设置双入口。网络失败、length、dirty切壳/切项目均需有证据。真实生成只纳入原80次总帽，不额外偷跑“皮肤测试”。确定性provider fixture须明确标注不是真实模型。

F05先Preflight→主集成者默认激活→同集成SHA Final/post-UI三门；S13强依赖新receipt。S00为post-UI在原80总帽内预留三固定中文两臂案例；原S07/S10B/S11 owners重建manifest、实际双目标零模型dry-run/parity和对应selector，milestone=post-ui，每请求绑定实际candidate SHA。不能以mock或早于F04的PASS替代；不足则blocked/inconclusive。后续相关入口/参数有改动同样需重新资格，不把新SHA自动视作通过。

S14A之前完成F05默认激活、S13退出、版本号和release/tool适配；S14A核验而非再次悄改默认。版本号由该阶段根据最新Release和用户批准的目标版本固定，本包不猜具体下一版本。S14B/C/D不改tracked源码；任何修改回S14A重新冻结，旧证据不继承，完整原规则继续有效。

## C15：权限与问题真实性

Issue行政归档不得宣称修复。报告证据≠本轮复现；静态存在入口≠运行成功；renderer-only≠Electron≠安装包。缺信息关单条件见03；PR未合并/CI失败也不能标完成。R01/G01/G02只由主线程在对应用户授权下做远端写入，worker只准备脱敏稿/清单。与作者沟通使用非技术说明，必要技术诊断单列。

## 旧24Spec的显式覆盖表

| Spec | 新增约束/依赖，原有验收不删除 |
| --- | --- |
| S00 | 10项Issue刷新、三方donor文件manifest/许可、头像/overview/字体偏好资产、前端能力矩阵；真实可运行baseline与80总帽含post-UI三门预留；固定F05性能测量协议 |
| S01 | 接收F01外观合同；登记M05、单一前端共享接线owner与源文件交接表 |
| S02 | 新donor消费者不得重新引入velaAPI/URI，F02通过canonical facade接入 |
| S03 | **增加F01依赖**；只负责main全局/skin迁移与mainReady，renderer偏好由F01在App hydration前完成；保留原userData/partition/origin直到ack |
| S04 | 扩展donor头像/DB变体/overview资产处置，未知fork不猜；复用同registry最终M05 |
| S05–S07 | 恢复/预算/诊断状态必须有外壳无关的公开读取接缝，F04消费；不为UI新建run owner |
| S08–S09C | 角色ID给F03头像/F04图谱用，保留旧资产关联→新ID映射；#191后续更新为提议/批准，不覆盖作者 |
| S10A/B | 新首页/图谱/头像信息不得自动塞prompt；#221两个症状独立验证 |
| S11 | 状态徽标不能将merge等同resolved；F04消费最终finding模型 |
| S12 | 所有导入UI保留取消、输入、来源和单完成账本，F04随后接管展示 |
| S13 | **增加F05及其post-ui-requalification强门**；包括新UI带来的生产Vela/旧缓存/无消费者清理，#222唯一owner；不能使用F04前旧early PASS |
| S14A | 冻结前含F05外壳/默认/新资产、版本与发布工具；subjectSha规则不变 |
| S14B | 仍原18章/80总帽；不按皮肤倍增模型实验，最终candidate为Writer默认同一内核 |
| S14C | 增加旧经典偏好和donor合法项目/头像升级fixture，两外壳可回退但不降库 |
| S14D | 同subjectSha三个目标验证Writer默认与Classic回切；仍只出资格，交R01 |
