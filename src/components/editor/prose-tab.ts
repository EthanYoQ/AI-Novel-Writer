import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

const KEEPS_TAB_FOCUS_MODE = new Set(['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta'])

/**
 * 正文里 Tab 插入两个 em 空格（U+2003，2em 正好是中文首行缩进两字，不依赖 CJK 字体），键盘用户因此出不去编辑区：
 * 先按 Esc 打开 CodeMirror 的 tab-focus 模式，下一次 Tab 或 Shift+Tab 就按正常焦点顺序移出、不插空格；
 * 中间按了别的键或编辑区失焦就关掉，Tab 恢复插空格。CodeMirror 自带的 Esc 只开 2 秒，这里不限时。
 * Esc 本身不拦，搜索框、沉浸写作等对 Esc 的处理照旧。
 */
export const proseTab = Prec.highest([
  keymap.of([
    {
      key: 'Escape',
      run: (view) => {
        view.setTabFocusMode(true)
        return false
      },
    },
    {
      key: 'Tab',
      run: (view) => {
        if (view.state.readOnly || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return false
        view.dispatch({
          changes: { from: view.state.selection.main.head, insert: '\u2003\u2003' },
          selection: { anchor: view.state.selection.main.head + 2 },
        })
        return true
      },
    },
  ]),
  // 排在按键绑定之前：方向键等被绑定处理掉的键也要关掉 tab-focus 模式
  EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (!KEEPS_TAB_FOCUS_MODE.has(event.key)) view.setTabFocusMode(false)
      return false
    },
    blur: (_event, view) => {
      view.setTabFocusMode(false)
      return false
    },
  }),
])
