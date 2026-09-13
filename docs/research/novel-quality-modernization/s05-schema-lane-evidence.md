# S05 M01 中央 schema 接线证据

依赖 S04：`86d4ab043acc111d2614449385e507ff9d6ecb38`。仅合成项目；模型调用 0。

- 唯一 desktop registry 安装 M00(0→1)、M01(1→2)。版本 1 指纹仍由原 M00 参考 DDL 生成；版本 2 引用 inventory 提供的 `M01_GENERATION_SQL/createM01Migration`，无第二套生成表 DDL。
- `CURRENT_DESKTOP_SCHEMA_VERSION=2` 用于新建、正常验证、S04 staging 备份及 converter 目标门。manifest schemaVersion/storageVersion 保持独立，不随 DB 编号改动。
- 正常 canonical 打开先检查 manifest/路径，再在物理副本只读 probe；仅已注册版本 1 可进入单通道 M01 事务，提交后验证、admit，再业务 fencing。已版本 2 仅验证，不重跑 migration/backfill。未知/高版本/无 manifest 拒绝且不改源字节。
- `onProjectDatabaseBeforeClose` 为严格同步通知；main owner须在仍有效的 DB 上同步暂停/取消并停止新 dispatch。Promise 或异常拒绝关闭，不能把未等待的 flush 当完成；异步 drain 必须在外层生命周期完成后才请求关闭。

实际 Node ABI 141 的 SQLite `SELECT 1` 探针通过，未切 ABI。真实文件与旧接缝测试：`m01-project-upgrade`、`project-data-locator`、`sqlite-project-migration` 共 19/19；连同 registry/service/facade 共 89/89；converter 26/26（包括真实 SQLite/LanceDB 集成）。M00 旧字段签署测试明确迁移到 target 1，未降低当前版本 2 验收。

故障覆盖包括升级中抛错的整步 rollback（原 DB 字节一致）、未知/高版/缺 manifest 拒写、原正文/word_count保全、重复重开不回填、beforeClose 同步写成功及异步/异常拒绝关闭。真实 provider 和打包 Electron 未在本切片运行。
