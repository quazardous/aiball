// Daemon-side ESLint (#B.200). Minimal scope: catch unused imports
// (auto-fixable) and unused locals. tsc with noUnusedLocals already
// guards the build — this surfaces the same issues faster in editor
// + offers `--fix` to remove dead imports in bulk.
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**", "frontend/**", "drizzle/**"],
    },
    ...tseslint.configs.recommended,
    {
        plugins: { "unused-imports": unusedImports },
        rules: {
            "@typescript-eslint/no-unused-vars": "off",
            "unused-imports/no-unused-imports": "error",
            "unused-imports/no-unused-vars": [
                "warn",
                { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            // The daemon does plenty of typed-but-untyped boundary work
            // (sqlite rows, parseMeta JSON, etc.); recommended rules that
            // double up with tsc's strict checks would just create noise.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-empty-object-type": "off",
        },
    },
);
