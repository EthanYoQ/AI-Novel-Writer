import { useState, type ComponentType, type ReactNode } from 'react'
import {
  Check,
  Image,
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
import type { SkinId } from '../../shared/skin-types'

/** Replace this single public path when the bundled anime asset is finalized. */
export const ANIME_SKIN_URL = '/skins/anime-night.webp'

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
              <span>{t(labelKey)}</span>
              {theme === id && <Check size={14} aria-hidden="true" />}
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
