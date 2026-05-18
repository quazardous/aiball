// Frontend ESLint (#B.200). Minimal scope — only what david asked
// for: catch unused imports + unused locals across .ts/.vue files.
// vue-tsc with noUnusedLocals already gates the build; this surfaces
// the same issues live in editor + offers `--fix` for bulk cleanup.
//
// vue's `flat/recommended` preset is intentionally NOT included —
// it flags formatting/style preferences (attribute case, multi-space,
// v-html XSS warnings) that aren't the stated objective. Add it
// later via a follow-up ticket if the team wants the broader rules.
import vueParser from "vue-eslint-parser";
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**", "scripts/**"],
    },
    {
        files: ["**/*.ts", "**/*.vue"],
        languageOptions: {
            parser: vueParser,
            parserOptions: {
                parser: tseslint.parser,
                ecmaVersion: "latest",
                sourceType: "module",
                extraFileExtensions: [".vue"],
            },
        },
        plugins: { "unused-imports": unusedImports },
        rules: {
            "unused-imports/no-unused-imports": "error",
            "unused-imports/no-unused-vars": [
                "warn",
                { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
        },
    },
);
