const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const $root = require('../proto/message.js');
const { injectToolsIntoMessages, convertToolResultMessages } = require('./toolEmulation');

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join(' ');
  }
  return String(content ?? '');
}

function isSystemRole(role) {
  return role === 'system' || role === 'developer';
}

function generateCursorBody(messages, modelName, tools, toolChoice) {
  // Convert tool result messages and inject tool definitions
  let processedMessages = convertToolResultMessages(messages);
  processedMessages = injectToolsIntoMessages(processedMessages, tools, toolChoice);

  // Both "system" and "developer" roles go into the protobuf instruction field
  let instruction = processedMessages
    .filter(msg => isSystemRole(msg.role))
    .map(msg => normalizeContent(msg.content))
    .join('\n');

  // Agent mode activation strategy (dual approach):
  //   1. Protobuf fields: unknown27=1, supportedTools=[...], chatModeEnum=2, chatMode="Agent"
  //      These make Cursor's backend generate an Agent-mode system prompt.
  //   2. unknown48=1 (should_disable_tools) attempts to prevent native tool dispatch.
  //      If it works, the model uses our text-based <tool_call> protocol.
  //   3. Fallback: chunkToUtf8String scans response protobuf for native tool calls
  //      (ClientSideToolV2Call) and converts them to <tool_call> XML so the
  //      existing pipeline handles them transparently.

  const formattedMessages = processedMessages
    .filter(msg => !isSystemRole(msg.role))
    .map(msg => ({
      content: normalizeContent(msg.content),
      role: msg.role === 'user' ? 1 : 2,
      messageId: uuidv4(),
      ...(msg.role === 'user' ? { chatModeEnum: 2 } : {})
    }));

  const messageIds = formattedMessages.map(msg => {
    const { role, messageId, summaryId } = msg;
    return summaryId ? { role, messageId, summaryId } : { role, messageId };
  });

  const body = {
    request:{
      messages: formattedMessages,
      unknown2: 1,
      instruction: {
        instruction: instruction
      },
      unknown4: 1,
      model: {
        name: modelName,
        empty: '',
      },
      webTool: "",
      unknown13: 1,
      cursorSetting: {
        name: "cursor\\aisettings",
        unknown3: "",
        unknown6: {
          unknwon1: "",
          unknown2: ""
        },
        unknown8: 1,
        unknown9: 1
      },
      unknown19: 1,
      conversationId: uuidv4(),
      metadata: {
        os: "linux",
        arch: "x64",
        version: "6.8.0",
        path: "/bin/bash",
        timestamp: new Date().toISOString(),
      },
      unknown27: 1, // is_agentic = true (field 27) — REQUIRED for Agent mode
      // supported_tools (field 29): ClientSideToolV2 enum values.
      // REQUIRED for Agent mode system prompt. Without these, Cursor's backend
      // generates an "Ask mode" system prompt regardless of other fields.
      // The proxy intercepts native tool calls from the response (see
      // findNativeToolCalls) and converts them to <tool_call> XML so the
      // existing OpenAI-compatible pipeline handles them.
      // EDIT_FILE (7) and EDIT_FILE_V2 (38) are intentionally excluded.
      // They send file content in rawArgs which always gets truncated
      // (proxy is unidirectional), causing 50+ request loops.
      // Without them, the model uses run_terminal_cmd with heredoc for
      // file writes, which works because the command string is small.
      // If this causes "read-only mode", add them back — it means
      // Cursor requires them for full agent mode activation.
      supportedTools: [
        5,  // READ_FILE
        6,  // LIST_DIR
        8,  // FILE_SEARCH
        15, // RUN_TERMINAL_COMMAND_V2
        18, // WEB_SEARCH
        39, // LIST_DIR_V2
        40, // READ_FILE_V2
        41, // RIPGREP_RAW_SEARCH
        42, // GLOB_FILE_SEARCH
      ],
      messageIds: messageIds,
      largeContext: 0,
      unknown38: 0,
      chatModeEnum: 2,
      unknown47: "",
      unknown48: 1, // field 48 — purpose unconfirmed, kept at 1 (matching known working state)
      unknown49: 0,
      unknown51: 0,
      unknown53: 1,
      chatMode: "Agent"
    }
  };

  const errMsg = $root.StreamUnifiedChatWithToolsRequest.verify(body);
  if (errMsg) throw Error(errMsg);

  const instance = $root.StreamUnifiedChatWithToolsRequest.create(body);
  let buffer = $root.StreamUnifiedChatWithToolsRequest.encode(instance).finish();

  let magicNumber = 0x00
  if (formattedMessages.length >= 3){
    buffer = zlib.gzipSync(buffer)
    magicNumber = 0x01
  }

  const finalBody = Buffer.concat([
    Buffer.from([magicNumber]),
    Buffer.from(buffer.length.toString(16).padStart(8, '0'), 'hex'),
    buffer
  ])

  return finalBody
}

// ─── Raw Protobuf Scanner ──────────────────────────────────────────────
// Extracts native tool calls (ClientSideToolV2Call) from Cursor's response
// protobuf frames. This is the fallback when unknown48 (should_disable_tools)
// doesn't prevent native tool dispatch.
//
// Based on eisbaw/cursor_api_demo ToolCallDecoder. The proto structure is:
//   message ClientSideToolV2Call {
//     ClientSideToolV2 tool = 1;   // enum (varint)
//     string tool_call_id = 3;     // unique call ID
//     string name = 9;             // tool function name
//     string raw_args = 10;        // JSON argument string
//   }
// We don't need the full proto definition — just scan for this pattern
// recursively in any length-delimited (wire type 2) sub-messages.
// ────────────────────────────────────────────────────────────────────────

function pbDecodeVarint(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos];
    result |= (b & 0x7F) << shift;
    pos++;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 35) break; // safety: max 5-byte varint for uint32
  }
  return [result, pos];
}

function pbDecodeFields(buf) {
  const fields = {};
  let pos = 0;
  while (pos < buf.length) {
    const [tag, tagEnd] = pbDecodeVarint(buf, pos);
    if (tagEnd === pos) break; // no progress
    pos = tagEnd;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    let value;
    if (wireType === 0) { // varint
      [value, pos] = pbDecodeVarint(buf, pos);
    } else if (wireType === 1) { // fixed64
      if (pos + 8 > buf.length) break;
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wireType === 2) { // length-delimited
      const [len, lenEnd] = pbDecodeVarint(buf, pos);
      pos = lenEnd;
      if (pos + len > buf.length) break;
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wireType === 5) { // fixed32
      if (pos + 4 > buf.length) break;
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      break; // unknown wire type, stop
    }

    if (!fields[fieldNum]) fields[fieldNum] = [];
    fields[fieldNum].push({ wireType, value });
  }
  return fields;
}

function pbGetString(fields, num) {
  const entries = fields[num];
  if (!entries) return null;
  for (const { wireType, value } of entries) {
    if (wireType === 2 && Buffer.isBuffer(value)) {
      try { return value.toString('utf-8'); } catch (_) { /* skip */ }
    }
  }
  return null;
}

function pbGetInt(fields, num) {
  const entries = fields[num];
  if (!entries) return null;
  for (const { wireType, value } of entries) {
    if (wireType === 0) return value;
  }
  return null;
}

/**
 * Extract a ClientSideToolV2Call from decoded protobuf fields.
 * Returns { tool, toolCallId, name, rawArgs } or null.
 */
function extractToolCallFromFields(fields) {
  const tool = pbGetInt(fields, 1);          // field 1: tool enum
  const toolCallId = pbGetString(fields, 3); // field 3: tool_call_id
  const name = pbGetString(fields, 9);       // field 9: name
  const rawArgs = pbGetString(fields, 10);   // field 10: raw_args

  // A valid tool call needs the tool enum > 0, a tool_call_id,
  // AND at least one of name or rawArgs to reduce false positives
  if (tool != null && tool > 0 && toolCallId && (name || rawArgs)) {
    return { tool, toolCallId, name: name || '', rawArgs: rawArgs || '{}' };
  }
  return null;
}

/**
 * Recursively search protobuf bytes for ClientSideToolV2Call messages.
 * Scans up to 3 levels deep in nested length-delimited fields.
 */
function findNativeToolCalls(data) {
  const toolCalls = [];
  const seen = new Set(); // deduplicate by tool_call_id

  function scanFields(buf, depth) {
    if (depth > 3 || buf.length < 5) return;
    let fields;
    try { fields = pbDecodeFields(buf); } catch (_) { return; }

    // Check if this message itself is a tool call
    const tc = extractToolCallFromFields(fields);
    if (tc && !seen.has(tc.toolCallId)) {
      seen.add(tc.toolCallId);
      toolCalls.push(tc);
    }

    // Recurse into length-delimited sub-fields
    for (const entries of Object.values(fields)) {
      for (const { wireType, value } of entries) {
        if (wireType === 2 && Buffer.isBuffer(value) && value.length > 8) {
          scanFields(value, depth + 1);
        }
      }
    }
  }

  scanFields(Buffer.isBuffer(data) ? data : Buffer.from(data), 0);
  return toolCalls;
}

// Cursor ClientSideToolV2 enum → human-readable name (for logging / fallback)
// These should match what the model ACTUALLY sends in tc.name field.
const CURSOR_TOOL_NAMES = {
  5:  'read_file',
  6:  'list_dir',
  7:  'edit_file',
  8:  'file_search',
  15: 'run_terminal_cmd',      // model sends 'run_terminal_cmd', not 'run_terminal_command'
  18: 'web_search',
  38: 'write',                 // model sends 'write', not 'edit_file_v2' (enum name is misleading)
  39: 'list_dir_v2',
  40: 'read_file_v2',
  41: 'ripgrep_raw_search',    // model sends 'ripgrep_raw_search'
  42: 'glob_file_search',
};

// ─── Cursor → OpenClaw Tool/Param Mapping ─────────────────────────────
// Cursor's native tool names differ from OpenClaw's tool names.
// The model uses whichever names Cursor's Agent-mode system prompt provides,
// so we remap them to match what OpenClaw actually exposes.

// Simple name-only mappings (params use standard rename table below).
// Tools that need args-based detection (edit vs write) go in SPECIAL_TOOL_CONVERSIONS instead.
const CURSOR_TO_OPENCLAW_TOOLS = {
  'run_terminal_cmd': 'exec',
  'run_terminal_command': 'exec',
  'read_file': 'read',
  'read_file_v2': 'read',
  'web_search': 'web_search',
  'write': 'write',         // explicit: model sends 'write' for file creation via enum 38
};

// Cursor parameter names that differ from OpenClaw's
const CURSOR_TO_OPENCLAW_PARAMS = {
  'file_path': 'path',
  'contents': 'content',
  'search_term': 'query',
};

// Cursor-specific params to drop (not used by OpenClaw)
const CURSOR_DROP_PARAMS = new Set(['explanation', 'is_background', 'blocking']);

// Tools that need full argument restructuring (not just param rename).
// Each returns { name, arguments } ready for OpenClaw.
const SPECIAL_TOOL_CONVERSIONS = {
  // ─── Directory listing ──────────────────────────────────────────────
  'list_dir': (args) => ({
    name: 'exec',
    arguments: { command: `ls -la ${shellEscape(args.target_directory || args.path || '.')}` },
  }),
  'list_dir_v2': (args) => ({
    name: 'exec',
    arguments: { command: `ls -la ${shellEscape(args.target_directory || args.path || '.')}` },
  }),

  // ─── Search tools ──────────────────────────────────────────────────
  'ripgrep_raw_search': (args) => {
    const pattern = args.pattern || '';
    const path = args.path || '.';
    const limit = args.head_limit ? ` | head -${args.head_limit}` : '';
    return { name: 'exec', arguments: { command: `rg ${shellEscape(pattern)} ${shellEscape(path)}${limit}` } };
  },
  'ripgrep_search': (args) => {
    const pattern = args.pattern || '';
    const path = args.path || '.';
    const limit = args.head_limit ? ` | head -${args.head_limit}` : '';
    return { name: 'exec', arguments: { command: `rg ${shellEscape(pattern)} ${shellEscape(path)}${limit}` } };
  },
  'file_search': (args) => ({
    name: 'exec',
    arguments: { command: `find ${shellEscape(args.path || '.')} -name ${shellEscape(args.pattern || args.query || '*')} 2>/dev/null` },
  }),
  'glob_file_search': (args) => ({
    name: 'exec',
    arguments: { command: `find ${shellEscape(args.path || '.')} -name ${shellEscape(args.glob_pattern || args.pattern || '*')} 2>/dev/null` },
  }),

  // ─── File edit/write (args-based detection) ─────────────────────────
  // Cursor's EDIT_FILE_V2 (enum 38) is used for BOTH write (create/overwrite)
  // and edit (old_string/new_string) operations. The model's tc.name is usually
  // 'write' for creation, but the enum fallback is 'edit_file_v2'.
  // We detect based on which arguments are present.
  'edit_file': (args) => {
    if ('contents' in args || 'content' in args) {
      return {
        name: 'write',
        arguments: {
          path: args.file_path || args.path || '',
          content: args.contents || args.content || '',
        },
      };
    }
    return {
      name: 'edit',
      arguments: {
        path: args.file_path || args.path || '',
        oldText: args.old_string || args.oldText || args.old_text || '',
        newText: args.new_string || args.newText || args.new_text || '',
      },
    };
  },
  'edit_file_v2': (args) => {
    if ('contents' in args || 'content' in args) {
      return {
        name: 'write',
        arguments: {
          path: args.file_path || args.path || '',
          content: args.contents || args.content || '',
        },
      };
    }
    return {
      name: 'edit',
      arguments: {
        path: args.file_path || args.path || '',
        oldText: args.old_string || args.oldText || args.old_text || '',
        newText: args.new_string || args.newText || args.new_text || '',
      },
    };
  },
};

/** Escape a shell argument (wraps in single quotes, escapes existing quotes) */
function shellEscape(s) {
  if (!s || typeof s !== 'string') return "''";
  // Already looks safe (alphanumeric, dots, slashes, dashes)
  if (/^[a-zA-Z0-9._\-\/]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Tool types that involve large payloads (file content) and are prone to truncation
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'edit_file', 'edit_file_v2', 'write_to_file']);

/**
 * Convert an intercepted native Cursor tool call to OpenClaw format.
 * Returns:
 *   { name, arguments }          — successful conversion
 *   { truncated: true, hint }    — truncated payload, with guidance text for the model
 *   null                         — skip entirely (non-file tool with bad JSON)
 */
function convertNativeToolCall(tc) {
  const cursorName = tc.name || CURSOR_TOOL_NAMES[tc.tool] || `cursor_tool_${tc.tool}`;

  // 1. Validate rawArgs as JSON — truncated payloads need special handling
  let args;
  try {
    args = JSON.parse(tc.rawArgs);
  } catch (_) {
    // For file-write tools, return a hint so the model adapts quickly
    // instead of retrying the same large payload
    if (FILE_WRITE_TOOLS.has(cursorName)) {
      // Try to extract the file path from the partial JSON
      const pathMatch = tc.rawArgs.match(/"(?:file_path|path)"\s*:\s*"([^"]+)"/);
      const filePath = pathMatch ? pathMatch[1] : 'unknown';
      console.warn(`[convertNativeToolCall] Truncated file write for "${filePath}" — returning exec fallback with hint`);
      return {
        truncated: true,
        filePath: filePath,
        hint: `[System: File write for "${filePath}" was truncated due to streaming payload limits. ` +
              `You MUST now write this file using chunked heredoc via the exec tool. ` +
              `Determine the chunk size dynamically based on the total file length — ` +
              `divide the file into the fewest chunks that will fit through the stream. ` +
              `Use cat << 'CHUNK1' > ${filePath} for the first chunk (creates file), ` +
              `then cat << 'CHUNK2' >> ${filePath} (>> appends) for each subsequent chunk. ` +
              `If any chunk still gets truncated or fails, automatically retry that chunk with fewer lines until it succeeds, then continue. ` +
              `Do NOT stop or ask the user — keep writing until the entire file is complete. Start CHUNK1 now.]`,
      };
    }
    console.warn(`[convertNativeToolCall] Skipping tool call with truncated/invalid JSON: ${cursorName} (rawArgs=${tc.rawArgs.substring(0, 120)}...)`);
    return null;
  }

  // 2. Check for special conversions that need full arg restructuring
  const specialConvert = SPECIAL_TOOL_CONVERSIONS[cursorName];
  if (specialConvert) {
    const result = specialConvert(args);
    console.log(`[convertNativeToolCall] ${cursorName} →(special)→ ${result.name} (args: ${JSON.stringify(result.arguments).substring(0, 150)})`);
    return result;
  }

  // 3. Standard name mapping + parameter rename
  const openclawName = CURSOR_TO_OPENCLAW_TOOLS[cursorName] || cursorName;
  const mappedArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (CURSOR_DROP_PARAMS.has(key)) continue;
    const mappedKey = CURSOR_TO_OPENCLAW_PARAMS[key] || key;
    mappedArgs[mappedKey] = value;
  }

  console.log(`[convertNativeToolCall] ${cursorName} → ${openclawName} (params: ${Object.keys(args).join(',')} → ${Object.keys(mappedArgs).join(',')})`);
  return { name: openclawName, arguments: mappedArgs };
}

/**
 * Parses Cursor's binary-framed streaming response into text.
 * Frame format: [1 byte magic] [4 bytes BE length] [N bytes data]
 *   magic 0 = raw protobuf, 1 = gzipped protobuf (chat content)
 *   magic 2 = raw JSON,     3 = gzipped JSON     (metadata/errors)
 *
 * FIX: The old code had a single try/catch around the entire loop.
 * When a gzip frame was split across TCP packets, gunzipSync threw
 * Z_BUF_ERROR and the catch aborted ALL remaining frames — losing content.
 * Now: per-frame try/catch + frame boundary validation so one bad frame
 * doesn't kill the parse.
 */
function chunkToUtf8String(chunk) {
  const thinkingOutput = [];
  const textOutput = [];
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  // Cross-frame deduplication: a tool call may appear in multiple protobuf
  // frames (e.g. repeated in a follow-up confirmation frame). Track by ID.
  const seenToolCallIds = new Set();

  let i = 0;
  while (i < buffer.length) {
    // Need at least 5 bytes for the frame header (1 magic + 4 length)
    if (i + 5 > buffer.length) {
      break;
    }

    const magicNumber = buffer[i];
    const dataLength = buffer.readUInt32BE(i + 1);

    // Validate frame data fits within the buffer
    if (dataLength === 0 || i + 5 + dataLength > buffer.length) {
      // Incomplete frame — data extends beyond buffer boundary.
      // This is the root cause of Z_BUF_ERROR: the gzip frame is split
      // across two TCP packets so gunzipSync gets a truncated stream.
      // With buffer accumulation in v1.js this should no longer happen,
      // but we guard here as a safety net.
      if (dataLength > 0) {
        console.warn(`[chunkToUtf8String] Incomplete frame at offset ${i}: need ${dataLength} bytes, only ${buffer.length - i - 5} available — skipping remainder`);
      }
      break;
    }

    const data = buffer.subarray(i + 5, i + 5 + dataLength);

    try {
      if (magicNumber === 0 || magicNumber === 1) {
        const gunzipData = magicNumber === 0 ? data : zlib.gunzipSync(data);
        const response = $root.StreamUnifiedChatWithToolsResponse.decode(gunzipData);

        const thinking = response?.message?.thinking?.content;
        if (thinking !== undefined) {
          thinkingOutput.push(thinking);
        }

        const content = response?.message?.content;
        if (content !== undefined) {
          textOutput.push(content);
        }

        // Scan raw protobuf for native tool calls (e.g. tool_call_v2 at field 36
        // inside Message) that our proto definition doesn't cover.
        // If Cursor dispatches a native tool call, we intercept it, map the
        // tool name and parameters to OpenClaw format, and inject it as a
        // <tool_call> XML block so the existing pipeline handles it.
        const nativeCalls = findNativeToolCalls(gunzipData);
        for (const tc of nativeCalls) {
          // Skip if we already processed this tool call in a previous frame
          if (seenToolCallIds.has(tc.toolCallId)) continue;
          seenToolCallIds.add(tc.toolCallId);
          const cursorName = tc.name || CURSOR_TOOL_NAMES[tc.tool] || `cursor_tool_${tc.tool}`;
          console.log(`[chunkToUtf8String] Intercepted native tool call: ${cursorName} (enum=${tc.tool}, id=${tc.toolCallId}, rawArgs=${tc.rawArgs.substring(0, 200)})`);
          const mapped = convertNativeToolCall(tc);
          if (mapped && mapped.truncated) {
            // Truncated file write — inject hint text AND a fallback exec tool call.
            // The exec triggers a tool result cycle through OpenClaw, giving the
            // model a follow-up turn to write the file using chunked heredoc.
            // Without a tool call, the response would be text-only (finish_reason='stop')
            // and the model would never get another turn to act on the hint.
            textOutput.push(`\n${mapped.hint}\n`);
            const safeFilePath = (mapped.filePath || 'file').replace(/'/g, "'\\''");
            const fallbackExec = {
              name: 'exec',
              arguments: {
                command: `echo "Ready for chunked heredoc write to: ${safeFilePath}"`
              }
            };
            textOutput.push(`\n<tool_call>\n${JSON.stringify(fallbackExec)}\n</tool_call>\n`);
            console.log(`[chunkToUtf8String] Injected fallback exec for truncated write → triggers new turn`);
          } else if (mapped) {
            textOutput.push(`\n<tool_call>\n${JSON.stringify(mapped)}\n</tool_call>\n`);
          }
        }
      } else if (magicNumber === 2 || magicNumber === 3) {
        const gunzipData = magicNumber === 2 ? data : zlib.gunzipSync(data);
        const utf8 = gunzipData.toString('utf-8');
        try {
          const message = JSON.parse(utf8);
          if (message != null && (typeof message !== 'object' || (Array.isArray(message) ? message.length > 0 : Object.keys(message).length > 0))) {
            console.error(utf8);
          }
        } catch (_) {
          // Non-JSON metadata, ignore
        }
      }
      // else: unknown magic number, skip frame
    } catch (err) {
      // Per-frame error — log and continue parsing subsequent frames
      // instead of aborting the entire buffer
      console.warn(`[chunkToUtf8String] Frame parse error at offset ${i} (magic=${magicNumber}, len=${dataLength}): ${err.code || err.message}`);
    }

    i += 5 + dataLength;
  }

  return {
    thinking: thinkingOutput.join(''),
    text: textOutput.join('')
  };
}

function generateHashed64Hex(input, salt = '') {
  const hash = crypto.createHash('sha256');
  hash.update(input + salt);
  return hash.digest('hex');
}

function obfuscateBytes(byteArray) {
  let t = 165;
  for (let r = 0; r < byteArray.length; r++) {
    byteArray[r] = (byteArray[r] ^ t) + (r % 256);
    t = byteArray[r];
  }
  return byteArray;
}

function generateCursorChecksum(token) {
  const machineId = generateHashed64Hex(token, 'machineId');
  const macMachineId = generateHashed64Hex(token, 'macMachineId');
  const timestamp = Math.floor(Date.now() / 1e6);
  const byteArray = new Uint8Array([
    (timestamp >> 40) & 255,
    (timestamp >> 32) & 255,
    (timestamp >> 24) & 255,
    (timestamp >> 16) & 255,
    (timestamp >> 8) & 255,
    255 & timestamp,
  ]);
  const obfuscatedBytes = obfuscateBytes(byteArray);
  const encodedChecksum = Buffer.from(obfuscatedBytes).toString('base64');
  return `${encodedChecksum}${machineId}/${macMachineId}`;
}

// ─── Streaming Utilities ────────────────────────────────────────────────
// These classes enable real-time SSE streaming to OpenClaw while still
// detecting tool calls (both native protobuf and text-based <tool_call> tags).
// Without these, the proxy buffers the ENTIRE response (~5-70 seconds)
// before sending anything, blocking OpenClaw's Telegram draft streaming.
// ────────────────────────────────────────────────────────────────────────

/**
 * Incremental parser for Cursor's binary-framed streaming protocol.
 * Handles frames split across TCP packets (the root cause of Z_BUF_ERROR).
 * Frame format: [1 byte magic] [4 bytes BE length] [N bytes data]
 */
class IncrementalFrameParser {
  constructor() {
    this.pending = Buffer.alloc(0);
  }

  /**
   * Feed a new data chunk from the HTTP response body.
   * Returns an array of complete frames: [{ magic, data }]
   */
  addChunk(chunk) {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const frames = [];

    while (this.pending.length >= 5) {
      const magic = this.pending[0];
      const dataLength = this.pending.readUInt32BE(1);

      if (dataLength === 0) {
        this.pending = this.pending.subarray(5);
        continue;
      }

      if (this.pending.length < 5 + dataLength) {
        break; // Incomplete frame — wait for more data
      }

      // Copy frame data (subarray refs get invalidated on next concat)
      const data = Buffer.from(this.pending.subarray(5, 5 + dataLength));
      this.pending = this.pending.subarray(5 + dataLength);
      frames.push({ magic, data });
    }

    return frames;
  }
}

/**
 * Process a single protobuf frame. Returns text, thinking, and native tool calls
 * as SEPARATE outputs (unlike chunkToUtf8String which merges tool calls into text).
 *
 * @param {number} magic - Frame magic byte (0=raw protobuf, 1=gzipped, 2/3=JSON metadata)
 * @param {Buffer} data - Frame payload (after 5-byte header)
 * @param {Set} seenToolCallIds - Already-processed tool call IDs (for cross-frame dedup)
 * @returns {{ text: string, thinking: string, nativeToolCalls: Array }}
 */
function processSingleFrame(magic, data, seenToolCallIds) {
  const result = { text: '', thinking: '', nativeToolCalls: [] };

  try {
    if (magic === 0 || magic === 1) {
      const gunzipData = magic === 0 ? data : zlib.gunzipSync(data);
      const response = $root.StreamUnifiedChatWithToolsResponse.decode(gunzipData);

      const thinking = response?.message?.thinking?.content;
      if (thinking !== undefined) result.thinking = thinking;

      const content = response?.message?.content;
      if (content !== undefined) result.text = content;

      // Scan raw protobuf for native tool calls (separate from text content)
      const nativeCalls = findNativeToolCalls(gunzipData);
      for (const tc of nativeCalls) {
        if (!seenToolCallIds.has(tc.toolCallId)) {
          seenToolCallIds.add(tc.toolCallId);
          result.nativeToolCalls.push(tc);
        }
      }
    } else if (magic === 2 || magic === 3) {
      const gunzipData = magic === 2 ? data : zlib.gunzipSync(data);
      const utf8 = gunzipData.toString('utf-8');
      try {
        const message = JSON.parse(utf8);
        if (message != null && (typeof message !== 'object' ||
          (Array.isArray(message) ? message.length > 0 : Object.keys(message).length > 0))) {
          console.error(utf8);
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn(`[processSingleFrame] Frame error (magic=${magic}): ${err.code || err.message}`);
  }

  return result;
}

/**
 * Streaming detector for <tool_call> XML tags in incremental text.
 * Holds back tool call blocks while streaming plain text immediately.
 *
 * Design: As text tokens arrive from protobuf frames, this detector:
 *   - Streams text that is NOT part of a <tool_call> block immediately
 *   - Detects <tool_call>...</tool_call> boundaries and holds them back
 *   - Handles partial tags at chunk boundaries (e.g. "<tool" at end of frame)
 *   - Normalizes common near-miss formats ([tool_call], <function_call>, <tool-call>)
 *   - Handles unclosed <tool_call> blocks (model output cut off)
 */
class StreamingToolCallDetector {
  constructor() {
    this.buffer = '';
    this.toolCallBlocks = [];
    this.insideTag = false;
  }

  /**
   * Feed new text from a protobuf frame.
   * Returns safe text that can be streamed to the client immediately.
   * Any text that is part of a <tool_call> block is held back.
   */
  addText(newText) {
    // Normalize common near-miss formats on the fly
    let normalized = newText;
    if (/\[tool_call\]/i.test(normalized)) {
      normalized = normalized.replace(/\[tool_call\]/gi, '<tool_call>').replace(/\[\/tool_call\]/gi, '</tool_call>');
    }
    if (/<function_call>/i.test(normalized)) {
      normalized = normalized.replace(/<function_call>/gi, '<tool_call>').replace(/<\/function_call>/gi, '</tool_call>');
    }
    if (/<tool-call>/i.test(normalized)) {
      normalized = normalized.replace(/<tool-call>/gi, '<tool_call>').replace(/<\/tool-call>/gi, '</tool_call>');
    }

    this.buffer += normalized;
    return this._extractSafe();
  }

  _extractSafe() {
    let safe = '';

    while (true) {
      if (this.insideTag) {
        // We're inside a <tool_call>...</tool_call> block
        const closeIdx = this.buffer.indexOf('</tool_call>');
        if (closeIdx !== -1) {
          // Found closing tag — collect the block content
          this.toolCallBlocks.push(this.buffer.substring(0, closeIdx).trim());
          this.buffer = this.buffer.substring(closeIdx + '</tool_call>'.length);
          this.insideTag = false;
          continue;
        }
        break; // Still inside tag, wait for more data
      }

      // Not inside a tag — look for <tool_call> opening
      const openIdx = this.buffer.indexOf('<tool_call>');
      if (openIdx !== -1) {
        // Everything before the tag is safe to stream
        if (openIdx > 0) safe += this.buffer.substring(0, openIdx);
        this.buffer = this.buffer.substring(openIdx + '<tool_call>'.length);
        this.insideTag = true;
        continue;
      }

      // Check for partial tag at end of buffer
      // (e.g. "<tool_ca" could be the start of "<tool_call>")
      const holdBack = this._partialTagLength();
      if (holdBack > 0) {
        const safeEnd = this.buffer.length - holdBack;
        if (safeEnd > 0) {
          safe += this.buffer.substring(0, safeEnd);
          this.buffer = this.buffer.substring(safeEnd);
        }
        break;
      }

      // Everything is safe to stream
      safe += this.buffer;
      this.buffer = '';
      break;
    }

    return safe;
  }

  _partialTagLength() {
    const tags = ['<tool_call>', '</tool_call>'];
    let maxLen = 0;
    for (const tag of tags) {
      for (let len = Math.min(tag.length - 1, this.buffer.length); len > 0; len--) {
        if (this.buffer.endsWith(tag.substring(0, len))) {
          maxLen = Math.max(maxLen, len);
          break;
        }
      }
    }
    return maxLen;
  }

  /**
   * Call when the stream ends. Returns any remaining text and collected tool call blocks.
   */
  finish() {
    let remainingText = '';

    if (this.insideTag) {
      // Unclosed <tool_call> — model was cut off, try to parse it anyway
      if (this.buffer.trim()) {
        console.warn('[StreamingToolCallDetector] Unclosed <tool_call> block at end of stream');
        this.toolCallBlocks.push(this.buffer.trim());
      }
    } else {
      // Any remaining buffer text is safe to stream
      remainingText = this.buffer;
    }

    this.buffer = '';
    return { remainingText, toolCallBlocks: this.toolCallBlocks };
  }
}

module.exports = {
  generateCursorBody,
  chunkToUtf8String,
  generateHashed64Hex,
  generateCursorChecksum,
  // Streaming utilities (used by v1.js real-time streaming path)
  IncrementalFrameParser,
  processSingleFrame,
  StreamingToolCallDetector,
  // Tool call mapping (used by v1.js to convert native → OpenClaw format)
  convertNativeToolCall,
  CURSOR_TOOL_NAMES,
};
