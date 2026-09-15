#!/bin/bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly ELARA_HOME="${ELARA_HOME:-$HOME/Library/Application Support/Elara}"
readonly MODEL="${ELARA_MODEL:-Qwen3.6-35B-A3B-4bit}"
readonly MODEL_PATH="${ELARA_MODEL_PATH:-}"
readonly NODE_VERSION="22.23.2"
readonly NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
readonly NODE_SHA256="61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"
readonly WHISPER_TAG="v1.9.4"
readonly WHISPER_MODEL_SHA256="1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
readonly CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

step() { printf '\n\033[1;35mElara:\033[0m %s\n' "$*"; }
fail() { printf '\nElara install failed: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "Missing $1. $2"; }

[[ "$(uname -s)" == "Darwin" ]] || fail "This installer supports macOS."
[[ "$(uname -m)" == "arm64" ]] || fail "This build requires an Apple silicon Mac."
need curl "Install the macOS command line tools."
need git "Run: xcode-select --install"
need cmake "Install CMake, for example with: brew install cmake"
need jq "Install the macOS command line tools."
need rsync "Install the macOS command line tools."
need shasum "Install the macOS command line tools."
xcrun --find clang >/dev/null 2>&1 || fail "Run: xcode-select --install"
[[ -x "$CHROME" ]] || fail "Install Google Chrome before running this installer."
[[ -f "$HOME/.omlx/settings.json" ]] || fail "Install and open oMLX once before running this installer."

step "Finding $MODEL"
source_model="$MODEL_PATH"
if [[ -z "$source_model" && -d "$HOME/.omlx/models/$MODEL" ]]; then
  source_model="$HOME/.omlx/models/$MODEL"
fi
if [[ -z "$source_model" && -d "$HOME/.lmstudio/models" ]]; then
  source_model="$(find "$HOME/.lmstudio/models" -type d -name "$MODEL" -print -quit 2>/dev/null || true)"
fi
[[ -n "$source_model" && -d "$source_model" ]] || fail "Model not found. Re-run with ELARA_MODEL and ELARA_MODEL_PATH pointing to an MLX model directory."
mkdir -p "$HOME/.omlx/models"
if [[ ! -e "$HOME/.omlx/models/$MODEL" ]]; then
  ln -s "$source_model" "$HOME/.omlx/models/$MODEL"
fi

step "Preparing the private application directory"
if [[ -f "$ELARA_HOME/assistant.py" ]]; then
  /usr/bin/python3 "$ELARA_HOME/assistant.py" stop >/dev/null 2>&1 || true
fi
mkdir -p "$ELARA_HOME" "$ELARA_HOME/config" "$ELARA_HOME/data" "$ELARA_HOME/logs" "$ELARA_HOME/models" "$ELARA_HOME/runtime" "$ELARA_HOME/workspaces/default" "$ELARA_HOME/agent"
rsync -a --delete --exclude='.git/' --exclude='node_modules/' --exclude='test-results/' --exclude='playwright-report/' "$SCRIPT_DIR/" "$ELARA_HOME/app/"

step "Installing isolated Node.js $NODE_VERSION"
node_dir="$ELARA_HOME/runtime/node-v${NODE_VERSION}-darwin-arm64"
if [[ ! -x "$node_dir/bin/node" ]]; then
  download="$(mktemp -d)/$NODE_ARCHIVE"
  curl -fL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" -o "$download"
  printf '%s  %s\n' "$NODE_SHA256" "$download" | shasum -a 256 -c -
  tar -xzf "$download" -C "$ELARA_HOME/runtime"
fi
ln -sfn "$node_dir" "$ELARA_HOME/runtime/node"
export PATH="$ELARA_HOME/runtime/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

step "Building Elara"
cd "$ELARA_HOME/app"
npm ci
npm run build

step "Installing the local browser tools"
mkdir -p "$ELARA_HOME/runtime/browser-tools"
rsync -a --delete "$SCRIPT_DIR/deploy/macos/browser-tools/" "$ELARA_HOME/runtime/browser-tools/"
cd "$ELARA_HOME/runtime/browser-tools"
npm ci --omit=dev

step "Installing high quality Kokoro speech"
mkdir -p "$ELARA_HOME/runtime/kokoro"
rsync -a --delete "$SCRIPT_DIR/deploy/macos/kokoro/" "$ELARA_HOME/runtime/kokoro/"
cd "$ELARA_HOME/runtime/kokoro"
npm ci --omit=dev
node cache-model.mjs "$ELARA_HOME/models/kokoro-cache"

step "Building Whisper speech recognition"
if [[ ! -x "$ELARA_HOME/runtime/whisper-server" ]]; then
  whisper_source="$(mktemp -d)/whisper.cpp"
  git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git "$whisper_source"
  cmake -S "$whisper_source" -B "$whisper_source/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DGGML_METAL=ON \
    -DGGML_METAL_EMBED_LIBRARY=ON \
    -DBUILD_SHARED_LIBS=OFF
  cmake --build "$whisper_source/build" --config Release --target whisper-server -j "$(sysctl -n hw.logicalcpu)"
  install -m 755 "$whisper_source/build/bin/whisper-server" "$ELARA_HOME/runtime/whisper-server"
fi
if [[ ! -f "$ELARA_HOME/models/ggml-small.bin" ]]; then
  curl -fL --retry 3 https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin -o "$ELARA_HOME/models/ggml-small.bin"
fi
printf '%s  %s\n' "$WHISPER_MODEL_SHA256" "$ELARA_HOME/models/ggml-small.bin" | shasum -a 256 -c -

step "Configuring the local agent"
mkdir -p "$ELARA_HOME/agent/npm"
rsync -a --delete "$SCRIPT_DIR/deploy/macos/agent-npm/" "$ELARA_HOME/agent/npm/"
cd "$ELARA_HOME/agent/npm"
npm ci --omit=dev
jq -n --arg model "$MODEL" '{defaultProvider:"omlx",defaultModel:$model,defaultThinkingLevel:"off",compaction:{enabled:true,reserveTokens:8192,keepRecentTokens:8000},packages:["npm:pi-mcp-adapter"]}' > "$ELARA_HOME/agent/settings.json"
jq -n --arg model "$MODEL" '{providers:{omlx:{baseUrl:"http://127.0.0.1:8000/v1",api:"openai-completions",apiKey:"$OMLX_API_KEY",compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false,maxTokensField:"max_tokens",thinkingFormat:"qwen-chat-template"},models:[{id:$model,name:($model+" · local voice"),reasoning:true,input:["text","image"],contextWindow:32768,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}' > "$ELARA_HOME/agent/models.json"
jq -n --arg node "$ELARA_HOME/runtime/node/bin/node" --arg cli "$ELARA_HOME/runtime/browser-tools/node_modules/@playwright/mcp/cli.js" '{mcpServers:{browser:{command:$node,args:[$cli,"--cdp-endpoint","http://127.0.0.1:9222","--snapshot-mode","none"],lifecycle:"lazy",directTools:["browser_navigate","browser_navigate_back","browser_snapshot","browser_find","browser_click","browser_type","browser_fill_form","browser_select_option","browser_press_key","browser_wait_for","browser_take_screenshot"],excludeTools:["browser_run_code_unsafe"]}}}' > "$ELARA_HOME/agent/mcp.json"

step "Creating Elara's local configuration"
if [[ ! -f "$ELARA_HOME/config/secrets.json" ]]; then
  jq -n --arg password "$(openssl rand -hex 8)" --arg secret "$(openssl rand -hex 32)" '{portal_password:$password,portal_secret:$secret}' > "$ELARA_HOME/config/secrets.json"
  chmod 600 "$ELARA_HOME/config/secrets.json"
fi
if [[ ! -f "$ELARA_HOME/config/assistant.json" ]]; then
  jq -n --arg model "$MODEL" '{model:$model,context_length:32768,speech_instruction:"A warm, natural English voice with clear articulation, relaxed conversational pacing, gentle expression, and smooth sentence endings. Speak with quiet confidence, without sounding theatrical or hurried.",cfg_scale:4,provider:"omlx",speech_runtime:"kokoro",kokoro_voice:"af_heart"}' > "$ELARA_HOME/config/assistant.json"
else
  tmp_config="$(mktemp)"
  jq --arg model "$MODEL" '.model=$model | .provider="omlx" | .speech_runtime="kokoro" | .kokoro_voice=(.kokoro_voice // "af_heart")' "$ELARA_HOME/config/assistant.json" > "$tmp_config"
  mv "$tmp_config" "$ELARA_HOME/config/assistant.json"
fi
install -m 755 "$SCRIPT_DIR/deploy/macos/assistant.py" "$ELARA_HOME/assistant.py"
mkdir -p "$HOME/.local/bin"
install -m 755 "$SCRIPT_DIR/deploy/macos/elara" "$HOME/.local/bin/elara"

step "Starting Elara and creating its chat"
/usr/bin/python3 "$ELARA_HOME/assistant.py" start
if [[ "$(jq -r '.session_id // empty' "$ELARA_HOME/config/assistant.json")" == "" ]]; then
  cookie="$(mktemp)"
  password="$(jq -r '.portal_password' "$ELARA_HOME/config/secrets.json")"
  curl -fsS -c "$cookie" -H 'Content-Type: application/json' -d "$(jq -n --arg password "$password" '{password:$password}')" http://127.0.0.1:4100/api/auth/login >/dev/null
  session="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' -d "$(jq -n --arg title 'Elara' --arg workspace "$ELARA_HOME/workspaces/default" '{title:$title,workspace:$workspace}')" http://127.0.0.1:4100/api/sessions | jq -r '.id')"
  [[ -n "$session" && "$session" != "null" ]] || fail "Elara started, but its first chat could not be created."
  tmp_config="$(mktemp)"
  jq --arg id "$session" '.session_id=$id' "$ELARA_HOME/config/assistant.json" > "$tmp_config"
  mv "$tmp_config" "$ELARA_HOME/config/assistant.json"
fi

printf '\nElara is installed. Run:\n\n  elara\n\n'
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  printf 'Add this line to ~/.zprofile, then open a new terminal:\n\n  export PATH="$HOME/.local/bin:$PATH"\n\n'
fi
printf 'The first launch copies the private login password to your clipboard.\n'
