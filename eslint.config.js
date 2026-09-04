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
    // SPEC.md Section 7.1's second constants module holds the constants a
    // client may not be given (`packages/shared/src/server-config.ts`), and
    // Section 7.7's third clause is what happens when nothing stops one
    // reaching the browser: from v1.31 to v1.53 the badge floors shipped in the
    // production bundle while Section 7.7 promised they never left the server.
    //
    // The subpath is already outside `@tipsytrails/shared`'s default entry
    // point, so importing it takes a deliberate line rather than a stray
    // `CONFIG`. This is what makes that line fail rather than merely look
    // wrong. It is the second of the three guards named in server-config.ts;
    // the one that actually proves the property is
    // `packages/web/src/bundle.test.ts`, which greps the built output.
    files: ['packages/web/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tipsytrails/shared/server', '**/shared/src/server-config*'],
              message:
                'Server-only constants (SPEC.md Section 7.1) must not reach the browser bundle - ' +
                'see Section 7.7. Client-safe constants are in @tipsytrails/shared (CONFIG).',
            },
          ],
        },
      ],
    },
  },
  {
    // The one hand-written, non-Vite-processed browser script in the repo
    // (packages/web/public/sw.js, which absorbed the separate push worker
    // this rule was first written for) - it runs in a
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
