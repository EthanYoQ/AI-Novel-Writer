import { useEffect, useState } from 'react'
import { useLLMStore } from '../../stores/llm-store'
import { useLocaleStore } from '../../stores/locale-store'
import type { ModelProfile } from '../../shared/ipc-channels'
import { createModelProfileDraft } from '../../shared/model-profile-draft'
import { randomUUID } from '../../utils/id'
import { alertError } from '../ui/AlertDialog'

/**
 * 一类模型（生成或向量）的列表与编辑：按用途过滤、新增草稿、保存（该类第一个自动设为默认）、删除、设为默认。
 * 设置页的「AI 模型」与「检索模型」用它。
 */
export function useModelSection(purposes: ModelProfile['purposes']) {
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const defaultEmbeddingModelId = useLLMStore(s => s.defaultEmbeddingModelId)
  const loaded = useLLMStore(s => s.loaded)
  const loadModels = useLLMStore(s => s.loadModels)
  const saveModel = useLLMStore(s => s.saveModel)
  const deleteModel = useLLMStore(s => s.deleteModel)
  const setDefaultModel = useLLMStore(s => s.setDefaultModel)
  const setDefaultEmbeddingModel = useLLMStore(s => s.setDefaultEmbeddingModel)
  const [editingModel, setEditingModel] = useState<ModelProfile | null>(null)
  const [editingOriginal, setEditingOriginal] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!loaded) loadModels()
  }, [loaded, loadModels])

  const filtered = models.filter((m) =>
    m.purposes?.some((p) => purposes.includes(p as ModelProfile['purposes'][number]))
  )
  const isEmbeddingSection = purposes.includes('embedding')
  const defaultId = isEmbeddingSection ? defaultEmbeddingModelId : defaultModelId

  /** 向量模型由工厂选择完整的 SiliconFlow 默认值。 */
  const startEditing = (model: ModelProfile) => {
    setEditingModel(model)
    setEditingOriginal(JSON.stringify(model))
  }
  const add = () => {
    startEditing(createModelProfileDraft({
      id: randomUUID(),
      purposes: [...purposes],
    }))
  }

  const setDefault = (modelId: string) => isEmbeddingSection
    ? setDefaultEmbeddingModel(modelId)
    : setDefaultModel(modelId)

  const save = async () => {
    if (!editingModel) return
    setSaving(true)
    try {
      if (!await saveModel(editingModel)) return
      if (filtered.length === 0 && !await setDefault(editingModel.id)) return
      setEditingModel(null)
    } catch (error) {
      const text = useLocaleStore.getState().text
      void alertError(String(error), { title: text('模型设置保存失败', 'Model settings could not be saved') })
    } finally {
      setSaving(false)
    }
  }

  return {
    models: filtered,
    defaultId,
    isEmbeddingSection,
    editingModel,
    /** 编辑表单里的内容与打开时不同。 */
    editingDirty: editingModel !== null && JSON.stringify(editingModel) !== editingOriginal,
    setEditingModel,
    saving,
    add,
    edit: (model: ModelProfile) => startEditing({ ...model }),
    cancelEdit: () => setEditingModel(null),
    save,
    remove: (modelId: string) => deleteModel(modelId),
    setDefault,
  }
}
