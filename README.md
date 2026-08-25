# dsh-substrate

A conflict-resolution substrate for the DeepSeek Harness plugin ecosystem, and the measurements it is built on.

The ecosystem has a structural problem: **9,216 root inserts and 0 group inserts** across 9,873 scanned plugins, while the shipped design keeps the global layer empty. Every plugin author sees only their own row, so every plugin inserts into the one layer it can see, and they land on top of each other. Installing all of them makes **581 registry cells throw**, and any one of those is a boot failure.

The substrate adds the missing stage: a pass with a global view, between composition and boot.

```
  arbitrate ── decide who holds each contended seat
  adapt ───── emit the patch layer, plan the scope chain, rewrite routes
  contract ── publish what plugin authors cannot currently discover
```

## Result

```
all plugins installed together   581 cells throw, 896 packages involved (10.5%)
after arbitration                90.6% coexist
+ one upstream field             100.0% coexist

booted for real, 2,768 packages · 11,911 tool registrations
  without the substrate          654 registration failures, boot fails
  with the substrate             boots · 0 duplicate names · 648 scopes
```

## Layout

| | |
|---|---|
| `substrate/` | the substrate itself — arbitration, adapters, contracts (251 assertions) |
| `pipeline/` | the ecosystem scanner and the baseline catalog generator |
| `experiments/` | mechanism experiments against a real harness checkout (160 assertions) |
| `e2e/` | the whole thing booted: corpus packages on a real shipped profile |
| `docs/` | design notes and Discussion drafts |

```bash
npm install
npm test                              # substrate suite, no checkout needed
npm run baseline -- <dsh-checkout>    # regenerate the known-component catalog
```

`experiments/` and `e2e/` need a harness checkout; see [`experiments/EXPERIMENTS.md`](experiments/EXPERIMENTS.md).

## The four layers

**L1 — vocabulary.** Ten contribution kinds split into `exclusive` and `additive`. A conflict is only counted where the runtime makes it one: a `single`/`keyed` seat, a registry that throws, a config row two layers both rewrite. `list`/`chain` seats are additive by construction and are counted, never flagged.

**L2 — arbitration.** A pure function from contributions to decisions, with five remedies. All 581 tool-name conflicts resolve to `layer`; **not one requires renaming something a model can see.**

**L3 — adaptation.** Patch emission, scope-chain planning, route realm proxying, preset emission, and the boot-time tools shim that puts a config-mounted plugin into a scope.

**L4 — contracts.** The design-token vocabulary and the panel scaffold: the two things plugin authors cannot discover today.

## What is upstream's to fix

Four requests, two with working prototypes.

| | |
|---|---|
| `BootPluginRow.priority` | **37-line prototype.** Degraded 804 → 1 (9.4% of the corpus); coexistence 90.6% → 100.0% |
| a token export surface | **contract implemented.** Its first run found 10 real defects in the shipped client |
| `ui-theme` as a platform seed word | argued, not built |
| forward roster changes to the dev channel | located to two lines; deliberately not prototyped, because acting on the frame needs browser-side reconciliation and half a fix is not one |

## Honesty about the evidence

- The e2e plugin bodies are synthetic; their registrations are not. A plugin's business logic cannot make a registry throw, its registration set can, and that is what the corpus records. A pass means *the composition mounts*, never *these plugins work*.
- 37% of route registrations pass a non-literal path and are statically undecidable. Route findings are a sample of 503 repositories, not the full corpus.
- The shipped-tool catalog **over-derives on purpose**. A tool registered behind config is not statically decidable, and the two errors are not symmetric: a name wrongly believed taken costs one plugin a scope, a name wrongly believed free costs the composition its boot.
- Being named in the data is not a judgement about a plugin. The dominant cause is structural, and most of these packages work fine alone.

Published measurements and the arbitration replay: https://github.com/anweat/dsh-ecosystem-conflicts
