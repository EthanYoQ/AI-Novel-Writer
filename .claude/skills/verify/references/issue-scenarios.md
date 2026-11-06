# 按 issue 补的场景（#382 起）

> 历史说明：本文件按当时的改造或 issue 记录场景与对照步骤，不随当前构建更新。其中的对照命令（旧外壳场景、`--shell`、指向 trunk 的 `--app-root`）只适用于当时的 trunk，在当前构建上不能照抄。当前构建的做法以正文和 `driver.md` 为准；某个场景现在能不能对 head 跑，以 `driver.md`「RD-10 删除旧外壳之后」的分类为准。
>
> 场景自带的构建要求仍然有效，例如 `f491-backup-roundtrip` 要新旧两个构建，`--app-root` 指向 1.3.2，见本文「备份往返后的角色派生状态（#491）」一节。

RD 之后为具体缺陷补的场景。修同一块功能时，先在这里找已有场景。

## 说明文字对比度（#382）

场景在 `scripts/redesign/contrast-scenarios.mjs`。浅色、深色各跑一次（`--theme dark`）。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `caption-contrast` | 依次停在第 3 章外壳、写下一章时的运行侧页（进行中、完成、历史）、架构、角色名单、设置的 AI 模型与外观、书房与预览，每处收集颜色等于 `--ink-3` 的全部文字，按类名留最低的对比度写进 `measured`（底色沿祖先叠加求出）；普通字号不低于 4.5:1，24px 起或 18.66px 起粗体不低于 3:1，禁用控件豁免。量完再断言，失败信息里带全部数值；每处截一张 `caption-<位置>` | 书房预览 | 是 | #382 |

## 备份往返后的角色派生状态（#491）

场景在 `scripts/redesign/f491-scenarios.mjs`。必须用 `--app-root` 指向已构建好的 1.3.2（master 305ee755）工作树：旧版本负责造出损坏，场景中途用 `context.restart({ appRoot })` 换成本工作树的构建打开同一份数据。直接对本工作树跑会失败，因为新构建打开项目时就修好了，旧版本那一步的来源冲突断言不成立。假模型的 `fake.replyCharacterState(build)` 让定稿后处理的角色状态更新回 `build(提示词)` 给出的 JSON。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `f491-backup-roundtrip` | 旧版本里定稿第 3 章写入林岚的地点、道具、近况，用界面同一组 IPC 导出 .ainovel 再恢复、两轮后按 Ctrl O 打开第二个副本：「当前状态」三项是「历史派生（非当前）」、输入框为空（`f491-1-damaged-historical`）；定稿第 4 章，角色状态更新报 `FINALIZED_CHARACTER_SOURCE_CONFLICT` 原始错误（`f491-2-damaged-finalize-error`）。换新构建重启打开同一副本：失败说明是可读中文（`f491-3-fixed-readable-error`），点「重试失败步骤」后 3 / 3 完成（`f491-4-fixed-finalize-done`）；三项回到「定稿派生」并带第 4 章的新值，改「关键道具」后保存成功、该项变为「作者输入」 | 角色名单的当前状态 | 是 | #491 |

## 定稿后处理的角色状态字段冲突（#484）

场景在 `scripts/redesign/f484-scenarios.mjs`。主进程里卡住本流程第 2 次 `finalization-generation:commit`（第 1 次是章节要点，第 2 次是角色状态），卡住期间驱动在角色页改林岚的「当前位置」并保存，再放行，提交按 `FINALIZED_CHARACTER_FIELD_CONFLICT` 拒写。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `f484-field-conflict` | 第 3 章定稿后，角色状态更新这一步失败：中文说明以「正文定稿已保存，但角色卡没有自动更新：生成期间」开头（`f484-field-conflict-zh`）；切到英文后说明是英文、不带汉字（`f484-field-conflict-en`）；两种语言都不显示 `Error invoking` 与错误码，定稿后处理卡上也没有「重试」与「重试失败步骤」（#502） | 英文的定稿后处理 | 是 | #484 |
| `f484-deleted-source-roundtrip` | 定稿第 3 章写入林岚的地点、道具、近况，重开作品确认「当前位置」是「定稿派生」的「灯塔顶层灯室」，再从章节「更多操作」删除第 3 章正文，再用界面同一组 IPC 导出恢复两轮、按 Ctrl O 打开第二个副本，定稿第 4 章：定稿后处理正好 4 步且都完成（`f484-deleted-source-finalize`）；重新打开作品后「当前位置」是「定稿派生」的「守塔人的屋子」（`f484-deleted-source-character-state`）。两次都先重开作品再读，读到的是库里存下的值 | 角色名单的当前状态 | 是 | #484 |

## 定稿后角色页刷新与草稿合并（#504）

场景在 `scripts/redesign/st504-scenarios.mjs`。假模型的 `fake.replyCharacterState(build)` 让第 3 章定稿后处理给林岚写入新的地点、道具、近况。场景先打开角色页的「当前状态」，再去定稿，定稿完成后回到角色页立即读一次。`measured.timing` 用页面时钟记下「角色状态更新」一行变成成功、整个定稿结束、回到角色页、新地点出现的时刻，`stepToNewValueShownMs` 为 `null` 表示 15 秒内没出现。数字包含切回角色页的导航，是上界。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `st504-finalize-refreshes-cast` | 定稿前在「心理状态」填一句不保存。定稿完成后立即读：地点、道具是新值且标「定稿派生」，心理状态仍是作者那句、标「作者输入」（`st504-draft-zh`）；切到英文后地点同样是新值（`st504-draft-en`） | 英文的角色名单当前状态 | 是 | #504 |
| `st504-finalize-refreshes-cast-nodraft` | 不改任何字段。定稿完成后立即读：地点、道具是新值，心理状态与定稿前相同（`st504-nodraft-zh`、`st504-nodraft-en`） | 英文的角色名单当前状态 | 是 | #504 |

## 定稿后处理提交期数据变化与旧版本步骤（#512）

场景在 `scripts/redesign/f512-scenarios.mjs`。

`f512-retired-character` 在主进程里替换 `finalization-generation:commit`：本流程第 2、3 次提交（角色状态这一步的前两次自动尝试）按断线失败，第 4 次（最后一次自动尝试）卡住，期间驱动在角色页删掉林岚，再放行。前两次断线是为了让变化落在最后一次自动尝试上：更早发生的变化，之后的自动尝试会先按来源已变拒绝，卡上记下的是 `FINALIZATION_GENERATION_SOURCE_CHANGED`。

`f512-legacy-step` 先正常定稿第 3 章，再由驱动自己打开作品拿会话，用应用同一组 IPC（`db:post-process-create-run`、`db:post-process-mark-step-ok`、`db:post-process-mark-step-failed`）写一份旧版本的跑批：多一步「文风自动学习」（`style_analysis`），`f512-legacy-step` 里它失败，`f512-legacy-step-done` 里它成功。之后重载并按 Ctrl O 重新打开作品。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `f512-retired-character` | 角色状态更新失败：中英文说明（`f512-retired-character-zh`、`f512-retired-character-en`）不带 `Error invoking` 与错误码，提到重新定稿本章；这一行与卡片上都没有「重试」「重试失败步骤」 | 英文的定稿后处理 | 是 | #512 |
| `f512-legacy-step` | 「文风自动学习」当时失败：一行仍列出，状态是 `retired`（灰点），说明「来自旧版本」（`f512-legacy-step-zh`、`f512-legacy-step-en`）；没有任何重试按钮；完成数是「3 / 3 完成」 | 英文的定稿后处理 | 是 | #512 |
| `f512-legacy-step-done` | 「文风自动学习」当时成功：同上，不显示「完成」也不算进完成数（`f512-legacy-step-done-zh`、`f512-legacy-step-done-en`） | 英文的定稿后处理 | 是 | #512 |

## 分工模型（#517）

场景在 `scripts/redesign/sm517-scenarios.mjs`。除夹具模型外再存一个同端点、`modelName` 为 `gpt-4.1-mini` 的档案「驱动夹具小模型」，假服务按 `fake.chats[].model` 判断每次请求实际用了哪个档案。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `sm517-stage-models` | 只有夹具模型时分工模型页说明各环节都用它（`sm517-one-model`）；加小模型后把审稿指定为它（`sm517-settings-zh`），从蓝图写下一章的请求仍是 `gpt-4.1`，AI 审稿的请求是 `gpt-4.1-mini`；再把规划指定为它，生成第 13～16 章蓝图的请求是 `gpt-4.1-mini`。小模型改成只做检索后两行提示按默认运行（`sm517-stale`）；删掉全部模型后是空状态（`sm517-no-model`）；英文界面（`sm517-settings-en`） | 英文的分工模型页 | 是 | #517 |
| `sm517-stage-dialogs` | 预置时把修稿与规划都指定为小模型。剧情树的模型下拉预选它（`sm517-plot-tree-planning-model`），生成剧情树的请求是 `gpt-4.1-mini`；第 3 章重新审稿的请求仍是 `gpt-4.1`，「修稿选项」预选小模型（`sm517-revise-refinement-model`），不改选直接按意见修稿的请求是 `gpt-4.1-mini`。夹具的修稿正文太短，修稿会停在保存校验，场景只核对请求用的模型 | 修稿请求发出后的单章视图 | 是 | #517 |

## 重新生成蓝图保留作者字段（#516 讨论）

场景在 `scripts/redesign/bpg-scenarios.mjs`。示例作品的蓝图行没写作者字段（库里是 NULL），卡片文本框遇到 NULL 不受控，换章后会留着上一章的字；场景先把前 3 章的作者字段写成空串。假模型用 `fake.replyReview(fn)` 对目录生成请求回一份覆盖本批章节的合法蓝图 JSON（批量与单章压缩两种提示都认）。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `bpg-regenerate-keeps-guidance` | 蓝图页给第 1 章手写章节要点、第 2 章填作者微操指导并保存；AI 生成蓝图选「覆盖」接着生成 3 章，跑完后重新加载蓝图：第 1、2 章标题换成生成的新标题，章节要点与作者微操指导不变（`measured.before` 与 `measured.after`） | 第 2 章蓝图的作者微操指导 | 是 | #516 |

## 导入作者原稿并反推（#516 第 4 块）

场景在 `scripts/redesign/import-infer-scenarios.mjs`。假模型用 `fake.replyReview(fn)` 认三类反推请求：全局设定（模板里的「逆向推演出这部小说的完整设定体系」）返回一份格式合法的设定、三个架构文件和三张角色卡，文风分析（「【风格档案】与【仿写指南】」）回一段文风，蓝图（「本批必须且只能完整返回以下 chapterNumber」）按本批章号回蓝图。驱动包一层主进程的 `project:open` 记下界面打开作品的会话，用它读库核对。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `import-infer-empty` | 新建空作品「雨城」，作品菜单「小说拆解与仿写…」选「我的原稿」导入 3 章，反推默认勾选、显示费用预估（中途拍 `import-infer-dialog`）；跑完后类型、故事前提、文风是反推值，每章都有蓝图，建议里只剩新建作品默认的每章字数（`import-infer-empty-run`）；再拍设定、架构与角色名单（角色以待处理建议出现） | 第 2 章蓝图 | 是 | #516 |
| `import-infer-existing` | 示例作品「灯塔」先删第 4、5 章蓝图，从第 3 章接着导入 3 章：已有的类型、大纲、前提、世界观、情节大纲不变，空的文风与金手指补上；第 3、6 章蓝图不变，第 4、5 章补上；运行卡片列出建议（`import-infer-existing-suggestions`），采用「类型」后写入反推值；再拍设定页 | 第 4 章蓝图 | 是 | #516 |
| `import-infer-dangling` | 同 `import-infer-empty` 导入 3 章，但全局设定回 7 张角色卡，关系引用了两个名单外的人（林探两次、白先生一次）：补卡请求只要林探，周探长→白先生这条关系丢弃，诊断日志有一行写明丢了哪条、这是内部限制、可在「角色名单」里手补（`import-infer-dangling-log`）；导入完成，角色名单提示条是「从导入原稿反推的角色（8 位）」 | 角色名单 | 是 | #558 |

## 上下文容量交给服务商（#77 讨论，ADR-0023）

场景在 `scripts/redesign/d77-scenarios.mjs`。两个场景都把模型档案设成作者填的 64K 上下文。`fake.rejectContextLength()` 让假模型对之后的每个对话请求回 HTTP 400，错误体取自 `electron/llm/__tests__/provider-context-length-samples.json` 里的 DeepSeek 样本，和单元测试用同一份；传 `false` 恢复正常回复。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `d77-capacity` | 写第 3 章，正文提示词的字节数超过作者填的上下文窗口。请求不在发出前被拒绝：短细纲与正文各发一次，正文落到编辑器里（`measured.promptBytes`、`measured.chats`） | 第 3 章正文 | 是 | #77 |
| `d77-context-length` | 写第 3 章，假模型以上下文超长拒绝第一个请求，之后不自动重发（`measured.chats` 只有一次 `context-length`）。运行卡片显示登记的说明（换用上下文更长的模型、调低最大输出 Tokens、精简本章要求与参考材料）和「本次未保存草稿或正文章节。」；不出现「上下文窗口」「请调整章节要求」和服务商原文（`measured.card`） | 失败的运行卡片 | 是 | #77 |
| `d77-output-allowance` | 设置里编辑作者 64K 模型、展开高级设置：有效输出额度那句说明新开始的生成每次最多发这么多、旧版本开始的运行可能按 32,768 封顶（`d77-output-allowance-set`）；把最大输出 Tokens 和模型输出容量清成 0 后，改说还没有有效输出额度，不出现「未设置」（`d77-output-allowance-unset`）。不保存 | 清空后的高级设置 | 是 | #77 |

## 重新打开已定稿的章（#516 第 2、3 块，ADR-0024）

场景在 `scripts/redesign/reopen-scenarios.mjs`。种子是示例作品去掉第 4 章草稿：第 1、2 章导入定稿，第 3 章在场景里定稿，第 4–12 章只有蓝图。假模型用 `fake.replyCharacterState(characterStateReply)`（来自 `f491-scenarios.mjs`）回角色状态。驱动包一层主进程的 `project:open` 记下界面打开作品的会话，用它读知识库；重启之后的数据在场景最后由驱动自己打开作品读。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `reopen-refinalize` | 第 3 章定稿后重开第 2 章（`reopen-1-final-reopen-button`、`reopen-2-banner`），末尾加一句、直接修稿、全部用修稿合并后定稿。确认框预览「第 3 章写于这次修改之前，第 4–12 章只有蓝图」和状态来自后续章节的林岚（`reopen-3-finalize-preview`），后处理全部成功；本章顶部「第 2 章已修改」（`reopen-4-impact-notice`），第 3 章有「写于第 2 章修改之前」（`reopen-4b-later-chapter`），v1 标为已被替换的定稿（`reopen-5-superseded`）。点「知道了」后两处一起消失，导入时发布的旧正文文件已删；第 4 章照常能写；重启后不再提示。再重开替换一次（`reopen-6-second-replacement`）：预览含刚写的第 4 章，上一份定稿的知识库文档和正文文件在新的导入之后删掉，提示重新出现；库里 v1、v2 已被替换，v3 是权威定稿 | 驱动读库后的页面 | 是 | #516 |
| `reopen-refinalize-edited-txt` | 第 3 章定稿后重开、改一句再放弃修改：版本、正文文件、知识库都和重开前一样，横幅消失（`reopen-7-discarded`）。手改它的正文文件后重开替换：「删除旧版本的正文文件」失败并写出保留的文件名，其余各步成功，旧知识库文档照常删除，手改的文件原样保留，新定稿另起带后缀的文件，本章仍可再重开（`reopen-8-edited-txt-kept`） | 后处理结果 | 是 | #516 |
| `reopen-refinalize-cards-failed` | 第 3 章定稿后重开第 2 章、末尾加一句，角色状态请求改回非 JSON 再定稿：「角色状态更新」失败，本章顶部照样出现「第 2 章已修改」并列出第 3 章与第 4–12 章（`reopen-9-cards-failed-notice`）。影响列表随定稿完成事件重读，不靠角色状态那一步发的刷新 | 定稿后的本章 | 是 | #516 |

## 作品放在不支持硬链接的磁盘上（#571）

场景在 `scripts/redesign/f571-scenarios.mjs`。替身：驱动在主进程里替换 `fs.linkSync`，只让知识库导入前的硬链接探测（路径含 `.link-probe-`）失败，模拟 exFAT、FAT32 卷；LanceDB 的原生提交不经过 Node 的 fs，场景碰不到真实卷上的提交失败。`measured.probesAfterFinalize` 与 `probesTotal` 是主进程里探测失败的次数。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `f571-volume-unsupported` | 第 3 章定稿后「导入知识库」失败，中文说明以「正文定稿已保存，但没能收进知识库」开头，写明 exFAT、NTFS、APFS 与「重试」（`f571-volume-unsupported-zh`）；点「重试失败步骤」后又探测一次，说明不变；切到英文后说明是英文、不带汉字（`f571-volume-unsupported-en`）；两种语言都不显示 `LanceError`、`os error` 与错误码，这一行与整卡都有重试。去掉替身后点这一行的「Retry」，导入知识库完成，卡上 4 / 4、不再有「重试失败步骤」（`f571-volume-unsupported-retried`） | 重试成功后的定稿视图 | 是 | #571 |

## 导入创作资料时读文件失败（#593）

场景在 `scripts/redesign/f593-scenarios.mjs`。系统打开对话框桩成返回一个 GBK 编码的 `.txt`，授权照常签发，读文件时安全文件层报 `SECURE_FS_INVALID_TEXT`。

| 名称 | 检查 | 截图停在 | 夹具模型 | 对应 |
|---|---|---|---|---|
| `f593-kb-invalid-text` | 知识库页点「导入创作资料」选中非 UTF-8 文件，提示写明「另存为 UTF-8 后重新导入」，不出现「授权」和错误码；修复前是「外部文件授权操作失败。」 | 带提示的知识库页 | 否 | #593 |
