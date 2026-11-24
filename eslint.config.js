import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

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
    // ESLint 10 tracks JSX references itself, so eslint-plugin-react's
    // jsx-uses-vars / jsx-uses-react are no longer needed.
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^React$' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'react-hooks/exhaustive-deps': 'warn',
      // React Compiler rule (new in eslint-plugin-react-hooks 7). It flags the
      // load-on-mount pattern used across the app; this app does not use the
      // compiler, and rewriting every page's data loading is a separate change.
      'react-hooks/set-state-in-effect': 'off',
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
