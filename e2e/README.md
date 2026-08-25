# End-to-end install

Every layer of the substrate was verified on its own; nothing had booted whole.
This installs N corpus packages onto a real shipped profile and boots it twice.

```bash
node e2e/run.mjs 400      # ~40s
node e2e/run.mjs 2768     # the whole tool-registering corpus, ~3.5 min
```

## What is real and what is not

**Real**: the profile (`examples/headless-agent/cordis.yml`, 25 shipped rows), the
loader, the `ToolRuntime`, the `isolate` interception, the scopes, and the tool
names — every name comes from a corpus package's actual registrations.

**Not real**: the plugin bodies. Each generated module registers its package's
real tool names and nothing else. A plugin's business logic cannot make a
registry throw; its registration set can, and that is what the corpus records.

Two consequences. Registrations the scanner could not resolve statically are
absent, so this exercises no more contention than the published data claims. And
a pass means *the composition mounts*, never *these plugins work*.

## Files

| | |
|---|---|
| `generate.mjs` | corpus records to plugin modules plus a composed `cordis.yml` |
| `shipped-tools.mjs` | reads the profile's own tool names from a real boot |
| `compose.mjs` | runs the arbitration and emits `cordis.substrate.yml` |
| `boot-once.mjs` | boots one config and reports, unwrapping the loader aggregate |
| `run.mjs` | the A/B with assertions |

`shipped-tools.mjs` exists because guessing that list is a real failure mode: an
earlier hardcoded version missed `send_message`, and the full-corpus boot failed
on exactly that name.

### Why it takes a boot, and what that means for the substrate

Reading the shipped set from a boot is right for *this harness*, which composes
the file before anything runs. It is not what the substrate does in production,
and two alternatives were measured rather than assumed.

**A static catalog** is the designed answer, and one already exists —
`data/baseline.json` carries `tools: [{ name, package }]`, generated from the
harness checkout. Derived against this profile it gets 12 of the 15 right:
six missing, three spurious. Two distinct causes:

- a bundle row expands into packages the row list never names, so
  `@deepseek-ai/dsh-agent-spine-demo` silently brings `tool-bash`, `tool-jobs`,
  and `tool-skill` — deterministic, and fixable in the generator
- some tools register behind config (`read_image`, `list_agents`, `report`
  never appeared), which is undecidable in general, the same class as the 37%
  of routes whose path is not a literal

**Reading the live registry in-process** does not work at plugin-apply time. A
probe appended as the last row still sees zero tools when it applies: Cordis
orders activation by service availability, so a plugin injecting `tools`
activates as soon as `agent-spine` provides the service, which is before the
tool packages have registered into it. After boot completes the same read
returns all 15.

That splits the two substrate modes rather than blocking either. Preset-host
acts at agent setup, after boot, where the registry is already complete and no
catalog is needed. Gatekeeper has to answer before boot by construction, so it
depends on the catalog — and the catalog needs the bundle fix plus a
"may register more" state for config-gated tools, so an unknown stays unknown
instead of being read as a free name.

## Result, full corpus

```
2,768 packages · 11,911 tool registrations · 536 contended names

  without the substrate   654 registration failures, boot fails
  with the substrate      boots · 4,090 entries · 5,806 global tools
                          0 duplicate names · 648 scopes · 5,143 scope-only tools
```

A successful boot is not the claim on its own — an empty registry boots too. The
run reads every scope the substrate minted and counts the tools reachable only
through it, so "no collision" cannot be satisfied by having dropped them.
