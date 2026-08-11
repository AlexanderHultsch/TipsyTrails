import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // Phase 5 step 5: the one hand-written, non-Vite-processed browser
    // script in the repo (packages/web/public/push-sw.js) - it runs in a
    // ServiceWorkerGlobalScope, not the `window` every other web/src file
    // assumes, so it needs its own globals rather than tsconfig's DOM lib
    // (which TS-aware files get for free; this plain .js file does not go
    // through the TypeScript parser at all).
    files: ['packages/web/public/**/*.js'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
);
