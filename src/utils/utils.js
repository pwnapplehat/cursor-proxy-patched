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

  // Agent mode activation strategy:
  //   1. Protobuf fields: unknown27=1, supportedTools=[...], chatModeEnum=2, chatMode="Agent"
  //      These make Cursor's backend generate an Agent-mode system prompt with native tools.
  //   2. PRIMARY PATH: Bidirectional H2 streaming (h2-bidi.js) handles native tool calls
  //      natively via protobuf. The model uses Cursor's native tools (Shell, Read, Write, etc.)
  //      and we intercept them, convert to OpenClaw format, execute, and send results back.
  //   3. FALLBACK: chunkToUtf8String scans response for native tool calls and converts them
  //      to OpenClaw format. Text-based <tool_call> XML parsing also works as a second fallback.

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
      // findNativeToolCalls) and converts them to OpenClaw format so the
      // existing OpenAI-compatible pipeline handles them.
      //
      // EDIT_FILE (7) and EDIT_FILE_V2 (38) are now INCLUDED.
      // Cursor streams large tool calls across multiple frames using
      // is_streaming (field 14) and is_last_message (field 15). The
      // StreamingToolCallAccumulator concatenates rawArgs deltas across
      // frames, so full file content is captured before JSON.parse.
      // If accumulation fails, the truncation fallback (heredoc hint)
      // remains as a safety net.
      supportedTools: [
        5,  // READ_FILE
        6,  // LIST_DIR
        7,  // EDIT_FILE — now enabled: streaming rawArgs accumulation handles large payloads
        8,  // FILE_SEARCH
        11, // DELETE_FILE — maps to exec rm, common file operation
        15, // RUN_TERMINAL_COMMAND_V2
        18, // WEB_SEARCH
        38, // EDIT_FILE_V2 — now enabled: streaming rawArgs accumulation handles large payloads
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
 * Returns { tool, toolCallId, name, rawArgs, isStreaming, isLastMessage } or null.
 *
 * Cursor streams large tool calls (e.g., EDIT_FILE_V2 with full file content)
 * across multiple frames using is_streaming (field 14) and is_last_message (field 15).
 * Each frame contains a DELTA of rawArgs — callers must accumulate them.
 */
function extractToolCallFromFields(fields) {
  const tool = pbGetInt(fields, 1);          // field 1: tool enum
  const toolCallId = pbGetString(fields, 3); // field 3: tool_call_id
  const name = pbGetString(fields, 9);       // field 9: name
  const rawArgs = pbGetString(fields, 10);   // field 10: raw_args
  const isStreaming = pbGetInt(fields, 14);   // field 14: is_streaming (bool as varint)
  const isLastMessage = pbGetInt(fields, 15); // field 15: is_last_message (bool as varint)

  // A valid tool call needs the tool enum > 0 and a tool_call_id.
  // For streaming chunks, rawArgs may be empty (just a delta piece),
  // so we allow toolCallId + tool as minimum for streaming calls.
  if (tool != null && tool > 0 && toolCallId && (name || rawArgs || isStreaming || isLastMessage)) {
    const rawLen = rawArgs ? rawArgs.length : 0;
    const startsWithBrace = rawArgs ? rawArgs.startsWith('{') : false;
    const endsWithBrace = rawArgs ? rawArgs.endsWith('}') : false;
    const preview = rawLen > 200 ? rawArgs.substring(0, 100) + '...[' + rawLen + ' chars]...' + rawArgs.substring(rawLen - 80) : (rawArgs || '');

    // DIAGNOSTIC: Log every tool call extraction with streaming flags and rawArgs shape
    console.log(`[DIAG:extractTC] enum=${tool} id=${toolCallId.substring(0, 20)} name="${name || ''}" ` +
      `isStreaming=${!!isStreaming} isLastMessage=${!!isLastMessage} ` +
      `rawArgs.len=${rawLen} startsWithBrace=${startsWithBrace} endsWithBrace=${endsWithBrace}`);
    if (rawLen > 0) {
      console.log(`[DIAG:extractTC]   rawArgs.preview: ${preview.replace(/\n/g, '\\n').substring(0, 400)}`);
    }

    return {
      tool,
      toolCallId,
      name: name || '',
      rawArgs: rawArgs || '',
      isStreaming: !!isStreaming,
      isLastMessage: !!isLastMessage,
    };
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

// ─── Streaming Tool Call Accumulator ──────────────────────────────────────
// Cursor streams large tool calls (e.g., EDIT_FILE_V2 writing an entire file)
// across multiple protobuf frames. Each frame has is_streaming=true and the
// final frame has is_last_message=true. The rawArgs in each frame is a DELTA
// that must be concatenated to get the full JSON.
//
// This accumulator collects streaming chunks and emits complete tool calls.
// Reference: TASK-26-tool-schemas.md ClientSideToolV2Call fields 14, 15.
// ─────────────────────────────────────────────────────────────────────────

class StreamingToolCallAccumulator {
  /**
   * @param {Set} [sharedFlushedIds] - Optional external Set for tracking flushed IDs
   *   across multiple accumulator instances (persists across streamBidiResponse calls
   *   on the same H2 bidi stream). If not provided, a local Set is used.
   */
  constructor(sharedFlushedIds) {
    this.pending = new Map(); // toolCallId → { tool, name, rawArgs, frameCount, frameSizes }
    this.flushedIds = sharedFlushedIds || new Set(); // IDs already flushed — ignore duplicates
  }

  /**
   * Feed a tool call extracted from a frame.
   * @param {Object} tc - { tool, toolCallId, name, rawArgs, isStreaming, isLastMessage }
   * @returns {Object|null} Completed tool call { tool, toolCallId, name, rawArgs, isDuplicate? } or null if still accumulating
   */
  feed(tc) {
    const rawLen = tc.rawArgs ? tc.rawArgs.length : 0;
    const startsWithBrace = tc.rawArgs ? tc.rawArgs.startsWith('{') : false;
    const endsWithBrace = tc.rawArgs ? tc.rawArgs.endsWith('}') : false;
    const preview = rawLen > 200 ? tc.rawArgs.substring(0, 100) + '...' + tc.rawArgs.substring(rawLen - 80) : (tc.rawArgs || '');

    // DUPLICATE TRACKING: If this tool call was already flushed (by force-flush,
    // flushIfComplete, or isLastMessage=true), we still need to accumulate
    // continuation frames and let them complete. Cursor's server expects a tool
    // result for EVERY completed tool call. If we silently ignore frames, the
    // bidi stream hangs forever. Instead, we mark completed duplicates with
    // isDuplicate=true so the caller can auto-ack them to Cursor without
    // forwarding to OpenClaw.
    const isDuplicate = this.flushedIds.has(tc.toolCallId);
    if (isDuplicate) {
      console.log(`[DIAG:Accum] DUPLICATE frame for already-flushed id=${tc.toolCallId.substring(0, 20)} ` +
        `isStreaming=${tc.isStreaming} isLastMessage=${tc.isLastMessage} rawArgs.len=${rawLen} — still accumulating for auto-ack`);
    }

    // Non-streaming tool call — complete in one frame
    if (!tc.isStreaming && !tc.isLastMessage) {
      console.log(`[DIAG:Accum] NON-STREAMING tool call: id=${tc.toolCallId.substring(0, 20)} ` +
        `rawArgs.len=${rawLen} startsWithBrace=${startsWithBrace} endsWithBrace=${endsWithBrace}` +
        (isDuplicate ? ' (DUPLICATE)' : ''));
      return { tool: tc.tool, toolCallId: tc.toolCallId, name: tc.name, rawArgs: tc.rawArgs || '{}', isDuplicate };
    }

    const existing = this.pending.get(tc.toolCallId);

    if (existing) {
      existing.frameCount++;
      existing.frameSizes.push(rawLen);

      // DIAGNOSTIC: Log every continuation frame — this is the KEY data for determining format
      const prevLen = existing.rawArgs.length;
      console.log(`[DIAG:Accum] CONTINUATION frame #${existing.frameCount} for id=${tc.toolCallId.substring(0, 20)}: ` +
        `isStreaming=${tc.isStreaming} isLastMessage=${tc.isLastMessage} ` +
        `thisFrame.rawArgs.len=${rawLen} accumulated.len=${prevLen} ` +
        `thisStartsWithBrace=${startsWithBrace} thisEndsWithBrace=${endsWithBrace}`);
      if (rawLen > 0) {
        console.log(`[DIAG:Accum]   thisFrame.preview: ${preview.replace(/\n/g, '\\n').substring(0, 400)}`);
      }

      // Detect streaming format: FULL REPLACEMENTS vs DELTAS.
      // In full-replacement mode, every frame contains the complete rawArgs
      // rebuilt from scratch (always starts with '{'). In delta mode, only
      // the first frame starts with '{' and subsequent frames are fragments.
      //
      // Confirmed by live diagnostic logs: Cursor sends full replacements
      // for EDIT_FILE_V2 (write) — every frame starts with '{'.
      if (startsWithBrace) {
        // Full replacement — take this frame as the new complete state
        console.log(`[DIAG:Accum] FULL REPLACEMENT detected (starts with '{') — replacing (was ${prevLen} chars, now ${rawLen} chars)`);
        existing.rawArgs = tc.rawArgs;
      } else {
        // Delta — append fragment to accumulated string
        console.log(`[DIAG:Accum] DELTA detected (no leading '{') — appending ${rawLen} chars to ${prevLen} chars`);
        existing.rawArgs += tc.rawArgs;
      }
      // Use name from later frames if earlier ones were empty
      if (tc.name && !existing.name) existing.name = tc.name;

      if (tc.isLastMessage) {
        // Streaming complete — emit the full tool call
        this.pending.delete(tc.toolCallId);
        if (!isDuplicate) this.flushedIds.add(tc.toolCallId);
        const finalLen = existing.rawArgs.length;
        const finalStartsBrace = existing.rawArgs.startsWith('{');
        const finalEndsBrace = existing.rawArgs.endsWith('}');

        console.log(`[DIAG:Accum] ★ COMPLETED streaming tool call: id=${tc.toolCallId.substring(0, 20)} ` +
          `totalFrames=${existing.frameCount} frameSizes=[${existing.frameSizes.join(',')}] ` +
          `finalRawArgs.len=${finalLen} startsWithBrace=${finalStartsBrace} endsWithBrace=${finalEndsBrace}` +
          (isDuplicate ? ' (DUPLICATE — will auto-ack)' : ''));

        return {
          tool: existing.tool,
          toolCallId: tc.toolCallId,
          name: existing.name,
          rawArgs: existing.rawArgs || '{}',
          isDuplicate,
        };
      }
      return null; // Still accumulating
    }

    // First frame for this toolCallId
    if (tc.isLastMessage && !tc.isStreaming) {
      console.log(`[DIAG:Accum] SINGLE-FRAME streaming tool call (isLastMessage=true, isStreaming=false): ` +
        `id=${tc.toolCallId.substring(0, 20)} rawArgs.len=${rawLen}` +
        (isDuplicate ? ' (DUPLICATE)' : ''));
      if (!isDuplicate) this.flushedIds.add(tc.toolCallId);
      return { tool: tc.tool, toolCallId: tc.toolCallId, name: tc.name, rawArgs: tc.rawArgs || '{}', isDuplicate };
    }

    // Start accumulating — this is FRAME #1
    this.pending.set(tc.toolCallId, {
      tool: tc.tool,
      name: tc.name,
      rawArgs: tc.rawArgs,
      frameCount: 1,
      frameSizes: [rawLen],
    });
    console.log(`[DIAG:Accum] FIRST FRAME for streaming tool call: id=${tc.toolCallId.substring(0, 20)} ` +
      `isStreaming=${tc.isStreaming} isLastMessage=${tc.isLastMessage} ` +
      `rawArgs.len=${rawLen} startsWithBrace=${startsWithBrace} endsWithBrace=${endsWithBrace}`);
    if (rawLen > 0) {
      console.log(`[DIAG:Accum]   firstFrame.preview: ${preview.replace(/\n/g, '\\n').substring(0, 400)}`);
    }

    if (tc.isLastMessage) {
      // Edge case: first AND last in same frame
      const data = this.pending.get(tc.toolCallId);
      this.pending.delete(tc.toolCallId);
      if (!isDuplicate) this.flushedIds.add(tc.toolCallId);
      console.log(`[DIAG:Accum] FIRST+LAST frame (single streamed frame): id=${tc.toolCallId.substring(0, 20)} rawArgs.len=${rawLen}` +
        (isDuplicate ? ' (DUPLICATE)' : ''));
      return { tool: data.tool, toolCallId: tc.toolCallId, name: data.name, rawArgs: data.rawArgs || '{}', isDuplicate };
    }

    return null; // Still accumulating
  }

  /**
   * Check if there are any pending (still-accumulating) streaming tool calls.
   * Used by the turn inactivity timer to decide whether to flush.
   * @returns {boolean}
   */
  hasPending() {
    return this.pending.size > 0;
  }

  /**
   * Get info about pending (still-accumulating) streaming tool calls.
   * Used to send provisional acks to Cursor to trigger continuation frames.
   * Includes rawArgs so the caller can extract file paths for realistic
   * provisional messages (prevents the model from seeing "OK" as the result).
   * @returns {Array<{toolCallId: string, tool: number, rawArgs: string}>}
   */
  getPendingEntries() {
    const entries = [];
    for (const [toolCallId, data] of this.pending) {
      entries.push({ toolCallId, tool: data.tool, name: data.name, rawArgs: data.rawArgs });
    }
    return entries;
  }

  /**
   * Flush only pending streaming tool calls that have complete-looking JSON
   * (rawArgs starts with '{' and ends with '}'). Incomplete entries stay
   * pending so the turn timer can re-check after more frames arrive.
   *
   * This prevents premature flushing when the model is still generating
   * tokens and there's a >1.5s gap between streaming frames.
   * @returns {Array<Object>} Array of completed tool calls
   */
  flushIfComplete() {
    // Known edit tools send multi-key JSON in stages: file_path first, then
    // old_string/new_string in later streaming frames. The first frame
    // {"file_path":"..."} looks like valid complete JSON but is NOT the full
    // payload. Deferring these lets them reach the provisional-ack path,
    // which triggers Cursor to send continuation frames with the full args.
    const EDIT_LIKE_TOOL_NAMES = new Set(['search_replace', 'edit_file', 'edit_file_v2', 'str_replace']);

    const results = [];
    for (const [toolCallId, data] of this.pending) {
      const starts = data.rawArgs.startsWith('{');
      const ends = data.rawArgs.endsWith('}');
      if (starts && ends) {
        // Safety: for edit-like tools with only 1 frame, do NOT flush yet.
        // The first frame likely contains only file_path — the real payload
        // (old_string/new_string) arrives in continuation frames triggered
        // by the provisional ack. Flushing now would send incomplete args.
        if (data.frameCount === 1 && EDIT_LIKE_TOOL_NAMES.has(data.name)) {
          console.log(`[DIAG:Accum] flushIfComplete: DEFERRED — edit tool "${data.name}" with only 1 frame ` +
            `(id=${toolCallId.substring(0, 20)} rawArgs.len=${data.rawArgs.length}) — waiting for continuation`);
          continue;
        }

        // Safety: for write tools with only 1 frame, check if contents
        // is actually present. GPT-4o streams write calls in stages:
        // first frame = {"file_path":"..."} (valid JSON but NO contents),
        // then continuation frames = {"file_path":"...","contents":"actual text"}.
        // Without this check, the first frame flushes immediately and writes
        // an empty (0-byte) file — the real content arrives as a duplicate
        // and gets auto-acked without being sent to OpenClaw.
        if (data.frameCount === 1 && data.name === 'write') {
          try {
            const parsed = JSON.parse(data.rawArgs);
            if (!('contents' in parsed) && !('content' in parsed)) {
              console.log(`[DIAG:Accum] flushIfComplete: DEFERRED — write tool with only file_path (no contents) ` +
                `(id=${toolCallId.substring(0, 20)} rawArgs.len=${data.rawArgs.length} keys=[${Object.keys(parsed).join(',')}]) — waiting for content frame`);
              continue;
            }
          } catch (e) {
            // JSON parse failed — fall through to normal flush logic
          }
        }

        const dup = this.flushedIds.has(toolCallId);
        console.log(`[DIAG:Accum] flushIfComplete: COMPLETE — id=${toolCallId.substring(0, 20)} ` +
          `rawArgs.len=${data.rawArgs.length} frames=${data.frameCount}` +
          (dup ? ' (DUPLICATE)' : ''));
        results.push({
          tool: data.tool,
          toolCallId,
          name: data.name,
          rawArgs: data.rawArgs,
          isDuplicate: dup,
        });
        this.pending.delete(toolCallId);
        if (!dup) this.flushedIds.add(toolCallId);
      } else {
        console.log(`[DIAG:Accum] flushIfComplete: INCOMPLETE — id=${toolCallId.substring(0, 20)} ` +
          `rawArgs.len=${data.rawArgs.length} starts=${starts} ends=${ends} — keeping pending`);
      }
    }
    return results;
  }

  /**
   * Flush any pending (incomplete) streaming tool calls.
   * Called at end of stream or safety timeout — these are tool calls
   * where streaming started but isLastMessage=true never arrived.
   * With full-replacement format, the stored rawArgs IS the latest
   * complete state, so this produces valid results.
   * @returns {Array<Object>} Array of partially accumulated tool calls
   */
  flush() {
    const results = [];
    for (const [toolCallId, data] of this.pending) {
      const dup = this.flushedIds.has(toolCallId);
      console.warn(`[DIAG:Accum] FLUSHING incomplete streaming tool call: ${toolCallId} ` +
        `(${data.rawArgs.length} chars, ${data.frameCount} frames, frameSizes=[${data.frameSizes.join(',')}])` +
        (dup ? ' (DUPLICATE)' : ''));
      results.push({
        tool: data.tool,
        toolCallId,
        name: data.name,
        rawArgs: data.rawArgs || '{}',
        isDuplicate: dup,
      });
      if (!dup) this.flushedIds.add(toolCallId);
    }
    this.pending.clear();
    return results;
  }
}

// Cursor ClientSideToolV2 enum → human-readable name (for logging / fallback)
// These should match what the model ACTUALLY sends in tc.name field.
// Reference: cursor_agent_client.py ClientSideToolV2, TASK-126-toolv2-params.md
const CURSOR_TOOL_NAMES = {
  3:  'ripgrep_search',        // legacy ripgrep (RIPGREP_RAW_SEARCH=41 is V2)
  5:  'read_file',
  6:  'list_dir',
  7:  'edit_file',
  8:  'file_search',
  11: 'delete_file',           // DELETE_FILE — model sends 'delete_file'
  15: 'run_terminal_cmd',      // model sends 'run_terminal_cmd', not 'run_terminal_command'
  18: 'web_search',
  38: 'write',                 // model sends 'write', not 'edit_file_v2' (enum name is misleading)
  39: 'list_dir_v2',
  40: 'read_file_v2',
  41: 'ripgrep_raw_search',    // model sends 'ripgrep_raw_search'
  42: 'glob_file_search',
  50: 'apply_agent_diff',      // agent-generated diff apply (OpenClaw has no direct equivalent)
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
  'target_file': 'path',               // Cursor's read_file/read_file_v2 uses target_file; OpenClaw read uses path
  'target_directory': 'path',           // Cursor's list_dir_v2 uses target_directory; mapped to exec anyway but safe to have
  'directory_path': 'path',             // Cursor's list_dir uses directory_path (ListDirParams)
  'relative_workspace_path': 'path',    // Cursor's edit_file, edit_file_v2, delete_file use this
  'contents': 'content',
  'contents_after_edit': 'content',     // EditFileV2Params full-file replace
  'search_term': 'query',
};

// Cursor-specific params to drop (not used by OpenClaw)
// is_background and blocking are dropped because backgrounding is disabled
// (process tool denied in openclaw.json → allowBackground=false → exec runs synchronously).
const CURSOR_DROP_PARAMS = new Set(['explanation', 'blocking', 'is_background']);

// ─── Ripgrep command builder ─────────────────────────────────────────
// Translates Cursor's ripgrep tool args into a proper `rg` shell command.
// Without this, output_mode:"files_with_matches" (→ rg -l), -i, and glob
// filters were silently ignored, causing full-content scans that took 5-10s+
// on large codebases and triggering ERROR_USER_ABORTED_REQUEST.
function buildRgCommand(args) {
  const flags = [];
  const pattern = args.pattern || '';
  const searchPath = args.path || '.';

  // ── Output mode ──
  // files_with_matches → -l (stop after first match per file — dramatically faster)
  // count → -c (output match count per file)
  // content (default) → -n (include line numbers)
  const mode = args.output_mode;
  if (mode === 'files_with_matches') flags.push('-l');
  else if (mode === 'count') flags.push('-c');
  else flags.push('-n');

  // ── Case insensitivity ──
  // Model sends "-i": true (from Grep tool def); proto field is "case_insensitive".
  // Cursor's native client: caseInsensitive === true → --ignore-case, else → --case-sensitive
  if (args['-i'] === true || args.case_insensitive === true || args.caseInsensitive === true) {
    flags.push('--ignore-case');
  } else {
    flags.push('--case-sensitive');
  }

  // ── Context lines (only meaningful in content mode) ──
  // Model sends -A/-B/-C (from Grep tool def); proto fields are context_after/context_before/context.
  // Cursor native: contextBefore → --before-context, contextAfter → --after-context,
  //   context → --before-context + --after-context (when neither contextBefore nor contextAfter set)
  if (!mode || mode === 'content') {
    const ctxC = parseInt(args['-C'] ?? args.context, 10);
    const ctxA = parseInt(args['-A'] ?? args.context_after ?? args.contextAfter, 10);
    const ctxB = parseInt(args['-B'] ?? args.context_before ?? args.contextBefore, 10);
    if (ctxA > 0 || ctxB > 0) {
      // Explicit before/after takes priority (matches Cursor native behavior)
      if (ctxB > 0) flags.push(`--before-context ${ctxB}`);
      if (ctxA > 0) flags.push(`--after-context ${ctxA}`);
    } else if (ctxC > 0) {
      flags.push(`-C ${ctxC}`);
    }
  }

  // ── Multiline matching ──
  if (args.multiline === true) flags.push('-U --multiline-dotall');

  // ── Glob filter (e.g. "*.smali", "*.json") ──
  if (args.glob && typeof args.glob === 'string') flags.push(`--glob ${shellEscape(args.glob)}`);

  // ── File type filter (e.g. "js", "py") ──
  if (args.type && typeof args.type === 'string') flags.push(`--type ${shellEscape(args.type)}`);

  // ── Assemble command ──
  const flagStr = flags.length ? flags.join(' ') + ' ' : '';
  let cmd = `rg ${flagStr}${shellEscape(pattern)} ${shellEscape(searchPath)}`;

  // ── Offset + head_limit pipeline ──
  const offset = parseInt(args.offset, 10);
  const headLimit = parseInt(args.head_limit, 10);
  if (offset > 0 && headLimit > 0) {
    cmd += ` | tail -n +${offset + 1} | head -${headLimit}`;
  } else if (offset > 0) {
    cmd += ` | tail -n +${offset + 1}`;
  } else if (headLimit > 0) {
    cmd += ` | head -${headLimit}`;
  }

  // No yieldMs needed — backgrounding is disabled via process tool denial in openclaw.json.
  // Commands run synchronously to completion (limited only by timeoutSec, default 7200s).
  return { name: 'exec', arguments: { command: cmd } };
}

// Tools that need full argument restructuring (not just param rename).
// Each returns { name, arguments } ready for OpenClaw.
const SPECIAL_TOOL_CONVERSIONS = {
  // ─── Directory listing ──────────────────────────────────────────────
  'list_dir': (args) => ({
    name: 'exec',
    arguments: { command: `ls -la ${shellEscape(args.target_directory || args.directory_path || args.path || '.')}` },
  }),
  'list_dir_v2': (args) => ({
    name: 'exec',
    arguments: { command: `ls -la ${shellEscape(args.target_directory || args.directory_path || args.path || '.')}` },
  }),

  // ─── Search tools ──────────────────────────────────────────────────
  'ripgrep_raw_search': (args) => buildRgCommand(args),
  'ripgrep_search':     (args) => buildRgCommand(args),
  'file_search': (args) => ({
    name: 'exec',
    arguments: { command: `find ${shellEscape(args.path || '.')} -name ${shellEscape(args.pattern || args.query || '*')} 2>/dev/null` },
  }),
  'glob_file_search': (args) => ({
    name: 'exec',
    arguments: { command: `find ${shellEscape(args.path || '.')} -name ${shellEscape(args.glob_pattern || args.pattern || '*')} 2>/dev/null` },
  }),

  // ─── File delete ─────────────────────────────────────────────────────
  // Cursor's DELETE_FILE (enum 11) uses DeleteFileParams: relative_workspace_path.
  // Maps to exec rm since OpenClaw has no native delete_file tool.
  'delete_file': (args) => {
    const pathVal = args.target_file || args.relative_workspace_path || args.file_path || args.path || '';
    if (!pathVal) {
      console.warn('[convertNativeToolCall] delete_file called without a path — skipping');
      return null;
    }
    return {
      name: 'exec',
      arguments: { command: `rm -f ${shellEscape(pathVal)}` },
    };
  },

  // ─── File edit/write (args-based detection) ─────────────────────────
  // Cursor's EDIT_FILE_V2 (enum 38) is used for BOTH write (create/overwrite)
  // and edit (old_string/new_string) operations. The model's tc.name is usually
  // 'write' for creation, but the enum fallback is 'edit_file_v2'.
  // EditFileV2Params uses contents_after_edit for full-file replace (TASK-126).
  // EditFileParams/EditFileV2Params use relative_workspace_path for path.
  'edit_file': (args) => {
    const pathVal = args.file_path || args.path || args.relative_workspace_path || '';
    if ('contents' in args || 'content' in args || 'contents_after_edit' in args) {
      return {
        name: 'write',
        arguments: {
          path: pathVal,
          content: args.contents || args.content || args.contents_after_edit || '',
        },
      };
    }
    return {
      name: 'edit',
      arguments: {
        path: pathVal,
        oldText: args.old_string || args.oldText || args.old_text || '',
        newText: args.new_string || args.newText || args.new_text || '',
      },
    };
  },
  'edit_file_v2': (args) => {
    const pathVal = args.file_path || args.path || args.relative_workspace_path || '';
    if ('contents' in args || 'content' in args || 'contents_after_edit' in args) {
      return {
        name: 'write',
        arguments: {
          path: pathVal,
          content: args.contents || args.content || args.contents_after_edit || '',
        },
      };
    }
    return {
      name: 'edit',
      arguments: {
        path: pathVal,
        oldText: args.old_string || args.oldText || args.old_text || '',
        newText: args.new_string || args.newText || args.new_text || '',
      },
    };
  },
  // CURSOR_TOOL_NAMES[38] = 'write', so the model often sends tc.name = 'write'
  // for EDIT_FILE_V2 file creation. Without this entry, 'write' falls through to
  // the standard param rename path — which works for creation (contents_after_edit → content),
  // but would mishandle an edit (old_string/new_string wouldn't be remapped).
  // This defensive handler ensures correct routing regardless of tc.name.
  'write': (args) => {
    const pathVal = args.file_path || args.path || args.relative_workspace_path || '';
    if ('contents' in args || 'content' in args || 'contents_after_edit' in args) {
      return {
        name: 'write',
        arguments: {
          path: pathVal,
          content: args.contents || args.content || args.contents_after_edit || '',
        },
      };
    }
    // Edge case: model sent "write" but with old_string/new_string
    if ('old_string' in args || 'new_string' in args) {
      return {
        name: 'edit',
        arguments: {
          path: pathVal,
          oldText: args.old_string || args.oldText || args.old_text || '',
          newText: args.new_string || args.newText || args.new_text || '',
        },
      };
    }
    // Pure write with just path + content via standard params
    return {
      name: 'write',
      arguments: {
        path: pathVal,
        content: args.content || args.contents || '',
      },
    };
  },

  // ─── StrReplace / search_replace ────────────────────────────────────
  // Cursor's Agent mode sends StrReplace as tc.name = "search_replace" (enum 38).
  // This is DIFFERENT from "write" which is also enum 38 but for file creation.
  // The model sends "search_replace" with file_path, old_string, new_string.
  // Must map to OpenClaw's "edit" tool with path, oldText, newText.
  // Without this entry, it falls through as "search_replace" which OpenClaw rejects.
  'search_replace': (args) => {
    const pathVal = args.file_path || args.path || args.relative_workspace_path || '';
    return {
      name: 'edit',
      arguments: {
        path: pathVal,
        oldText: args.old_string || args.oldText || args.old_text || '',
        newText: args.new_string || args.newText || args.new_text || '',
      },
    };
  },

  // ─── Unsupported tools (no OpenClaw equivalent) ─────────────────────
  // APPLY_AGENT_DIFF (50) applies agent-generated diffs. OpenClaw has no
  // direct equivalent — skip and log so we don't forward unknown tool.
  'apply_agent_diff': (args) => {
    console.warn('[convertNativeToolCall] Skipping apply_agent_diff (enum 50) — OpenClaw has no equivalent. Use edit/write tools for file changes.');
    return null;
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
  const rawLen = tc.rawArgs ? tc.rawArgs.length : 0;

  // DIAGNOSTIC: Log every call to convertNativeToolCall with rawArgs analysis
  console.log(`[DIAG:convert] Converting tool call: cursorName="${cursorName}" enum=${tc.tool} ` +
    `id=${tc.toolCallId ? tc.toolCallId.substring(0, 20) : 'N/A'} rawArgs.len=${rawLen} ` +
    `startsWithBrace=${rawLen > 0 && tc.rawArgs.startsWith('{')} endsWithBrace=${rawLen > 0 && tc.rawArgs.endsWith('}')}`);
  if (rawLen > 0 && rawLen <= 500) {
    console.log(`[DIAG:convert]   rawArgs.full: ${tc.rawArgs.replace(/\n/g, '\\n')}`);
  } else if (rawLen > 500) {
    console.log(`[DIAG:convert]   rawArgs.first200: ${tc.rawArgs.substring(0, 200).replace(/\n/g, '\\n')}`);
    console.log(`[DIAG:convert]   rawArgs.last150: ${tc.rawArgs.substring(rawLen - 150).replace(/\n/g, '\\n')}`);
  }

  // 1. Validate rawArgs as JSON — truncated payloads need special handling
  let args;
  try {
    args = JSON.parse(tc.rawArgs);
    console.log(`[DIAG:convert] JSON.parse SUCCEEDED — keys: [${Object.keys(args).join(', ')}]`);
    // For file-write tools, log the payload sizes
    if (FILE_WRITE_TOOLS.has(cursorName)) {
      const contentLen = (args.contents_after_edit || args.content || args.contents || '').length;
      const pathVal = args.relative_workspace_path || args.file_path || args.path || '';
      console.log(`[DIAG:convert] FILE WRITE tool: path="${pathVal}" content.len=${contentLen}`);
    }
  } catch (parseErr) {
    console.warn(`[DIAG:convert] JSON.parse FAILED: ${parseErr.message}`);
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
    if (result) {
      console.log(`[convertNativeToolCall] ${cursorName} →(special)→ ${result.name} (args: ${JSON.stringify(result.arguments).substring(0, 150)})`);
    }
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

  // No yieldMs injection needed — backgrounding is disabled via process tool denial
  // in openclaw.json (allowBackground=false → exec runs synchronously to completion).
  // Only timeoutSec (default 7200s) limits execution time.

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
  // Streaming tool call accumulator: Cursor may stream large tool calls
  // (e.g., EDIT_FILE_V2 with full file content) across multiple frames.
  const toolCallAccumulator = new StreamingToolCallAccumulator();

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
          // Streaming tool calls — feed through accumulator
          let completedTc;
          if (tc.isStreaming || tc.isLastMessage) {
            completedTc = toolCallAccumulator.feed(tc);
            if (!completedTc) continue; // Still accumulating
          } else {
            // Non-streaming — dedup and process immediately
            if (seenToolCallIds.has(tc.toolCallId)) continue;
            seenToolCallIds.add(tc.toolCallId);
            completedTc = tc;
          }
          const cursorName = completedTc.name || CURSOR_TOOL_NAMES[completedTc.tool] || `cursor_tool_${completedTc.tool}`;
          console.log(`[chunkToUtf8String] Intercepted native tool call: ${cursorName} (enum=${completedTc.tool}, id=${completedTc.toolCallId}, rawArgs=${(completedTc.rawArgs || '').substring(0, 200)})`);
          const mapped = convertNativeToolCall(completedTc);
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

  // Flush any incomplete streaming tool calls that were still accumulating
  const flushedTCs = toolCallAccumulator.flush();
  for (const tc of flushedTCs) {
    const cursorName = tc.name || CURSOR_TOOL_NAMES[tc.tool] || `cursor_tool_${tc.tool}`;
    console.log(`[chunkToUtf8String] Flushed incomplete streaming tool call: ${cursorName} (enum=${tc.tool}, id=${tc.toolCallId}, rawArgs=${(tc.rawArgs || '').substring(0, 200)})`);
    const mapped = convertNativeToolCall(tc);
    if (mapped && mapped.truncated) {
      textOutput.push(`\n${mapped.hint}\n`);
      const safeFilePath = (mapped.filePath || 'file').replace(/'/g, "'\\''");
      const fallbackExec = {
        name: 'exec',
        arguments: {
          command: `echo "Ready for chunked heredoc write to: ${safeFilePath}"`
        }
      };
      textOutput.push(`\n<tool_call>\n${JSON.stringify(fallbackExec)}\n</tool_call>\n`);
    } else if (mapped) {
      textOutput.push(`\n<tool_call>\n${JSON.stringify(mapped)}\n</tool_call>\n`);
    }
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
  const result = { text: '', thinking: '', nativeToolCalls: [], error: null };

  try {
    if (magic === 0 || magic === 1) {
      const gunzipData = magic === 0 ? data : zlib.gunzipSync(data);
      const response = $root.StreamUnifiedChatWithToolsResponse.decode(gunzipData);

      // ── RAW PROTOBUF FIELD AUDIT ──────────────────────────────────
      // Scan ALL fields in the raw protobuf to detect signals Cursor
      // sends that our compiled proto definition doesn't cover (e.g.,
      // finish_reason, done, end_turn). Unknown fields are silently
      // skipped by protobufjs — this scan catches them.
      try {
        const rawFields = pbDecodeFields(gunzipData);
        const fieldNums = Object.keys(rawFields).map(Number).sort((a, b) => a - b);
        const knownTopLevel = new Set([2, 3]); // 2=message, 3=summary
        const unknownFields = fieldNums.filter(f => !knownTopLevel.has(f));
        if (unknownFields.length > 0) {
          console.log(`[FRAME-AUDIT] UNKNOWN top-level protobuf fields: [${unknownFields.join(', ')}] — may contain end-of-turn signal`);
          for (const f of unknownFields) {
            for (const entry of rawFields[f]) {
              if (entry.wireType === 0) {
                console.log(`[FRAME-AUDIT]   field ${f}: varint = ${entry.value}`);
              } else if (entry.wireType === 2 && Buffer.isBuffer(entry.value)) {
                const preview = entry.value.toString('utf-8').substring(0, 300);
                console.log(`[FRAME-AUDIT]   field ${f}: bytes (${entry.value.length}B) = "${preview}"`);
              } else if (entry.wireType === 1 || entry.wireType === 5) {
                console.log(`[FRAME-AUDIT]   field ${f}: fixed${entry.wireType === 1 ? '64' : '32'}`);
              }
            }
          }
        }
        // Also scan inside the message (field 2) for unknown sub-fields
        if (rawFields[2]) {
          for (const entry of rawFields[2]) {
            if (entry.wireType === 2 && Buffer.isBuffer(entry.value)) {
              try {
                const msgFields = pbDecodeFields(entry.value);
                const msgFieldNums = Object.keys(msgFields).map(Number).sort((a, b) => a - b);
                const knownMsg = new Set([1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 36]); // content, thinking, webtool, etc.
                const unknownMsg = msgFieldNums.filter(f => !knownMsg.has(f));
                if (unknownMsg.length > 0) {
                  console.log(`[FRAME-AUDIT] UNKNOWN message sub-fields: [${unknownMsg.join(', ')}]`);
                  for (const mf of unknownMsg) {
                    for (const me of msgFields[mf]) {
                      if (me.wireType === 0) {
                        console.log(`[FRAME-AUDIT]   message.field_${mf}: varint = ${me.value}`);
                      } else if (me.wireType === 2 && Buffer.isBuffer(me.value)) {
                        const mPreview = me.value.toString('utf-8').substring(0, 200);
                        console.log(`[FRAME-AUDIT]   message.field_${mf}: bytes (${me.value.length}B) = "${mPreview}"`);
                      }
                    }
                  }
                }
              } catch (_) { /* inner parse fail — ok */ }
            }
          }
        }
      } catch (_) { /* raw scan fail — non-fatal */ }

      const thinking = response?.message?.thinking?.content;
      if (thinking !== undefined) result.thinking = thinking;

      const content = response?.message?.content;
      if (content !== undefined) result.text = content;

      // Scan raw protobuf for native tool calls (separate from text content).
      // Streaming tool calls (is_streaming=true) are NOT deduped here — they
      // appear across multiple frames and must be accumulated by the caller
      // using StreamingToolCallAccumulator. Only non-streaming calls are deduped.
      const nativeCalls = findNativeToolCalls(gunzipData);
      if (nativeCalls.length > 0) {
        console.log(`[DIAG:processFrame] Found ${nativeCalls.length} tool call(s) in frame (magic=${magic}, dataLen=${data.length})`);
      }
      for (const tc of nativeCalls) {
        if (tc.isStreaming || tc.isLastMessage) {
          // Streaming chunk — always pass through for accumulation
          console.log(`[DIAG:processFrame] STREAMING chunk passed through: id=${tc.toolCallId.substring(0, 20)} isStreaming=${tc.isStreaming} isLastMessage=${tc.isLastMessage}`);
          result.nativeToolCalls.push(tc);
        } else if (!seenToolCallIds.has(tc.toolCallId)) {
          // Non-streaming complete tool call — dedup
          console.log(`[DIAG:processFrame] NON-STREAMING tool call (new): id=${tc.toolCallId.substring(0, 20)}`);
          seenToolCallIds.add(tc.toolCallId);
          result.nativeToolCalls.push(tc);
        } else {
          console.log(`[DIAG:processFrame] NON-STREAMING tool call (dedup skip): id=${tc.toolCallId.substring(0, 20)}`);
        }
      }
    } else if (magic === 2 || magic === 3) {
      // ConnectRPC error/trailer frame — parse and detect Cursor API errors.
      // Critical: Cursor sends errors like ERROR_CONVERSATION_TOO_LONG and
      // ERROR_USER_ABORTED_REQUEST as magic 2 frames. We must detect context
      // overflow errors and propagate them so OpenClaw can trigger compaction
      // (auto-summarization) instead of seeing an empty normal response.
      const gunzipData = magic === 2 ? data : zlib.gunzipSync(data);
      const utf8 = gunzipData.toString('utf-8');
      try {
        const message = JSON.parse(utf8);
        if (message != null && (typeof message !== 'object' ||
          (Array.isArray(message) ? message.length > 0 : Object.keys(message).length > 0))) {
          console.error(utf8);

          // Detect Cursor-specific errors and translate to standard OpenAI errors
          // so OpenClaw's isContextOverflowError() can match them and trigger
          // auto-compaction (summarization) instead of silently failing.
          const cursorError = detectCursorApiError(message);
          if (cursorError) {
            result.error = cursorError;
            console.warn(`[processSingleFrame] Detected Cursor API error: ${cursorError.type} — "${cursorError.message}"`);
          }
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn(`[processSingleFrame] Frame error (magic=${magic}): ${err.code || err.message}`);
  }

  // Frame summary — shows exactly what each frame contains
  const parts = [];
  if (result.text) parts.push(`text=${result.text.length}ch`);
  if (result.thinking) parts.push(`thinking=${result.thinking.length}ch`);
  if (result.nativeToolCalls.length > 0) parts.push(`toolCalls=${result.nativeToolCalls.length}`);
  if (result.error) parts.push(`error=${result.error.type}`);
  if (parts.length === 0) parts.push('empty');
  console.log(`[FRAME] magic=${magic} size=${data.length}B → ${parts.join(' | ')}`);

  return result;
}

/**
 * Detect and translate Cursor-specific API errors from ConnectRPC error frames.
 *
 * Cursor sends errors in a non-standard format:
 *   {"error":{"code":"invalid_argument","message":"Error","details":[
 *     {"type":"aiserver.v1.ErrorDetails","debug":{"error":"ERROR_CONVERSATION_TOO_LONG",...}}
 *   ]}}
 *
 * OpenClaw's isContextOverflowError() checks for patterns like:
 *   "context length exceeded", "prompt is too long", "exceeds model context window"
 *
 * This function translates Cursor errors into messages that match those patterns,
 * enabling OpenClaw to trigger auto-compaction (summarization) instead of silently
 * dropping the error and leaving the agent stuck.
 *
 * @param {object} message - Parsed JSON from a ConnectRPC error/trailer frame
 * @returns {{ type: string, message: string, code: string } | null}
 */
function detectCursorApiError(message) {
  if (!message?.error) return null;

  // Extract the Cursor-specific error code from the details array
  let cursorErrorCode = '';
  let cursorDetail = '';
  const details = message.error.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      const debugError = d?.debug?.error || '';
      const debugDetail = d?.debug?.details?.detail || '';
      if (debugError) cursorErrorCode = debugError;
      if (debugDetail) cursorDetail = debugDetail;
    }
  }

  const code = message.error.code || '';
  const topMessage = message.error.message || '';

  // Map Cursor errors to OpenAI-format errors that OpenClaw recognizes
  if (cursorErrorCode === 'ERROR_CONVERSATION_TOO_LONG' ||
      cursorDetail.toLowerCase().includes('conversation is too long')) {
    return {
      type: 'context_overflow',
      message: 'prompt is too long: context length exceeded — the conversation exceeds the model context window. Please compact or shorten the conversation.',
      code: 'context_length_exceeded',
    };
  }

  if (cursorErrorCode === 'ERROR_USER_ABORTED_REQUEST') {
    return {
      type: 'user_aborted',
      message: 'Tool call ended before result was received',
      code: 'aborted',
    };
  }

  // Generic fallback for unrecognized Cursor errors
  if (cursorErrorCode) {
    return {
      type: 'cursor_error',
      message: `Cursor API error: ${cursorErrorCode}${cursorDetail ? ' — ' + cursorDetail : ''}`,
      code: code || 'unknown',
    };
  }

  return null;
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

// ─── OpenClaw Tool Gateway via exec ──────────────────────────────────
// The Cursor model only trusts its native tools (run_terminal_cmd, read_file, etc.).
// OpenClaw-specific tools like sessions_spawn, memory_search, agents_list, etc.
// have NO native Cursor equivalent, so the model won't call them via <tool_call> tags.
//
// Solution: teach the model to invoke them via exec with the __oc prefix:
//   exec command: __oc sessions_spawn {"task": "build CSS", "model": "cursor/gpt-4o"}
//
// This function intercepts those exec calls and converts them to real OpenClaw tool calls
// BEFORE they are sent back to OpenClaw via SSE.
//
// The set of tools that NEED this gateway (no Cursor native equivalent):
const OC_ONLY_TOOLS = new Set([
  'sessions_spawn', 'session_status', 'sessions_send', 'sessions_list',
  'sessions_history', 'agents_list', 'memory_search', 'memory_get',
  'image', 'tts', 'browser', 'message', 'canvas', 'nodes', 'cron',
  'gateway', 'process', 'web_fetch',
]);

/**
 * Transforms exec tool calls that use the __oc prefix into real OpenClaw tool calls.
 * Input:  { name: "exec", arguments: '{"command":"__oc sessions_spawn {\\"task\\":\\"build CSS\\"}"}' }
 * Output: { name: "sessions_spawn", arguments: '{"task":"build CSS"}' }
 *
 * Tool calls that don't match the __oc pattern pass through unchanged.
 */
function expandOcExecCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return toolCalls;

  return toolCalls.map(tc => {
    if (!tc.function || tc.function.name !== 'exec') return tc;

    let args;
    try {
      args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;
    } catch (_) {
      return tc; // Invalid JSON — pass through
    }

    const command = args && typeof args.command === 'string' ? args.command.trim() : '';
    if (!command.startsWith('__oc ')) return tc; // Not an __oc call — pass through

    // Parse: __oc <toolName> [jsonArgs]
    const rest = command.substring(5).trim(); // Remove "__oc "
    const spaceIdx = rest.indexOf(' ');

    let toolName, toolArgsStr;
    if (spaceIdx > 0) {
      toolName = rest.substring(0, spaceIdx).trim();
      toolArgsStr = rest.substring(spaceIdx + 1).trim();
    } else {
      toolName = rest.trim();
      toolArgsStr = '{}';
    }

    // Validate the tool name is a known OpenClaw-only tool
    if (!OC_ONLY_TOOLS.has(toolName)) {
      console.warn(`[expandOcExecCalls] Unknown __oc tool: ${toolName} — passing through as exec`);
      return tc;
    }

    // Parse the JSON arguments
    let parsedArgs;
    try {
      parsedArgs = JSON.parse(toolArgsStr);
    } catch (e) {
      // Try to fix common issues: unquoted values, single quotes
      try {
        parsedArgs = JSON.parse(toolArgsStr.replace(/'/g, '"'));
      } catch (_) {
        console.warn(`[expandOcExecCalls] Failed to parse args for __oc ${toolName}: ${toolArgsStr.substring(0, 100)}`);
        return tc; // Can't parse — pass through as exec (will fail, but at least it's visible)
      }
    }

    console.log(`[expandOcExecCalls] __oc ${toolName} → ${toolName} (args: ${JSON.stringify(parsedArgs).substring(0, 200)})`);

    return {
      ...tc,
      function: {
        name: toolName,
        arguments: JSON.stringify(parsedArgs),
      }
    };
  });
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
  StreamingToolCallAccumulator,
  // Tool call mapping (used by v1.js to convert native → OpenClaw format)
  convertNativeToolCall,
  CURSOR_TOOL_NAMES,
  // OpenClaw tool gateway (used by v1.js to convert __oc exec calls → real tool calls)
  expandOcExecCalls,
};
