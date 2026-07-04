# Not maintained anymore, Use https://github.com/pwnapplehat/Cursor-OpenAI 

# Cursor-To-OpenAI (Patched Fork)

> Patched fork of [JiuZ-Chn/Cursor-To-OpenAI](https://github.com/JiuZ-Chn/Cursor-To-OpenAI) with six fixes for full [OpenClaw](https://openclaw.io) agent compatibility — including tool calling emulation, agent mode, and developer role handling.

Convert Cursor IDE's AI models into an OpenAI-compatible API with full tool calling support.

## What This Fork Adds

The stock Cursor-To-OpenAI proxy only supports basic chat completions (text in, text out). This fork adds six core patches plus reliability enhancements that make it fully compatible with OpenClaw's agent mode:

| Fix | File(s) | Problem | Solution |
|-----|---------|---------|----------|
| 1. Content Array Normalization | `utils.js` | `request.messages.content: string expected` — OpenClaw sends array content, protobuf needs strings | Added `normalizeContent()` helper |
| 2. Client Version Update | `v1.js` | `"Please update to the latest version of Cursor"` — stock hardcodes `0.48.7` | Updated to `2.4.28` |
| 3. Agent Mode | `utils.js` | Model says "I'm in ask mode, read-only" — stock sends `chatMode: "Ask"` | Changed to `chatMode: "Agent"`, `chatModeEnum: 2` |
| 4. Tool Call Emulation | `toolEmulation.js`, `utils.js`, `v1.js` | Agent can talk but cannot execute tools — no OpenAI tool calling support | Full emulation layer via `<tool_call>` XML tags |
| 5. Developer Role Handling | `utils.js`, `toolEmulation.js` | Tool definitions injected but model never uses them — OpenClaw sends `role: "developer"` not `"system"` | Added `isSystemRole()` helper matching both roles |
| 6. Robust Tool Call Parsing | `toolEmulation.js` | `Failed to parse tool call JSON` — model talks ABOUT `<tool_call>` tags in conversation | `sanitizeForParsing()` + balanced brace JSON extraction + smart quote handling |

### Reliability Enhancements

Beyond the six core fixes, the emulation layer includes these reliability features:

- **Mandatory tool calling protocol** — aggressive system prompt with explicit WRONG/CORRECT examples to maximize model compliance
- **Balanced brace JSON extraction** — handles nested objects in tool arguments (e.g., `{"command": "echo {hello}"}`) where regex fails
- **Unclosed `<tool_call>` block recovery** — if the model output is cut off mid-tag, auto-closes braces and attempts parse
- **Markdown fence stripping** — handles models wrapping JSON in `` ```json `` code blocks inside `<tool_call>` tags
- **Near-miss format normalization** — auto-corrects `[tool_call]`, `<function_call>`, `<tool-call>`, and bare JSON tool calls to standard format
- **Parameter auto-correction** — deterministic alias map (verified against [OpenClaw source](https://github.com/openclaw/openclaw/blob/main/src/agents/pi-tools.read.ts)) remaps common model mistakes (`file_path`→`path`, `old_string`→`oldText`, `cmd`→`command`, etc.) with a safety guard that only fires when the wrong key is genuinely absent from the tool schema
- **UUID-based tool_call IDs** — proper unique IDs instead of timestamp-based (avoids collisions on rapid multi-tool calls)
- **Warning logging** — alerts when tools were expected but the model didn't output any `<tool_call>` tags

## Architecture

```
Your Cursor Account
        ↓ (cookie auth)
Cursor-To-OpenAI Proxy (this repo)
  ├── Translates OpenAI chat/completions ↔ Cursor protobuf
  ├── Emulates tool calling via <tool_call> XML tags in text
  └── Converts model text output → OpenAI tool_calls format
        ↓ (OpenAI-compatible API with tool emulation)
OpenClaw Agent / Any OpenAI-compatible client
```

### How Tool Emulation Works

```
Client sends:    { tools: [...], messages: [...] }
                         ↓
Proxy injects:   Tool definitions appended to system prompt as text instructions
                         ↓
Cursor model:    Sees instructions, outputs <tool_call>{"name":"exec","arguments":{"command":"ls"}}</tool_call>
                         ↓
Proxy parses:    Detects <tool_call> tags → converts to OpenAI tool_calls format
                         ↓
Client receives: { tool_calls: [{ function: { name: "exec", arguments: ... } }] }
                         ↓
Client executes the tool, sends result back as role: "tool" message
                         ↓
Proxy converts:  role: "tool" → role: "user" with <tool_result> tags
                         ↓
Cycle repeats until task is complete
```

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- A [Cursor](https://www.cursor.com) account (free or paid)

## Step 1: Get Your Cursor Cookie

```bash
npm install
npm run login
```

This prints a URL:

```
[Log] Please open the following URL in your browser to login:
https://www.cursor.com/loginDeepControl?challenge=...&uuid=...&mode=login
```

1. Copy the URL and open it in your browser
2. Log in with your Cursor account
3. Wait — the terminal polls every 5 seconds (up to 60 attempts)
4. When it detects your login, it prints your cookie:

```
[Log] Login successfully. Your Cursor cookie:
user_01JJF...%3A%3AeyJhbGci...
```

5. **Copy the entire cookie string** and save it somewhere safe.

> The cookie expires periodically. Repeat this step to get a fresh one when needed.

### Alternative: API-based Cookie Retrieval

If you already have `WorkosCursorSessionToken` from your browser cookies:

- URL: `http://localhost:3010/cursor/loginDeepControl`
- Method: `GET`
- Auth: `Bearer Token` (value of `WorkosCursorSessionToken`)
- Response: JSON — the `accessToken` field is your Cursor Cookie

## Step 2: Run the Proxy

### Option A: Docker with patched files mounted (recommended for OpenClaw)

First, clone this repo on your server:

```bash
git clone https://github.com/pwnapplehat/cursor-proxy-patched.git
cd cursor-proxy-patched
```

Copy the patched files and run the stock Docker image with mounts:

```bash
cp src/utils/utils.js /opt/cursor-proxy-utils.js
cp src/routes/v1.js /opt/cursor-proxy-v1.js
cp src/utils/toolEmulation.js /opt/cursor-proxy-toolEmulation.js

docker run -d \
  --name cursor-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3010:3010 \
  -v /opt/cursor-proxy-utils.js:/app/src/utils/utils.js:ro \
  -v /opt/cursor-proxy-v1.js:/app/src/routes/v1.js:ro \
  -v /opt/cursor-proxy-toolEmulation.js:/app/src/utils/toolEmulation.js:ro \
  ghcr.io/jiuz-chn/cursor-to-openai:latest
```

### Option B: Run directly with npm

```bash
npm install
npm run start
```

### Option C: Stock Docker (no patches — basic chat only, no tool calling)

```bash
docker run -d --name cursor-to-openai -p 3010:3010 ghcr.io/jiuz-chn/cursor-to-openai:latest
```

> Option C uses the unpatched stock image. It works for basic chat completions but does NOT support agent mode, tool calling, or OpenClaw.

## Step 3: Verify

```bash
# Check it's running
docker logs cursor-proxy --tail 5
# Should see: The server listens port: 3010

# List available models
curl -s -H "Authorization: Bearer YOUR_COOKIE_HERE" http://127.0.0.1:3010/v1/models | python3 -m json.tool
```

## API Endpoints

### GET `/v1/models`

Returns available Cursor models.

- Auth: `Bearer <cursor-cookie>`

### POST `/v1/chat/completions`

OpenAI-compatible chat completions endpoint.

- Auth: `Bearer <cursor-cookie>` (supports comma-separated values for rotation)
- Body: Standard OpenAI chat completion request, including `tools` and `tool_choice`

**Supported request fields:**

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Model ID from `/v1/models` |
| `messages` | array | Chat messages (supports `role: "system"`, `"developer"`, `"user"`, `"assistant"`, `"tool"`) |
| `stream` | boolean | Stream response (default: false) |
| `tools` | array | OpenAI tool/function definitions (emulated via text) |
| `tool_choice` | string/object | Tool choice constraint (`"auto"`, `"required"`, `{"type": "function", "function": {"name": "..."}}`) |

**Response:** Standard OpenAI chat completion response. When tool calls are detected, the response includes `tool_calls` in the assistant message with `finish_reason: "tool_calls"`.

## Available Claude Models

| Model ID | Description |
|----------|-------------|
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
| `claude-4.5-haiku` | Claude 4.5 Haiku (fastest) |
| `claude-4.5-haiku-thinking` | Claude 4.5 Haiku with thinking |
| `claude-4-sonnet` | Claude 4 Sonnet |
| `claude-4-sonnet-thinking` | Claude 4 Sonnet with thinking |
| `claude-4-sonnet-1m` | Claude 4 Sonnet 1M context |
| `claude-4-sonnet-1m-thinking` | Claude 4 Sonnet 1M with thinking |

> Model availability depends on your Cursor plan (free vs Pro vs Business). The `-thinking` models include extended thinking/reasoning. Many GPT and Gemini models are also available — run `/v1/models` to see the full list.

## OpenClaw Setup

For a complete step-by-step guide on configuring OpenClaw to use this proxy (custom provider definition, `openclaw.json` config, troubleshooting), see:

**[docs/cursor-to-openclaw-setup-guide.md](docs/cursor-to-openclaw-setup-guide.md)**

### Quick OpenClaw Config

Add a custom `cursor` provider in your `openclaw.json`:

```json
{
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
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "cursor/claude-4.6-opus-max"
      }
    }
  }
}
```

> The `cursor/` prefix tells OpenClaw to route to the custom provider. The model ID after the slash must match the `id` in the provider's `models` array.

## Python Example

```python
from openai import OpenAI

client = OpenAI(
    api_key="user_01JJF...YOUR_CURSOR_COOKIE...",
    base_url="http://localhost:3010/v1"
)

# Basic chat
response = client.chat.completions.create(
    model="claude-4.6-opus-max",
    messages=[
        {"role": "user", "content": "Hello!"},
    ],
    stream=False
)
print(response.choices[0].message.content)

# With tool calling (emulated)
response = client.chat.completions.create(
    model="claude-4.6-opus-max",
    messages=[
        {"role": "user", "content": "What files are in the current directory?"},
    ],
    tools=[{
        "type": "function",
        "function": {
            "name": "exec",
            "description": "Execute a shell command",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The command to run"}
                },
                "required": ["command"]
            }
        }
    }],
    stream=False
)

# If the model decides to use a tool, response will have tool_calls
msg = response.choices[0].message
if msg.tool_calls:
    for tc in msg.tool_calls:
        print(f"Tool: {tc.function.name}, Args: {tc.function.arguments}")
else:
    print(msg.content)
```

## Updating the Patched Files

When you push fixes to this repo, update the running deployment:

```bash
cd /opt/cursor-proxy-patched && git pull
cp src/utils/utils.js /opt/cursor-proxy-utils.js
cp src/routes/v1.js /opt/cursor-proxy-v1.js
cp src/utils/toolEmulation.js /opt/cursor-proxy-toolEmulation.js
docker restart cursor-proxy
```

## Debug Logging

The proxy logs every request for debugging:

```bash
docker logs cursor-proxy --tail 20
```

Example output:

```
[chat/completions] model=claude-4.6-opus-max stream=true tools=[read, edit, write, exec, ...] tool_choice=null messages={"developer":1,"assistant":1,"user":1}
[chat/completions] Response preview (109 chars): <tool_call>\n{"name": "exec", "arguments": {"command": "ls -la ..."}}\n</tool_call>
[ToolEmulation] Parsed 1 tool call(s): exec
[chat/completions] Response contains 1 tool call(s), hasTools=true
```

**What to look for:**
- `tools=[read, edit, ...]` — Client is sending tool definitions (good)
- `tools=[NONE]` — No tool definitions sent; proxy still checks for `<tool_call>` tags in output
- `[ToolEmulation] Parsed N tool call(s)` — Tool calls detected and converted
- `Response preview` — Raw model output; should show `<tool_call>` tags with JSON inside

## Patched Files Reference

### `src/utils/toolEmulation.js` (new file)

| Function | Purpose |
|----------|---------|
| `formatToolDefinitions(tools, toolChoice)` | Converts OpenAI tool definitions to system prompt text with mandatory protocol, handles `tool_choice` constraints |
| `injectToolsIntoMessages(messages, tools, toolChoice)` | Appends tool instructions to system/developer message |
| `convertToolResultMessages(messages)` | Converts `role: "tool"` → `role: "user"` with `<tool_result>` tags |
| `sanitizeForParsing(text)` | Strips backtick-wrapped and code-fenced `<tool_call>` references before parsing |
| `extractJsonObject(str)` | Balanced brace JSON extraction (handles nested objects where regex fails) |
| `stripMarkdownFences(str)` | Removes `` ```json `` fences from inside `<tool_call>` blocks |
| `parseToolCalls(text, tools)` | Parses `<tool_call>` XML from model text → OpenAI `tool_calls` format (with unclosed tag recovery and parameter auto-correction) |
| `tryParseToolCallContent(raw, tools)` | Attempts to parse a single `<tool_call>` block's inner content with all normalization |
| `validateAndFixToolArgs(toolName, args, tools)` | Deterministic parameter auto-correction verified against OpenClaw source — remaps `file_path`→`path`, `old_string`→`oldText`, `cmd`→`command`, etc. with 4-condition safety guard |
| `hasToolCallTags(text)` | Detects actual `<tool_call>` tags (ignoring backtick-wrapped references) |
| `normalizeNearMissToolCalls(text)` | Converts `[tool_call]`, `<function_call>`, `<tool-call>`, and bare JSON to standard format |

### `src/utils/utils.js` changes

| Change | Stock Value | Patched Value |
|--------|-------------|---------------|
| Added `normalizeContent()` helper | N/A | Converts array/string content to plain string |
| Added `isSystemRole()` helper | N/A | Matches both `"system"` and `"developer"` roles |
| Imports from `toolEmulation.js` | N/A | `injectToolsIntoMessages`, `convertToolResultMessages` |
| `generateCursorBody()` signature | `(messages, modelName)` | `(messages, modelName, tools, toolChoice)` |
| Pre-processes messages for tools | N/A | `convertToolResultMessages()` then `injectToolsIntoMessages()` |
| System/developer message filter | `msg.role === 'system'` | `isSystemRole(msg.role)` |
| Formatted message content | `content: msg.content` | `content: normalizeContent(msg.content)` |
| User message chatModeEnum | `chatModeEnum: 1` | `chatModeEnum: 2` |
| Global chatModeEnum | `chatModeEnum: 1` | `chatModeEnum: 2` |
| Global chatMode | `chatMode: "Ask"` | `chatMode: "Agent"` |

### `src/routes/v1.js` changes

| Change | Stock Value | Patched Value |
|--------|-------------|---------------|
| Client version (2 locations) | `"0.48.7"` | `"2.4.28"` |
| Imports from `toolEmulation.js` | N/A | `parseToolCalls`, `hasToolCallTags`, `normalizeNearMissToolCalls` |
| Debug logging | N/A | Logs tools, tool_choice, message roles, response preview, tool-miss warnings |
| Extracts `tools`, `tool_choice` from request | N/A | Destructured from `req.body` |
| Passes `tools` + `tool_choice` to `generateCursorBody()` | `generateCursorBody(messages, model)` | `generateCursorBody(messages, model, tools, tool_choice)` |
| Streaming response handling | Real-time streaming | Always buffers full response, checks for `<tool_call>` tags |
| Non-streaming response handling | Returns text only | Checks for `<tool_call>` tags, returns `tool_calls` in response |

## Important Caveats

1. **Cookie expiration**: The Cursor cookie expires periodically. Re-run `npm run login` to get a fresh one.
2. **Rate limits**: Cursor has rate limits (150 fast premium on free, 500 on Pro). Each tool call round-trip counts as a separate request.
3. **Terms of Service**: This operates against Cursor's ToS. Your account could be banned.
4. **Private API dependency**: Depends on Cursor's private API (`api2.cursor.sh`). Changes on their end could break it.
5. **Version drift**: When Cursor updates, the `cursorClientVersion` in `v1.js` may need updating. Check your Cursor version in **Help > About**.
6. **Tool emulation reliability**: Tool calling is emulated via text, not native OpenAI tool calling. Claude 4.6 Opus handles this very well, but it is not 100% deterministic. Occasionally the model may describe what it would do instead of emitting the `<tool_call>` tag.
7. **Streaming delay**: ALL responses are buffered (not streamed in real-time) because the proxy needs the full response to detect `<tool_call>` tags. This is a necessary trade-off for reliable tool detection.

## Notes

- Keep your Cursor cookie safe and do not share it
- This project is for study and research only — please abide by the Cursor Terms of Use

## Acknowledgements

- Original project: [JiuZ-Chn/Cursor-To-OpenAI](https://github.com/JiuZ-Chn/Cursor-To-OpenAI)
- Based on [cursor-api](https://github.com/zhx47/cursor-api) by zhx47
- Integrates commits from [cursor-api](https://github.com/lvguanjun/cursor-api) by lvguanjun

---

*Last updated: February 10, 2026. Cursor-To-OpenAI v2.5.x. Patched for OpenClaw v2026.2.4.*
