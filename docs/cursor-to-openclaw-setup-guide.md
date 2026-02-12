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
```

Run the proxy with all 4 patched files mounted:

```bash
docker run -d \
  --name cursor-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3010:3010 \
  -v /opt/cursor-proxy-utils.js:/app/src/utils/utils.js:ro \
  -v /opt/cursor-proxy-v1.js:/app/src/routes/v1.js:ro \
  -v /opt/cursor-proxy-toolEmulation.js:/app/src/utils/toolEmulation.js:ro \
  -v /opt/cursor-proxy-message.js:/app/src/proto/message.js:ro \
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

docker restart cursor-proxy
```

After updating the proxy, send `/reset` in Telegram to start a fresh session with the new environment context.

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

| Tool | Purpose |
|------|---------|
| `sessions_spawn` | Spawn a background sub-agent |
| `session_status` | Check if a spawned session finished |
| `sessions_send` | Send a message to another session |
| `sessions_list` | List active sessions |
| `sessions_history` | Get session conversation history |
| `agents_list` | List available agents |
| `memory_search` | Semantic search over memory files |
| `memory_get` | Read a specific memory file/section |
| `image` | Image generation or understanding |
| `tts` | Text-to-speech audio generation |
| `browser` | Headless browser automation |
| `message` | Send a message to a channel |
| `canvas` | Visual canvas operations |
| `nodes` | Workflow node management |
| `cron` | Schedule recurring tasks |
| `gateway` | API gateway operations |
| `process` | List/manage background processes |

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
| `sessions_spawn` returns "pairing required" | Run the device pairing steps (Step 4 above) |
| `sessions_spawn` returns "gateway closed (1008)" | Gateway bind might be `"lan"` — change to `"loopback"` in config, restart |
| Agent says "can't spawn sub-agents" / "tools not available" | Proxy update needed — run the Updating section, then `/reset` |
| Replies arrive all at once (batched) | Set `blockStreamingBreak: "text_end"` in config (see Step 3) |
| 10+ minute response times | Context bloat from failed tool loops — send `/reset` |

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

# Check device pairing status
docker exec openclaw npx openclaw devices list

# Check proxy is reachable from OpenClaw
docker exec openclaw curl -s http://127.0.0.1:3010/v1/models | head -c 200
```

---

## Caveats

1. **Cookie expiration** — needs periodic refresh from your PC
2. **Rate limits** — each tool call round-trip is a separate API request; heavy use burns through limits fast
3. **ToS violation** — your Cursor account could be banned
4. **Tool emulation** — native Cursor tools (exec, read, write, edit, web_search) work reliably; extended OpenClaw tools work via the `__oc` gateway through `exec`
5. **Context bloat** — long sessions with many tool calls accumulate context, increasing response times; use `/reset` periodically
6. **Sub-agent scope** — sub-agents spawned via `sessions_spawn` cannot spawn their own sub-agents (one level deep)

---

*Last updated: February 13, 2026. Patched repo: [github.com/pwnapplehat/cursor-proxy-patched](https://github.com/pwnapplehat/cursor-proxy-patched).*
