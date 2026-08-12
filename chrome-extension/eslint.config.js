import js from '@eslint/js';
import globals from 'globals';
import typescriptEslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettierConfig from 'eslint-config-prettier';

export default typescriptEslint.config(
  { ignores: ['dist', 'dist-storybook', 'node_modules', 'scripts/**/*.js'] },
  js.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Config files run in Node, not the browser.
    files: ['*.config.ts', '.storybook/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Storybook config and stories are never hot-reloaded as app modules.
    files: ['.storybook/**/*.{ts,tsx}', '**/*.stories.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  prettierConfig,
);
