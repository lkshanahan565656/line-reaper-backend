// ESLint flat config. `npm run lint` runs it; CI runs it on every PR.
// Recommended rules, Node globals for the server, browser globals for the
// service worker. Rules turned off below are style, not bugs.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist-desktop/**', 'data/**', 'public/**/*.html'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker } },
  },
  {
    // the app's script (served as /assets/app.<hash>.js). A classic script:
    // its top-level functions are called from onclick attributes in the page
    // and in the HTML it builds, so only unused locals are reported.
    files: ['public/app.js'],
    languageOptions: {
      ecmaVersion: 2024,
      globals: { ...globals.browser, LRCalc: 'readonly', LRFees: 'readonly', LRGlossary: 'readonly', LRSlips: 'readonly', LRBets: 'readonly', LRVenue: 'readonly' },
    },
    rules: { 'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }] },
  },
  {
    // browser tests: Node scripts whose page.evaluate callbacks run in the app
    files: ['e2e/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, showTab: 'readonly', shpUi: 'readonly' } },
  },
  {
    files: ['calc.js', 'bets.js', 'slips.js', 'fees.js', 'glossary.js', 'acctsync.js'],   // also served to the page
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
];
