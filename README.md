# Task progress — a Mandara Shell plugin

Repository: https://github.com/tekwiz99/mandara-task-progress (`mandara-plugin` topic).

The live desktop uses Mandara's **built-in `progress` plugin** with a small
local patch (PR [#252](https://github.com/theHamdiz/mandara/pull/252)) and the
OpenCode bridge in `opencode-bridge/`. The Wasm plugin in this repo is the
original standalone version, kept for reference and manual tasks.

## The indicator

The bar chip uses one visual language:

| State | Bar |
|---|---|
| idle | quiet dim row of eight cells (upstream v0.40: only with `show_when_idle` on; the local `feat/task-progress-animated` branch keeps it always resident) |
| running | soft breathing brightness ripple, cells stay in place |
| done | solid green cells for 30 s |
| failed | solid red cells for 30 s |

Cell size, spacing, breath period, ripple spread and the three brightness
levels are bounded settings in **Studio → Plugins → Task progress**. The eight
cell count is fixed: the bar chip is laid out for eight and it is part of the
indicator's identity.

Colors come from the active Mandara theme. `opencode.toml` in this folder is a
user theme with OpenCode's palette (running blue `#5c9cf5`, warning amber
`#f5a742`, success green `#7fd88f`):

```sh
cp opencode.toml ~/.config/mandara/themes/opencode.toml
mandara msg config set /theme/source '{"kind":"preset","preset":"opencode"}'
# revert: mandara msg config set /theme/source '{"kind":"preset","preset":"mandara-obsidian"}'
```

## Open to any task, not just agents

`progress` is a shared board: any script, build, shell job or agent can report
to it. `task-progress` is a thin wrapper over `mandara msg progress ...`;
`task-run` wraps an arbitrary command so it reports automatically.

```sh
task-progress -i build start "Compiling"
task-progress -i build set 40 "Compiling: 2/5"
task-progress -i build step "3/5"          # change label, keep percent
task-progress -i build done "All green"
task-progress -i build fail "Tests failed"
task-progress -i build reset               # remove from the bar
task-progress list                         # all tasks as JSON

task-run -i verify "Running tests" -- cargo test --workspace
```

The default id is `task`; use `-i ID` or `TASK_ID=ID` for concurrent tasks.
`MANDARA_BIN` points at another shell binary (e.g. a sandbox build).

## Live sync with OpenCode

`opencode-bridge/task-progress-bridge.ts` (installed at
`~/.config/opencode/plugins/task-progress-bridge.ts`) watches OpenCode's event
stream and drives the built-in task `opencode`:

| OpenCode event | Command |
|---|---|
| `session.execution.started` | `progress start opencode OpenCode` |
| `permission.asked` / `form.created` | label `Needs confirmation` |
| answer / rejection | label `OpenCode` |
| `session.execution.succeeded` | `progress done opencode` |
| failed / interrupted / tool failed | `progress fail opencode` |

It follows one session at a time and skips duplicate commands. It is only one
producer — CLI-reported tasks appear beside it.

## Standalone Wasm plugin (reference)

`src/`, `wit/`, `plugin.toml` are the original third-party plugin, kept for
reference. A sandboxed Wasm plugin has no filesystem, network or subprocess
access, so it reads progress from its own settings via `host::setting()` and
needs a companion script to write them:

```
script → mandara msg config set /plugins/settings/task-progress/percent 42
       → plugin render → host::setting("percent") == "42"
```

The shipped `task-progress` CLI does **not** use this plugin: it drives
Mandara's built-in `progress` plugin with `mandara msg progress …`.

Third-party `refresh-ms` is clamped to 33 ms at full motion (250 ms with
reduce motion on), but the animated light lives in the built-in plugin so it
can use that frame without a Wasm boundary on every render.

## Mandara patch

PR #252 was merged and shipped in upstream v0.40.0. The local
`feat/task-progress-animated` branch adds one further tweak on top: the idle
row stays resident instead of being gated behind `show_when_idle`. Checks:
`cargo check`, `clippy -D warnings`, `cargo test -p mandara-i18n`,
`no_hardcoded`, and a release build. Maintenance work happens on the local
`perf/progress-hot-path` branch, based on the v0.40.0 tag.

## Install

```sh
./install.sh                 # builds and copies the Wasm plugin into plugins-dev
cp task-progress task-run ~/.local/bin/
```
