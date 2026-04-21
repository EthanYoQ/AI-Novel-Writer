# Vela 项目 Cursor AI 规则

项目完整规范：`./rule.md`

## 核心规则

1. 所有注释和用户可见文本使用中文
2. 颜色使用 CSS 变量（var(--color-xxx)），禁止硬编码
3. 禁止 window.alert() / window.confirm() — 用 toast / alertError / confirm 替代
4. 禁止 window.dispatchEvent 全局事件 — 用 layout-store 管理
5. 路径常量引用 src/shared/project-paths.ts
6. 使用相对路径导入，不用 @ 别名
7. 组件 .tsx 用 PascalCase，工具 .ts 用 kebab-case
8. 按钮使用 <Button> 或 <IconBtn> 组件
9. Store 使用 Zustand（无 Redux），文件命名 xxx-store.ts
10. Prompt 模板使用 {{变量}} 插值，通过 renderPrompt() 渲染
11. 数字输入框必须允许清空：state 类型允许 `number | ''`，onChange 中转为 `e.target.value === '' ? '' : Number(e.target.value)`，默认值回退逻辑放在 onBlur 中处理。
