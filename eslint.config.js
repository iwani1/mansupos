import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', '.data/**', 'coverage/**', '**/release/**', 'desktop/pos-trial/bundle/**'] },
  {
    files: ['desktop/pos-trial/preload.cjs'],
    languageOptions: { globals: globals.node },
  },
  js.configs.recommended,
  {
    files: ['desktop/hardware-test/main.cjs', 'desktop/online/*.cjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, react },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^React$' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Server code runs only in Node: browser globals such as `name`, `status`
    // or `history` would hide a missing variable from no-undef.
    files: ['server/**/*.js'],
    ignores: ['server/**/public/**'], // pages served to the browser
    languageOptions: {
      globals: Object.fromEntries(Object.keys(globals.browser)
        .filter(key => !(key in globals.node)).map(key => [key, 'off'])),
    },
  },
];
