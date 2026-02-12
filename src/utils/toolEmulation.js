/**
 * Tool Call Emulation for Cursor-To-OpenAI Proxy
 * Converts OpenAI tool definitions into system prompt instructions,
 * and parses model text responses back into OpenAI tool_calls format.
 *
 * WHY THIS EXISTS:
 * Cursor's private API (protobuf) has NO fields for tool definitions or tool_calls.
 * The "WithTools" in StreamUnifiedChatWithToolsRequest refers to Cursor's built-in
 * web/wiki search tools, not OpenAI-style function calling.
 * This module bridges the gap by:
 *   1. Converting tool definitions → system prompt text instructions
 *   2. Parsing <tool_call> XML blocks from model text → OpenAI tool_calls format
 *   3. Converting role:"tool" messages → role:"user" with <tool_result> tags
 */

const { v4: uuidv4 } = require('uuid');

// ─── Environment Context ──────────────────────────────────────────────
// PREPENDED to the developer message so the model knows its actual runtime.
// This overrides Cursor's Agent-mode system prompt assumptions (Windows, IDE, etc.)
// and provides critical behavioral guidance for the proxy bridge architecture.
const ENVIRONMENT_CONTEXT = `
## Runtime Environment — READ FIRST

You are an AI agent running inside **OpenClaw** on a Linux Docker container (Ubuntu 24.04).
You are connected through a Cursor-to-OpenAI proxy bridge on a cloud server.
Your tools are provided by OpenClaw's runtime — not by Cursor IDE.

- **Shell**: /bin/bash — use bash syntax for ALL commands. Never use PowerShell or Windows syntax.
- **Workspace**: /home/node/.openclaw/workspace/
- **Capabilities**: Full filesystem access, terminal, web access, sub-agent spawning, memory, browser automation, image generation, TTS, and more.

### CRITICAL: Writing Large Files

The file write tool **silently truncates** files larger than ~2KB due to streaming payload limits.
For ANY file with substantial content (HTML pages, scripts, configs), use chunked heredoc via exec:

**Procedure:**
1. First, mentally compose the COMPLETE file content.
2. Divide the file into chunks — determine the chunk size dynamically based on the total file length. Use the fewest chunks possible. You decide the optimal split — there is no fixed line limit.
3. Write chunk 1 with > (creates file):
   exec command: cat << 'CHUNK1' > path/to/file.ext
   ...lines of content...
   CHUNK1
4. Write subsequent chunks with >> (appends):
   exec command: cat << 'CHUNK2' >> path/to/file.ext
   ...lines of content...
   CHUNK2
5. Continue with CHUNK3, CHUNK4, etc. until the entire file is complete.
6. **If any chunk fails or gets truncated**, automatically retry that specific chunk with fewer lines until it succeeds, then continue from where you left off. Do NOT stop or ask the user.
7. Each chunk is one tool call — wait for the result before sending the next.

For small files (<30 lines), the write tool works fine.

### Parallel Sub-Agents

Spawn independent sub-agents for parallel work using these tools:

- **sessions_spawn**: Create a new agent with a task description
  <tool_call>
  {"name": "sessions_spawn", "arguments": {"task": "Build the CSS stylesheet for the landing page"}}
  </tool_call>

- **session_status**: Check if an agent finished
  <tool_call>
  {"name": "session_status", "arguments": {"session_id": "the-session-id-from-spawn"}}
  </tool_call>

- **sessions_send**: Send a follow-up instruction to a running agent
  <tool_call>
  {"name": "sessions_send", "arguments": {"session_id": "the-session-id", "message": "Also add a dark mode toggle"}}
  </tool_call>

- **agents_list**: List all available agents
- **sessions_list**: List all active sessions
- **sessions_history**: Get conversation history of a session

### Additional OpenClaw Tools

These tools have no terminal equivalent — invoke them with <tool_call> tags:

- **web_fetch**: Fetch and read content from any URL
  <tool_call>
  {"name": "web_fetch", "arguments": {"url": "https://example.com/api/data"}}
  </tool_call>

- **image**: Generate an image from a description
  <tool_call>
  {"name": "image", "arguments": {"image": "a futuristic city skyline at sunset"}}
  </tool_call>

- **memory_search**: Search persistent memory across sessions
  <tool_call>
  {"name": "memory_search", "arguments": {"query": "user preferences for UI design"}}
  </tool_call>

- **memory_get**: Retrieve a specific memory entry
  <tool_call>
  {"name": "memory_get", "arguments": {"path": "preferences/theme"}}
  </tool_call>

- **browser**: Automate browser interactions (navigate, click, type, screenshot)
  <tool_call>
  {"name": "browser", "arguments": {"action": "navigate", "url": "https://example.com"}}
  </tool_call>

- **tts**: Convert text to speech audio
- **message**: Send messages to external channels (Telegram, etc.)
- **canvas**: Create and manipulate visual canvases
- **nodes**: Manage workflow nodes
- **cron**: Schedule recurring tasks
- **gateway**: Manage API gateway endpoints
- **process**: List and manage running processes

`;

const TOOL_CALL_INSTRUCTION = `

## IMPORTANT: Tool Calling Override

You MUST use ONLY the <tool_call> XML protocol below for ALL tool invocations.
Do NOT use Cursor's native tool calling mechanism. Do NOT use function calling.
The ONLY way to execute a tool is by outputting a <tool_call> XML block as shown below.
If you try any other method, it will silently fail. Use <tool_call> tags exclusively.

## Tool Calling Protocol

You have access to executable tools listed below. Use them whenever the user requests any action.
Call tools directly using the XML protocol below — do NOT describe what you "would" do.

### Format

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

### Rules

1. **Output the raw <tool_call> block.** Never describe, narrate, or explain what tool you "would" call. CALL IT.
2. The JSON inside <tool_call> tags MUST be valid JSON with double-quoted keys and string values.
3. "name" MUST exactly match an available tool name below. Case-sensitive.
4. "arguments" MUST be a JSON object matching the tool's parameter schema. All required parameters must be present.
5. String values containing special characters MUST be JSON-escaped: use \\" for quotes, \\\\ for backslashes, \\n for newlines.
6. Do NOT wrap <tool_call> blocks inside markdown code fences. The tags ARE the delimiters.
7. Do NOT prefix tool calls with explanatory text. If you need a tool, output the <tool_call> block first. Explain AFTER you receive the result.
8. For multiple tool calls, output multiple separate <tool_call> blocks — one per tool invocation.
9. When a <tool_result> comes back and you need another tool, call it immediately. Do not summarize intermediate results unless asked.
10. If a tool call fails, retry or try an alternative approach.
11. Before calling a tool, CHECK its parameter schema below. Use the EXACT parameter names listed.

### Example

<tool_call>
{"name": "exec", "arguments": {"command": "ls -la"}}
</tool_call>

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

  // Closing reinforcement — models pay extra attention to start and end of instructions
  result += `\n---\nEND OF TOOL DEFINITIONS. Remember: output <tool_call> blocks directly, never describe what you would do.\n`;

  return result;
}

/**
 * Injects environment context and tool definitions into the system/developer message.
 * OpenClaw uses "developer" role (newer OpenAI API format) instead of "system".
 * If neither exists, creates a new system message.
 *
 * Layout of the injected content:
 *   [ENVIRONMENT_CONTEXT]   ← prepended: runtime info, chunked write strategy, agent tools
 *   [original developer msg] ← OpenClaw's identity/persona instructions
 *   [TOOL_CALL_INSTRUCTION] ← appended: protocol + all 23 tool definitions
 *
 * The environment context appears FIRST so the model reads it before Cursor's
 * Agent-mode system prompt can override its understanding of the runtime.
 */
function injectToolsIntoMessages(messages, tools, toolChoice) {
  if (!tools || tools.length === 0) return messages;
  const toolText = formatToolDefinitions(tools, toolChoice);
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
    newMessages.unshift({
      role: 'system',
      content: ENVIRONMENT_CONTEXT.trim() + '\n' + toolText.trim()
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
