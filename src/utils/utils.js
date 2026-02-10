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
        os: "win32",
        arch: "x64",
        version: "10.0.22631",
        path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        timestamp: new Date().toISOString(),
      },
      unknown27: 1, // is_agentic = true (field 27) — REQUIRED for Agent mode
      // supported_tools (field 29): ClientSideToolV2 enum values.
      // REQUIRED for Agent mode system prompt. Without these, Cursor's backend
      // generates an "Ask mode" system prompt regardless of other fields.
      // The proxy intercepts native tool calls from the response (see
      // findNativeToolCalls) and converts them to <tool_call> XML so the
      // existing OpenAI-compatible pipeline handles them.
      supportedTools: [
        5,  // READ_FILE
        6,  // LIST_DIR
        7,  // EDIT_FILE
        8,  // FILE_SEARCH
        15, // RUN_TERMINAL_COMMAND_V2
        18, // WEB_SEARCH
        38, // EDIT_FILE_V2
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
      unknown48: 1, // should_disable_tools (field 48) — prevents native bidi tool dispatch
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

// Cursor ClientSideToolV2 enum → human-readable name (for logging/mapping)
const CURSOR_TOOL_NAMES = {
  5: 'read_file', 6: 'list_dir', 7: 'edit_file', 8: 'file_search',
  15: 'run_terminal_command', 18: 'web_search', 38: 'edit_file_v2',
  39: 'list_dir_v2', 40: 'read_file_v2', 41: 'ripgrep_search',
  42: 'glob_file_search',
};

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

        // Fallback: scan raw protobuf for native tool calls that our proto
        // definition doesn't cover (e.g. tool_call_v2 at field 36 inside Message).
        // If Cursor dispatches a native tool call, we intercept it here and
        // convert it to a <tool_call> XML block so the existing pipeline
        // (parseToolCalls in toolEmulation.js) handles it transparently.
        const nativeCalls = findNativeToolCalls(gunzipData);
        for (const tc of nativeCalls) {
          const cursorName = CURSOR_TOOL_NAMES[tc.tool] || `cursor_tool_${tc.tool}`;
          // Use the model's own name/rawArgs if present (field 9 & 10),
          // otherwise fall back to the Cursor enum name.
          const toolName = tc.name || cursorName;
          console.log(`[chunkToUtf8String] Intercepted native tool call: ${toolName} (enum=${tc.tool}, id=${tc.toolCallId}, rawArgs=${tc.rawArgs.substring(0, 200)})`);
          // Inject as <tool_call> so the text-based pipeline picks it up
          textOutput.push(`\n<tool_call>\n{"name": ${JSON.stringify(toolName)}, "arguments": ${tc.rawArgs}}\n</tool_call>\n`);
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

module.exports = {
  generateCursorBody,
  chunkToUtf8String,
  generateHashed64Hex,
  generateCursorChecksum
};
