# @anweat/dsh-substrate

`dsh-substrate` diagnoses DeepSeek Harness plugin conflicts, prefixes duplicate runtime tool names, and supplies a reversible, version-locked repair for duplicate loader entry IDs.

The Web card is read-only. It reports the detected DSH installation, the exact loader version, and the repair state. The external CLI performs installation changes so the running DSH process never rewrites its own dependencies.

## Install in DSH

```powershell
dsh plugin --profile web add @anweat/dsh-substrate@^0.1.3
```

Restart DSH after installing the plugin. Open the Substrate compatibility card to inspect the current state.

## Repair duplicate entry IDs

Check whether the detected installation is supported:

```powershell
npx --yes @anweat/dsh-substrate@0.1.3 repair --home "<DSH_HOME>"
```

Apply the repair, then restart DSH:

```powershell
npx --yes @anweat/dsh-substrate@0.1.3 repair --home "<DSH_HOME>" --apply --yes
```

Revert the repair, then restart DSH again:

```powershell
npx --yes @anweat/dsh-substrate@0.1.3 repair --home "<DSH_HOME>" --revert --yes
```

The repair currently supports these exact packages:

- `@deepseek-ai/cordis-plugin-include@1.0.6`
- `@deepseek-ai/cordis-plugin-include@1.0.7`
- `@deepseek-ai/dsh-app-boot@0.1.2-alpha.2` through `0.1.2-alpha.5`
- `@deepseek-ai/dsh-app-boot@0.1.2-rc.1`
- `@deepseek-ai/dsh-app-boot@0.1.3-alpha.2`
- `@deepseek-ai/dsh-app-boot@0.1.5-alpha.1`

The Git tag `dsh-v0.1.3-alpha.1` has source-level evidence, but npm never
published the matching `dsh-app-boot` package. It therefore remains outside
the installable repair matrix.

Unknown versions are refused before any file is changed. The CLI stages a pnpm patch in the real DSH installation workspace, runs `pnpm install`, verifies the installed file, and supports a matching revert transaction.

The runtime plugin keeps the first tool registration under its original name and exposes later duplicates with a deterministic npm/plugin prefix, for example `anweat_dsh_browser__browser_click`. The card lists every active alias. The default-injection mode is enabled; search-only and collapsed-search are shown as unavailable because the audited DSH runtime has no tool-search registry or tool-reference dispatcher. The small bootstrap row improves activation order, but an ordinary plugin cannot recover a conflict rejected before that row activates; exact-version boot integration is deferred to the next DSH adaptation round. Service-name conflicts still require host composition with service realms.

Version `0.1.0` users must add npm's peer-dependency compatibility flag when running the standalone CLI:

```powershell
npx --yes --legacy-peer-deps @anweat/dsh-substrate@0.1.0 repair --home "<DSH_HOME>"
```

See the [compatibility matrix](https://github.com/anweat/dsh-substrate/blob/master/docs/pnpm-plugin-compatibility.md), [browser coexistence verification](https://github.com/anweat/dsh-substrate/blob/master/docs/browser-issue11-verification.md), and [tested boundaries](https://github.com/anweat/dsh-substrate/blob/master/plugin/TESTED.md).
