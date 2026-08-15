/** Token-based context-window styles embedded into the independently distributed client bundle. */
export const novelContextCss = String.raw`
.aiNovelContextTrigger{display:inline-flex;min-height:32px;align-items:center;gap:8px;border:0;border-radius:8px;padding:6px 10px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer}
.aiNovelContextTrigger:hover,.aiNovelContextTrigger:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.aiNovelContextOverlay{position:fixed;inset:0;z-index:1000;display:flex;justify-content:flex-end;pointer-events:none}
.aiNovelContextDrawer{box-sizing:border-box;width:min(440px,calc(100vw - 80px));height:100%;overflow:auto;pointer-events:auto;border-left:1px solid var(--dsw-alias-border-inverted);padding:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}
.aiNovelContextHeader,.aiNovelContextSectionHeader{display:flex;align-items:center;justify-content:space-between;gap:16px}
.aiNovelContextHeader h2,.aiNovelContextSections h3,.aiNovelContextSections h4,.aiNovelContextSections p,.aiNovelContextSetup h3,.aiNovelContextSetup p{margin:0}
.aiNovelContextBody,.aiNovelContextSetup{margin-top:24px}
.aiNovelContextSetup{border-top:1px solid var(--dsw-alias-border-l2);padding-top:20px}
.aiNovelContextSections{display:grid;gap:20px}
.aiNovelContextSections section{display:grid;gap:10px}
.aiNovelContextFacts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0}
.aiNovelContextFacts div{min-width:0}.aiNovelContextFacts dt{color:var(--dsw-alias-label-secondary)}.aiNovelContextFacts dd{margin:2px 0 0;overflow-wrap:anywhere}
.aiNovelContextCharacters{display:grid;gap:10px;margin:0;padding:0;list-style:none}.aiNovelContextCharacters li{display:grid;gap:4px}.aiNovelContextCharacters span,.aiNovelContextMuted{color:var(--dsw-alias-label-secondary)}
.aiNovelContextPreview{margin:0;max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:12px}
.aiNovelContextSectionHeader input{width:76px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px;color:inherit;background:transparent}
.aiNovelContextSrOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.aiNovelPresetClose,.aiNovelPresetPrimary,.aiNovelPresetSecondary{min-height:32px;border-radius:8px;padding:6px 12px;cursor:pointer}
.aiNovelPresetClose,.aiNovelPresetSecondary{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:transparent}
.aiNovelPresetPrimary{border:1px solid transparent;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill)}
@media(max-width:760px){.aiNovelContextDrawer{width:100%;padding:18px}.aiNovelContextFacts{grid-template-columns:1fr}}
`

/**
 * Install this plugin's context-window styles for one client fiber.
 *
 * @param target Browser document receiving the owned style element.
 * @returns A disposer that removes only this plugin's style element.
 */
export function installNovelContextStyle(target: Document): () => void {
  const style = target.createElement('style')
  style.dataset.plugin = '@ethanyoq/dsh-ai-novel-writer'
  style.dataset.pluginCss = '@ethanyoq/dsh-ai-novel-writer/context-window'
  style.textContent = novelContextCss
  target.head.appendChild(style)
  return () => { style.remove() }
}
