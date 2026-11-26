# Task progress — a Mandara Shell plugin

A resident bar item with just the animated running light by default: an
eight-cell Knight-Rider scanner with a fading trail, matching OpenCode's
"blocks" spinner. The meter and the numeric percentage are
optional bar settings, off by default because they duplicate each other and
are already in the panel. The panel shows the task name, elapsed time, step,
a meter and a larger chase strip. Statuses follow an OpenCode-like scheme:
**running = blue**, **need confirm = yellow**, **finished = green**, **failed =
red**.

```
running:     ▬ · · · ·      42%   (animates)
need confirm: ● ● ● ● ●      waiting on an answer
finished:     ● ● ● ● ●      100%  (all green)
```

Third-party Mandara plugins cannot set raw hex colors: nodes only accept
semantic tones. The plugin maps running → accent, need confirm → warning,
finished → success, failed → error. When a theme's accent is too close to its
warning color (both gold in Mandara Obsidian), running falls back to the
neutral tone so the states stay distinguishable. The panel's **Show details**
button includes a color key.

To get OpenCode's exact colors, copy its palette into a Mandara user theme:
`~/.config/mandara/themes/opencode.toml` (included here and installed on this
machine). Its running blue `#5c9cf5` is the primary seed, warning is amber
`#f5a742`, success is green `#7fd88f`, error is red `#e06c75`:

```sh
mandara msg config set /theme/source '{"kind":"preset","preset":"opencode"}'
# revert:
mandara msg config set /theme/source '{"kind":"preset","preset":"mandara-obsidian"}'
```

This changes the whole shell theme, not just the plugin — that is the only way
a sandboxed plugin can render exact hex colors, because tones come from the
active palette.

## Bar item or toast?

Resident bar item wins for progress: it is glanceable at any moment, while a
toast is gone in seconds. So the progress lives in the bar, the detail lives
in the panel, and a toast is used **only once**, when a running task finishes
(needs the `notifications.send` capability granted in Studio).

## How the companion CLI works

A Mandara plugin is a sandboxed WebAssembly component: it has no filesystem,
network, environment or subprocess access. It cannot watch a log file or run
your build, so progress has to be pushed in through a host API. Settings are
that API:

```
task-progress set 42
  │
  └─ mandara msg config set /plugins/settings/task-progress/percent 42
       │
       ├─ IPC to the running shell → ~/.config/mandara/config.toml
       │                              [plugins.settings.task-progress]
       │                              percent = 42
       │
       └─ plugin's next render → host::setting("percent") == "42"
```

`task-progress` is a thin Bash wrapper around `mandara msg config set`; `jq`
quotes strings correctly. This is the same path Studio uses, so values show up
in the plugin's settings page too. The plugin asks for `refresh-ms = 250`
(the host minimum) while it is drawn: that both picks up new values promptly
and steps the chase light once per 250 ms. When the state changes from
`running` to `done`, it submits one `notifications.send` broker request.

## Live sync with OpenCode (current setup)

Mandara 0.38 ships a built-in `progress` plugin with a 33 ms animated bar chip
(a smooth spinner/shimmer) and `progress start/set/done/fail` commands. It is
enabled and on the bar; this project's Wasm plugin is installed but switched
off. That is the recommended setup — no shell patch, no 250 ms third-party
refresh ceiling.

`opencode-bridge/task-progress-bridge.ts` (installed at
`~/.config/opencode/plugins/task-progress-bridge.ts`) watches OpenCode's event
stream and drives that built-in task:

| OpenCode event | Built-in command |
|---|---|
| `session.execution.started` | `progress start opencode OpenCode` |
| `permission.asked` / `form.created` | `progress start opencode "Needs confirmation"` |
| answer / rejection | `progress start opencode OpenCode` |
| `session.execution.succeeded` | `progress done opencode` |
| `session.execution.failed` / `interrupted` / `session.tool.failed` | `progress fail opencode` |

It follows one active session and skips duplicate commands. Set `MANDARA_BIN`
to point at a different shell binary if needed. The CLI in this folder is kept
for the standalone Wasm plugin if you switch it back on.

## Commands

```sh
task-progress start "Build firmware" 1/4   # 0%, running
task-progress set 42                        # 42%
task-progress step 3/4                      # change the step label
task-progress ask "Approve the build?"      # yellow, need confirm
task-progress set 100                       # back to running at 100%
task-progress done                          # all green, finished, one toast
task-progress fail                          # red, failed
task-progress reset                         # idle / clear
task-progress status                        # print the stored values
```

Use it from any script,CI job or agent:

```sh
task-progress start "Installing packages"
for i in $(seq 1 10); do
  sudo pacman -S --noconfirm "$pkg" >/dev/null
  task-progress set $((i * 10))
done
task-progress done
```

## Install

```sh
./install.sh                 # builds and copies into plugins-dev (hot reload)
mandara msg plugins enable task-progress
cp task-progress ~/.local/bin/   # puts the CLI on PATH as `task-progress`
```

To place it on the bar, add `task-progress` to a bar zone, e.g.:

```sh
mandara msg config set /bar/right '["weather","resources","clipboard","screenshot","tray","network","bluetooth","audio","notifications","power","task-progress"]'
```

Grant **Notifications → Send** on the plugin's page in Studio if you want the
completion toast. The bar, panel and sidebar work without it.

## Settings

Declared in `plugin.toml`, readable in Studio and writable by the CLI:

| key | type | meaning |
|---|---|---|
| `label` | text | task name |
| `state` | choice | `idle`, `running`, `question`, `done`, `error` |
| `percent` | number | 0–100 |
| `step` | text | step label or the question being asked |
| `started` | number | Unix ms, used for "Elapsed" |
| `animate` | bool | chase animation; off = static light and no redraw timer (default on, reload after changing) |
| `show_percent` | bool | percentage in the bar (default off) |
| `show_bar_meter` | bool | small meter in the bar (default off) |
| `notify_done` | bool | toast on completion |

`MANDARA_BIN=/path/to/mandara` selects a different shell binary; useful with
`cargo xtask sandbox` for isolated testing.

## Verification

- `cargo build --release --target wasm32-wasip2` — clean.
- `cargo clippy --release --target wasm32-wasip2 -- -D warnings` — clean.
- `mandara msg plugins vet <dir>` — `ok` (it instantiates the component and
  renders the bar, panel and sidebar).
- `plugin.wasm` is 126 KiB (release, `opt-level = "s"`, LTO, stripped).

The bar item was screenshot-checked in all three states (running, need
confirm, finished); the fix for the host's full-width `meter` came from that
pass. Light/dark and Arabic passes still need a look in the demo sandbox.

## Resident idle chip (local Mandara patch)

The stock built-in `progress` plugin hides its chip when there is no task. A
small patch in the local Mandara fork (`feat/task-progress-animated`, branched
from upstream `origin/main` v0.38.7) changes `Show::Nothing` in
`crates/mandara-ui/src/plugins/progress.rs` to draw a quiet static ring at 45%
opacity instead of an empty view. The chip is then always present: still ring
when idle, animated spinner while OpenCode works, ✓ / ! briefly after
completion. Your codec-badge work stays on the original
`feat/bluez-codec-badge` branch; upstream main already contains an equivalent
fix, so the cherry-pick was skipped.

A second patch replaces the indeterminate spinner in the built-in chip with
the eight-cell OpenCode running light (bright head, 6-step fading trail,
bidirectional scan) drawn at the built-in 33 ms animation frame. The quiet
idle state is a dim version of the same eight cells. Removed the now-unused
`spinner()` helper and its constants.

Build output: `mandara-animated` in this folder (installed as
`~/.local/bin/mandara`; backup `mandara.bak-0.38.3`). Checks: `cargo check
-p mandara-ui`, `cargo test -p mandara-ui --test no_hardcoded`, and
`cargo clippy -p mandara-ui --all-targets -- -D warnings` all pass.
