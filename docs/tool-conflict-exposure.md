# Duplicate tool exposure modes

Status: implemented runtime policy; exact-version boot integration is deferred to the next DSH adaptation round.

This review was refreshed on 2026-09-10 against official `deepseek-ai/deepseek-harness` HEAD `aa8262ec091698bae9a6b04773a6b5b06ad4aef2`.

## Current DSH seams

- `ToolRuntime.register()` rejects duplicate names within one layer and reserves `run_code`.
- `ToolRuntime.schemas(scope)` returns every tool visible to that scope. It has no deferred reference or discovery token.
- Presentation mode is `native`, `ptc`, or `both`. `ptc` exposes `run_code` plus a generated SDK for the complete visible set; it does not search for hidden definitions.
- `tools.restrict()` can mask global tools for one agent, but a masked tool has no later search-and-materialize path.
- The repository has no `tool_search` registry or dispatcher. `deferredToolsMode` appears only in the pi-ai compatibility catalog with disposition `withhold`.
- The `tool-web` documentation's “search-only” phrase means enabling `web_search` while disabling `web_fetch`; it is unrelated to tool discovery.

## Product choices

| Choice | Availability | Behavior |
|---|---|---|
| Default injection | Enabled | First registration keeps the original name; later duplicates receive a deterministic npm/plugin prefix and remain globally visible. |
| Search only | Unavailable | Requires a registry that can return hidden schemas by query and a dispatcher that accepts stable tool references. |
| Collapsed search | Unavailable | Requires the same discovery contract plus a compact model transport. Current PTC mode collapses execution syntax, not discovery. |

The settings card lists all three so the product decision remains visible. Unavailable choices are disabled and state the missing DSH seam. This release does not monkeypatch web search or reinterpret PTC mode.

## Activation boundary

The package includes a small dependency-free bootstrap row before its reporter row. It patches a discovered `ToolRuntime` prototype before construction when the Loader publishes that fiber, and falls back to patching an already available tools service. A duplicate rejected before this bootstrap activates cannot be recovered by an ordinary plugin because root Loader siblings start concurrently and roll back failed activation.

The next exact-version adaptation should move the same hook into the audited boot boundary before the root include starts. Until that work is tested per published DSH version, the runtime mechanism is verified but early activation is not claimed as unconditional.
