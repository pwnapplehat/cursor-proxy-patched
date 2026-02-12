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

Edit the config:

```bash
nano /opt/openclaw/config/openclaw.json
```

Replace the entire file with (swap `YOUR_CURSOR_COOKIE_HERE` with your cookie):

```json
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
      }
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
      "dmPolicy": "pairing"
    }
  },
  "gateway": {
    "bind": "lan",
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
```

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

## Step 4: Test

Send a message via Telegram. Check proxy logs:

```bash
docker logs cursor-proxy --tail 10
```

You should see `POST /v1/chat/completions 200` entries and tool call interceptions like:

```
[chunkToUtf8String] Intercepted native tool call: run_terminal_cmd (enum=15, ...)
[convertNativeToolCall] run_terminal_cmd → exec (params: command,explanation,is_background → command)
[ToolEmulation] Parsed 1 tool call(s): exec
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
cd /opt/cursor-proxy-patched && git pull

cp src/utils/utils.js /opt/cursor-proxy-utils.js
cp src/routes/v1.js /opt/cursor-proxy-v1.js
cp src/utils/toolEmulation.js /opt/cursor-proxy-toolEmulation.js
cp src/proto/message.js /opt/cursor-proxy-message.js

docker restart cursor-proxy
```

---

## Cookie Refresh

When the cookie expires (proxy shows 401):

1. On your Windows PC:
   ```powershell
   cd Cursor-To-OpenAI
   npm run login
   ```
2. Copy the new cookie
3. Update `apiKey` in `/opt/openclaw/config/openclaw.json`
4. `docker restart openclaw`

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401 Unauthorized` | Cookie expired — refresh it (see above) |
| Agent says "switch to Agent mode" / "no tools" | `message.js` not mounted — recreate container with all 4 mounts |
| Agent says "I can only read files" | `EDIT_FILE` / `EDIT_FILE_V2` missing from `supportedTools` in `utils.js` |
| `resource_exhausted` / rate limit | Wait, or switch model |
| `"Please update to the latest version"` | Update `cursorClientVersion` in `v1.js` to match your Cursor IDE version |
| Tool calls truncated for large files | Expected — model will retry with chunked heredoc via `exec` |
| Agent loops on same command | Start a new session (`/reset` in Telegram) |

### Debug Commands

```bash
docker logs cursor-proxy --tail 20   # proxy logs
docker logs openclaw --tail 20       # openclaw logs
docker ps | grep cursor-proxy        # check container running
docker exec cursor-proxy ls -la /app/src/utils/toolEmulation.js /app/src/utils/utils.js /app/src/routes/v1.js /app/src/proto/message.js  # verify mounts
```

---

## Caveats

1. **Cookie expiration** — needs periodic refresh from your PC
2. **Rate limits** — each tool call round-trip is a separate API request; heavy use burns through limits fast
3. **ToS violation** — your Cursor account could be banned
4. **Tool emulation** — tool calling is emulated via text, not native OpenAI tool calling; works well with Claude 4.6 Opus but not 100% deterministic
5. **Streaming delay** — all responses are buffered for tool call detection; no real-time streaming

---

*Last updated: February 12, 2026. Patched repo: [github.com/pwnapplehat/cursor-proxy-patched](https://github.com/pwnapplehat/cursor-proxy-patched).*
