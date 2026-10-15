// Root-level shim so this directory works as a discovery-style plugin package
// (see PLAN.md §7 fallback ladder, rung 3). The real implementation lives in src/.
export { default } from "./src/index"
