# Cursor-To-OpenAI → OpenClaw Setup Guide

> **Personal use only.** This guide documents how to use a [patched fork](https://github.com/pwnapplehat/cursor-proxy-patched) of the [Cursor-To-OpenAI](https://github.com/JiuZ-Chn/Cursor-To-OpenAI) proxy to power an OpenClaw agent on a CloudClaw droplet using your Cursor account's AI models — with full agent mode and tool calling support.
>
> **Warning:** This operates against Cursor's Terms of Service. Your Cursor account could be banned if they detect the usage pattern. Use at your own risk.

---

## Architecture

```
Your Cursor Account
        ↓ (cookie auth)
Cursor-To-OpenAI Proxy (Docker, localhost:3010 on droplet)
  ├── Translates OpenAI chat/completions ↔ Cursor protobuf
  ├── Emulates tool calling via <tool_call> XML tags in text
  └── Converts model text output → OpenAI tool_calls format
        ↓ (OpenAI-compatible API with tool emulation)
OpenClaw Agent (Docker, port 18789 on droplet)
        ↓
Telegram / WebChat / Discord
```

Your local PC is **not involved** after initial setup. The proxy runs entirely on the droplet. You only need your PC to refresh the Cursor cookie when it expires.

---

## Prerequisites

- A CloudClaw droplet with an active OpenClaw instance
- Node.js installed on your local Windows PC (for the login step only)
- SSH access to your droplet
- Git installed on the droplet (`apt install -y git` if needed)
- A Cursor account (free or paid)

---

## Step 1: Get Your Cursor Cookie (on your Windows PC)

Open PowerShell on your local machine:

```powershell
git clone https://github.com/JiuZ-Chn/Cursor-To-OpenAI.git
cd Cursor-To-OpenAI
npm install
npm run login
```

This prints a URL:

```
[Log] Please open the following URL in your browser to login:
https://www.cursor.com/loginDeepControl?challenge=...&uuid=...&mode=login
```

1. Copy the URL and open it in your browser
2. Log in with your Cursor account (same account you use in your Cursor IDE)
3. Wait — the terminal polls every 5 seconds (up to 60 attempts = 5 minutes)
4. When it detects your login, it prints your cookie:

```
[Log] Login successfully. Your Cursor cookie:
user_01JJF...%3A%3AeyJhbGci...
```

5. **Copy the entire cookie string** and save it somewhere safe.

> The cookie will expire eventually. When it does, repeat this step to get a fresh one.

---

## Step 2: Deploy the Patched Proxy on Your Droplet

> **Important:** The stock `ghcr.io/jiuz-chn/cursor-to-openai:latest` Docker image has six bugs that prevent it from working with OpenClaw. The patched repo at [github.com/pwnapplehat/cursor-proxy-patched](https://github.com/pwnapplehat/cursor-proxy-patched) contains all fixes pre-applied. You clone this repo on the droplet and mount the patched files into the container.

SSH into your droplet:

```bash
ssh root@<your-droplet-ip>
```

**2a. Install git (if not already installed) and clone the patched repo:**

```bash
apt install -y git
cd /opt && git clone https://github.com/pwnapplehat/cursor-proxy-patched.git
```

**2b. Copy the patched files into place:**

```bash
cp /opt/cursor-proxy-patched/src/utils/utils.js /opt/cursor-proxy-utils.js
cp /opt/cursor-proxy-patched/src/routes/v1.js /opt/cursor-proxy-v1.js
cp /opt/cursor-proxy-patched/src/utils/toolEmulation.js /opt/cursor-proxy-toolEmulation.js
```

**2c. Run the proxy with patched files mounted:**

```bash
docker run -d \
  --name cursor-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3010:3010 \
  -v /opt/cursor-proxy-utils.js:/app/src/utils/utils.js:ro \
  -v /opt/cursor-proxy-v1.js:/app/src/routes/v1.js:ro \
  -v /opt/cursor-proxy-toolEmulation.js:/app/src/utils/toolEmulation.js:ro \
  ghcr.io/jiuz-chn/cursor-to-openai:latest
```

Verify it's running:

```bash
docker ps | grep cursor-proxy
```

**Updating the patched files later:** If you push new fixes to the repo, update the droplet with:

```bash
cd /opt/cursor-proxy-patched && git pull
cp src/utils/utils.js /opt/cursor-proxy-utils.js
cp src/routes/v1.js /opt/cursor-proxy-v1.js
cp src/utils/toolEmulation.js /opt/cursor-proxy-toolEmulation.js
docker restart cursor-proxy
```

---

## Step 3: Verify Proxy is Running

```bash
docker logs cursor-proxy --tail 5
```

You should see: `The server listens port: 3010`

---

## Appendix: What the Patches Fix (Reference)

The patched files in this repo (`src/utils/utils.js`, `src/routes/v1.js`, and `src/utils/toolEmulation.js`) fix six issues in the stock Cursor-To-OpenAI proxy that prevent it from working fully with OpenClaw. These are **already applied** in the [patched repo](https://github.com/pwnapplehat/cursor-proxy-patched) — this section is for reference only.

### Fix 1: Content Array Normalization (`utils.js`)

**Error:** `request.messages.content: string expected`

OpenClaw sends `messages.content` as an array of content parts (OpenAI multi-modal format), but the proxy's Protobuf schema only accepts plain strings.

**Fix:** Added `normalizeContent()` helper that converts both string and array content to a plain string. Applied to system message mapping and formatted message content.

### Fix 2: Client Version (`v1.js`)

**Error:** `"Please update to the latest version of Cursor at cursor.com/downloads to continue using the Agent"`

The stock proxy hardcodes `cursorClientVersion = "0.48.7"` which is extremely outdated. Cursor blocks requests from old client versions.

**Fix:** Updated to `cursorClientVersion = "2.4.28"`. If Cursor releases a new version and starts blocking again, update this value to match your current Cursor IDE version (check in Cursor: **Help > About**).

### Fix 3: Agent Mode (`utils.js`)

**Error:** Model responds with "I'm currently in ask mode — read-only, can't create files or folders."

The stock proxy hardcodes `chatMode: "Ask"` and `chatModeEnum: 1`, telling Cursor to instruct the model to operate in read-only "Ask" mode.

**Fix:** Changed to `chatMode: "Agent"` and `chatModeEnum: 2`, which unlocks full agent capabilities (file creation, command execution, etc.).

### Fix 4: Tool Calling Emulation (`toolEmulation.js` + `utils.js` + `v1.js`)

**Error:** Agent can talk but cannot execute tools — says "I can see tools listed but I'm unable to invoke them." Commands like `exec`, `read`, `write` are visible but never actually called. The agent can only chat, not act.

**Cause:** The Cursor-To-OpenAI proxy only supports basic chat completions (text in, text out). It does **not** support the OpenAI Tools/Function Calling API (`tools`, `tool_calls` fields). OpenClaw's agent mode **requires** tool calling to function — when the agent decides to run a shell command, it emits a `tool_calls` response with `{"name": "exec", "arguments": {"command": "ls"}}`. The stock proxy has no way to handle this.

**Fix:** Added a full tool emulation layer that bridges the gap:

1. **`src/utils/toolEmulation.js`** (new file) provides:
   - `formatToolDefinitions()` — converts OpenAI tool definitions into clear text instructions appended to the system prompt, telling the model to output `<tool_call>` XML tags when it wants to use a tool
   - `injectToolsIntoMessages()` — appends tool instructions to the system message
   - `convertToolResultMessages()` — converts `role: "tool"` messages (tool results from OpenClaw) into `role: "user"` messages with `<tool_result>` tags, and converts assistant messages with `tool_calls` history into text with `<tool_call>` tags — so the full conversation history makes sense to the model in a text-only format
   - `parseToolCalls()` — parses `<tool_call>` XML blocks from the model's text response back into proper OpenAI `tool_calls` format
   - `hasToolCallTags()` — detects whether a response contains tool call tags

2. **`src/utils/utils.js`** changes:
   - Imports `injectToolsIntoMessages` and `convertToolResultMessages` from `toolEmulation.js`
   - `generateCursorBody()` now accepts a `tools` parameter (third argument)
   - Before building the Protobuf message, runs messages through `convertToolResultMessages()` then `injectToolsIntoMessages()` to inject tool definitions into the system prompt

3. **`src/routes/v1.js`** changes:
   - Extracts `tools` and `tool_choice` from the request body
   - Passes `tools` to `generateCursorBody()`
   - **Streaming:** Always buffers the full response (necessary to detect `<tool_call>` tags regardless of whether `tools` was in the request), then emits proper OpenAI `tool_calls` stream chunks with `finish_reason: "tool_calls"` if tags are found, or normal text chunks if not
   - **Non-streaming:** Also buffers full response, detects tool calls and returns proper `tool_calls` response format

**How the emulation works end-to-end:**

```
OpenClaw sends:  { tools: [...], messages: [...] }
                         ↓
Proxy injects:   Tool definitions appended to system prompt as text instructions
                         ↓
Cursor model:    Sees instructions, outputs <tool_call>{"name":"exec","arguments":{"command":"ls"}}</tool_call>
                         ↓
Proxy parses:    Detects <tool_call> tags → converts to OpenAI tool_calls format
                         ↓
OpenClaw receives: { tool_calls: [{ function: { name: "exec", arguments: ... } }] }
                         ↓
OpenClaw executes the tool, sends result back as role: "tool" message
                         ↓
Proxy converts:  role: "tool" → role: "user" with <tool_result> tags
                         ↓
Cycle repeats until agent completes the task
```

**Trade-off:** ALL streaming responses are buffered (the entire response must be collected before tool calls can be detected). This means the first token takes longer to arrive. This is necessary because tool calls can appear even when OpenClaw doesn't explicitly send the `tools` parameter.

### Fix 5: `developer` Role Handling (`utils.js` + `toolEmulation.js`)

**Error:** `Response contains 0 tool call(s)` — tool definitions were injected but the model never used them.

**Cause:** OpenClaw uses the newer OpenAI API format and sends `role: "developer"` instead of `role: "system"`. The proxy only looked for `role === 'system'` when building the protobuf `instruction` field, so the `developer` message (containing OpenClaw's core agent instructions) was being treated as a regular assistant message instead of going into the system instruction. Tool definitions were injected as a separate system message that got lost.

**Fix:** Added `isSystemRole()` helper that matches both `"system"` and `"developer"`. Applied to the instruction builder in `utils.js` and the tool injection in `toolEmulation.js`.

### Fix 6: Robust Tool Call Parsing (`toolEmulation.js`)

**Error:** `[ToolEmulation] Failed to parse tool call JSON: ... Unexpected token` — the model output valid `<tool_call>` tags but parsing failed.

**Cause:** The model was talking ABOUT the `<tool_call>` format in its conversational text (e.g., `` using the `<tool_call>` format ``). The regex matched the first `<tool_call>` occurrence in the conversational text instead of the actual tool call block, capturing garbage text between them.

**Fix:** Added `sanitizeForParsing()` that strips backtick-wrapped and code-fenced `<tool_call>` references before regex matching. The parser now uses balanced brace counting for JSON extraction (handles nested objects), recovers unclosed `<tool_call>` blocks, strips markdown fences inside blocks, and handles smart quotes from Telegram/chat formatting.

### Reliability Enhancements (on top of the 6 fixes)

These enhancements improve tool call detection and parsing reliability:

- **Mandatory tool calling protocol** — aggressive system prompt with explicit WRONG/CORRECT examples telling the model to NEVER describe a tool call, always execute it
- **Balanced brace JSON extraction** — `extractJsonObject()` uses character-level brace counting instead of regex, correctly handles nested objects like `{"command": "echo {hello}"}`
- **Unclosed `<tool_call>` block recovery** — if the model output is cut off mid-tag (no `</tool_call>`), auto-closes braces and attempts parse
- **Markdown fence stripping** — handles models wrapping JSON in `` ```json `` code blocks inside `<tool_call>` tags
- **Near-miss format normalization** — `normalizeNearMissToolCalls()` auto-corrects `[tool_call]`, `<function_call>`, `<tool-call>`, and bare JSON `{"name":...}` patterns to standard `<tool_call>` format
- **Parameter auto-correction** — `validateAndFixToolArgs()` uses a deterministic alias map (verified against [OpenClaw source code](https://github.com/openclaw/openclaw/blob/main/src/agents/pi-tools.read.ts)) to remap common model mistakes: `file_path`→`path`, `old_string`→`oldText`, `new_string`→`newText`, `cmd`→`command`, `search_query`→`query`, `content`→`text` (for tts), etc. A four-condition safety guard ensures remapping only fires when the wrong key is genuinely absent from the tool's schema
- **UUID-based tool_call IDs** — proper unique IDs via `uuidv4()` instead of timestamp-based (avoids collisions on rapid multi-tool calls)
- **Warning logging** — logs a warning when tools were provided but the model didn't output any `<tool_call>` tags, making it easier to diagnose "describe instead of execute" failures

### Summary of Changes

**`src/utils/toolEmulation.js`** (NEW FILE):

| Function | Purpose |
|---|---|
| `formatToolDefinitions(tools, toolChoice)` | Converts OpenAI tool definitions to system prompt text with mandatory protocol, handles `tool_choice` constraints |
| `injectToolsIntoMessages(messages, tools, toolChoice)` | Appends tool instructions to system/developer message |
| `convertToolResultMessages(messages)` | Converts `role: "tool"` → `role: "user"` with `<tool_result>` tags |
| `sanitizeForParsing(text)` | Strips backtick-wrapped and code-fenced `<tool_call>` references before parsing |
| `extractJsonObject(str)` | Balanced brace JSON extraction (handles nested objects where regex fails) |
| `stripMarkdownFences(str)` | Removes `` ```json `` fences from inside `<tool_call>` blocks |
| `parseToolCalls(text, tools)` | Parses `<tool_call>` XML from model text → OpenAI `tool_calls` format (with unclosed tag recovery and parameter auto-correction) |
| `tryParseToolCallContent(raw, tools)` | Attempts to parse a single `<tool_call>` block's inner content with all normalization |
| `validateAndFixToolArgs(toolName, args, tools)` | Deterministic parameter auto-correction: remaps common model mistakes (`file_path`→`path`, `old_string`→`oldText`, etc.) verified against OpenClaw source schemas, with safety guard |
| `hasToolCallTags(text)` | Detects actual `<tool_call>` tags (ignoring backtick-wrapped references) |
| `normalizeNearMissToolCalls(text)` | Converts `[tool_call]`, `<function_call>`, `<tool-call>`, and bare JSON to standard format |

**`src/utils/utils.js`:**

| Change | Stock Value | Patched Value |
|---|---|---|
| Added `normalizeContent()` helper | N/A | New function |
| Added `isSystemRole()` helper | N/A | Matches both `"system"` and `"developer"` roles |
| Imports from `toolEmulation.js` | N/A | `injectToolsIntoMessages`, `convertToolResultMessages` |
| `generateCursorBody()` signature | `(messages, modelName)` | `(messages, modelName, tools, toolChoice)` |
| Pre-processes messages for tools | N/A | `convertToolResultMessages()` then `injectToolsIntoMessages()` |
| System/developer message filter | `msg.role === 'system'` | `isSystemRole(msg.role)` (handles `developer` role) |
| Formatted message content | `content: msg.content,` | `content: normalizeContent(msg.content),` |
| User message chatModeEnum | `chatModeEnum: 1` | `chatModeEnum: 2` |
| Global chatModeEnum | `chatModeEnum: 1,` | `chatModeEnum: 2,` |
| Global chatMode | `chatMode: "Ask"` | `chatMode: "Agent"` |

**`src/routes/v1.js`:**

| Change | Stock Value | Patched Value |
|---|---|---|
| Client version (2 locations) | `"0.48.7"` | `"2.4.28"` |
| Imports from `toolEmulation.js` | N/A | `parseToolCalls`, `hasToolCallTags`, `normalizeNearMissToolCalls` |
| Debug logging | N/A | Logs tools, tool_choice, message roles, response preview, tool-miss warnings |
| Extracts `tools`, `tool_choice` from request | N/A | Destructured from `req.body` |
| Passes `tools` + `tool_choice` to `generateCursorBody()` | `generateCursorBody(messages, model)` | `generateCursorBody(messages, model, tools, tool_choice)` |
| Near-miss normalization | N/A | Applies `normalizeNearMissToolCalls()` before tool detection |
| Streaming response handling | Real-time streaming | Always buffers full response, checks for `<tool_call>` tags |
| Non-streaming response handling | Returns text only | Checks for `<tool_call>` tags, returns `tool_calls` in response |

---

## Step 4: Check Available Models

Query the proxy for available models:

```bash
curl -s -H "Authorization: Bearer YOUR_COOKIE_HERE" http://127.0.0.1:3010/v1/models | python3 -m json.tool
```

### Available Claude Models (Chat Completions)

| Model ID | Description |
|---|---|
| `claude-4.6-opus-max` | Claude 4.6 Opus — highest capability (tested, confirmed working) |
| `claude-4.6-opus-max-thinking` | Claude 4.6 Opus with extended thinking |
| `claude-4.6-opus-high` | Claude 4.6 Opus — high tier |
| `claude-4.6-opus-high-thinking` | Claude 4.6 Opus high with thinking |
| `claude-4.6-opus-max-thinking-fast` | Claude 4.6 Opus max thinking (fast variant) |
| `claude-4.6-opus-high-thinking-fast` | Claude 4.6 Opus high thinking (fast variant) |
| `claude-4.5-opus-high` | Claude 4.5 Opus — high tier |
| `claude-4.5-opus-high-thinking` | Claude 4.5 Opus with thinking |
| `claude-4.5-sonnet` | Claude 4.5 Sonnet |
| `claude-4.5-sonnet-thinking` | Claude 4.5 Sonnet with thinking |
| `claude-4.5-haiku` | Claude 4.5 Haiku (fastest, cheapest) |
| `claude-4.5-haiku-thinking` | Claude 4.5 Haiku with thinking |
| `claude-4-sonnet` | Claude 4 Sonnet |
| `claude-4-sonnet-thinking` | Claude 4 Sonnet with thinking |
| `claude-4-sonnet-1m` | Claude 4 Sonnet 1M context |
| `claude-4-sonnet-1m-thinking` | Claude 4 Sonnet 1M with thinking |

> Model availability depends on your Cursor plan (free vs Pro vs Business). The `-thinking` models include extended thinking/reasoning traces.

---

## Step 5: Configure OpenClaw

Edit the OpenClaw configuration:

```bash
nano /opt/openclaw/config/openclaw.json
```

The key sections to add/modify:

### Custom Provider Definition

Add a `models` section at the root level to register a custom `cursor` provider:

```json
"models": {
  "mode": "merge",
  "providers": {
    "cursor": {
      "baseUrl": "http://127.0.0.1:3010/v1",
      "apiKey": "YOUR_FULL_CURSOR_COOKIE_HERE",
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
}
```

### Model Selection

Set your primary model and fallback:

```json
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
    }
  }
}
```

> **Important:** The model format is `cursor/<model-id>`. The `cursor/` prefix tells OpenClaw to use the custom provider. The model ID after the slash must match the `id` field in the provider's `models` array.

### Why a Custom Provider Is Required

OpenClaw has a built-in model registry and rejects unknown model names (error: `Unknown model: openai/...`). Standard provider prefixes like `openai/` or `anthropic/` only work with models in OpenClaw's internal catalog.

By defining a custom `cursor` provider via `models.providers`, OpenClaw accepts any model ID registered in that provider's definition without built-in validation.

---

## Step 6: Restart and Test

```bash
docker restart openclaw
```

Wait a few seconds, then verify:

```bash
docker logs openclaw --tail 10
```

You should see: `[gateway] agent model: cursor/claude-4.6-opus-max`

Send a message via Telegram, WebChat, or Discord. Check proxy logs:

```bash
docker logs cursor-proxy --tail 10
```

You should see successful `POST /v1/chat/completions 200` entries. For tool-calling requests, look for:

```
[ToolEmulation] Parsed 1 tool call(s): exec
[chat/completions] Response contains 1 tool call(s), hasTools=true
```

This confirms the full tool emulation pipeline is working: OpenClaw sends tools, the model outputs `<tool_call>` tags, the proxy parses them, and OpenClaw executes the tool.

---

## Full Example: openclaw.json

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
      "workspace": "/home/node/.openclaw/workspace",
      "memorySearch": {
        "provider": "openai",
        "model": "text-embedding-3-small"
      },
      "maxConcurrent": 4,
      "subagents": {
        "maxConcurrent": 8
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
        "apiKey": "YOUR_FULL_CURSOR_COOKIE_HERE",
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
  "commands": {
    "native": "auto",
    "nativeSkills": "auto"
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "streamMode": "partial"
    }
  },
  "gateway": {
    "port": 18789,
    "bind": "lan",
    "controlUi": {
      "allowInsecureAuth": true
    },
    "auth": {
      "mode": "token"
    }
  },
  "messages": {
    "ackReactionScope": "group-mentions"
  },
  "plugins": {
    "entries": {
      "telegram": {
        "enabled": true
      }
    }
  },
  "meta": {
    "lastTouchedVersion": "2026.2.4",
    "lastTouchedAt": "2026-02-09T21:50:59.488Z"
  }
}
```

---

## Troubleshooting

### "Internal server error" — no response from agent

Check the proxy logs:

```bash
docker logs cursor-proxy --tail 20
```

| Proxy Error | Cause | Fix |
|---|---|---|
| `request.messages.content: string expected` | Missing content normalization patch | Apply Fix 1 — ensure `normalizeContent()` is in `utils.js` |
| `"Please update to the latest version of Cursor"` | Outdated client version | Apply Fix 2 — update `cursorClientVersion` in `v1.js` to match your Cursor IDE version |
| Agent says "I'm in ask mode, read-only" | Proxy sends `chatMode: "Ask"` to Cursor | Apply Fix 3 — change to `chatMode: "Agent"` and `chatModeEnum: 2` in `utils.js` |
| Agent can talk but cannot use tools (exec, read, write) | Proxy lacks OpenAI tool calling support | Apply Fix 4 — ensure `toolEmulation.js` exists and is mounted, and `utils.js`/`v1.js` import it |
| `401 Unauthorized` | Cookie expired | Repeat Step 1 on your PC to get a fresh cookie, update `apiKey` in config, restart |
| `resource_exhausted` / rate limit | Hit Cursor's rate limit | Wait, or switch to a different model |

### "Unknown model: openai/..." or "Unknown model: cursor/..."

Model name not in OpenClaw's registry. Ensure:
1. The custom `cursor` provider is defined in `models.providers`
2. The model `id` in the provider matches what you use after `cursor/`
3. The model is in the `agents.defaults.models` allowlist

### Agent shows "typing" but no response

Check both logs:

```bash
docker logs cursor-proxy --tail 10  # proxy errors
docker logs openclaw --tail 10      # openclaw errors
```

### Agent can talk but tools don't work (no background tasks)

The agent responds to messages but cannot execute commands, read/write files, or perform background tasks. In the OpenClaw UI or Telegram, the agent may say things like "I can see tools listed but I'm unable to invoke them" or "every time I say running... nothing actually happens."

**Cause:** The stock proxy only supports plain chat completions. OpenClaw requires the OpenAI tool calling API (`tools` / `tool_calls`) for agent mode to function.

**Fix:** Re-clone the patched repo and redeploy:

```bash
cd /opt/cursor-proxy-patched && git pull
cp src/utils/utils.js /opt/cursor-proxy-utils.js
cp src/routes/v1.js /opt/cursor-proxy-v1.js
cp src/utils/toolEmulation.js /opt/cursor-proxy-toolEmulation.js
docker stop cursor-proxy && docker rm cursor-proxy

docker run -d \
  --name cursor-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3010:3010 \
  -v /opt/cursor-proxy-utils.js:/app/src/utils/utils.js:ro \
  -v /opt/cursor-proxy-v1.js:/app/src/routes/v1.js:ro \
  -v /opt/cursor-proxy-toolEmulation.js:/app/src/utils/toolEmulation.js:ro \
  ghcr.io/jiuz-chn/cursor-to-openai:latest
```

Verify all three files are mounted:

```bash
docker exec cursor-proxy ls -la /app/src/utils/toolEmulation.js /app/src/utils/utils.js /app/src/routes/v1.js
```

### Cookie Refresh

When your cookie expires (agent stops responding, proxy shows 401):

1. On your Windows PC:
   ```powershell
   cd Cursor-To-OpenAI
   npm run login
   ```
2. Copy the new cookie
3. SSH into droplet and update `/opt/openclaw/config/openclaw.json` — change the `apiKey` value in the `cursor` provider
4. `docker restart openclaw`

---

## Important Caveats

1. **Cookie expiration**: The Cursor cookie expires periodically. You'll need to re-run `npm run login` on your Windows PC and update the cookie on the droplet.
2. **Rate limits**: Cursor has rate limits (e.g., 150 fast premium requests on free tier, 500 on Pro). Heavy agent use with tool calling can exhaust these very quickly — each tool call round-trip is a separate API request.
3. **Terms of Service**: This operates against Cursor's ToS. Your account could be banned.
4. **Private API dependency**: The proxy depends on Cursor's private API (`api2.cursor.sh`). Any changes on their end could break it without warning.
5. **Version drift**: When Cursor releases new versions, the proxy's `cursorClientVersion` may need updating to avoid blocks.
6. **PC not required**: After setup, your local Windows PC can be turned off. Everything runs on the droplet. You only need your PC to refresh the cookie.
7. **Tool emulation reliability**: Tool calling is emulated via text prompts — NOT native OpenAI tool calling. The model is instructed with a mandatory protocol (including explicit WRONG/CORRECT examples) to output `<tool_call>` XML tags, which the proxy parses back into OpenAI `tool_calls` format. The proxy also auto-recovers near-miss formats (`[tool_call]`, `<function_call>`, bare JSON), unclosed tags, and markdown-wrapped JSON. A deterministic parameter auto-correction layer (`validateAndFixToolArgs`) remaps common model mistakes (e.g., `file_path`→`path`, `old_string`→`oldText`, `cmd`→`command`) — the alias map was verified against the [OpenClaw source code](https://github.com/openclaw/openclaw/blob/main/src/agents/pi-tools.read.ts) on 2026-02-06. Claude 4.6 Opus handles this format very well, but it is not as deterministic as native tool calling. If the proxy logs show `WARNING: Tools were provided but model did not output any <tool_call> tags`, retry the request.
8. **Streaming delay**: ALL responses are buffered (not streamed in real-time) because the proxy needs the full response to detect `<tool_call>` tags. The user sees the complete response at once rather than word-by-word. This is a necessary trade-off for reliable tool detection.
9. **OpenClaw `tools` parameter**: Confirmed working — OpenClaw v2026.2.4 sends all 24 tools (`read, edit, write, exec, process, browser, canvas, nodes, cron, message, tts, gateway, agents_list, sessions_list, sessions_history, sessions_send, sessions_spawn, session_status, web_search, web_fetch, image, memory_search, memory_get`) in the request. The previous bug (#1866) is fixed in this version.

---

## Debugging

### Check what OpenClaw sends to the proxy

The proxy logs every request with details:

```bash
docker logs cursor-proxy --tail 20
```

You should see lines like:

```
[chat/completions] model=claude-4.6-opus-max stream=true tools=[read, edit, write, exec, ...] tool_choice=null messages={"developer":1,"assistant":1,"user":1}
```

> Note: OpenClaw sends `role: "developer"` (newer OpenAI API format), not `role: "system"`. The proxy handles both.

**What to look for:**
- `tools=[read, edit, write, exec, ...]` → OpenClaw IS sending tools (confirmed working in v2026.2.4).
- `tools=[NONE]` → OpenClaw is NOT sending tool definitions. The proxy still checks for `<tool_call>` tags in case OpenClaw embeds tools in the developer message directly.
- `[ToolEmulation] Parsed N tool call(s): exec` → Tool calls were detected and converted. This confirms the emulation pipeline is working end-to-end.
- `Response preview (N chars): <tool_call>...` → Shows the raw model output. You should see `<tool_call>` tags with JSON inside.

### Check if tool calls are being detected

After the agent responds, look for:

```
[chat/completions] Response preview (109 chars): <tool_call>\n{"name": "exec", "arguments": {"command": "ls -la ..."}}\n</tool_call>
[ToolEmulation] Parsed 1 tool call(s): exec
[chat/completions] Response contains 1 tool call(s), hasTools=true
```

On the next request, you should see `"tool":1` in the messages breakdown, confirming OpenClaw sent the tool result back and the full round-trip is working.

---

## Fallback: If Tool Emulation Doesn't Work

If after testing you find the emulation is unreliable or OpenClaw doesn't recognize the emulated `tool_calls`, the guaranteed alternative is to use a real API provider that natively supports OpenAI tool calling:

1. **OpenRouter** — aggregator with pay-per-use pricing, supports Claude/GPT/etc with native tool calling. Get an API key from [openrouter.ai](https://openrouter.ai), add credit, and configure OpenClaw with the `openai-completions` API pointing to OpenRouter.
2. **Anthropic** — direct Claude API access with native tool support.
3. **OpenAI** — direct GPT API access with native tool support.

Any of these providers would give OpenClaw fully reliable tool calling without the emulation layer.

---

*Guide created: February 2026. Last updated: February 10, 2026. Patched repo: [github.com/pwnapplehat/cursor-proxy-patched](https://github.com/pwnapplehat/cursor-proxy-patched). Cursor-To-OpenAI v2.5.x. OpenClaw v2026.2.4.*
