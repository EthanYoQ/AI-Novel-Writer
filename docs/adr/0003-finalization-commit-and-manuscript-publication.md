# 定稿提交与实体稿发布

定稿以编辑器提交的不可变正文快照为输入，SQLite 中的定稿内容是事实源，根目录章节文本是可恢复的实体稿发布投影。一次定稿在数据库事务中更新正文与状态并登记发布任务，随后由实体稿发布器原子落盘并记录结果；落盘失败表现为“定稿已提交、实体稿待发布”，可以安全重试。完成结果携带定稿 ID、内容哈希和编辑器修订号，只有仍对应已提交快照的标签页才能清除未保存状态；提交后继续产生的本地编辑必须保留并显式进入冲突状态。

## 修订：章节的定稿可以被替换（2026-11-03，[ADR-0024](0024-replace-finalized-chapter-via-reopened-draft.md)）

每份定稿的正文快照和收据一经提交就不再改变。章节的权威定稿可以被替换：登记过重开关系的重开稿定稿时，commit 在同一事务里把本章原来的定稿降为只读的 `superseded`，再提交新定稿与收据。同一章任何时刻至多一行 `finalized`，由唯一写入口 `FinalizationRepository.commit` 在事务里保证。被替换的定稿不再发布实体稿，它留下的实体稿和知识库文档由新定稿后处理里的清理步骤处理。

## 修订：finalized 与 superseded 的唯一写入者（2026-11-05，[ADR-0025](0025-chapter-trash-soft-delete-and-restore.md)）

`finalized` 与 `superseded` 只由 `FinalizationRepository` 写。commit 替换、遗留重复定稿修复、从回收站作为旧版本放回，都经 `demoteToSuperseded`；从回收站放回原位经 `reinstateDeleted`，它在同一事务里检查本章至多一行 `finalized`，并把这份定稿的实体稿重新置为待发布。删除只把行标为 `deleted`，由 `ChapterDeletionRepository` 写。
