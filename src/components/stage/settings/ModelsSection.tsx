import { useState, type ReactNode } from 'react'
import { Cpu, MoreHorizontal, Plus } from 'lucide-react'
import type { ModelProfile } from '../../../shared/ipc-channels'
import { BUILTIN_PRESETS } from '../../../shared/provider-presets'
import { useLocaleStore } from '../../../stores/locale-store'
import { openModelProviderResource } from '../../settings/model-provider-resource'
import { useUnsavedSettings } from '../../settings/unsaved-settings'
import { ModelForm } from '../../settings/ModelForm'
import { useModelSection } from '../../settings/use-model-section'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { EmptyState } from '../../ui/EmptyState'
import { Menu } from '../../ui/Menu'
import { Notice } from '../../ui/Notice'

function providerName(model: ModelProfile): string {
  const preset = BUILTIN_PRESETS.find(candidate => candidate.provider === model.provider)
  return preset?.displayName ?? model.provider
}

/** 一类模型的列表与编辑：生成用的「AI 模型」或知识库用的「检索模型」。删除要先确认。 */
export default function ModelsSection({ purposes, header }: { purposes: ModelProfile['purposes']; header: (action: ReactNode) => ReactNode }) {
  const text = useLocaleStore(s => s.text)
  const section = useModelSection(purposes)
  useUnsavedSettings(section.editingDirty)
  const [deleting, setDeleting] = useState<ModelProfile | null>(null)
  const retrieval = section.isEmbeddingSection
  const kind = retrieval ? text('检索模型', 'retrieval model') : text('模型', 'model')
  const add = <Button variant="secondary" onClick={section.add}><Plus size={14} aria-hidden="true" />{text(`添加${kind}`, `Add ${kind}`)}</Button>

  if (section.editingModel) {
    return (
      <>
        {header(null)}
        <div className="stage-set-legacy">
          <ModelForm
            key={section.editingModel.id}
            model={section.editingModel}
            onChange={section.setEditingModel}
            onSave={() => void section.save()}
            onCancel={section.cancelEdit}
            saving={section.saving}
            purposeOptions={purposes}
            presets={BUILTIN_PRESETS}
          />
        </div>
      </>
    )
  }

  const deletingDefault = deleting !== null && deleting.id === section.defaultId
  return (
    <>
      {header(section.models.length > 0 ? add : null)}
      {retrieval && (
        <Notice
          tone="info"
          title={text('免费的检索模型', 'A free retrieval model')}
          actions={<Button variant="text" size="sm" onClick={() => void openModelProviderResource('siliconflow-invite', text)}>{text('去注册', 'Sign up')}</Button>}
        >
          {text('SiliconFlow 提供免费的 BAAI/bge-m3，注册后填上密钥就能用。', 'SiliconFlow offers BAAI/bge-m3 for free. Sign up and add your key.')}
        </Notice>
      )}
      {section.models.length === 0
        ? (
          <div className="stage-set-card">
            <EmptyState
              heading={retrieval ? text('还没有检索模型', 'No retrieval model yet') : text('还没有添加模型', 'No models yet')}
              description={retrieval
                ? text('添加一个之后，知识库就能按意思找到相关段落。', 'Add one so the knowledge base can find passages by meaning.')
                : text('写作、审稿、修稿都要用到它。添加的第一个会成为默认模型。', 'Writing, reviews and revisions all need one. The first you add becomes the default.')}
              action={<Button variant="primary" onClick={section.add}><Plus size={14} aria-hidden="true" />{text(`添加${kind}`, `Add ${kind}`)}</Button>}
            />
          </div>
        )
        : (
          <ul className="stage-set-models" aria-label={retrieval ? text('检索模型', 'Retrieval models') : text('AI 模型', 'AI models')}>
            {section.models.map(model => {
              const isDefault = model.id === section.defaultId
              const name = model.name || model.modelName
              return (
                <li key={model.id} className="stage-set-model" data-default={isDefault || undefined}>
                  <span className="stage-set-model-mark" aria-hidden="true"><Cpu size={16} /></span>
                  <div className="stage-set-model-text">
                    <div className="stage-set-model-name">
                      <span>{name}</span>
                      {isDefault && <span className="stage-badge">{text('默认', 'Default')}</span>}
                    </div>
                    <p className="stage-set-model-meta">{providerName(model)} · {model.modelName}</p>
                  </div>
                  <Button variant="text" size="sm" onClick={() => section.edit(model)} aria-label={text(`编辑「${name}」`, `Edit “${name}”`)}>{text('编辑', 'Edit')}</Button>
                  <Menu
                    label={text(`「${name}」更多操作`, `More for “${name}”`)}
                    icon={<MoreHorizontal size={16} aria-hidden="true" />}
                    align="end"
                    groups={[
                      ...(isDefault ? [] : [{ id: 'default', items: [{ id: 'default', label: text('设为默认', 'Make default'), onSelect: () => void section.setDefault(model.id) }] }]),
                      { id: 'danger', tone: 'danger' as const, items: [{ id: 'delete', label: text('删除模型…', 'Delete model…'), onSelect: () => setDeleting(model) }] },
                    ]}
                  />
                </li>
              )
            })}
          </ul>
        )}
      <DangerConfirm
        open={deleting !== null}
        onOpenChange={open => { if (!open) setDeleting(null) }}
        title={text(`删除「${deleting ? deleting.name || deleting.modelName : ''}」？`, `Delete “${deleting ? deleting.name || deleting.modelName : ''}”?`)}
        consequence={deletingDefault
          ? text(`它是默认${kind}。删除后要先另选一个默认${kind}，${retrieval ? '知识库才能按意思检索' : '才能继续用 AI 写作、审稿'}。`, `It is the default ${kind}. After deleting it, choose another default before ${retrieval ? 'the knowledge base can search by meaning' : 'AI writing and reviews work again'}.`)
          : text('这个模型的名称、接口地址和密钥会从本机删除。', 'Its name, endpoint and key are removed from this computer.')}
        recoverability={text('删除后无法恢复，需要时重新添加。', 'This cannot be undone. Add it again if you need it.')}
        cancelLabel={text('取消', 'Cancel')}
        confirmLabel={text('删除模型', 'Delete model')}
        onConfirm={() => { if (deleting) void section.remove(deleting.id) }}
      />
    </>
  )
}
