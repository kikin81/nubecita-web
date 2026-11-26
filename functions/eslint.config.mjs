import tseslint from "typescript-eslint";

export default tseslint.config(
  {ignores: ["lib/**", "node_modules/**", "coverage/**"]},
  ...tseslint.configs.strict,
  {
    rules: {
      // A logged secret cannot be unlogged. All output goes through src/log.ts,
      // which only accepts an allow-listed set of fields.
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": ["error", {argsIgnorePattern: "^_"}],
    },
  },
);
