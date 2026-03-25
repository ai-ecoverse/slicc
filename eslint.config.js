import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // Base config - shared globals only
    languageOptions: {
      globals: {
        __DEV__: 'readonly',
      },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      // TypeScript handles these better
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_|^(e|err|error)$',
        },
      ],

      // Allow explicit any in specific cases (legacy code migration)
      '@typescript-eslint/no-explicit-any': 'warn',

      // Enforce consistent type imports (warn to allow gradual migration)
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Prevent common bugs
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-extra-boolean-cast': 'error',
      'no-irregular-whitespace': 'error',
      'no-loss-of-precision': 'error',
      'no-sparse-arrays': 'error',

      // Code quality
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',

      // Allow empty functions (common in tests and stubs)
      '@typescript-eslint/no-empty-function': 'off',

      // Allow require imports for dynamic loading
      '@typescript-eslint/no-require-imports': 'off',

      // Allow non-null assertions (project uses them intentionally)
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Allow Function type (common in event handlers and callbacks)
      '@typescript-eslint/no-unsafe-function-type': 'warn',

      // Allow control characters in regex (used for ANSI escape sequences)
      'no-control-regex': 'off',

      // Allow unused expressions (common in test assertions)
      '@typescript-eslint/no-unused-expressions': 'off',

      // Allow useless escapes (some are for readability)
      'no-useless-escape': 'warn',

      // Allow useless assignment (common in destructuring for documentation)
      'no-useless-assignment': 'warn',

      // Allow this aliasing (needed for some callback patterns)
      '@typescript-eslint/no-this-alias': 'warn',

      // Disable preserve-caught-error (from typescript-eslint recommended)
      'preserve-caught-error': 'off',
    },
  },
  {
    // CLI / Node.js files - Node globals only
    files: [
      'packages/node-server/src/**/*.ts',
      'packages/cloudflare-worker/src/**/*.ts',
      'vite.config*.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Browser UI files - Browser globals only
    files: [
      'packages/webapp/src/ui/**/*.ts',
      'packages/webapp/src/cdp/**/*.ts',
      'packages/webapp/src/core/**/*.ts',
      'packages/webapp/src/fs/**/*.ts',
      'packages/webapp/src/git/**/*.ts',
      'packages/webapp/src/providers/**/*.ts',
      'packages/webapp/src/scoops/**/*.ts',
      'packages/webapp/src/shell/**/*.ts',
      'packages/webapp/src/skills/**/*.ts',
      'packages/webapp/src/tools/**/*.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // Browser extension files - Browser + chrome globals
    files: ['packages/chrome-extension/voice-popup.js', 'packages/chrome-extension/src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        chrome: 'readonly',
      },
    },
  },
  {
    // Test files - Both environments + lenient rules
    files: ['**/*.test.ts', '**/*.test.mjs', 'test-*.mjs'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern:
            '^_|^(leader|follower|channel|transport|shell|fs|scoop|context|orchestrator|api|client|manager|recorder|proxy|bridge|handler|worker|session|store|panel|zone|dialog|renderer|entry|watcher)$',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Electron overlay files - ban innerHTML for Trusted Types compatibility
    files: [
      'packages/webapp/src/ui/electron-overlay.ts',
      'packages/webapp/src/ui/electron-overlay-entry.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'innerHTML',
          message:
            'innerHTML is banned in electron-overlay files due to Trusted Types (VS Code CSP). Use createElement + textContent instead.',
        },
        {
          property: 'outerHTML',
          message:
            'outerHTML is banned in electron-overlay files due to Trusted Types (VS Code CSP). Use createElement + textContent instead.',
        },
      ],
    },
  },
  {
    // Ignore patterns
    ignores: ['dist/**', 'node_modules/**', 'artifacts/**', '*.min.js', 'packages/assets/fonts/**'],
  }
);
