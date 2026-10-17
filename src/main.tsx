import { installMainGenerationTransport } from './services/generation/generation-runtime'
import { mainGenerationTransport } from './services/generation/main-generation-transport'
import React from 'react'
import ReactDOM from 'react-dom/client'
import RendererStartup from './components/startup/RendererStartup'
// 纸墨样式只在入口引入：原语组件不带样式副作用，Node 侧打包（如真实供应商资格脚本）才能引用它们。
import './styles/paper-ink/index.css'
import './index.css'
// 外壳样式同样只在入口引入，排在全局样式之后，颜色桥接才能覆盖 index.css 里的 --color-*。
import './components/stage/stage.css'


installMainGenerationTransport(mainGenerationTransport)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererStartup />
  </React.StrictMode>,
)
