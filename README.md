# OpenAI Speed

OpenCode sidebar plugin for OpenRouter's provider performance metrics.

It uses the supported endpoint:

```text
GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints
```

The sidebar is titled `OpenRouter speed` and displays the output throughput
number for each configured provider in aligned columns. The default percentile is `p50`, meaning the median value
among the measurements collected by OpenRouter during the rolling 30-minute
window. Provider labels and their values are colored; model names and other
text stay white.

The values are rolling 30-minute percentiles, not a live measurement. The
plugin reads `OPENROUTER_API_KEY` when present and otherwise reuses the
OpenRouter API key already stored by OpenCode in its auth file.

## Install from GitHub

The following commands install the plugin into OpenCode's user configuration
directory:

```sh
PLUGIN_DIR="$HOME/.config/opencode/plugins/openai-speed"
mkdir -p "$(dirname "$PLUGIN_DIR")"
git clone https://github.com/aMoonshine/openai-speed.git "$PLUGIN_DIR"
npm install --omit=dev --prefix "$PLUGIN_DIR"
```

Add the absolute value of `PLUGIN_DIR` to the `plugin` array in both files:

```text
~/.config/opencode/opencode.json
~/.config/opencode/tui.json
```

Example entry:

```json
"/home/YOUR_USER/.config/opencode/plugins/openai-speed"
```

The same package is intentionally listed in both files: `opencode.json` loads
the server entry point and `tui.json` loads the TUI sidebar entry point.

Copy the example speed configuration:

```sh
cp "$PLUGIN_DIR/config.example.json" "$HOME/.config/opencode/openrouter-speed.json"
```

Restart OpenCode after installation or configuration changes.

## OpenRouter API key

Do not put the key in this repository or in `openrouter-speed.json`. Configure
it in the shell that starts OpenCode:

```sh
export OPENROUTER_API_KEY="sk-or-v1-..."
opencode
```

For persistent setup, add the export to your private shell profile. You can
also run `opencode providers login`, choose OpenRouter, and paste the key in
OpenCode's credential dialog. The plugin automatically reuses credentials
stored by OpenCode when the environment variable is not set.

The plugin makes read-only OpenRouter endpoint requests for performance data;
it does not send prompts and does not spend model tokens.

## Configure the speed panel

Copy `config.example.json` to:

```text
~/.config/opencode/openrouter-speed.json
```

The default model list is ordered with Pro models first, then regular models:

- `openai/gpt-6-astra-pro`
- `openai/gpt-5.6-sol-pro`
- `openai/gpt-5.6-terra-pro`
- `openai/gpt-5.6-luna-pro`
- `openai/gpt-6-astra`
- `openai/gpt-5.6-sol`
- `openai/gpt-5.6-terra`
- `openai/gpt-5.6-luna`

Add or remove model IDs in `models` as needed. Provider `tag` must match
OpenRouter's endpoint tag, such as `openai` or `openai/fast`. `percentile` can
be `p50`, `p75`, `p90`, or `p99`; the default is `p50`. The panel refreshes
every ten minutes by default. Set `pollMs` to change it. The footer shows the
last refresh as `upd HH:MM:SS`.

The active OpenRouter model in the current OpenCode session is also included
automatically, even if it is not in the file.

Use `/openai-speed` to force a refresh. Restart OpenCode after changing
the config file or plugin registration.

## OpenCode plugin registration

This is one plugin package with two OpenCode entry points, following the same
pattern as the Codex quota plugin:

- `~/.config/opencode/opencode.json` loads the package server entry point;
- `~/.config/opencode/tui.json` loads the package `./tui` entry point that
  renders the sidebar.

The TUI entry point is the plugin's terminal interface, not a separate
implementation or a replacement for plugin registration.
