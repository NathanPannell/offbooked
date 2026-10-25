import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config({ ignores: ["bench/fixtures/**", "bench/results/**"] }, js.configs.recommended, tseslint.configs.recommended, {
  files: ["**/*.ts", "**/*.js", "**/*.mjs"],
  languageOptions: { globals: globals.node },
  rules: {
    // server.ts reads `app` from log closures that can run before it is assigned.
    "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
  },
});
