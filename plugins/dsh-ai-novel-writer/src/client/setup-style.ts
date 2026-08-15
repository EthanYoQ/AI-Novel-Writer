/** Token-based setup styles embedded into the independently distributed client bundle. */
export const presetSetupCss = String.raw`
.aiNovelPresetTrigger{display:inline-flex;min-height:32px;align-items:center;gap:8px;border:0;border-radius:8px;padding:6px 10px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer}
.aiNovelPresetTrigger:hover,.aiNovelPresetTrigger:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.aiNovelPresetOverlay{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px}
.aiNovelPresetMask{position:absolute;inset:0;border:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.aiNovelPresetDialog{position:relative;width:min(520px,100%);max-height:min(640px,calc(100vh - 48px));overflow:auto;border:1px solid var(--dsw-alias-border-inverted);border-radius:16px;padding:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}
.aiNovelPresetHeader{display:flex;align-items:center;justify-content:space-between;gap:16px}
.aiNovelPresetHeader h2,.aiNovelPresetDescription,.aiNovelPresetBody p{margin:0}
.aiNovelPresetDescription{margin-top:8px;color:var(--dsw-alias-label-secondary)}
.aiNovelPresetBody{margin-top:24px}
.aiNovelPresetBody p+p,.aiNovelPresetBody p+button{margin-top:12px}
.aiNovelPresetClose,.aiNovelPresetPrimary,.aiNovelPresetSecondary{min-height:32px;border-radius:8px;padding:6px 12px;cursor:pointer}
.aiNovelPresetClose,.aiNovelPresetSecondary{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:transparent}
.aiNovelPresetPrimary{border:1px solid transparent;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill)}
@media(max-width:560px){.aiNovelPresetOverlay{align-items:end;padding:12px}.aiNovelPresetDialog{width:100%;max-height:calc(100vh - 24px);border-radius:14px;padding:18px}}
`

/**
 * Install this plugin's setup styles for one client fiber.
 *
 * @param target Browser document receiving the owned style element.
 * @returns A disposer that removes only this plugin's style element.
 */
export function installPresetSetupStyle(target: Document): () => void {
  const style = target.createElement('style')
  style.dataset.plugin = '@ethanyoq/dsh-ai-novel-writer'
  style.dataset.pluginCss = '@ethanyoq/dsh-ai-novel-writer/preset-setup'
  style.textContent = presetSetupCss
  target.head.appendChild(style)
  return () => { style.remove() }
}
