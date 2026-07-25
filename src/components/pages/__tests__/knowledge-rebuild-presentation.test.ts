import { describe, expect, it } from 'vitest'
import { getVectorRebuildPresentation } from '../knowledge-rebuild-presentation'

describe('知识库向量重建入口', () => {
  it('未配置可用 Embedding 模型时不展示入口，也不会诱导调用重建', () => {
    expect(getVectorRebuildPresentation({
      embeddingConfigured: false,
      canRebuild: false,
      totalChunks: 12,
      vectorlessCount: 12,
      activeVectorDimension: 0,
    })).toBeNull()
  })

  it('在满旧索引时仍展示中英文检查并重建入口，而不是仅依赖缺失向量数量', () => {
    expect(getVectorRebuildPresentation({
      embeddingConfigured: true,
      canRebuild: true,
      totalChunks: 12,
      vectorlessCount: 0,
      activeVectorDimension: 768,
    })).toEqual({
      kind: 'check-current-model',
      title: {
        zhCN: '检查当前模型的向量索引',
        enUS: 'Check the current model vector index',
      },
      action: {
        zhCN: '检查并重建向量索引',
        enUS: 'Check and rebuild vector index',
      },
    })
  })
})
