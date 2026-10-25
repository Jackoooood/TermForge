import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'build/**',
      'coverage/**',
      '.vite/**',
      '.tmp/**',
      '*.log',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'electron.vite.config.ts',
      'vitest.config.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx}', 'tests/unit/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/acceptance/**/*.{mjs,ts}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
)
