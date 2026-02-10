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

const TOOL_CALL_INSTRUCTION = `

## Tool Use Instructions

You have access to tools. To call a tool, output a tool_call block in EXACTLY this format:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1"}}
</tool_call>

CRITICAL RULES:
- The JSON inside <tool_call> tags MUST be valid JSON
- "name" must exactly match an available tool name
- "arguments" must match the tool's parameter schema
- You may output multiple <tool_call> blocks to call multiple tools
- Do NOT wrap tool calls in markdown code blocks
- Do NOT describe what you would do — actually call the tool
- When you need to use a tool, output ONLY the tool_call block(s)
- After receiving a <tool_result>, analyze it and decide next steps

Available tools:
`;

/**
 * Converts OpenAI tool definitions to text instructions for the system prompt.
 */
function formatToolDefinitions(tools, toolChoice) {
  if (!tools || tools.length === 0) return '';
  let result = TOOL_CALL_INSTRUCTION;
  for (const tool of tools) {
    if (tool.type === 'function') {
      const fn = tool.function;
      result += `\n### ${fn.name}\n`;
      if (fn.description) {
        result += `${fn.description}\n`;
      }
      if (fn.parameters) {
        result += `Parameters schema: ${JSON.stringify(fn.parameters)}\n`;
      }
    }
  }

  // Handle tool_choice constraints
  if (toolChoice === 'required' || toolChoice === 'auto') {
    // "required" means the model MUST call at least one tool
    // "auto" means the model decides (default behavior)
    if (toolChoice === 'required') {
      result += `\nIMPORTANT: You MUST call at least one tool in your response. Do NOT respond with only text.\n`;
    }
  } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function') {
    // Specific function required: { type: "function", function: { name: "specific_tool" } }
    const requiredName = toolChoice.function?.name;
    if (requiredName) {
      result += `\nIMPORTANT: You MUST call the "${requiredName}" tool in your response.\n`;
    }
  }

  return result;
}

/**
 * Injects tool definitions into the system message.
 * If no system message exists, creates one.
 */
function injectToolsIntoMessages(messages, tools, toolChoice) {
  if (!tools || tools.length === 0) return messages;
  const toolText = formatToolDefinitions(tools, toolChoice);
  const newMessages = [...messages];
  const systemIdx = newMessages.findIndex(m => m.role === 'system');
  if (systemIdx !== -1) {
    newMessages[systemIdx] = {
      ...newMessages[systemIdx],
      content: newMessages[systemIdx].content + toolText
    };
  } else {
    newMessages.unshift({
      role: 'system',
      content: toolText.trim()
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
 * Parses <tool_call> XML blocks from model text output into OpenAI tool_calls format.
 * Returns { textContent, toolCalls } where textContent is the text without tool call blocks.
 */
function parseToolCalls(text) {
  const toolCalls = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;
  let callIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    try {
      const jsonStr = match[1].trim();
      const parsed = JSON.parse(jsonStr);
      if (parsed.name) {
        toolCalls.push({
          id: `call_${Date.now()}_${callIndex}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string'
              ? parsed.arguments
              : JSON.stringify(parsed.arguments || {})
          }
        });
        callIndex++;
      }
    } catch (e) {
      console.error('[ToolEmulation] Failed to parse tool call JSON:', match[1], e.message);
    }
  }

  const textContent = text.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, '').trim();

  if (toolCalls.length > 0) {
    console.log(`[ToolEmulation] Parsed ${toolCalls.length} tool call(s): ${toolCalls.map(tc => tc.function.name).join(', ')}`);
  }

  return { textContent, toolCalls };
}

/**
 * Detects whether text contains <tool_call> tags.
 */
function hasToolCallTags(text) {
  return /<tool_call>/.test(text);
}

module.exports = {
  formatToolDefinitions,
  injectToolsIntoMessages,
  convertToolResultMessages,
  parseToolCalls,
  hasToolCallTags
};
