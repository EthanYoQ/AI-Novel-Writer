# Program v3：约束合同与旧Spec覆盖

继承 [C01–C09](../novel-quality-modernization/03-CONTRACTS-AND-GATES.md) 与 [Spec v3执行合同](../novel-quality-modernization/05-SOL-EXECUTION.md)。此页为显式增量；v2的问题行政归档/全手工角色更新/云存档排除已撤销。C01–C09的预算、来源、作者保护仍生效，增加自动派生与便携副本的显式边界。

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

Writer必须承载最新生产旧能力与donor实际新增功能的并集，再加本轮批准增强；详见09与feature-union.json。requiredInWriter项只能由Writer自身入口通过，Classic成功不代填。选择性移植针对代码实现而非选择性删除功能；允许拒绝陈旧或不安全实现，但必须登记等价替代及验证。占位/demo不算已实现功能，#213备份则已另行纳入B01/B02/F04，必须交付。

S00建立current-master / v1.1.0 / donor三方manifest。每个不同文件归类：纯外观复用、接口适配、行为变化、持久资产/schema、测试/工具、陈旧上游、拒收/待核实。每个非纯外观项有owner、源路径/哈希、采用/修改/拒绝理由、测试门。文件相同只证明无需移植该文件，不证明行为全等。

贡献者说明、截图、测试数量均为来源声明；本轮实际renderer-only检查另列。PR#212/#223/#225/#229按最新状态决定复用哪一个实现，不并行接入互斥补丁。新UI不能把旧upstream版本的command/store拷贝回来。未知来源素材/字体先核验许可与归属，不将Vela署名按字符串清零；图标沿用lucide，不新增Emoji/手写SVG图标。

## C13：头像、图谱与缓存

**头像为MUST，不允许删除、隐藏或降为仅历史保全来过门。** 选择预览、明确保存、压缩、读/替换/删除、人物卡/图谱、重开、迁移及B01/B02归档恢复均有验收；以现有256px压缩/格式/大小语义为起点，失败可见并保原图，批量/有界读避免每人一个IPC，不建通用媒体平台。

donor新增头像不是皮肤资源而是作者项目资产。名字hash文件不能作为稳定身份：F03以S08稳定character_id绑定，显示改名不移错图；旧图按旧DB明确关联迁移，冲突/多义/文件无记录保全并待确认，禁止猜名字拼合。

C07在M04后增加唯一 **M05(character-assets，由F03提供)**，具体整数由S01统一分配；S04 staging始终跑同一registry到当时目标版本，最终发布迁移到M05。不得直接照搬donor database.ts/ALTER TABLE补丁绕开probe。若已有可复用资产结构无需新增表，M05作为受控验证/映射迁移记录；不另建registry。

S00/S04资产表必须识别donor characters.avatar、.vela/avatars及已有标准库变体；已知fixture fingerprint才进入转换，未知fork只做隔离副本/待确认，不自动补列“修好”。所有头像原字节/引用保全，重新绑定与正式角色变更保持事务边界；取消选择不落库，失败不删除既有头像。复用已有文件grant/魔数/大小检查，不扩任意文件路径权限，不扫描真实作者头像。

运行期asset commit与迁移期M05是两个显式入口。M05只能收S04已验证sourceSnapshot/stagingTargetRoot capability，禁止解析默认runtime/canonical locator；文件、DB引用、孤儿清单只写staging，target-installed之前不创建live .ai-novel资产，不改/删来源。文件/引用集合与源/目标字节hash进入S04 journal/receipt，源/staging DB和文件句柄verified后关闭再cutover。S08身份转换保留S04旧资产关联→新ID的确定/歧义映射，不因M02删旧列丢掉后续M05依据。

F03交S04/central owner一个明确适配请求，并以F03.m05-integrated作为完成门：同一registry目标已包含M05、S04资产表/portable处置表已含头像/引用/孤儿/歧义、tracked project-migration-acceptance runner已适配且可实际构造/验证M05。B01.requiredGates依赖此门；不能到S14A才接线。F03门覆盖known donor/unknown fork、名字碰撞、DB/文件/journal注入及原字节保全；S14C再对最终subjectSha做真实旧版升级/恢复。迁移中任一注入失败都证明legacy-isolated前live canonical零创建/零写，只留下任务staging；不能在S14C冻结后才补tracked runner。项目迁移/受控副本要保头像引用，正文merged-md/split-md/txt不新增头像附件；完整项目归档由B01独占，必须保头像字节/引用。F03提供资产manifest及迁移函数，不能自己改正文导出或另发明备份格式。

关系图仅为ID关系投影，布局权重不成为小说事实或新prompt来源，保留已有关系自定义/AI提议/只读来源界限。S09身份歧义不能被F04图形布局的first-match重新引入。

首页vela:overview:<path>等缓存若含正文尾句/绝对路径按潜在私密数据处理：不公开、不记诊断，不跨项目串读；新缓存以projectId+revision为键只存最少统计，不持久化正文摘句。保留真实书架速览：IPC只收main授予且仍有效的recent-project能力标识，不接受任意renderer路径；绑定规范化路径/项目ID/fingerprint/版本，重验证后只读聚合。不能在readonly失败后可写打开、创建/迁移DB或触发恢复outbox；旧/未知库显示暂不可预览，正式打开走S04迁移。需要显示尾句时从当前授权被预览项目即时读，只存在内存；切项目/撤权/版本失效即清；旧尾句缓存识别后退出活跃读取并清理其已确认缓存键，不能按vela前缀删其他作者资料。字体/外壳偏好、恢复候选不是可随便清除的overview缓存。

## C14：前端/质量/发布证据

F05以同一candidate内核、同一合成fixture比较Classic/Writer动作→命令→参数→落盘/失败行为；共享业务能力两外壳覆盖并比较结果；Writer专属书架/标签/沉浸/新图谱等只要求Writer完整操作，不强制Classic复制布局。所有requiredInWriter行必须在Writer自己通过，不能以fallback或disabled过门。四颜色与背景用关键页面pairwise检查可读性/portal，不为每个颜色再跑全套模型生成。不运行英文产品场景，只保翻译键完整性。

界面关键验收必须使用中文、真实组件/入口/IPC接缝；mock仅可证明mock覆盖的边界。至少实际Electron新建→配置→指定范围大纲→保存/恢复→正文编辑→审修/合并→定稿→重开/导出，以及图谱/角色导入/Skill/设置双入口。网络失败、length、dirty切壳/切项目均需有证据。真实生成只纳入原80次总帽，不额外偷跑“皮肤测试”。确定性provider fixture须明确标注不是真实模型。

F05先Preflight→主集成者默认激活→同集成SHA Final/post-UI三门；S13强依赖新receipt。S00为post-UI在原80总帽内预留三固定中文两臂案例；原S07/S10B/S11 owners重建manifest、实际双目标零模型dry-run/parity和对应selector，milestone=post-ui，每请求绑定实际candidate SHA。不能以mock或早于F04的PASS替代；不足则blocked/inconclusive。后续相关入口/参数有改动同样需重新资格，不把新SHA自动视作通过。

S14A之前完成F05默认激活、S13退出、版本号和release/tool适配；S14A核验而非再次悄改默认。版本号由该阶段根据最新Release和用户批准的目标版本固定，本包不猜具体下一版本。S14B/C/D不改tracked源码；任何修改回S14A重新冻结，旧证据不继承，完整原规则继续有效。

## C15：Issue实质交付与真实性

禁止用行政归档、开successor、超时无回复或部分child合并替代原问题的修复/增强。原产品Issue保持open到本包03的全部门；PR用Refs避免提前自动关闭。报告证据≠本轮复现；静态存在入口≠运行成功；renderer-only≠Electron≠安装包；未合并/CI失败/未发布分开报告。R01/G01/G02只由主线程在对应执行授权下远端写入，worker准备脱敏稿。

#211由v3显式提高到实际产品/Release门；#199/#205只做已完成复核不重复实现；#222按内部清理的较窄合同。缺信息但无法自证不计修复且保持open，不设置自动过期机器人。新反例一律撤销关闭建议并重判。

## C16：有出处的自动角色演进

S09A负责文本导入候选，S09B在现有finalization/outbox路径接派生更新，S09C/F04呈现。重用当前提取结果/字段provenance；不新建每人一次模型请求或第二后处理队列，不越过C01总预算。已定稿且仍权威的finalizationId/contentHash/chapterNumber、stable characterId、字段来源是最小写条件。

无冲突空字段/旧derived字段可自动更新derived，作者不必逐项批准；绝不自动变author。author/legacy冲突、身份歧义、新人物准入走提议，源过期拒写并可见。静态设定与当前章派生状态分开表示时间与来源，不能为了自动化覆盖作者文字。原S09B“不覆盖作者”不等于禁止非冲突自动派生，v2全手工表述不执行。

优先复用字段级provenance和现有拒绝/采用动作。author接受成为一次显式编辑；拒绝记录限于相同角色/字段/源hash/提议值，重启/重试不反复弹同建议；新定稿来源可重判，不静默永久封杀合法更新。重新定稿使旧derived失效，不自动全书重抽取；C03禁止stale事实进入写作。

自动写入必须在现有同一DB事务内做字段级commit-time compare-and-swap：patch携带生成时baseFieldRevision/baseValueHash/baseProvenance及stable characterId，提交时重读当前字段、项目epoch和权威定稿source；任一变化拒绝旧patch并保留可见冲突，不自动补发模型请求。不能仅在生成前检查author标志。

派生进度使用同一continuityEpoch中的(chapterNumber, authoritativeFinalizationRevision)来源顺序；较早章outbox即使晚到/重试也不得覆盖更后章的当前derived，同章只接受当前权威版本并幂等。更改较早定稿导致依赖失效时，沿现有来源规则标stale，不用新时间戳让旧内容冒充更晚状态，不自动全书重抽取。字段revision/来源比较/拒绝去重由S01登记合同、S09B现有事务实现；author并发编辑永远优先。

必须有自动成功正例、author冲突保全反例、改名/同名、旧源重试/重复outbox、拒绝后重开、身份不明和后处理失败，以及“提取后作者改字段再提交”“第4章derived已写后第3章outbox重试”“同章重定稿旧版本回包”的并发反例。测试在S00预注册用原预算/既有提取路径，F04无需用户手工逐字段确认即可展示成功结果。

## C17：可携带项目，不携带机器权限

B01在S04/S12/F03完成后提供独占portable archive service；B02仅传输B01合格产物，不第二次解释/修改小说或DB。新能力必须在F04/F05及S14A之前集成。

1. 本地归档/云存档是完整项目副本：作者正文、canonical知识原文/Prompt/Skill、稳定角色/关系/头像、可恢复候选和必要历史。可重建向量/cache明确列为未带且恢复后stale，不把知识原文当cache删掉。模型/云凭据、app配置/secretRef、grant/lease、日志/临时/旧迁移备份和机器元数据路径排除。作者文字中的路径/词语是正文，不能按正则改写；不能保证作者主动写入正文的秘密被自动识别，上传确认明确内容范围。
2. 源项目在现有lease/revision门下形成WAL一致快照；不复制活动DB+wal文件。文件/DB快照跨revision变化则丢弃本次未发布staging或要求重试，不假装原子成功。源始终不变。
3. portable DB/manifest依字段allowlist构建，S01签署表/字段/资产处置表，未知schema/表字段必须保全在源并blocked，不盲带潜在secret。必要不可安全便携字段不能静默漏掉后说完整。采用一个版本化格式与现有SQLite/zip能力，不建通用序列化/云插件框架。
4. 恢复为新local projectId/epoch/session，领域ID和作者原字节/source hash保留；历史receipt不就地伪改。用一个窄transfer-authority receipt记录origin→target、snapshot generation、稳定领域ID、原finalizationId/contentHash/sourceHash与当前性校验。当前已接受author事实、权威定稿及精确来源存在且hash相符的derived，以原值/provenance安装成新项目current readable authority，derived不升author。新ContextSnapshot由新项目当前事实重建，引用此transfer receipt；当前SourceRef读取通过明确源映射，不改历史执行receipt。这仅承接可读事实，不授权模型、候选提交、outbox或发布。

来源缺失/已替换/多义的derived才stale，按C03确定性回读仍有效的定稿原文作fallback，不重抽全书模型；不能把全部旧projectId事实一律冻结，导致恢复后第21章丢掉前20章角色/线索。B01交S05/S09/S10/S12单一owner实现这个读取边界并验证改章后的失效，不能用另一个自由事实store绕来源检查。
5. 旧C01未知已发请求不释放预算、不重发；outbox pending/inflight、import/recovery、C02候选冻结为可见历史/待采用，不在启动恢复自动跑。显式采用旧候选须以当前新项目输入重校验，产生新lineage/fingerprint/rootActionId；旧源不匹配仅可查看/复制候选，不能伪恢复为授权formal commit。使用已有授权和候选流程加origin标志，不另建Agent恢复引擎。
6. 原记录完全符合portable允许字段且不含排除信息，才可带原receipt/hash。原记录含credential、secretRef、机器路径等排除字节时，既不带原值，也不带对含这些字节的原记录所算digest/MAC；仅带redactedProjection、基于该projection的projectionHash、被排除字段名、终态/非敏感稳定ID和nonReplayable=true，明确“不验证原receipt字节”。不能安全构造投影则blocked；不重写作者文稿。current authority的hash只可来自允许携带的作者正文/定稿资产，不能借transfer receipt重新夹带秘密元数据hash。
7. 解包先检查size/count/ratio、路径、symlink/reparse、hash/schema/SQL一致性，全部在staging，调用现有迁移/接入validator。目标目录不存在才安装新副本；碰撞/取消/失败只清本attempt可证明staging，不覆盖当前/其他小说。OS文件授权/模型端点在目标机重新选择，不恢复秘密或外部访问许可。

具体portable身份/来源/冻结/当前权威读取映射由B01交S04/S05/S09/S10/S12 owners会签；不能仅完成压缩解压就宣称跨设备继续创作可用。

## C18：最小WebDAV闭环

单一协议，手动配置→连接检查→立即备份→列出备份→恢复为副本；不后台上传、不做实时双向同步、任意Git命令/自建服务。Electron OS-backed秘密存储只在main；不可用仅session内存，不明文降级，不进localStorage/项目/诊断/model prompt。

默认HTTPS、TLS不可绕过，跨origin/降级重定向不携凭据。请求有界、只访问用户配置根及受控子路径；DAV href必须规范化后仍在授权根内。云服务端可见正文、首版非E2E加密，在配置/上传确认说明。

**选择不可变generation为唯一真相**，不做强latest-CAS依赖。每次独立随机ID/不可覆盖路径，完整archive/hash manifest上传并校验后才写该世代completion descriptor；只列入可验证完整世代，半对象不计成功。应用从不覆盖/删除其他generation。latest仅是可丢/过期hint，支持安全条件写才可更新，不支持则不写hint；列表/恢复不依赖它，无CAS服务仍可手动备份。

每个世代记录用户实际选择/本地持久绑定的parentGenerationIds，不把fresh latest悄悄当新的已认可基准。A/B从同父世代各自append都可成功、两个都保留，列出siblings/分叉并让作者明确选择恢复或新建云书；不自动合并、不按时间戳伪称唯一“已同步”。首次云书竞争也是不同世代/不覆盖，不承诺只有一个上传成功。

B02唯一writer维护canonical app-data/cloud-backup-bindings.json（非秘密、原子更新/revision）：localProjectId、cloudBookId、localEndpointAccountId、lastSelectedParentGenerationIds、mode(unconfigured/writable/origin-readonly)、revision。OS秘密另库；该本机绑定表与localEndpointAccountId不进项目/归档。B01副本仅带cloudBookId/originGeneration只读来源，首次在目标机由B02创建origin-readonly绑定，重启仍不可自动推送；显式重绑/选择父世代后才writable。清秘密只使连接unconfigured，不删历史/误授权；确实删除本地项目后清其本机binding，不删除云世代或其他项目凭据。

B02消费B01合格快照与时点，网络期间本地可继续写；显示“已备份X时点/本地仍有新改动”而非实时同步。归档阶段自身跨revision不一致仍拒绝；上传成功后binding更新失败保留远端完整世代但报告本地状态未保存，重启重新列出并明确选择，不冒充一致完成。

两个隔离profile打包入口与受控WebDAV实测：无CAS仍append/可列/恢复；A gen1退出→B gen2→A重启由已存父gen1上传得到两条可恢复分支，不覆盖；恢复副本重启仍origin-readonly；云端latest缺失/过期不影响安全；秘密/网络/损坏边界。合成数据，不探取真实云账号。没有新云平台或自动远端GC。

## 旧24Spec的显式覆盖表

| Spec | 新增约束/依赖，原有验收不删除 |
| --- | --- |
| S00 | 10项Issue刷新、三方donor文件manifest/许可、头像/overview/字体偏好资产、09功能并集及B01便携字段表；真实可运行baseline与80总帽含post-UI三门预留；固定feature-union.editor-absolute-v1绝对/相对/IME协议及逐action失败反例 |
| S01 | 接收F01外观合同；登记M05与便携资产/身份/字段处置表、单一前端共享接线owner与源文件交接表 |
| S02 | 新donor消费者不得重新引入velaAPI/URI，F02通过canonical facade接入 |
| S03 | **增加F01依赖**；只负责main全局/skin迁移与mainReady，renderer偏好由F01在App hydration前完成；保留原userData/partition/origin直到ack |
| S04 | 扩展donor头像/DB变体/overview资产处置，未知fork不猜；复用同registry最终M05 |
| S05–S07 | 恢复/预算/诊断状态必须有外壳无关的公开读取接缝，F04消费；不为UI新建run owner |
| S08–S09C | 角色ID给F03头像/F04图谱用，保留旧资产关联→新ID映射；#191按C16自动更新非冲突derived，冲突/身份歧义才提议；S09B接现有后处理，不覆盖作者 |
| S10A/B | 新首页/图谱/头像信息不得自动塞prompt；#221两个症状独立验证 |
| S11 | 状态徽标不能将merge等同resolved；F04消费最终finding模型 |
| S12 | 所有导入UI保留取消、输入、来源和单完成账本，F04随后接管展示 |
| S13 | **增加F05及其post-ui-requalification强门**；包括新UI带来的生产Vela/旧缓存/无消费者清理，#222唯一owner；不能使用F04前旧early PASS |
| S14A | 冻结前含F05外壳/默认/新资产、版本与发布工具；subjectSha规则不变 |
| S14B | 仍原18章/80总帽；不按皮肤倍增模型实验，最终candidate为Writer默认同一内核 |
| S14C | 增加旧经典偏好、donor合法项目/头像升级与B01/B02跨profile恢复继续创作fixture，两外壳可回退但不降库 |
| S14D | 同subjectSha三个目标验证Writer默认与Classic回切；仍只出资格，交R01 |
