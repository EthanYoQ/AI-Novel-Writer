import { connect, type Connection } from '@lancedb/lancedb'

export { Index } from '@lancedb/lancedb'

/**
 * 应用打开 LanceDB 的唯一入口（eslint no-restricted-imports 兜住其他值导入）。
 * 新表钉住 2.0 数据格式：0.41 默认格式建的表，0.22.3 能打开却一读就 panic，钉住后升级再回退仍读得回。
 */
export function openLanceDatabase(directory: string): Promise<Connection> {
  return connect(directory, { storageOptions: { new_table_data_storage_version: '2.0' } })
}
