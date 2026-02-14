# Cursor-To-OpenAI → OpenClaw Setup Guide

> **Personal use only.** Uses a [patched fork](https://github.com/pwnapplehat/cursor-proxy-patched) of Cursor-To-OpenAI to power an OpenClaw agent with your Cursor account's AI models.
>
> **Warning:** This operates against Cursor's Terms of Service. Your account could be banned.

---

## Architecture

```
Cursor Account (cookie auth)
  → Cursor-To-OpenAI Proxy (Docker, localhost:3010 on droplet)
    → OpenClaw Agent (Docker, port 18789 on droplet)
      → Telegram / WebChat / Discord
```

The proxy translates between Cursor's protobuf API and OpenAI's chat completions format. It also:

- Maps Cursor's native tools (`run_terminal_cmd`, `read_file`, etc.) to OpenClaw tools (`exec`, `read`, etc.)
- Intercepts `exec __oc <tool> <json>` calls and converts them to real OpenClaw tool calls (for tools with no native Cursor equivalent, like `sessions_spawn`, `memory_search`, `cron`, `tts`, `image`, etc.)
- Streams responses in real-time via SSE
- Injects environment context so the model understands the OpenClaw runtime

Your local PC is only needed to get the Cursor cookie. Everything else runs on the droplet.

---

## Step 1: Get Your Cursor Cookie (on your Windows PC)

```powershell
git clone https://github.com/JiuZ-Chn/Cursor-To-OpenAI.git
cd Cursor-To-OpenAI
npm install
npm run login
```

1. Open the printed URL in your browser
2. Log in with your Cursor account
3. Copy the cookie string when it appears

---

## Step 2: Deploy the Proxy on Your Droplet

SSH into your droplet:

```bash
ssh root@<your-droplet-ip>
```

Clone the patched repo and copy files:

```bash
apt install -y git
cd /opt && git clone https://github.com/pwnapplehat/cursor-proxy-patched.git

cp /opt/cursor-proxy-patched/src/utils/utils.js /opt/cursor-proxy-utils.js
cp /opt/cursor-proxy-patched/src/routes/v1.js /opt/cursor-proxy-v1.js
cp /opt/cursor-proxy-patched/src/utils/toolEmulation.js /opt/cursor-proxy-toolEmulation.js
cp /opt/cursor-proxy-patched/src/proto/message.js /opt/cursor-proxy-message.js
cp /opt/cursor-proxy-patched/src/utils/h2-bidi.js /opt/cursor-proxy-h2-bidi.js
```

Run the proxy with all 5 patched files mounted:

```bash
docker run -d \
  --name cursor-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3010:3010 \
  -v /opt/cursor-proxy-utils.js:/app/src/utils/utils.js:ro \
  -v /opt/cursor-proxy-v1.js:/app/src/routes/v1.js:ro \
  -v /opt/cursor-proxy-toolEmulation.js:/app/src/utils/toolEmulation.js:ro \
  -v /opt/cursor-proxy-message.js:/app/src/proto/message.js:ro \
  -v /opt/cursor-proxy-h2-bidi.js:/app/src/utils/h2-bidi.js:ro \
  ghcr.io/jiuz-chn/cursor-to-openai:latest
```

Verify:

```bash
docker logs cursor-proxy --tail 5
# Should show: The server listens port: 3010
```

---

## Step 3: Configure OpenClaw

Edit the OpenClaw config inside the container:

```bash
docker exec -it openclaw bash -c '
cat > /home/node/.openclaw/openclaw.json << '\''OCEOF'\''
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "cursor/claude-4.6-opus-max",
        "fallbacks": [
          "cursor/gpt-4o"
        ]
      },
      "models": {
        "cursor/claude-4.6-opus-max": {
          "alias": "Opus 4.6"
        },
        "cursor/gpt-4o": {
          "alias": "GPT-4o"
        }
      },
      "workspace": "~/.openclaw/workspace",
      "memorySearch": {
        "provider": "openai",
        "model": "text-embedding-3-small"
      },
      "blockStreamingDefault": "on",
      "blockStreamingBreak": "text_end"
    },
    "list": [
      {
        "id": "main"
      }
    ]
  },
  "models": {
    "mode": "merge",
    "providers": {
      "cursor": {
        "baseUrl": "http://127.0.0.1:3010/v1",
        "apiKey": "YOUR_CURSOR_COOKIE_HERE",
        "api": "openai-completions",
        "models": [
          {
            "id": "claude-4.6-opus-max",
            "name": "Claude 4.6 Opus Max",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "gpt-4o",
            "name": "GPT-4o",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "blockStreaming": true,
      "streamMode": "off"
    }
  },
  "gateway": {
    "bind": "loopback",
    "port": 18789,
    "auth": {
      "mode": "token"
    },
    "controlUi": {
      "allowInsecureAuth": true
    }
  },
  "plugins": {
    "entries": {
      "telegram": {
        "enabled": true
      }
    }
  }
}
OCEOF
echo "Config written."
'
```

**Replace `YOUR_CURSOR_COOKIE_HERE`** with your actual Cursor cookie from Step 1.

### Config Highlights

| Setting | Value | Purpose |
|---------|-------|---------|
| `blockStreamingDefault` | `"on"` | Enables block streaming for real-time message delivery |
| `blockStreamingBreak` | `"text_end"` | Sends messages as text blocks complete (not buffered to end) |
| `channels.telegram.blockStreaming` | `true` | Enables block streaming for Telegram |
| `channels.telegram.streamMode` | `"off"` | Disables draft bubble streaming (incompatible with block streaming) |
| `gateway.bind` | `"loopback"` | Internal connections use 127.0.0.1 (enables auto-pairing for sub-agents) |

Restart OpenClaw:

```bash
docker restart openclaw
```

Verify:

```bash
docker logs openclaw --tail 10
# Should show: [gateway] agent model: cursor/claude-4.6-opus-max
```

---

## Step 4: Pair the Gateway Device

OpenClaw's gateway requires device pairing for internal tool connections (needed for `sessions_spawn`, CLI commands, etc.). Since the proxy bridge creates tool connections programmatically, we need to pair the device manually.

**4a.** Trigger a pairing request:

```bash
docker exec openclaw npx openclaw devices list 2>/dev/null || true
```

This will fail with "pairing required" — that's expected. It creates a pending pairing request.

**4b.** Approve the pending device:

```bash
docker exec openclaw node -e '
const crypto = require("crypto");
const fs = require("fs");
const pendingPath = "/home/node/.openclaw/devices/pending.json";
const pairedPath = "/home/node/.openclaw/devices/paired.json";

const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
const paired = JSON.parse(fs.readFileSync(pairedPath, "utf8"));
const requestId = Object.keys(pending)[0];
const req = pending[requestId];

if (!req) { console.log("No pending request found — already paired or no request created."); process.exit(0); }

const now = Date.now();
const token = crypto.randomBytes(32).toString("hex");

paired[req.deviceId] = {
  deviceId: req.deviceId,
  publicKey: req.publicKey,
  platform: req.platform,
  clientId: req.clientId,
  clientMode: req.clientMode,
  role: req.role,
  roles: req.roles || [req.role],
  scopes: req.scopes,
  remoteIp: req.remoteIp,
  tokens: {
    [req.role]: {
      token: token,
      role: req.role,
      scopes: req.scopes,
      createdAtMs: now
    }
  },
  createdAtMs: now,
  approvedAtMs: now
};

delete pending[requestId];

fs.writeFileSync(pairedPath, JSON.stringify(paired, null, 2));
fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
console.log("Device approved:", req.deviceId.substring(0, 16) + "...");
console.log("Token generated for role:", req.role);
'
```

**4c.** Restart and verify:

```bash
docker restart openclaw
sleep 10
docker exec openclaw npx openclaw devices list
```

You should see a table with "Paired (1)" and the device listed with the `operator` role. If you see the table (no errors), pairing is complete.

---

## Step 5: Test

Send a message via Telegram. Check proxy logs:

```bash
docker logs cursor-proxy --tail 20
```

You should see `POST /v1/chat/completions 200` entries and tool call interceptions:

```
[convertNativeToolCall] run_terminal_cmd → exec (params: command,explanation,is_background → command)
[streaming] Emitting 1 tool call(s): exec
```

### Test Sub-Agent Spawning

In Telegram, ask the agent: **"spawn a test sub-agent that says hello"**

In the proxy logs you should see:

```
[expandOcExecCalls] __oc sessions_spawn → sessions_spawn (args: {"task":"..."})
```

The agent will use `exec __oc sessions_spawn {"task":"..."}` and the proxy converts it to a real `sessions_spawn` tool call.

### Test Memory Search

Ask the agent: **"search your memory for my preferences"**

Proxy logs should show:

```
[expandOcExecCalls] __oc memory_search → memory_search (args: {"query":"..."})
```

---

## Available Models

| Model ID | Description |
|---|---|
| `claude-4.6-opus-max` | Claude 4.6 Opus — highest capability |
| `claude-4.6-opus-max-thinking` | Claude 4.6 Opus with extended thinking |
| `claude-4.6-opus-high` | Claude 4.6 Opus — high tier |
| `claude-4.5-sonnet` | Claude 4.5 Sonnet |
| `claude-4.5-haiku` | Claude 4.5 Haiku (fastest) |
| `gpt-4o` | GPT-4o |

Model availability depends on your Cursor plan. Use `cursor/<model-id>` format in the config.

---

## Updating the Proxy

When new fixes are pushed to the repo:

```bash
cd /opt/cursor-proxy-patched && git pull origin master
cp src/utils/utils.js /opt/cursor-proxy-utils.js
cp src/routes/v1.js /opt/cursor-proxy-v1.js
cp src/utils/toolEmulation.js /opt/cursor-proxy-toolEmulation.js
cp src/proto/message.js /opt/cursor-proxy-message.js
cp src/utils/h2-bidi.js /opt/cursor-proxy-h2-bidi.js
docker restart cursor-proxy
```

The `git pull` fetches the latest code, the `cp` commands update the mounted files, and the container restart picks them up.

After updating, send `/reset` in Telegram to start a fresh session with the new environment context.

---

## Cookie Refresh

When the cookie expires (proxy shows 401 errors):

1. On your Windows PC:
   ```powershell
   cd Cursor-To-OpenAI
   npm run login
   ```
2. Copy the new cookie
3. Update the cookie inside the OpenClaw container:
   ```bash
   docker exec openclaw bash -c '
   python3 -c "
   import json
   cfg = json.load(open(\"/home/node/.openclaw/openclaw.json\"))
   cfg[\"models\"][\"providers\"][\"cursor\"][\"apiKey\"] = \"YOUR_NEW_COOKIE_HERE\"
   json.dump(cfg, open(\"/home/node/.openclaw/openclaw.json\", \"w\"), indent=2)
   print(\"Cookie updated.\")
   "'
   ```
4. Restart:
   ```bash
   docker restart openclaw
   ```

---

## How the __oc Tool Gateway Works

The Cursor model only has native protobuf tools: `run_terminal_cmd`, `read_file`, `grep`, `list_dir`, `web_search`. These map 1:1 to OpenClaw's `exec`, `read`, `write`, `edit`, `web_search`.

But OpenClaw has many more tools with **no native Cursor equivalent**: `sessions_spawn`, `memory_search`, `cron`, `tts`, `image`, `browser`, `message`, `agents_list`, etc.

The `__oc` gateway solves this by leveraging `exec` (which the model trusts):

1. The `ENVIRONMENT_CONTEXT` (in `toolEmulation.js`) teaches the model to use:
   ```
   exec command: __oc sessions_spawn {"task": "Build CSS", "model": "cursor/gpt-4o"}
   ```
2. The proxy's `expandOcExecCalls()` (in `utils.js`) intercepts `exec` calls starting with `__oc`
3. It converts them to real OpenClaw tool calls before sending via SSE
4. OpenClaw executes the tool and returns results normally

### Supported __oc Tools

| Tool | Purpose | Key Params |
|------|---------|------------|
| `sessions_spawn` | Spawn a background sub-agent | `task` (required), `model`, `label` |
| `session_status` | Check if a spawned session finished | `sessionKey` |
| `sessions_send` | Send a message to another session | `message` (required), `sessionKey` |
| `sessions_list` | List active sessions | `kinds`, `limit` |
| `sessions_history` | Get session conversation history | `sessionKey` (required), `limit` |
| `agents_list` | List available agents | `{}` (no params) |
| `memory_search` | Semantic search over memory files | `query` (required), `maxResults` |
| `memory_get` | Read a specific memory file/section | `path` (required), `from`, `lines` |
| `image` | Image understanding (NOT generation) | `image` (required — file path or URL, NOT text), `prompt` |
| `tts` | Text-to-speech audio generation | `text` (required), `channel` |
| `browser` | Browser automation | `action` (required — status/open/snapshot/screenshot/navigate/act/tabs/etc.), `targetUrl`, `ref` |
| `message` | Send a message to a channel | `action` (required), `target`, `message` |
| `canvas` | Visual canvas display/interaction | `action` (required — present/hide/navigate/eval/snapshot/a2ui_push/a2ui_reset) |
| `nodes` | Companion node management | `action` (required — status/describe/notify/camera_snap/run/invoke/etc.), `node` |
| `cron` | Schedule recurring tasks | `action` (required — create/list/delete), `job`, `jobId` |
| `gateway` | Gateway config and management | `action` (required — restart/config.get/config.patch/config.apply/update.run) |
| `process` | List/manage background processes | `{}` to list |

---

## Agent Timeout Configuration

OpenClaw has a per-run timeout (`agents.defaults.timeoutSeconds`) that aborts agent runs after a specified duration. The default is **600 seconds (10 minutes)**.

The proxy also has its own timeout settings (HTTP server timeouts, undici fetch timeouts) that can kill connections to Cursor's API before the response arrives.

### Proxy Timeouts (already configured in the patched repo)

The patched proxy disables all internal timeouts so overnight/long-running agent sessions are never interrupted:

- **`v1.js`**: `undici` fetch timeouts set to `0` (unlimited) — `timeout.connect: 0`, `timeout.read: 0`, dispatcher `bodyTimeout: 0`, `headersTimeout: 0`
- **`app.js`**: Node.js HTTP server timeouts set to `0` — `server.timeout`, `server.requestTimeout`, `server.headersTimeout`, `server.keepAliveTimeout` all disabled

These are already baked into the patched repo. No action needed.

### OpenClaw Agent Timeout

To increase the agent run timeout (e.g., to 24 hours for long reverse engineering sessions):

```bash
docker exec openclaw bash -c '
python3 -c "
import json
cfg_path = \"/home/node/.openclaw/openclaw.json\"
with open(cfg_path) as f:
    cfg = json.load(f)
cfg[\"agents\"][\"defaults\"][\"timeoutSeconds\"] = 86400
with open(cfg_path, \"w\") as f:
    json.dump(cfg, f, indent=2)
print(\"Done — agent timeout set to 86400s (24 hours)\")
"'
docker restart openclaw
```

Verify:

```bash
docker exec openclaw cat /home/node/.openclaw/openclaw.json | grep timeoutSeconds
```

> **Note:** The maximum allowed value is `86400` (24 hours) — OpenClaw's schema enforces this hard cap. Setting `0` is invalid (schema requires a positive integer). The CloudClaw dashboard default is 600 seconds (10 minutes) to prevent excessive API credit usage for other users.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Unauthorized` | Cookie expired — refresh it (see Cookie Refresh above) |
| Agent says "switch to Agent mode" / "no tools" | `message.js` not mounted — recreate proxy container with all 4 volume mounts |
| Agent says "I can only read files" | Verify all 4 files are mounted: `docker exec cursor-proxy ls -la /app/src/utils/utils.js /app/src/routes/v1.js /app/src/utils/toolEmulation.js /app/src/proto/message.js` |
| `resource_exhausted` / rate limit | Wait, or switch model to a lighter one |
| `"Please update to the latest version"` | Update `cursorClientVersion` in `v1.js` to match your Cursor IDE version |
| Tool calls truncated for large files | Expected — model retries with chunked heredoc via `exec` |
| Agent loops on same command | Context bloat — send `/reset` in Telegram to start fresh |
| Agent aborts after ~10 minutes | OpenClaw `timeoutSeconds` default is 600s — increase to 86400 (see Agent Timeout Configuration above) |
| `Stream terminated early` in proxy logs | Proxy-side timeouts killing connection — ensure patched `v1.js` and `app.js` are deployed (all timeouts = 0) |
| `ERROR_USER_ABORTED_REQUEST` in proxy logs | Expected Cursor API behavior — not an error. Cursor emits this when a tool call finishes before inline result is received. Does not break tool execution. |
| Agent responds with "What can I help you with?" after long silence | Context bloat (400+ messages) causing model confusion — send `/reset` |
| `scp: Connection closed` when transferring files | Use the Python HTTP server workaround (see Transferring Files section above) |
| `sessions_spawn` returns "pairing required" | Run the device pairing steps (Step 4 above) |
| `sessions_spawn` returns "gateway closed (1008)" | Gateway bind might be `"lan"` — change to `"loopback"` in config, restart |
| Agent says "can't spawn sub-agents" / "tools not available" | Proxy update needed — run the Updating section, then `/reset` |
| Replies arrive all at once (batched) | Set `blockStreamingBreak: "text_end"` in config (see Step 3) |
| 10+ minute response times | Context bloat from failed tool loops — send `/reset` |
| `session file locked (timeout 10000ms)` | Stale lock from OOM-killed process — see Stale Session Lock Fix below |
| Agent OOM-killed during heavy tasks (jadx, baksmali) | VM needs swap space — see Add Swap Space below |
| `rg: Permission denied` or `rg: command not found` | ripgrep not installed in container — see Install ripgrep below |

### Debug Commands

```bash
# Proxy logs (tool call interception, __oc expansion, streaming)
docker logs cursor-proxy --tail 30

# OpenClaw logs (agent activity, gateway, tool execution)
docker logs openclaw --tail 30

# Live proxy logs (watch in real-time while testing)
docker logs cursor-proxy -f --tail 10

# Check containers are running
docker ps --format "table {{.Names}}\t{{.Status}}"

# Verify proxy mounts
docker exec cursor-proxy ls -la /app/src/utils/utils.js /app/src/routes/v1.js /app/src/utils/toolEmulation.js /app/src/proto/message.js

# Check OpenClaw config
docker exec openclaw cat /home/node/.openclaw/openclaw.json

# Check agent timeout setting
docker exec openclaw cat /home/node/.openclaw/openclaw.json | grep timeoutSeconds

# Check device pairing status
docker exec openclaw npx openclaw devices list

# Check proxy is reachable from OpenClaw
docker exec openclaw curl -s http://127.0.0.1:3010/v1/models | head -c 200
```

### Add Swap Space (Prevents OOM Kills)

Memory-intensive operations like decompiling APKs with Jadx or Ghidra can exceed the droplet's physical RAM (e.g., trying `java -Xmx4g` on a 3.8GB RAM VM). When the Linux OOM killer terminates these processes, it can leave stale lock files that block OpenClaw sessions entirely.

**Solution:** Add swap space so the OS can spill excess memory to disk instead of killing processes.

Run these commands on the **host VM** (SSH into the droplet):

```bash
# Create a 4GB swap file
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Make it persistent across reboots
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Verify swap is active
free -h
```

You should see a `Swap` row with `4.0G` total in the `free -h` output. This survives reboots thanks to the `/etc/fstab` entry.

> **Recommendation:** For heavy RE workloads (Jadx, Ghidra, baksmali on large APKs), a droplet with **8GB+ RAM** is strongly recommended. Swap prevents crashes but is slower than real RAM.

### Stale Session Lock Fix

If an agent process gets OOM-killed or crashes mid-operation, OpenClaw's session journal file may retain a stale `.lock` file. This prevents the session from resuming and produces errors like:

```
session file locked (timeout 10000ms): pid=1 ...jsonl.lock
```

**Diagnosis — find stale lock files:**

```bash
docker exec openclaw find /home/node/.openclaw/agents/main/sessions/ -name "*.lock" -ls
```

**Fix — remove the stale lock and restart:**

```bash
# Remove the specific stale lock file (replace <session-id> with the actual ID from the find output)
docker exec openclaw rm /home/node/.openclaw/agents/main/sessions/<session-id>.jsonl.lock

# Restart OpenClaw to clear any cached state
docker restart openclaw
```

If there are multiple stale locks, remove them all:

```bash
docker exec openclaw find /home/node/.openclaw/agents/main/sessions/ -name "*.lock" -delete
docker restart openclaw
```

> **Root cause:** Usually caused by OOM kills (see Add Swap Space above) or unexpected container restarts. Adding swap space prevents most occurrences.

### Install ripgrep in the OpenClaw Container

The AI agent uses `ripgrep` (`rg`) for fast code/text searches via the `ripgrep_raw_search` native tool. It is **not installed by default** in the OpenClaw container, causing `rg: command not found` or `Permission denied` errors.

**Install ripgrep (must run as root inside the container):**

```bash
docker exec -u root openclaw bash -c 'apt-get update && apt-get install -y ripgrep'
```

> **Important:** The `-u root` flag is required. The default container user (`node`) does not have permission to run `apt-get`. Running without `-u root` produces `Permission denied` errors.

**Verify it works:**

```bash
docker exec openclaw rg --version
```

You should see output like `ripgrep 13.0.0` or similar. The agent can now use `rg` for searches without falling back to slower `grep` alternatives.

> **Note:** This installation does not persist across container rebuilds. If you recreate the OpenClaw container (e.g., `docker rm openclaw && docker run ...`), you'll need to reinstall ripgrep.

---

## Context Management (Prevents ERROR_CONVERSATION_TOO_LONG)

Long-running agent sessions accumulate tool call results and messages until the context exceeds the model's 200K token window. When this happens, Cursor's API returns `ERROR_CONVERSATION_TOO_LONG` and the agent dies. This section documents the three-layer defense system that prevents this.

### How It Works

The system uses three layers, each operating at a different stage:

1. **Context Pruning (Layer 1 — every request):** Before each API call, old tool results (older than 5 minutes, beyond the 5 most recent assistant turns) are progressively trimmed. Large results get soft-trimmed (head + tail kept, middle cut) first, then hard-cleared if context is still too large. This keeps the context lean without losing conversation flow.

2. **Compaction (Layer 2 — on overflow):** If pruning isn't enough and the API returns a context overflow error, OpenClaw automatically compresses older messages into a summary using the LLM. Before summarizing, `memoryFlush` (enabled by default) prompts the agent to save important findings to `memory/YYYY-MM-DD.md` files. After compaction, the request is retried (up to 3 attempts).

3. **DM History Limit (Layer 3 — safety net):** As a final backstop, only the last 100 user turns (and their associated responses) are sent to the model. Older turns are dropped entirely. This prevents runaway growth even if layers 1 and 2 can't keep up.

### Proxy Error Translation

The proxy translates Cursor's `ERROR_CONVERSATION_TOO_LONG` (which arrives as a protobuf error frame, not an OpenAI-format error) into an OpenAI-compatible SSE error chunk containing `"prompt is too long: context length exceeded"`. This matches the patterns in OpenClaw's `isContextOverflowError` function, triggering auto-compaction.

Without this translation, the proxy would silently send `finish_reason: 'stop'` and OpenClaw would think the response simply ended, never triggering compaction.

### Required OpenClaw Container Patch

OpenClaw's context pruning (`cache-ttl` mode) is hard-coded to only work with Anthropic providers. Since the Cursor proxy presents as a custom provider, this check must be patched in the bundled JavaScript:

```bash
# Patch isCacheTtlEligibleProvider to accept "cursor" provider
# The function is code-split across multiple bundle files — this patches all of them
docker exec -i openclaw node << 'PATCH_EOF'
const fs = require('fs');
const path = require('path');
const distDir = '/app/dist';
const files = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
let patchCount = 0;
for (const fname of files) {
  const file = path.join(distDir, fname);
  let code;
  try { code = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const marker = 'function isCacheTtlEligibleProvider';
  const fnIdx = code.indexOf(marker);
  if (fnIdx === -1) continue;
  const region = code.substring(fnIdx, fnIdx + 600);
  if (region.includes('"cursor"')) {
    console.log('Already patched: ' + fname);
    patchCount++;
    continue;
  }
  const rfIdx = region.lastIndexOf('return false');
  if (rfIdx === -1) {
    console.error('return false not found in ' + fname);
    continue;
  }
  const globalIdx = fnIdx + rfIdx;
  const cursorCheck = 'if (normalizedProvider === "cursor") {\n    return true;\n  }\n  ';
  code = code.substring(0, globalIdx) + cursorCheck + code.substring(globalIdx);
  fs.writeFileSync(file, code);
  console.log('Patched: ' + fname);
  patchCount++;
}
if (patchCount === 0) {
  console.error('ERROR: No files patched');
  process.exit(1);
} else {
  console.log('Done — patched ' + patchCount + ' file(s)');
}
PATCH_EOF
```

> **Note:** This patch does not persist across OpenClaw container rebuilds or updates. Re-run it after any `docker pull` / recreate of the OpenClaw container.

### openclaw.json Configuration

Add these settings under `agents.defaults` in `/home/node/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "contextTokens": 200000,
      "compaction": {
        "mode": "safeguard",
        "maxHistoryShare": 0.6,
        "reserveTokensFloor": 20000
      },
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "5m",
        "keepLastAssistants": 5,
        "softTrimRatio": 0.4,
        "hardClearRatio": 0.6,
        "minPrunableToolChars": 30000,
        "softTrim": {
          "maxChars": 6000,
          "headChars": 2500,
          "tailChars": 2500
        },
        "hardClear": {
          "enabled": true,
          "placeholder": "[Earlier tool result cleared to manage context. Key findings preserved in conversation history.]"
        }
      }
    }
  },
  "channels": {
    "telegram": {
      "dmHistoryLimit": 100
    }
  }
}
```

**Key parameter explanations:**

- `contextTokens: 200000` — matches the model's context window (acts as a cap)
- `compaction.maxHistoryShare: 0.6` — allows up to 60% of context for history before pruning old messages
- `compaction.reserveTokensFloor: 20000` — always keeps 20K tokens free for the next response
- `contextPruning.ttl: "5m"` — tool results older than 5 minutes become eligible for trimming
- `contextPruning.keepLastAssistants: 5` — the 5 most recent assistant responses are never pruned
- `contextPruning.softTrim` — large tool results are trimmed to 6000 chars (2500 head + 2500 tail)
- `contextPruning.hardClear` — if soft-trim isn't enough, old results are replaced entirely with a placeholder
- `dmHistoryLimit: 100` — only the last 100 user turns are sent to the model (safety net)
- `memoryFlush` — enabled by default (not set explicitly); before compaction, the agent saves important findings to memory files

### Verification

After applying all changes and restarting OpenClaw:

```bash
docker exec openclaw node -e "
const cfg = require('/home/node/.openclaw/openclaw.json');
console.log('contextTokens:', cfg.agents?.defaults?.contextTokens);
console.log('compaction.mode:', cfg.agents?.defaults?.compaction?.mode);
console.log('contextPruning.mode:', cfg.agents?.defaults?.contextPruning?.mode);
console.log('dmHistoryLimit:', cfg.channels?.telegram?.dmHistoryLimit);
"
```

Expected output:
```
contextTokens: 200000
compaction.mode: safeguard
contextPruning.mode: cache-ttl
dmHistoryLimit: 100
```

---

## Transferring Files from Windows to the OpenClaw Container

`scp` and `sftp` may fail with "Connection closed" on some DigitalOcean droplets. The workaround is to use a temporary Python HTTP server on the VM and `curl.exe` from Windows.

### Step 1: Start a one-shot HTTP upload server on the VM

SSH into the droplet and run:

```bash
python3 -c "
import http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        length = int(self.headers['Content-Length'])
        with open('/tmp/upload.bin', 'wb') as f:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk: break
                f.write(chunk)
                remaining -= len(chunk)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'OK')
        print(f'Received {length} bytes')
http.server.HTTPServer(('0.0.0.0', 9999), H).handle_request()
" &
```

This starts a one-shot HTTP PUT server on port `9999` that saves the uploaded file to `/tmp/upload.bin` and then exits automatically after receiving one file.

### Step 2: Upload the file from Windows

In PowerShell on your local machine:

```powershell
curl.exe -T C:\Users\csahi\Downloads\yourfile.apk http://<droplet-ip>:9999/yourfile.apk
```

You should see `OK` printed when the transfer completes. On the VM side, you'll see `Received <size> bytes`.

### Step 3: Copy into the OpenClaw container

Back on the VM:

```bash
# Create the target directory inside the container (if needed)
docker exec openclaw mkdir -p /home/node/.openclaw/workspace/YourFolder/

# Copy the file from VM into the container
docker cp /tmp/upload.bin openclaw:/home/node/.openclaw/workspace/YourFolder/yourfile.apk

# Verify
docker exec openclaw ls -lh /home/node/.openclaw/workspace/YourFolder/yourfile.apk
```

### Real Example: Transferring snapchat.apk

**VM (SSH session):**

```bash
python3 -c "
import http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        length = int(self.headers['Content-Length'])
        with open('/tmp/snapchat.apk', 'wb') as f:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk: break
                f.write(chunk)
                remaining -= len(chunk)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'OK')
        print(f'Received {length} bytes')
http.server.HTTPServer(('0.0.0.0', 9999), H).handle_request()
" &
```

**Windows (PowerShell):**

```powershell
curl.exe -T C:\Users\csahi\Downloads\snapchat.apk http://167.172.196.152:9999/snapchat.apk
```

**VM (copy into container):**

```bash
ls -lh /tmp/snapchat.apk && docker cp /tmp/snapchat.apk openclaw:/home/node/.openclaw/workspace/Snapchat/ && echo "Done"
```

> **Security note:** Port 9999 is open to the internet briefly while the server runs. The one-shot server (`handle_request()`) exits after receiving one file, so the window is small. For extra safety, restrict with `ufw allow from <your-ip> to any port 9999` beforehand and `ufw delete allow 9999` after.

---

## Caveats

1. **Cookie expiration** — needs periodic refresh from your PC
2. **Rate limits** — each tool call round-trip is a separate API request; heavy use burns through limits fast
3. **ToS violation** — your Cursor account could be banned
4. **Tool emulation** — native Cursor tools (exec, read, write, edit, web_search) work reliably; extended OpenClaw tools work via the `__oc` gateway through `exec`
5. **Context management** — long sessions are automatically managed via three layers (pruning, compaction, history limit); see Context Management section for setup and the required container patch
6. **Sub-agent scope** — sub-agents spawned via `sessions_spawn` cannot spawn their own sub-agents (one level deep)
7. **Agent timeout** — OpenClaw default is 10 minutes (600s); increase to 86400 (24h) for long-running tasks (see Agent Timeout Configuration)
8. **File transfer** — `scp`/`sftp` may fail on some droplets; use the Python HTTP server method (see Transferring Files section)
9. **OOM kills on low-RAM droplets** — memory-intensive tasks (Jadx, Ghidra, baksmali) can trigger Linux OOM killer on VMs with less than 8GB RAM; add swap space to mitigate (see Add Swap Space under Troubleshooting)
10. **Stale session locks** — OOM kills or crashes can leave `.lock` files blocking sessions; manual cleanup required (see Stale Session Lock Fix under Troubleshooting)
11. **ripgrep not pre-installed** — the OpenClaw container does not include `ripgrep` by default; must be installed manually as root, and does not persist across container rebuilds (see Install ripgrep under Troubleshooting)

---

*Last updated: February 14, 2026 (added context management system, proxy error translation, swap space setup, stale session lock fix, ripgrep installation guide). Patched repo: [github.com/pwnapplehat/cursor-proxy-patched](https://github.com/pwnapplehat/cursor-proxy-patched).*
