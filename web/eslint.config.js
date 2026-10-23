import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "public/**", "playwright-report/**", "test-results/**", "ios/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      // Leading underscores mark values that are unused on purpose, as with tsc's noUnusedParameters.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "react-hooks/exhaustive-deps": "error",
      // These four only matter to the React Compiler, which this app does not use: refs read in
      // render, Date.now() in render, setState in effects and mutated values are all intended here.
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["scripts/**/*.mjs", "bench/**/*.mjs", "e2e/**/*.ts", "*.config.ts", "*.config.js"],
    languageOptions: { globals: globals.node },
  },
);
