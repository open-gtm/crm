import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", ".claude/**", "packages/web/test-results/**", "packages/web/playwright-report/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // SQL lives in per-domain query modules (ADR 0012). Anywhere else in the server, a tagged template
  // (tx`…`, sql`…`, db()`…`) or .unsafe() is refused. The few statements built at run time that stay
  // beside their builders carry an eslint-disable-line comment saying so.
  {
    files: ["packages/server/src/**/*.ts"],
    ignores: ["packages/server/src/**/queries.ts", "packages/server/src/**/queries/**"],
    rules: {
      "no-restricted-syntax": ["error",
        {
          selector: "TaggedTemplateExpression:not([tag.object.name='String'][tag.property.name='raw'])",
          message: "Put SQL in the directory's query module (queries.ts or queries/), not inline. See docs/decisions/0012-sql-in-query-modules.md",
        },
        {
          selector: "CallExpression[callee.property.name='unsafe']",
          message: "Put SQL in the directory's query module (queries.ts or queries/), not inline. See docs/decisions/0012-sql-in-query-modules.md",
        },
      ],
    },
  },
  // The web UI (packages/web): browser globals, the rules of hooks, and accessibility checks on JSX.
  {
    files: ["packages/web/src/**/*.{ts,tsx}", "packages/web/test/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      ...jsxA11y.flatConfigs.recommended.rules,
      // Labels are associated through ids from FormField, which the rule can't follow.
      "jsx-a11y/label-has-associated-control": "off",
      // Dialogs move focus to their first field on purpose.
      "jsx-a11y/no-autofocus": "off",
      // A scrollable region (role="region" with a name) must be focusable so the keyboard can scroll it (WCAG 2.1.1).
      "jsx-a11y/no-noninteractive-tabindex": ["error", { roles: ["tabpanel", "region"], tags: [] }],
    },
  },
);
