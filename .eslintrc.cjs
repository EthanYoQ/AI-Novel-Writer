module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:react-hooks/recommended', 'plugin:storybook/recommended'],
  ignorePatterns: ['dist', 'dist-electron', 'build', 'docs', 'plugins', '.eslintrc.cjs', '!.release'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      excludedFiles: ['electron/lance-database.ts', '**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', 'scripts/**', 'test/**'],
      rules: {
        '@typescript-eslint/no-restricted-imports': ['error', {
          paths: [{ name: '@lancedb/lancedb', allowTypeImports: true, message: '经 electron/lance-database.ts 打开 LanceDB，新表格式钉在那里。' }],
        }],
        'no-restricted-syntax': ['error', {
          selector: "ImportExpression[source.value='@lancedb/lancedb'], CallExpression[arguments.0.value='@lancedb/lancedb']",
          message: '经 electron/lance-database.ts 打开 LanceDB，新表格式钉在那里。',
        }],
      },
    },
    {
      files: ['**/*.mjs'],
      env: { node: true },
      rules: {
        '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
        'react-hooks/rules-of-hooks': 'off',
      },
    },
  ],
}
