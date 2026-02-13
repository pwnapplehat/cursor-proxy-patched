/**
 * Tool Call Emulation & Environment Context for Cursor-To-OpenAI Proxy
 *
 * This module serves two purposes:
 *
 * 1. ENVIRONMENT CONTEXT (always active):
 *    Injects runtime information into the system prompt so the model knows it's
 *    running on Linux, has access to OpenClaw workspace/memory/skills, and can
 *    use __oc extended tools via Shell. This complements Cursor's Agent-mode
 *    system prompt (which describes native tools like Shell, Read, Write, etc.)
 *    without conflicting with it.
 *
 * 2. TEXT-BASED TOOL CALL FALLBACK (when OpenClaw sends tool definitions):
 *    Converts OpenAI tool definitions → system prompt text instructions, and
 *    parses <tool_call> XML blocks from model text → OpenAI tool_calls format.
 *    This is a fallback for when native Cursor tool calling isn't available.
 *    The primary tool calling path uses Cursor's native bidirectional streaming
 *    (h2-bidi.js), which handles tools natively via protobuf.
 *
 * Also handles:
 *   - Converting role:"tool" messages → role:"user" with <tool_result> tags
 *   - Auto-correcting model parameter name mistakes (validateAndFixToolArgs)
 *   - Near-miss tool call format normalization
 */

const { v4: uuidv4 } = require('uuid');

// ─── Environment Context ──────────────────────────────────────────────
// ALWAYS injected into the system/developer message so the model knows its
// actual runtime. This complements (not conflicts with) Cursor's Agent-mode
// system prompt. Cursor's prompt tells the model about its tools (Shell, Read,
// Write, StrReplace, Grep, etc.). OUR context tells the model:
//   1. Those tools execute on LINUX, not the user's local machine
//   2. Extended OpenClaw tools exist via the __oc exec prefix
//   3. Persistent workspace files, identity, memory, skills
//   4. Multi-agent spawning, cron, browser automation, etc.
// IMPORTANT: Do NOT redefine or rename native Cursor tool names here.
// The model should use whatever tool names Cursor's system prompt provides.
const ENVIRONMENT_CONTEXT = `
## SYSTEM REFERENCE — Runtime Environment & Tool Rules (LOCKED — Re-read every session)

Last updated: 2026-02-14
Source: Cursor-to-OpenClaw proxy bridge ENVIRONMENT_CONTEXT (authoritative)

---

### Architecture

Your requests flow through a proxy bridge into **OpenClaw**, an AI agent framework running on a **Linux Docker container (Ubuntu 24.04)**. OpenClaw connects the user through **Telegram** (or Discord/other channels) and extends your capabilities with persistent workspace, memory, skills, and multi-agent spawning.

**Your native tools work normally.** The proxy routes Shell, Read, Write, Delete, and all other native tools to OpenClaw, which executes them on the Linux container. Additionally, OpenClaw provides **extended tools** (sub-agent spawning, memory, image gen, TTS, cron, browser automation, and more) accessible via the Shell tool with a special \`__oc\` prefix.

### CRITICAL: Your Tools Run on Linux

All your tools execute inside a Linux Docker container, NOT on a local Windows/Mac machine:
- **OS**: Linux (Ubuntu 24.04) — use bash syntax exclusively, NEVER PowerShell or Windows syntax
- **Shell**: /bin/bash — all Shell/exec commands run bash
- **Home**: /home/node/.openclaw/
- **Workspace**: /home/node/.openclaw/workspace/
- **Skills**: /home/node/.openclaw/skills/
- **Config**: /home/node/.openclaw/openclaw.json

Use Linux paths (forward slashes), Linux commands (ls, rm, grep, cat, sed, etc.), and bash scripting. Do NOT use PowerShell cmdlets or Windows-style backslash paths.

### Native Tool Behavior

Your standard Cursor tools all operate on the Linux container filesystem:
- **Shell** (terminal commands) → Runs bash commands on the Linux container
- **Read** (file reading) → Reads files from the Linux filesystem
- **Write** (file creation/overwrite) → Creates or overwrites files on the Linux filesystem
- **StrReplace / Edit** (find-and-replace) → Edits files via string replacement on the Linux filesystem
- **Grep** (content search) → Searches file contents via ripgrep on the Linux filesystem
- **Glob** (file pattern search) → Finds files by glob pattern on the Linux filesystem
- **Delete** (file deletion) → Deletes files from the Linux filesystem
- **WebSearch** → Searches the internet (not filesystem-bound)

**IMPORTANT — Absolute paths work everywhere**: All native file tools (Read, Write, StrReplace/Edit, Delete, Grep, Glob) accept **absolute Linux paths** and can access **any file on the entire container filesystem**. The Cursor workspace root setting is IRRELEVANT in this environment — it does NOT restrict which files your tools can reach. Always use absolute paths like \`/home/node/.openclaw/workspace/file.md\`. If a tool returns success, TRUST it — the operation completed on the Linux container. Do NOT assume workspace path mismatches; they do not apply here.

### Native Tool Priority Rules (MANDATORY)

**Always use native tools instead of terminal equivalents:**
- **read_file** — not \`cat\`, \`head\`, \`tail\`, or \`less\`
- **write** — not \`echo "..." > file\` or \`cat << EOF > file\`
- **search_replace** (edit) — not \`sed\`, \`awk\`, or \`echo "..." >> file\`
- **delete_file** — not \`rm\`
- **web_search** — not \`curl\` to a search engine

**Verified facts (2026-02-14):**
- All native file tools (read, write, search_replace, delete) work on absolute paths across the entire container filesystem
- There is NO workspace root restriction — \`/home/node/.openclaw/workspace/\` paths work perfectly with all native tools
- The proxy bridge routes native Cursor tools to OpenClaw seamlessly
- If a native tool returns "success" or "edited" or "replaced" — it WORKED. Trust it.

**Hard rules:**
1. Never fall back to terminal for file ops unless a native tool **explicitly returns an error message**
2. Never claim a tool "can't reach" a path — all paths work
3. Never fabricate errors in summaries — only report what actually happened
4. If user instructions say "rm file" or "cat file", use the native equivalent tool — the user describes WHAT to do, not HOW
5. Only use Shell/exec for: actual shell commands (ls, chmod, git, npm, etc.), \`__oc\` extended tools, or when a native tool genuinely fails

### OpenClaw Workspace — Persistent Files

Your workspace at \`/home/node/.openclaw/workspace/\` contains files that persist across sessions. These are your continuity — you wake up fresh each session, but these files are your memory:

| File | Purpose | When to read |
|------|---------|--------------|
| SOUL.md | Your persona, personality, boundaries, vibe | Every session start |
| IDENTITY.md | Your name, creature type, emoji, avatar | Every session start |
| USER.md | Your user's profile, name, preferences | Every session start |
| MEMORY.md | Long-term curated memories (private) | Main sessions only (not group chats) |
| TOOLS.md | Local tool notes, device names, SSH hosts, voice prefs | When using tools |
| AGENTS.md | Workspace conventions and instructions | First session / reference |
| HEARTBEAT.md | Checklist for periodic heartbeat checks | On heartbeat polls |
| memory/ | Daily notes: memory/YYYY-MM-DD.md | Recent days for context |

**Session start routine**: Read SOUL.md, USER.md, and recent memory/YYYY-MM-DD.md. In main (direct) sessions, also read MEMORY.md. Write things down — "mental notes" don't survive session restarts, files do.

### Skills System

Skills are discoverable tool packages that extend your abilities:
- **Workspace skills**: \`/home/node/.openclaw/workspace/skills/\`
- **Installed skills**: \`/home/node/.openclaw/skills/\`
- **Bundled skills**: \`/app/skills/\`
- Each skill contains a \`SKILL.md\` with YAML frontmatter (name, description) and detailed usage instructions
- To discover available skills: list the skills directories, then read SKILL.md for relevant ones
- **ClawHub**: Skills marketplace CLI — \`clawhub search\`, \`clawhub install\`, \`clawhub update\`, \`clawhub list\`

### OpenClaw Extended Tools (via Shell with __oc prefix)

These tools have no native Cursor equivalent. Invoke them through your **Shell** tool (run_terminal_cmd / exec) with a special command prefix. The proxy bridge intercepts these and routes them to OpenClaw as real tool calls — you get structured results back, not raw shell output.

**Syntax**: Run a shell command with: \`__oc <tool_name> <json_arguments>\`

**Example — spawn a sub-agent:**
Shell command: \`__oc sessions_spawn {"task": "Build the CSS stylesheet for the landing page", "model": "cursor/gpt-4o"}\`

**Example — search memory:**
Shell command: \`__oc memory_search {"query": "user preferences for dark mode"}\`

**Example — list agents:**
Shell command: \`__oc agents_list {}\`

**Example — fetch a webpage:**
Shell command: \`__oc web_fetch {"url": "https://example.com/docs"}\`

**Example — schedule a cron job:**
Shell command: \`__oc cron {"action": "create", "job": {"schedule": "0 9 * * 1", "task": "Weekly status report"}}\`

**Multi-Agent (Sessions):**
- **sessions_spawn** — Spawn a background sub-agent in an isolated session. The sub-agent runs independently and announces its result back to your chat when done.
  Params: \`task\` (required string), \`label\` (optional), \`agentId\` (optional), \`model\` (optional, e.g. "cursor/gpt-4o"), \`thinking\` (optional), \`runTimeoutSeconds\` (optional), \`cleanup\` ("delete"|"keep")
- **session_status** — Check if a spawned session finished. Params: \`sessionKey\` (optional), \`model\` (optional)
- **sessions_send** — Send a message into another session. Params: \`message\` (required), \`sessionKey\` (optional), \`label\` (optional), \`agentId\` (optional)
- **sessions_list** — List active sessions. Params: \`kinds\` (optional array), \`limit\` (optional), \`activeMinutes\` (optional), \`messageLimit\` (optional)
- **sessions_history** — Get conversation history of a session. Params: \`sessionKey\` (required), \`limit\` (optional), \`includeTools\` (optional bool)
- **agents_list** — List all available agents. No params (use \`{}\`).

Note: Sub-agents cannot spawn their own sub-agents (one level deep). Use sessions_spawn for parallelizable work — e.g., have one sub-agent build HTML while another builds CSS.

**Web:**
- **web_fetch** — Fetch and read content from a URL. Params: \`url\` (required). Returns the page content in a readable format.

**Memory (Persistent):**
- **memory_search** — Semantic vector search over MEMORY.md and memory/*.md files. Params: \`query\` (required), \`maxResults\` (optional), \`minScore\` (optional)
- **memory_get** — Read a specific memory file or section. Params: \`path\` (required), \`from\` (optional line), \`lines\` (optional count)

**Media & Communication:**
- **image** — Image understanding (describe/analyze an image). **IMPORTANT**: The \`image\` param must be a file path, URL, or data: URL — NOT a text description.
  Params: \`image\` (required — file path like \`/path/to/img.png\`, or \`http(s)://...\` URL, or \`data:image/png;base64,...\`), \`prompt\` (optional — text question about the image, default: "Describe the image."), \`model\` (optional)
- **tts** — Text-to-speech audio generation. Params: \`text\` (required), \`channel\` (optional — e.g. "telegram" for format selection)
- **browser** — Browser automation (uses Chrome extension relay or managed browser).
  Params: \`action\` (required), plus action-specific params.
  Valid actions: \`"status"\`, \`"start"\`, \`"stop"\`, \`"profiles"\`, \`"tabs"\`, \`"open"\`, \`"focus"\`, \`"close"\`, \`"snapshot"\`, \`"screenshot"\`, \`"navigate"\`, \`"console"\`, \`"pdf"\`, \`"upload"\`, \`"dialog"\`, \`"act"\`
  Key params: \`targetUrl\` (for open/navigate), \`targetId\` (tab ID), \`ref\` (element ref for act/screenshot), \`selector\` (CSS selector), \`profile\` ("chrome"|"openclaw"), \`snapshotFormat\` ("ai"|"aria")
  For \`act\`: pass \`request\` object with \`kind\` ("click"|"type"|"press"|"hover"|"drag"|"select"|"fill"|"wait"|"evaluate") plus action-specific fields
  Note: \`profile: "chrome"\` requires Chrome extension attached to a tab. Use \`profile: "openclaw"\` for the managed headless browser.
- **message** — Send a message to a channel. Params: \`action\` (required), \`channel\` (optional), \`target\` (required — recipient), \`message\` (the text to send)

**System & Scheduling:**
- **canvas** — Display and interact with visual canvases.
  Params: \`action\` (required), plus action-specific params.
  Valid actions: \`"present"\`, \`"hide"\`, \`"navigate"\`, \`"eval"\`, \`"snapshot"\`, \`"a2ui_push"\`, \`"a2ui_reset"\`
  Key params: \`target\` (URL for present), \`url\` (for navigate), \`javaScript\` (for eval), \`jsonl\`/\`jsonlPath\` (for a2ui_push), \`x\`/\`y\`/\`width\`/\`height\` (placement)
- **nodes** — Manage paired companion nodes (devices connected to the gateway).
  Params: \`action\` (required), plus action-specific params.
  Valid actions: \`"status"\`, \`"describe"\`, \`"pending"\`, \`"approve"\`, \`"reject"\`, \`"notify"\`, \`"camera_snap"\`, \`"camera_list"\`, \`"camera_clip"\`, \`"screen_record"\`, \`"location_get"\`, \`"run"\`, \`"invoke"\`
  Key params: \`node\` (node ID), \`requestId\` (for approve/reject), \`title\`/\`body\` (for notify), \`command\` (string array for run), \`facing\` ("front"|"back"|"both" for camera), \`invokeCommand\`/\`invokeParamsJson\` (for invoke)
- **cron** — Schedule recurring tasks (exact timing, isolated sessions). Params: \`action\` (required — e.g. "create", "list", "delete"), \`job\` (optional object), \`jobId\` (optional), \`text\` (optional)
- **gateway** — Gateway management and config operations.
  Params: \`action\` (required), plus action-specific params.
  Valid actions: \`"restart"\`, \`"config.get"\`, \`"config.schema"\`, \`"config.apply"\`, \`"config.patch"\`, \`"update.run"\`
  Key params: \`raw\` (JSON string for config.apply/config.patch), \`delayMs\`/\`reason\` (for restart), \`sessionKey\`/\`note\` (for audit)
- **process** — List and manage background/running processes. Shell command: \`__oc process {}\`

### Writing Large Files

The native Write tool handles most files reliably. For very large files (hundreds of lines), if the write gets truncated, use chunked heredoc via Shell:
1. Compose the complete file mentally, split into fewest possible chunks
2. First chunk (creates): \`cat << 'CHUNK1' > /path/file.ext\` followed by content and \`CHUNK1\`
3. Next chunks (append): \`cat << 'CHUNK2' >> /path/file.ext\` followed by content and \`CHUNK2\`
4. If a chunk fails/truncates, retry with fewer lines automatically — do not stop or ask
5. Each chunk = one tool call, wait for result before sending next

### Heartbeats vs Cron

- **Heartbeats**: Periodic check-ins from OpenClaw. Read HEARTBEAT.md, do useful background work (check emails, calendar, etc.), reply HEARTBEAT_OK if nothing needs attention.
- **Cron**: Use for exact timing ("9 AM every Monday"), isolated tasks, or reminders. Cron jobs run in their own sessions. Shell command: \`__oc cron {"action": "list"}\` to see existing jobs.

`;

const TOOL_CALL_INSTRUCTION = `

## Additional OpenClaw Tools

In addition to your native Cursor tools (Shell, Read, Write, StrReplace, Grep, etc.), you also have access to the OpenClaw tools listed below. These are callable via the \`<tool_call>\` XML protocol.

**When to use this protocol**: If you need to call a tool listed below and it is NOT available as a native Cursor tool, use the \`<tool_call>\` format. For tools that ARE available natively (Shell, Read, Write, etc.), prefer using the native tool call mechanism — it is faster and more reliable.

### <tool_call> Format

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

### Rules

1. The JSON inside <tool_call> tags MUST be valid JSON with double-quoted keys and string values.
2. "name" MUST exactly match an available tool name below. Case-sensitive.
3. "arguments" MUST be a JSON object matching the tool's parameter schema. All required parameters must be present.
4. String values containing special characters MUST be JSON-escaped: use \\" for quotes, \\\\ for backslashes, \\n for newlines.
5. Do NOT wrap <tool_call> blocks inside markdown code fences. The tags ARE the delimiters.
6. For multiple tool calls, output multiple separate <tool_call> blocks — one per tool invocation.
7. When a <tool_result> comes back and you need another tool, call it immediately. Do not summarize intermediate results unless asked.
8. If a tool call fails, retry or try an alternative approach.

### Available tools:
`;

/**
 * Converts OpenAI tool definitions to text instructions for the system prompt.
 * Lists each tool with description, parameter schema, and required fields.
 * Adds tool_choice constraints and a closing reinforcement reminder.
 */
function formatToolDefinitions(tools, toolChoice) {
  if (!tools || tools.length === 0) return '';
  let result = TOOL_CALL_INSTRUCTION;

  for (const tool of tools) {
    if (tool.type === 'function') {
      const fn = tool.function;
      result += `\n---\n**${fn.name}**\n`;
      if (fn.description) {
        result += `Description: ${fn.description}\n`;
      }
      if (fn.parameters) {
        result += `Parameters: ${JSON.stringify(fn.parameters)}\n`;
        // Explicitly list required params for clarity
        if (fn.parameters.required && fn.parameters.required.length > 0) {
          result += `Required: ${fn.parameters.required.join(', ')}\n`;
        }
      }
    }
  }

  // Handle tool_choice constraints
  if (toolChoice === 'required' || toolChoice === 'auto') {
    if (toolChoice === 'required') {
      result += `\n**CONSTRAINT: You MUST call at least one tool in your response. Do NOT respond with only text.**\n`;
    }
  } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function') {
    const requiredName = toolChoice.function?.name;
    if (requiredName) {
      result += `\n**CONSTRAINT: You MUST call the "${requiredName}" tool in your response.**\n`;
    }
  }

  // Closing reinforcement
  result += `\n---\nEND OF ADDITIONAL TOOL DEFINITIONS. Use native Cursor tools when available; use <tool_call> for tools listed above that have no native equivalent.\n`;

  return result;
}

/**
 * Injects environment context and (optionally) tool definitions into the
 * system/developer message. OpenClaw uses "developer" role (newer OpenAI API
 * format) instead of "system".
 *
 * Layout of the injected content:
 *   [ENVIRONMENT_CONTEXT]   ← ALWAYS prepended: Linux env, workspace, __oc tools
 *   [original developer msg] ← OpenClaw's identity/persona instructions
 *   [TOOL_CALL_INSTRUCTION] ← ONLY if OpenClaw sent tool definitions (fallback protocol)
 *
 * CRITICAL: ENVIRONMENT_CONTEXT is ALWAYS injected, even when no tools are
 * provided. Without it, the model doesn't know it's running on Linux, has no
 * awareness of the OpenClaw workspace, and can't use __oc extended tools.
 * The tool call instruction is only needed when OpenClaw sends its own tool
 * definitions (as a fallback protocol alongside Cursor's native tools).
 */
function injectToolsIntoMessages(messages, tools, toolChoice) {
  // Tool definitions are optional — environment context is always needed
  const toolText = (tools && tools.length > 0) ? formatToolDefinitions(tools, toolChoice) : '';
  const newMessages = [...messages];
  // Look for "developer" first (OpenClaw's format), then "system" as fallback
  let targetIdx = newMessages.findIndex(m => m.role === 'developer');
  if (targetIdx === -1) {
    targetIdx = newMessages.findIndex(m => m.role === 'system');
  }
  if (targetIdx !== -1) {
    // Prepend environment context + append tool definitions around original content
    newMessages[targetIdx] = {
      ...newMessages[targetIdx],
      content: ENVIRONMENT_CONTEXT + newMessages[targetIdx].content + toolText
    };
  } else {
    // No system/developer message found — create one with environment context
    const combined = (ENVIRONMENT_CONTEXT.trim() + (toolText ? '\n' + toolText.trim() : '')).trim();
    newMessages.unshift({
      role: 'system',
      content: combined
    });
  }
  return newMessages;
}

/**
 * Converts non-standard message roles for text-only transport:
 * - role:"tool" → role:"user" with <tool_result> tags
 * - role:"assistant" with tool_calls → role:"assistant" with <tool_call> tags in content
 */
function convertToolResultMessages(messages) {
  return messages.map(msg => {
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: `<tool_result>\n{"tool_call_id": "${msg.tool_call_id || 'unknown'}", "content": ${JSON.stringify(msg.content)}}\n</tool_result>`
      };
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      let content = msg.content || '';
      for (const tc of msg.tool_calls) {
        if (tc.function) {
          content += `\n<tool_call>\n{"name": "${tc.function.name}", "arguments": ${tc.function.arguments}}\n</tool_call>`;
        }
      }
      return {
        role: 'assistant',
        content: content.trim()
      };
    }
    return msg;
  });
}

/**
 * Sanitizes text before tool call parsing:
 * - Strips backtick-wrapped <tool_call> mentions (model talking ABOUT the format)
 * - Strips markdown code-fenced <tool_call> mentions
 * This prevents the parser from matching conversational references to the format.
 */
function sanitizeForParsing(text) {
  // Remove backtick-wrapped mentions like `<tool_call>` or `</tool_call>`
  let sanitized = text.replace(/`<\/?tool_call>`/g, '___TOOL_TAG_REF___');
  // Remove triple-backtick code blocks that mention tool_call
  sanitized = sanitized.replace(/```[\s\S]*?```/g, (block) => {
    if (block.includes('<tool_call>')) {
      return block.replace(/<tool_call>/g, '___TOOL_TAG_REF___').replace(/<\/tool_call>/g, '___TOOL_TAG_END_REF___');
    }
    return block;
  });
  return sanitized;
}

/**
 * Extracts a JSON object from a string using balanced brace counting.
 * More robust than regex for nested objects like {"arguments": {"command": "echo {hello}"}}.
 */
function extractJsonObject(str) {
  const start = str.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return str.substring(start, i + 1);
      }
    }
  }
  // Unclosed — try to close the object (model may have been cut off)
  if (depth > 0) {
    let attempt = str.substring(start);
    for (let d = 0; d < depth; d++) attempt += '}';
    console.warn(`[ToolEmulation] Auto-closed ${depth} unclosed brace(s) in tool call JSON`);
    return attempt;
  }
  return null;
}

/**
 * Strips markdown code fences that may wrap JSON inside a <tool_call> block.
 * Models sometimes output: <tool_call>```json\n{...}\n```</tool_call>
 */
function stripMarkdownFences(str) {
  return str.replace(/^```(?:json|javascript|js)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
}

/**
 * Parses <tool_call> XML blocks from model text output into OpenAI tool_calls format.
 * Handles:
 * - Backtick-wrapped and code-fenced <tool_call> references (model talking ABOUT the format)
 * - Markdown code fences inside <tool_call> blocks
 * - Unclosed <tool_call> blocks (model output cut off or missing closing tag)
 * - Smart quotes from Telegram/chat formatting
 * - Nested JSON objects via balanced brace counting
 * Returns { textContent, toolCalls } where textContent is the text without tool call blocks.
 */
function parseToolCalls(text, tools) {
  const toolCalls = [];
  let callIndex = 0;

  // Sanitize: strip backtick-wrapped and code-fenced <tool_call> mentions
  const sanitized = sanitizeForParsing(text);

  // Match both closed and unclosed <tool_call> blocks
  // Pattern 1: properly closed <tool_call>...</tool_call>
  // Pattern 2: unclosed <tool_call>...EOF (model was cut off)
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;
  let lastMatchEnd = 0;

  while ((match = regex.exec(sanitized)) !== null) {
    lastMatchEnd = match.index + match[0].length;
    const parsed = tryParseToolCallContent(match[1], tools);
    if (parsed) {
      toolCalls.push(parsed);
      callIndex++;
    }
  }

  // Check for unclosed <tool_call> at the end (model output was cut off)
  const unclosedMatch = sanitized.substring(lastMatchEnd).match(/<tool_call>\s*([\s\S]+)$/);
  if (unclosedMatch) {
    console.warn('[ToolEmulation] Found unclosed <tool_call> block at end of response, attempting parse');
    const parsed = tryParseToolCallContent(unclosedMatch[1], tools);
    if (parsed) {
      toolCalls.push(parsed);
      callIndex++;
    }
  }

  // Remove actual tool call blocks from the text content
  let textContent = sanitized
    .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, '')
    .replace(/<tool_call>\s*[\s\S]*$/, '') // Also remove unclosed blocks at end
    .replace(/___TOOL_TAG_REF___/g, '`<tool_call>`')
    .replace(/___TOOL_TAG_END_REF___/g, '`</tool_call>`')
    .trim();

  if (toolCalls.length > 0) {
    console.log(`[ToolEmulation] Parsed ${toolCalls.length} tool call(s): ${toolCalls.map(tc => tc.function.name).join(', ')}`);
  }

  return { textContent, toolCalls };
}

/**
 * Validates and auto-corrects tool call arguments against the tool's parameter schema.
 * Fixes common model mistakes where the model uses training-bias parameter names
 * instead of the schema-defined names (e.g., "file_path" instead of "path").
 * This is a deterministic correction layer — more reliable than any prompt rule.
 */
function validateAndFixToolArgs(toolName, args, tools) {
  if (!tools || !Array.isArray(tools) || typeof args !== 'object' || args === null) return args;

  const toolDef = tools.find(t => t.type === 'function' && t.function?.name === toolName);
  if (!toolDef) return args;

  const schema = toolDef.function?.parameters?.properties || {};
  const schemaKeys = Object.keys(schema);
  if (schemaKeys.length === 0) return args;

  // Common model mistakes: map wrong key names to the correct schema key.
  //
  // VERIFIED against cloned OpenClaw source (openclaw/openclaw@main, 2026-02-06)
  // and upstream pi-coding-agent (badlogic/pi-mono, v0.52.9):
  //
  //   Tool            | Required params          | Source file
  //   read            | path                     | pi-mono/packages/coding-agent/src/core/tools/read.ts
  //   write           | path, content            | pi-mono/packages/coding-agent/src/core/tools/write.ts
  //   edit            | path, oldText, newText    | pi-mono/packages/coding-agent/src/core/tools/edit.ts
  //   exec            | command                  | openclaw/src/agents/bash-tools.exec.ts
  //   process         | action                   | openclaw/src/agents/bash-tools.process.ts
  //   web_search      | query                    | openclaw/src/agents/tools/web-search.ts
  //   web_fetch       | url                      | openclaw/src/agents/tools/web-fetch.ts
  //   memory_search   | query                    | openclaw/src/agents/tools/memory-tool.ts
  //   memory_get      | path                     | openclaw/src/agents/tools/memory-tool.ts
  //   image           | image                    | openclaw/src/agents/tools/image-tool.ts
  //   tts             | text                     | openclaw/src/agents/tools/tts-tool.ts
  //   browser         | action                   | openclaw/src/agents/tools/browser-tool.schema.ts
  //   message         | action                   | openclaw/src/agents/tools/message-tool.ts
  //   canvas          | action                   | openclaw/src/agents/tools/canvas-tool.ts
  //   nodes           | action                   | openclaw/src/agents/tools/nodes-tool.ts
  //   cron            | action                   | openclaw/src/agents/tools/cron-tool.ts
  //   gateway         | action                   | openclaw/src/agents/tools/gateway-tool.ts
  //
  // OpenClaw also patches read/write/edit schemas with Claude aliases:
  //   file_path (alias for path), old_string (alias for oldText), new_string (alias for newText)
  //   via patchToolSchemaForClaudeCompatibility() in pi-tools.read.ts
  //
  // Tools with params that MATCH alias wrongKeys (guard MUST prevent remapping):
  //   tts:     has 'text'    → 'text':'content' blocked     ✓
  //   cron:    has 'text'    → 'text':'content' blocked     ✓
  //   process: has 'text'    → 'text':'content' blocked     ✓
  //   process: has 'data'    → 'data':'content' blocked     ✓
  //   nodes:   has 'body'    → 'body':'content' blocked     ✓
  //   canvas:  has 'url'     → 'url':'path'     blocked     ✓
  //   web_fetch: has 'url'   → 'url':'path'     blocked     ✓
  //   message: has 'filename'→ 'filename':'path' blocked    ✓
  //   nodes:   has 'command' → 'cmd':'command'  fires (OK)  ✓
  //
  // Safety: the loop below only remaps when wrongKey is NOT in the tool's schema,
  // preventing false positives (4-condition guard).
  const COMMON_ALIASES = {
    // read / write / edit → path
    'file_path': 'path',
    'target_file': 'path',      // Cursor's read_file / read_file_v2 native name
    'target_directory': 'path', // Cursor's list_dir_v2 native name
    'filepath': 'path',
    'file': 'path',
    'filename': 'path',
    'file_name': 'path',
    'dir': 'path',
    'directory': 'path',
    'folder': 'path',
    'uri': 'path',
    'url': 'path',
    // write → content
    'text': 'content',
    'body': 'content',
    'data': 'content',
    // edit → oldText / newText (OpenClaw primary names; Claude uses old_string/new_string)
    'old_string': 'oldText',
    'old_text': 'oldText',
    'oldString': 'oldText',
    'original': 'oldText',
    'new_string': 'newText',
    'new_text': 'newText',
    'newString': 'newText',
    'replacement': 'newText',
    // exec → command
    'cmd': 'command',
    'shell': 'command',
    // web_search / memory_search → query (models sometimes invent 'search_query')
    'search_query': 'query',
    'search': 'query',
    'q': 'query',
    // image → image
    'image_path': 'image',
    'image_url': 'image',
    'img': 'image',
    // tts → text (if model sends 'content' to tts instead of 'text')
    'content': 'text',
  };

  const fixed = { ...args };
  let didFix = false;

  for (const [wrongKey, rightKey] of Object.entries(COMMON_ALIASES)) {
    // Only remap if:
    //   1. Model sent the wrong key with a value
    //   2. Model did NOT send the right key
    //   3. The right key IS in the tool's schema
    //   4. The wrong key is NOT in the tool's schema (so it's truly wrong, not a valid param)
    if (fixed[wrongKey] && !fixed[rightKey] && schemaKeys.includes(rightKey) && !schemaKeys.includes(wrongKey)) {
      fixed[rightKey] = fixed[wrongKey];
      delete fixed[wrongKey];
      console.log(`[ToolEmulation] Auto-fixed param: ${wrongKey} → ${rightKey} for tool ${toolName}`);
      didFix = true;
    }
  }

  // Fallback: if a required param is still missing, try to find any unrecognized arg
  // that could fill it (single missing required + single extra arg = likely match)
  const required = toolDef.function?.parameters?.required || [];
  const missingRequired = required.filter(k => !(k in fixed));
  const extraKeys = Object.keys(fixed).filter(k => !schemaKeys.includes(k));

  if (missingRequired.length === 1 && extraKeys.length === 1) {
    const missingKey = missingRequired[0];
    const extraKey = extraKeys[0];
    fixed[missingKey] = fixed[extraKey];
    delete fixed[extraKey];
    console.log(`[ToolEmulation] Auto-fixed param (fallback): ${extraKey} → ${missingKey} for tool ${toolName}`);
    didFix = true;
  }

  return fixed;
}

/**
 * Attempts to parse the inner content of a <tool_call> block into a tool call object.
 * Handles smart quotes, markdown fences, and uses balanced brace extraction.
 * If tools array is provided, validates and auto-corrects argument names.
 */
function tryParseToolCallContent(raw, tools) {
  try {
    let jsonStr = raw.trim();

    // Strip markdown code fences: ```json ... ```
    jsonStr = stripMarkdownFences(jsonStr);

    // Handle smart quotes (from Telegram/chat formatting)
    jsonStr = jsonStr.replace(/\u201c|\u201d/g, '"');
    jsonStr = jsonStr.replace(/\u2018|\u2019/g, "'");

    // Extract JSON object using balanced brace counting (handles nested braces)
    const extracted = extractJsonObject(jsonStr);
    if (!extracted) {
      console.error('[ToolEmulation] No JSON object found in tool_call block:', jsonStr.substring(0, 100));
      return null;
    }

    const parsed = JSON.parse(extracted);
    if (!parsed.name) {
      console.error('[ToolEmulation] tool_call JSON missing "name" field:', extracted.substring(0, 100));
      return null;
    }

    // Validate and auto-correct argument names against the tool schema
    let args = parsed.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch (_) { /* keep as string */ }
    }
    if (typeof args === 'object' && args !== null && tools) {
      args = validateAndFixToolArgs(parsed.name, args, tools);
    }

    return {
      id: `call_${uuidv4()}`,
      type: 'function',
      function: {
        name: parsed.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args)
      }
    };
  } catch (e) {
    console.error('[ToolEmulation] Failed to parse tool call JSON:', raw.substring(0, 200), e.message);
    return null;
  }
}

/**
 * Detects whether text contains actual <tool_call> tags (not backtick-wrapped references).
 */
function hasToolCallTags(text) {
  const sanitized = sanitizeForParsing(text);
  return /<tool_call>/.test(sanitized);
}

/**
 * Attempts to detect and recover near-miss tool call formats.
 * Some models may output slight variations of the expected format:
 *   - [tool_call]...[/tool_call]
 *   - <function_call>...</function_call>
 *   - <tool-call>...</tool-call>
 *   - Raw JSON with {"name": "...", "arguments": ...} outside tags
 * Returns the text with near-misses normalized to <tool_call>...</tool_call>,
 * or the original text if no near-misses found.
 */
function normalizeNearMissToolCalls(text) {
  let normalized = text;
  let fixed = false;

  // [tool_call]...[/tool_call] → <tool_call>...</tool_call>
  if (/\[tool_call\]/i.test(normalized)) {
    normalized = normalized.replace(/\[tool_call\]/gi, '<tool_call>').replace(/\[\/tool_call\]/gi, '</tool_call>');
    fixed = true;
  }

  // <function_call>...</function_call> → <tool_call>...</tool_call>
  if (/<function_call>/i.test(normalized)) {
    normalized = normalized.replace(/<function_call>/gi, '<tool_call>').replace(/<\/function_call>/gi, '</tool_call>');
    fixed = true;
  }

  // <tool-call>...</tool-call> → <tool_call>...</tool_call>
  if (/<tool-call>/i.test(normalized)) {
    normalized = normalized.replace(/<tool-call>/gi, '<tool_call>').replace(/<\/tool-call>/gi, '</tool_call>');
    fixed = true;
  }

  // Detect bare JSON tool calls at end of text (no tags at all)
  // Pattern: text ends with {"name": "...", "arguments": {...}}
  if (!fixed && !/<tool_call>/.test(normalized)) {
    const bareJsonMatch = normalized.match(/(\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*\}\s*\})\s*$/);
    if (bareJsonMatch) {
      normalized = normalized.substring(0, bareJsonMatch.index) + `<tool_call>\n${bareJsonMatch[1]}\n</tool_call>`;
      fixed = true;
    }
  }

  if (fixed) {
    console.log('[ToolEmulation] Normalized near-miss tool call format to standard <tool_call> tags');
  }
  return normalized;
}

module.exports = {
  formatToolDefinitions,
  injectToolsIntoMessages,
  convertToolResultMessages,
  parseToolCalls,
  hasToolCallTags,
  normalizeNearMissToolCalls,
  tryParseToolCallContent
};
