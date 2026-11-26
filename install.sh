#!/usr/bin/env bash
# Build and hot-install the plugin into Mandara's development folder.
set -euo pipefail
cd "$(dirname "$0")"

dest="${MANDARA_PLUGIN_DIR:-$HOME/.local/share/mandara/plugins-dev/task-progress}"
cargo build --release --target wasm32-wasip2
mkdir -p "$dest/locales"
cp plugin.toml "$dest/plugin.toml"
cp target/wasm32-wasip2/release/task_progress.wasm "$dest/plugin.wasm"
cp locales/*.toml "$dest/locales/"
mkdir -p "$HOME/.local/bin"
cp task-progress "$HOME/.local/bin/task-progress"
chmod +x "$HOME/.local/bin/task-progress"
mandara msg plugins vet "$dest"
printf 'Installed to %s (Mandara hot-reloads it).\n' "$dest"
