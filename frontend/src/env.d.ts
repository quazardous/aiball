/// <reference types="vite/client" />

// Injected at build time by vite.config.ts `define` — the aiball version
// read from the repo-root package.json (single source of truth, qcmp-tracked).
declare const __AIBALL_VERSION__: string;
