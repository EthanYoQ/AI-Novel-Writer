import { useState, type ComponentType, type ReactNode } from 'react'
import {
  Check,
  Image,
  LayoutTemplate,
  Moon,
  Palette,
  ScrollText,
  Sparkles,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react'

import { cn } from '../../lib/utils'
import { useLocaleStore } from '../../stores/locale-store'
import { useSkinStore } from '../../stores/skin-store'
import { useThemeStore, type Theme } from '../../stores/theme-store'
import { isMagazine, useUiVersionStore, type UiVersion } from '../../stores/ui-version-store'
import type { SkinId } from '../../shared/skin-types'

/**
 * Vite's base is deliberately relative for BrowserWindow.loadFile().  This
 * keeps the public asset rooted at dist/ both in development and in a
 * packaged file:// renderer.
 */
const skinAssetBase = import.meta.env.BASE_URL === '/' ? './' : import.meta.env.BASE_URL
export const ANIME_SKIN_URL = `${skinAssetBase}skins/anime-night.webp`

/** Native picker validation is authoritative; this copy makes its limits visible first. */
export const CUSTOM_SKIN_REQUIREMENTS = {
  acceptedMimeTypes: ['image/png', 'image/jpeg'],
  maxBytes: 20 * 1024 * 1024,
  recommendedAspectRatio: '16:10',
} as const

interface ThemeOption {
  id: Theme
  labelKey: 'theme.light' | 'theme.galaxy' | 'theme.paper' | 'theme.dark'
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>
}

const THEME_OPTIONS: ThemeOption[] = [
  { id: 'light', labelKey: 'theme.light', Icon: Sun },
  { id: 'galaxy', labelKey: 'theme.galaxy', Icon: Sparkles },
  { id: 'paper', labelKey: 'theme.paper', Icon: ScrollText },
  { id: 'dark', labelKey: 'theme.dark', Icon: Moon },
]

/**
 * v3「时尚杂志」的主题名 —— **与 v2 分家**（先生定调：界面版本各自分家）。
 *
 * v2「墨纸书斋」沿用 i18n 里的「浅色 / 星空 / 纸质 / 黑夜」（旧纸与文人语境）；
 * v3 用杂志自己的命名，与它的四套冷调配色一一对应。
 * 只换显示名，theme id 不变，因此不影响任何存储与切换逻辑。
 */
const MAGAZINE_THEME_LABELS: Record<Theme, { zh: string; en: string }> = {
  light: { zh: '影棚白', en: 'Studio White' },
  galaxy: { zh: '墨版', en: 'Ink Edition' },
  paper: { zh: '烟灰', en: 'Ash Grey' },
  dark: { zh: '夜墨', en: 'Night Ink' },
}

/**
 * 界面版本：v3「时尚杂志」为当前默认主题；v2「墨纸书斋」保留为可回退的保险。
 * v1 经典界面已隐藏入口（共享组件与 V2 未彻底分家，暂不再开放）。
 */
const UI_VERSION_OPTIONS: Array<{ id: UiVersion; zh: string; en: string; descZh: string; descEn: string }> = [
  { id: 'v3', zh: '时尚杂志', en: 'Magazine', descZh: '全新主题', descEn: 'New theme' },
  { id: 'v2', zh: '墨纸书斋', en: 'Ink & Paper', descZh: '上一版', descEn: 'Previous' },
]

type WorkingAction = 'classic' | 'anime' | 'choose' | 'change' | 'remove' | null

// eslint-disable-next-line react-refresh/only-export-components
export function getCustomSkinActionIds(customAvailable: boolean): Array<'choose' | 'change' | 'remove'> {
  return customAvailable ? ['change', 'remove'] : ['choose']
}

/** Theme selection and image-skin selection intentionally remain independent. */
export default function AppearanceSettings() {
  const { theme, setTheme } = useThemeStore()
  const { text, t } = useLocaleStore()
  const skinState = useSkinStore((state) => state.skinState)
  const backgroundUrl = useSkinStore((state) => state.backgroundUrl)
  const notice = useSkinStore((state) => state.notice)
  const activateSkin = useSkinStore((state) => state.activateSkin)
  const importCustomSkin = useSkinStore((state) => state.importCustomSkin)
  const removeCustomSkin = useSkinStore((state) => state.removeCustomSkin)
  const dismissNotice = useSkinStore((state) => state.dismissNotice)
  const [working, setWorking] = useState<WorkingAction>(null)
  const uiVersion = useUiVersionStore((state) => state.uiVersion)
  const setUiVersion = useUiVersionStore((state) => state.setUiVersion)

  const run = async (action: Exclude<WorkingAction, null>, operation: () => Promise<boolean>) => {
    setWorking(action)
    try {
      await operation()
    } finally {
      setWorking(null)
    }
  }

  const selectSkin = (skinId: Exclude<SkinId, 'custom'>) => {
    void run(skinId, () => activateSkin(skinId))
  }

  const chooseCustomSkin = (action: 'choose' | 'change') => {
    void run(action, importCustomSkin)
  }

  const selectCustomSkin = () => {
    if (skinState.customSkin) {
      void run('change', () => activateSkin('custom'))
      return
    }
    chooseCustomSkin('choose')
  }

  const isCustomAvailable = skinState.customSkin !== null
  const customActionIds = getCustomSkinActionIds(isCustomAvailable)
  const customPreview = backgroundUrl ?? undefined

  return (
    <section className="appearance-settings max-w-3xl space-y-7" aria-label={t('appearance.section')}>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Palette size={16} aria-hidden="true" style={{ color: 'var(--color-accent)' }} />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{t('appearance.theme')}</h3>
        </div>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('appearance.themeDescription')}</p>
        <div className="appearance-theme-grid" role="group" aria-label={t('appearance.theme')}>
          {THEME_OPTIONS.map(({ id, labelKey, Icon }) => (
            <button
              key={id}
              type="button"
              data-theme={id}
              aria-pressed={theme === id}
              onClick={() => setTheme(id)}
              className={cn('appearance-theme-option', theme === id && 'appearance-theme-option--active')}
            >
              <Icon size={15} aria-hidden="true" />
              <span>
                {isMagazine(uiVersion)
                  ? text(MAGAZINE_THEME_LABELS[id].zh, MAGAZINE_THEME_LABELS[id].en)
                  : t(labelKey)}
              </span>
              {theme === id && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <LayoutTemplate size={16} aria-hidden="true" style={{ color: 'var(--color-accent)' }} />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{text('界面版本', 'Interface version')}</h3>
        </div>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {text(
            '「时尚杂志」是全新的杂志风主题：统一放大字号、重排全部菜单与子菜单，正文更易读。「墨纸书斋」与经典界面作为随时可回退的保险。切换立即生效，不影响项目数据与创作任务。',
            'Magazine is the new editorial theme: larger type across every menu and submenu. Ink & Paper and Classic stay available as one-click fallbacks. The switch applies immediately and never touches project data or running tasks.',
          )}
        </p>
        <div className="appearance-theme-grid" role="group" aria-label={text('界面版本', 'Interface version')}>
          {UI_VERSION_OPTIONS.map(({ id, zh, en, descZh, descEn }) => (
            <button
              key={id}
              type="button"
              data-ui-version={id}
              aria-pressed={uiVersion === id}
              onClick={() => setUiVersion(id)}
              className={cn('appearance-theme-option', uiVersion === id && 'appearance-theme-option--active')}
            >
              <LayoutTemplate size={15} aria-hidden="true" />
              <span>{text(zh, en)}</span>
              <span style={{ opacity: 0.7, marginLeft: 'auto' }}>{text(descZh, descEn)}</span>
              {uiVersion === id && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Image size={16} aria-hidden="true" style={{ color: 'var(--color-accent)' }} />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{t('appearance.skins')}</h3>
          </div>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{t('appearance.skinsDescription')}</p>
        </div>

        <div className="appearance-skin-grid">
          <SkinCard
            skinId="classic"
            active={skinState.activeSkin === 'classic'}
            title={t('appearance.classic')}
            description={t('appearance.classicDescription')}
            previewClassName="appearance-skin-preview--classic"
            busy={working === 'classic'}
            onSelect={() => selectSkin('classic')}
          />
          <SkinCard
            skinId="anime"
            active={skinState.activeSkin === 'anime'}
            title={t('appearance.anime')}
            description={t('appearance.animeDescription')}
            previewClassName="appearance-skin-preview--anime"
            previewUrl={ANIME_SKIN_URL}
            busy={working === 'anime'}
            onSelect={() => selectSkin('anime')}
          />
          <SkinCard
            skinId="custom"
            active={skinState.activeSkin === 'custom'}
            title={t('appearance.custom')}
            description={isCustomAvailable ? t('appearance.customAvailable') : t('appearance.customUnavailable')}
            previewClassName="appearance-skin-preview--custom"
            previewUrl={customPreview}
            busy={working === 'choose' || working === 'change'}
            onSelect={selectCustomSkin}
          >
            <p className="appearance-skin-hint">{t('appearance.customHint')}</p>
            <div className="appearance-skin-actions">
              {customActionIds.includes('change') ? (
                <>
                  <button
                    type="button"
                    data-skin-action="change"
                    className="appearance-action-button"
                    disabled={working !== null}
                    onClick={() => chooseCustomSkin('change')}
                  >
                    <Upload size={14} aria-hidden="true" />
                    {t('appearance.change')}
                  </button>
                  <button
                    type="button"
                    data-skin-action="remove"
                    className="appearance-action-button appearance-action-button--danger"
                    disabled={working !== null}
                    onClick={() => void run('remove', removeCustomSkin)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {t('appearance.remove')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-skin-action="choose"
                  className="appearance-action-button"
                  disabled={working !== null}
                  onClick={() => chooseCustomSkin('choose')}
                >
                  <Upload size={14} aria-hidden="true" />
                  {t('appearance.choose')}
                </button>
              )}
            </div>
          </SkinCard>
        </div>
      </div>

      {notice && (
        <div className="appearance-notice" role="status" aria-live="polite">
          <span>{text(notice.zh, notice.en)}</span>
          <button type="button" onClick={dismissNotice} className="appearance-notice-dismiss">
            {t('common.close')}
          </button>
        </div>
      )}
    </section>
  )
}

function SkinCard({
  skinId,
  active,
  title,
  description,
  previewClassName,
  previewUrl,
  busy,
  onSelect,
  children,
}: {
  skinId: SkinId
  active: boolean
  title: string
  description: string
  previewClassName: string
  previewUrl?: string
  busy: boolean
  onSelect: () => void
  children?: ReactNode
}) {
  const text = useLocaleStore((state) => state.text)

  return (
    <article
      data-skin-card={skinId}
      className={cn('appearance-skin-card', active && 'appearance-skin-card--active')}
    >
      <button
        type="button"
        className="appearance-skin-select"
        aria-pressed={active}
        disabled={busy}
        onClick={onSelect}
      >
        <span
          className={cn('appearance-skin-preview', previewClassName)}
          style={previewUrl ? { backgroundImage: `url("${previewUrl}")` } : undefined}
          aria-hidden="true"
        />
        <span className="appearance-skin-copy">
          <span className="flex items-center gap-1.5">
            <strong>{title}</strong>
            {active && <Check size={14} aria-label={text('当前使用', 'Selected')} />}
          </span>
          <span>{description}</span>
        </span>
      </button>
      {children}
    </article>
  )
}
