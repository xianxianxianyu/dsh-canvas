#!/bin/sh
# Boot an isolated DSH web profile (`canvas-dev`) on http://127.0.0.1:3996 with this plugin
# linked in. The first run creates the profile from DSH's web template, links the plugin, and
# routes the default model through the signed-in DeepSeek account. Later runs reuse the profile.
# PORT=… picks another port.
# Additional CLI arguments (for example --patch /tmp/dev.patch.yml) are passed through.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
profile=canvas-dev
runtime="/Applications/DeepSeek Harness.app/Contents/Resources/runtime"
# Only cli/bin: runtime/bin/node is an Electron wrapper that needs DSH_DESKTOP_NODE_EXECUTABLE and
# breaks `node` inside the agent's bash when inherited from this shell.
export PATH="$runtime/cli/bin:$PATH"

# Match DSH's home resolver: blank overrides fall back; tilde and relative paths expand.
profile_dir=$(node --input-type=module - "$profile" <<'JS'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
const configured = process.env.DSH_HOME
const home = configured?.trim() ? configured : join(homedir(), '.dsh')
const expanded = home === '~' ? homedir() : /^~[/\\]/.test(home) ? join(homedir(), home.slice(2)) : home
console.log(join(resolve(expanded), 'profiles', process.argv[2]))
JS
)

if [ ! -d "$profile_dir" ]; then
  dsh --profile "$profile" --from-default-profile web --dump-config >/dev/null
  # The template patch is an empty `[]` list; replace it rather than appending after it.
  cat >"$profile_dir/cordis.patch.yml" <<'YAML'
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high
YAML
fi
if ! grep -q '"dsh-canvas"' "$profile_dir/package.json"; then
  dsh plugin --profile "$profile" add "link:$root"
fi
exec dsh --profile "$profile" "$@" --no-open --port "${PORT:-3996}"
