/** Token-based context-window styles embedded into the independently distributed client bundle. */
export const novelContextCss = String.raw`
.aiNovelContextTrigger{display:inline-flex;min-height:32px;align-items:center;gap:8px;border:0;border-radius:8px;padding:6px 10px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer}
.aiNovelContextTrigger:hover,.aiNovelContextTrigger:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.aiNovelWorkbenchFrameOpen{box-sizing:border-box;padding-right:440px}
.aiNovelContextOverlay{position:fixed;inset:0;z-index:2147483001;display:flex;justify-content:flex-end;pointer-events:none}
.aiNovelContextDrawer{box-sizing:border-box;width:440px;min-width:400px;max-width:calc(100vw - 80px);height:100%;overflow:auto;pointer-events:auto;border-left:1px solid var(--dsw-alias-border-inverted);padding:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}
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
.aiNovelPresetClose:focus-visible,.aiNovelPresetPrimary:focus-visible,.aiNovelPresetSecondary:focus-visible,.aiNovelBackButton:focus-visible,.aiNovelDangerButton:focus-visible,.aiNovelAssetList button:focus-visible,.aiNovelCharacterList button:focus-visible,.aiNovelWorkbenchField input:focus-visible,.aiNovelWorkbenchField select:focus-visible,.aiNovelWorkbenchField textarea:focus-visible,.aiNovelCastEditor input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.aiNovelPresetPrimary:disabled{opacity:.45;cursor:default}
.aiNovelWorkbenchForm{display:grid;gap:16px}.aiNovelWorkbenchIntro{display:grid;gap:8px}.aiNovelWorkbenchIntro h3,.aiNovelWorkbenchIntro p{margin:0}
.aiNovelWorkbenchField{display:grid;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.aiNovelWorkbenchField input,.aiNovelWorkbenchField select,.aiNovelWorkbenchField textarea{box-sizing:border-box;width:100%;min-height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}.aiNovelWorkbenchField textarea{min-height:84px;resize:vertical}
.aiNovelWorkbenchField .aiNovelChapterDraftEditor{min-height:360px;line-height:1.65;overflow-wrap:anywhere;white-space:pre-wrap}
.aiNovelInitializationPreview{display:grid;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px;background:var(--dsw-alias-bg-layer-1)}.aiNovelInitializationPreview h4,.aiNovelInitializationPreview p{margin:0}.aiNovelInitializationPreview pre{margin:0;max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary)}
.aiNovelWorkbenchActions,.aiNovelPluginActions{display:flex;justify-content:flex-end;gap:8px}.aiNovelWorkbenchActions{position:sticky;bottom:-24px;margin:0 -24px -24px;padding:16px 24px;background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l2)}
.aiNovelWorkbenchActionsInline{position:static;margin:0;padding:0;border:0}.aiNovelWorkbenchActions button:disabled,.aiNovelCharacterToolbar button:disabled{opacity:.45;cursor:default}
.aiNovelAssetList{display:grid;gap:8px}.aiNovelAssetList button,.aiNovelCharacterList button{display:grid;gap:3px;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;text-align:left;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);cursor:pointer}.aiNovelAssetList button:hover,.aiNovelCharacterList button:hover,.aiNovelCharacterList button[aria-current=true]{background:var(--dsw-alias-interactive-bg-hover)}.aiNovelAssetList span,.aiNovelCharacterList span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.aiNovelAssetHeading{display:grid;gap:12px}.aiNovelAssetHeading h3,.aiNovelAssetHeading p{margin:0}.aiNovelAssetHeading p{margin-top:3px;font-size:12px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}.aiNovelBackButton{display:inline-flex;justify-self:start;min-height:34px;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:inherit;font-weight:500;cursor:pointer}.aiNovelBackButton:hover{background:var(--dsw-alias-interactive-bg-hover)}.aiNovelBackButton:disabled{opacity:.45;cursor:default}
.aiNovelGenerationPanel{display:grid;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1)}.aiNovelGenerationHeader{display:grid;gap:4px}.aiNovelGenerationHeader h4,.aiNovelGenerationHeader p,.aiNovelGenerationPanel>p{margin:0}.aiNovelGenerationHeader p{font-size:12px;color:var(--dsw-alias-label-secondary)}.aiNovelGenerationButton{justify-self:start}
.aiNovelCharacterToolbar{display:grid;grid-template-columns:1fr auto;align-items:end;gap:8px}.aiNovelCharacterList{display:grid;gap:6px;max-height:210px;overflow:auto;margin:0;padding:0;list-style:none}.aiNovelCharacterEditor{display:grid;gap:12px;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px}.aiNovelCharacterEditor legend{padding:0 5px;color:var(--dsw-alias-label-secondary)}
.aiNovelRelationshipEditor,.aiNovelCastEditor{display:grid;gap:10px;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px}.aiNovelRelationshipEditor legend,.aiNovelCastEditor legend{padding:0 5px;color:var(--dsw-alias-label-secondary)}.aiNovelRelationshipRow{display:grid;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:10px}.aiNovelRelationshipRow>button,.aiNovelRelationshipEditor>button{justify-self:start}.aiNovelCastEditor>label{display:flex;align-items:center;gap:8px;min-height:30px;color:var(--dsw-alias-label-primary)}.aiNovelCastEditor input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.aiNovelDangerButton{justify-self:start;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;color:var(--dsw-alias-state-error-primary);background:transparent;cursor:pointer}.aiNovelEditorNotice{display:grid;gap:8px;border-left:2px solid var(--dsw-alias-brand-primary);padding-left:10px}.aiNovelEditorNotice p{margin:0}
.aiNovelPluginCard{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;background:var(--dsw-alias-bg-layer-3)}
.aiNovelPluginCardHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.aiNovelPluginCardHeader strong{font-size:15px}.aiNovelPluginCardHeader p{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px}
.aiNovelPluginMounted{flex:none;border-radius:999px;padding:2px 8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);font-size:11px}
.aiNovelPluginFacts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}.aiNovelPluginFacts div{min-width:0}.aiNovelPluginFacts dt{font-size:12px;color:var(--dsw-alias-label-tertiary)}.aiNovelPluginFacts dd{margin:2px 0 0;font-size:13px;color:var(--dsw-alias-label-primary)}
.aiNovelV2Workbench{display:grid;gap:20px;min-width:0}.aiNovelV2Panel{display:grid;gap:10px;min-width:0}.aiNovelV2Panel h3,.aiNovelV2Panel p{margin:0}.aiNovelV2Summary{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0}.aiNovelV2Summary div{min-width:0}.aiNovelV2Summary dt{font-size:12px;color:var(--dsw-alias-label-tertiary)}.aiNovelV2Summary dd{margin:2px 0 0;overflow-wrap:anywhere}.aiNovelV2List{display:grid;gap:6px;margin:0;padding:0;list-style:none}.aiNovelV2List button,.aiNovelV2DetailList button,.aiNovelV2AssetNav button{width:100%;min-height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;text-align:left;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);cursor:pointer}.aiNovelV2List button[aria-current=true],.aiNovelV2List button:hover,.aiNovelV2DetailList button:hover,.aiNovelV2AssetNav button:hover{background:var(--dsw-alias-interactive-bg-hover)}.aiNovelV2DetailList,.aiNovelV2AssetNav,.aiNovelV2Diff{display:grid;gap:8px}.aiNovelV2Diff section{min-width:0}.aiNovelV2Diff h4{margin:0;font-size:13px}.aiNovelV2Diff pre{margin:0;max-height:240px;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}.aiNovelV2Editor textarea{width:100%;min-height:360px;box-sizing:border-box;resize:vertical;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
@media(max-width:899px){.aiNovelWorkbenchFrameOpen{padding-right:0}.aiNovelContextDrawer{width:100%;min-width:0;max-width:none;padding:18px}.aiNovelContextFacts,.aiNovelPluginFacts{grid-template-columns:1fr}.aiNovelWorkbenchActions{bottom:-18px;margin:0 -18px -18px;padding:14px 18px}}
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
