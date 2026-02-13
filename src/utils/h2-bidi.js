'use strict';

/**
 * Bidirectional HTTP/2 streaming client for Cursor's Agent API.
 *
 * Cursor's StreamUnifiedChatWithTools is a bidirectional streaming RPC:
 *   Client → field 1: initial request (messages, model, tools)
 *   Server → streaming response (text, thinking, tool calls)
 *   Client → field 2: tool results (ClientSideToolV2Result)
 *   Server → continuation (more text, more tool calls, or done)
 *
 * The previous proxy used undici.fetch() which is UNIDIRECTIONAL — it can't
 * send tool results back on the same stream.  This caused:
 *   - ERROR_USER_ABORTED_REQUEST on every tool call
 *   - Full context re-send on each continuation (context bloat)
 *   - GPT-4o fallback from repeated errors
 *
 * This module uses Node.js's native http2 module for true bidirectional
 * streaming, eliminating all of the above issues.
 *
 * Protocol: ConnectRPC over HTTP/2
 * Frame format: [1 byte flags][4 bytes BE length][payload]
 * Endpoint: /aiserver.v1.ChatService/StreamUnifiedChatWithTools
 *
 * Based on reverse engineering by eisbaw/cursor_api_demo (TASK-26, TASK-43).
 */

const http2 = require('http2');
const { EventEmitter } = require('events');

// ─── Protobuf Encoding Primitives ────────────────────────────────────────

function pbEncodeVarint(value) {
  const bytes = [];
  value = value >>> 0; // ensure unsigned
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7F);
  return Buffer.from(bytes);
}

function pbEncodeField(fieldNum, wireType, value) {
  const tag = pbEncodeVarint((fieldNum << 3) | wireType);
  if (wireType === 0) {
    // Varint
    return Buffer.concat([tag, pbEncodeVarint(typeof value === 'number' ? value : 0)]);
  } else if (wireType === 2) {
    // Length-delimited (string, bytes, sub-message)
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf-8');
    return Buffer.concat([tag, pbEncodeVarint(data.length), data]);
  }
  throw new Error(`Unsupported wire type: ${wireType}`);
}

// ─── Tool Result Encoding ────────────────────────────────────────────────
// Complete mapping of ALL 44 ClientSideToolV2 tool enums to their result
// field numbers within ClientSideToolV2Result.
//
// Source of truth: eisbaw/cursor_api_demo → cursor_agent_client.py
//   _get_result_field_number() and _encode_tool_specific_result()
// Cross-verified against TASK-26-tool-schemas.md.
//
// Each entry: { field: <result field number>, encode: (text) => Buffer }
// The encode function creates the inner result message from the text output
// returned by OpenClaw's tool execution.

/** Helper: encode text into field 1 as string (most common pattern) */
function encodeTextField(text) {
  return pbEncodeField(1, 2, Buffer.from(text, 'utf-8'));
}

const TOOL_RESULT_FIELD_MAP = {
  // ─── Core file operations ──────────────────────────────────────────
  1:  { // READ_SEMSEARCH_FILES → ReadSemsearchFilesResult at field 2
    field: 2,
    encode: encodeTextField, // contents
  },
  3:  { // RIPGREP_SEARCH → RipgrepSearchResult at field 4
    // RipgrepSearchResult.internal(1) → RipgrepSearchResultInternal
    //   .results(1) = repeated IFileMatch, .exit(2) = enum
    field: 4,
    encode: (text) => {
      // Encode as: internal → single IFileMatch with text as preview
      const previewText = pbEncodeField(3, 2, Buffer.from(text, 'utf-8')); // ITextSearchMatch.preview_text
      const textSearchMatch = pbEncodeField(1, 2, previewText); // ITextSearchResult.match (oneof)
      const fileMatch = Buffer.concat([
        pbEncodeField(1, 2, Buffer.from('search_results', 'utf-8')), // resource path
        pbEncodeField(2, 2, textSearchMatch), // results[]
      ]);
      const internal = Buffer.concat([
        pbEncodeField(1, 2, fileMatch), // results[]
        pbEncodeField(2, 0, 1), // exit = NORMAL (1)
      ]);
      return pbEncodeField(1, 2, internal); // RipgrepSearchResult.internal
    },
  },
  5:  { // READ_FILE → ReadFileResult at field 6
    // ReadFileResult: contents(1), relative_workspace_path(9), total_lines(12)
    field: 6,
    encode: encodeTextField, // contents
  },
  6:  { // LIST_DIR → ListDirResult at field 9
    // ListDirResult: files(1 repeated File), directory_relative_workspace_path(2)
    // File: name(1 string), is_directory(2 bool), size(3 int64)
    // We wrap the text inside a proper File sub-message so Cursor can parse it.
    // Raw text bytes as a sub-message would cause protobuf parse errors.
    field: 9,
    encode: (text) => {
      const fileName = pbEncodeField(1, 2, Buffer.from(text, 'utf-8')); // File { name = text }
      return pbEncodeField(1, 2, fileName); // ListDirResult.files[0]
    },
  },
  7:  { // EDIT_FILE → EditFileResult at field 10
    // EditFileResult: is_applied(2 bool)
    field: 10,
    encode: (_text) => pbEncodeField(2, 0, 1), // is_applied = true
  },
  8:  { // FILE_SEARCH → ToolCallFileSearchResult at field 11
    // ToolCallFileSearchResult: files(1 repeated File), limit_hit(2 bool), num_results(3 int32)
    // File: uri(1 string)
    // Wrap text in a proper File sub-message to avoid protobuf parse errors.
    field: 11,
    encode: (text) => {
      const fileUri = pbEncodeField(1, 2, Buffer.from(text, 'utf-8')); // File { uri = text }
      const fileEntry = pbEncodeField(1, 2, fileUri); // files[0]
      const numResults = pbEncodeField(3, 0, 1); // num_results = 1
      return Buffer.concat([fileEntry, numResults]);
    },
  },
  9:  { // SEMANTIC_SEARCH_FULL → SemanticSearchFullResult at field 18
    field: 18,
    encode: encodeTextField,
  },
  11: { // DELETE_FILE → DeleteFileResult at field 20
    field: 20,
    encode: (_text) => pbEncodeField(1, 0, 1), // success = true
  },
  12: { // REAPPLY → ReapplyResult at field 21
    field: 21,
    encode: (_text) => pbEncodeField(1, 0, 1), // applied = true
  },

  // ─── Terminal and system tools ─────────────────────────────────────
  15: { // RUN_TERMINAL_COMMAND_V2 → RunTerminalCommandV2Result at field 24
    // RunTerminalCommandV2Result: output(1 string), exit_code(2 int32)
    field: 24,
    encode: (text) => {
      const output = pbEncodeField(1, 2, Buffer.from(text, 'utf-8'));
      const exitCode = pbEncodeField(2, 0, 0); // exit_code = 0
      return Buffer.concat([output, exitCode]);
    },
  },
  16: { // FETCH_RULES → FetchRulesResult at field 25
    field: 25,
    encode: encodeTextField,
  },
  18: { // WEB_SEARCH → WebSearchResult at field 27
    // WebSearchResult: references(1 repeated WebReference), is_final(2 bool)
    // WebReference: title(1 string), url(2 string), chunk(3 string)
    field: 27,
    encode: (text) => {
      const refChunk = pbEncodeField(3, 2, Buffer.from(text, 'utf-8')); // WebReference.chunk
      const ref = pbEncodeField(1, 2, refChunk); // references[0]
      const isFinal = pbEncodeField(2, 0, 1); // is_final = true
      return Buffer.concat([ref, isFinal]);
    },
  },
  19: { // MCP → MCPResult at field 28
    field: 28,
    encode: encodeTextField,
  },

  // ─── Code intelligence tools ───────────────────────────────────────
  23: { // SEARCH_SYMBOLS → SearchSymbolsResult at field 32
    field: 32,
    encode: encodeTextField,
  },
  24: { // BACKGROUND_COMPOSER_FOLLOWUP → at field 33
    field: 33,
    encode: encodeTextField,
  },
  25: { // KNOWLEDGE_BASE → KnowledgeBaseResult at field 34
    field: 34,
    encode: encodeTextField,
  },
  26: { // FETCH_PULL_REQUEST → FetchPullRequestResult at field 36
    field: 36,
    encode: encodeTextField,
  },
  27: { // DEEP_SEARCH → DeepSearchResult at field 37
    field: 37,
    encode: encodeTextField,
  },
  28: { // CREATE_DIAGRAM → CreateDiagramResult at field 38
    field: 38,
    encode: encodeTextField,
  },
  29: { // FIX_LINTS → FixLintsResult at field 39
    field: 39,
    encode: encodeTextField,
  },
  30: { // READ_LINTS → ReadLintsResult at field 40
    field: 40,
    encode: encodeTextField,
  },
  31: { // GO_TO_DEFINITION → GotodefResult at field 41
    field: 41,
    encode: encodeTextField,
  },

  // ─── Task management tools ─────────────────────────────────────────
  32: { // TASK → TaskResult at field 42
    field: 42,
    encode: encodeTextField,
  },
  33: { // AWAIT_TASK → AwaitTaskResult at field 43
    field: 43,
    encode: encodeTextField,
  },
  34: { // TODO_READ → TodoReadResult at field 44
    field: 44,
    encode: encodeTextField,
  },
  35: { // TODO_WRITE → TodoWriteResult at field 45
    field: 45,
    encode: encodeTextField,
  },

  // ─── V2 tools ──────────────────────────────────────────────────────
  38: { // EDIT_FILE_V2 → EditFileV2Result at field 51
    // EditFileV2Result: file_was_created(2 bool), diff(3 FileDiff), rejected(4 bool)
    // Setting file_was_created=true signals success (not rejected). Cursor's backend
    // only checks that the result exists and rejected is absent/false.
    field: 51,
    encode: (_text) => pbEncodeField(2, 0, 1), // file_was_created = true
  },
  39: { // LIST_DIR_V2 → ListDirV2Result at field 52
    // ListDirV2Result: tree nodes with name(1)
    field: 52,
    encode: (text) => {
      const nameField = pbEncodeField(1, 2, Buffer.from(text, 'utf-8'));
      return pbEncodeField(1, 2, nameField); // root node
    },
  },
  40: { // READ_FILE_V2 → ReadFileV2Result at field 53
    // ReadFileV2Result: contents(1 string)
    field: 53,
    encode: encodeTextField, // contents
  },
  41: { // RIPGREP_RAW_SEARCH → RipgrepRawSearchResult at field 54
    field: 54,
    encode: encodeTextField, // output
  },
  42: { // GLOB_FILE_SEARCH → GlobFileSearchResult at field 55
    // GlobFileSearchResult: files(1 repeated File), limit_hit(2 bool), num_results(3 int32)
    // File: uri(1 string)
    // Same structure as FILE_SEARCH — wrap in proper File sub-message.
    field: 55,
    encode: (text) => {
      const fileUri = pbEncodeField(1, 2, Buffer.from(text, 'utf-8')); // File { uri = text }
      const fileEntry = pbEncodeField(1, 2, fileUri); // files[0]
      const numResults = pbEncodeField(3, 0, 1); // num_results = 1
      return Buffer.concat([fileEntry, numResults]);
    },
  },
  43: { // CREATE_PLAN → CreatePlanResult at field 56
    field: 56,
    encode: encodeTextField,
  },

  // ─── MCP V2 tools ─────────────────────────────────────────────────
  44: { // LIST_MCP_RESOURCES → ListMcpResourcesResult at field 57
    field: 57,
    encode: encodeTextField,
  },
  45: { // READ_MCP_RESOURCE → ReadMcpResourceResult at field 58
    field: 58,
    encode: encodeTextField,
  },

  // ─── Project tools ─────────────────────────────────────────────────
  46: { // READ_PROJECT → ReadProjectResult at field 59
    field: 59,
    encode: encodeTextField,
  },
  47: { // UPDATE_PROJECT → UpdateProjectResult at field 60
    field: 60,
    encode: encodeTextField,
  },

  // ─── Advanced agent tools ──────────────────────────────────────────
  48: { // TASK_V2 → TaskV2Result at field 61
    field: 61,
    encode: encodeTextField,
  },
  49: { // CALL_MCP_TOOL → CallMcpToolResult at field 62
    field: 62,
    encode: encodeTextField,
  },
  50: { // APPLY_AGENT_DIFF → ApplyAgentDiffResult at field 63
    field: 63,
    encode: (_text) => pbEncodeField(1, 0, 1), // success = true
  },
  51: { // ASK_QUESTION → AskQuestionResult at field 64
    field: 64,
    encode: encodeTextField,
  },
  52: { // SWITCH_MODE → SwitchModeResult at field 65
    field: 65,
    encode: encodeTextField,
  },
  53: { // GENERATE_IMAGE → GenerateImageResult at field 67
    field: 67,
    encode: encodeTextField,
  },
  54: { // COMPUTER_USE → ComputerUseResult at field 66
    field: 66,
    encode: encodeTextField,
  },
  55: { // WRITE_SHELL_STDIN → WriteShellStdinResult at field 68
    field: 68,
    encode: encodeTextField,
  },
};

/**
 * Encode a ToolResultError message.
 * ClientSideToolV2Result.error is field 8.
 * ToolResultError: message(1 string)
 * @param {string} errorMessage
 * @returns {Buffer}
 */
function encodeToolResultError(errorMessage) {
  const inner = pbEncodeField(1, 2, Buffer.from(errorMessage, 'utf-8'));
  return pbEncodeField(8, 2, inner); // field 8: ToolResultError
}

/**
 * Encode a ClientSideToolV2Result protobuf message.
 * @param {number} toolEnum - The tool enum (e.g., 15 for RUN_TERMINAL_COMMAND_V2)
 * @param {string} cursorToolCallId - The original Cursor tool_call_id
 * @param {string} outputText - The tool execution result text
 * @returns {Buffer} Encoded ClientSideToolV2Result
 */
function encodeToolResult(toolEnum, cursorToolCallId, outputText) {
  let msg = pbEncodeField(1, 0, toolEnum); // field 1: tool enum (varint)
  msg = Buffer.concat([msg, pbEncodeField(35, 2, Buffer.from(cursorToolCallId, 'utf-8'))]); // field 35: tool_call_id

  // Encode the specific result type
  const encoder = TOOL_RESULT_FIELD_MAP[toolEnum];
  if (encoder) {
    const innerResult = encoder.encode(outputText);
    msg = Buffer.concat([msg, pbEncodeField(encoder.field, 2, innerResult)]);
  } else {
    // Unknown tool enum — use RunTerminalCommandV2Result as fallback (field 24)
    // since it has a simple output(string) + exit_code(int32) structure.
    // Reference default is field 2, but terminal result is more universally safe for text.
    console.warn(`[h2-bidi] Unknown tool enum ${toolEnum} — using terminal result (field 24) as fallback`);
    const fallbackResult = TOOL_RESULT_FIELD_MAP[15].encode(outputText);
    msg = Buffer.concat([msg, pbEncodeField(24, 2, fallbackResult)]);
  }

  return msg;
}

/**
 * Wrap a ClientSideToolV2Result in a StreamUnifiedChatWithToolsRequest.
 * The request message has the result at field 2 (not field 1 which is the initial request).
 * @returns {Buffer} Encoded StreamUnifiedChatWithToolsRequest
 */
function encodeToolResultRequest(toolEnum, cursorToolCallId, outputText) {
  const resultProto = encodeToolResult(toolEnum, cursorToolCallId, outputText);
  return pbEncodeField(2, 2, resultProto); // field 2: client_side_tool_v2_result
}

/**
 * Frame a message with the ConnectRPC envelope format.
 * @param {Buffer} data - Protobuf payload
 * @param {boolean} compress - Whether to gzip (default false)
 * @returns {Buffer} Framed message: [flags:1][length:4BE][payload]
 */
function frameMessage(data, compress = false) {
  const header = Buffer.alloc(5);
  header[0] = compress ? 0x01 : 0x00;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

// ─── Bidirectional Stream Manager ────────────────────────────────────────

/**
 * Global registry of pending bidirectional streams.
 * Key: proxy-generated tool_call_id (e.g., "call_abc123")
 * Value: BidiStreamState
 */
const pendingStreams = new Map();

/**
 * Clean up expired pending streams (older than 10 minutes).
 * Runs periodically to prevent memory leaks.
 */
const STREAM_TTL_MS = 10 * 60 * 1000; // 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of pendingStreams) {
    if (now - state.createdAt > STREAM_TTL_MS) {
      console.log(`[h2-bidi] Cleaning up expired pending stream: ${id}`);
      state.close();
      pendingStreams.delete(id);
    }
  }
}, 60 * 1000); // check every minute

class BidiStreamState extends EventEmitter {
  /**
   * @param {http2.ClientHttp2Session} session - HTTP/2 session
   * @param {http2.ClientHttp2Stream} stream - HTTP/2 stream
   */
  constructor(session, stream) {
    super();
    this.session = session;
    this.stream = stream;
    this.createdAt = Date.now();
    this.ended = false;
    this.responseBuffer = Buffer.alloc(0);
    this.bufferedFrames = []; // frames received while waiting for tool result
    this.pendingToolCalls = new Map(); // proxyCallId → { cursorToolCallId, toolEnum }
    this._waitingForToolResult = false;
    this.flushedStreamingIds = new Set(); // Persists across streamBidiResponse calls to prevent duplicates

    // Wire up data events — log every raw chunk to diagnose streaming stalls
    this._lastDataTime = Date.now();
    this._dataChunkCount = 0;
    this.stream.on('data', (chunk) => {
      const now = Date.now();
      const gap = now - this._lastDataTime;
      this._dataChunkCount++;
      console.log(`[h2-bidi:RAW] data chunk #${this._dataChunkCount}: ${chunk.length} bytes (gap=${gap}ms, buffer=${this.responseBuffer.length})`);
      this._lastDataTime = now;
      this.responseBuffer = Buffer.concat([this.responseBuffer, chunk]);
      this._parseFrames();
    });

    this.stream.on('end', () => {
      console.log(`[h2-bidi:RAW] stream END received (total data chunks: ${this._dataChunkCount})`);
      this.ended = true;
      this.emit('end');
    });

    this.stream.on('error', (err) => {
      console.error(`[h2-bidi] Stream error: ${err.message}`);
      this.ended = true;
      this.emit('error', err);
    });

    // Diagnose HTTP/2 flow control issues
    this.stream.on('pause', () => {
      console.warn(`[h2-bidi:FLOW] ⚠ stream PAUSED — possible flow control stall!`);
    });
    this.stream.on('resume', () => {
      console.log(`[h2-bidi:FLOW] stream RESUMED`);
    });

    // Check if the stream is flowing or paused
    console.log(`[h2-bidi:FLOW] stream readableFlowing=${this.stream.readableFlowing} readableHighWaterMark=${this.stream.readableHighWaterMark}`);
  }

  /**
   * Send a tool result back on this stream.
   * @param {number} toolEnum
   * @param {string} cursorToolCallId
   * @param {string} outputText
   */
  sendToolResult(toolEnum, cursorToolCallId, outputText) {
    if (this.ended || !this.stream || this.stream.destroyed) {
      console.warn('[h2-bidi] Cannot send tool result — stream already ended');
      return false;
    }

    const resultMsg = encodeToolResultRequest(toolEnum, cursorToolCallId, outputText);
    const framed = frameMessage(resultMsg);

    try {
      this.stream.write(framed);
      console.log(`[h2-bidi] Sent tool result (${framed.length} bytes) for ${cursorToolCallId} (tool=${toolEnum})`);
      this._waitingForToolResult = false;
      return true;
    } catch (err) {
      console.error(`[h2-bidi] Failed to send tool result: ${err.message}`);
      return false;
    }
  }

  /**
   * Register a pending tool call.
   * @param {string} proxyCallId - The ID we generated for OpenClaw
   * @param {string} cursorToolCallId - Cursor's original tool_call_id
   * @param {number} toolEnum - Cursor's tool enum
   */
  registerPendingToolCall(proxyCallId, cursorToolCallId, toolEnum) {
    this.pendingToolCalls.set(proxyCallId, { cursorToolCallId, toolEnum });
    this._waitingForToolResult = true;
    // Also register in global map
    pendingStreams.set(proxyCallId, this);
    console.log(`[h2-bidi] Registered pending tool call: ${proxyCallId} → ${cursorToolCallId} (enum=${toolEnum})`);
  }

  /**
   * Start buffering frames (while waiting for OpenClaw to execute tool).
   */
  startBuffering() {
    this._waitingForToolResult = true;
    this.bufferedFrames = [];
  }

  /**
   * Get and clear buffered frames.
   * @returns {Array<{magic: number, data: Buffer}>}
   */
  flushBufferedFrames() {
    const frames = this.bufferedFrames;
    this.bufferedFrames = [];
    return frames;
  }

  /**
   * Parse ConnectRPC frames from the response buffer.
   * Emits 'frame' events for each complete frame.
   */
  _parseFrames() {
    let framesInBatch = 0;
    while (this.responseBuffer.length >= 5) {
      const flags = this.responseBuffer[0];
      const length = this.responseBuffer.readUInt32BE(1);
      if (this.responseBuffer.length < 5 + length) {
        // Partial frame — we have the header but not enough payload
        console.log(`[h2-bidi:PARSE] Partial frame in buffer: have ${this.responseBuffer.length} bytes, need ${5 + length} (header says ${length} byte payload)`);
        break;
      }

      const payload = this.responseBuffer.subarray(5, 5 + length);
      this.responseBuffer = this.responseBuffer.subarray(5 + length);
      framesInBatch++;

      const magic = flags; // 0=raw protobuf, 1=gzipped, 2=json metadata, 3=gzipped json

      if (this._waitingForToolResult) {
        // Buffer frames while waiting for tool result from OpenClaw
        this.bufferedFrames.push({ magic, data: Buffer.from(payload) });
      } else {
        this.emit('frame', { magic, data: Buffer.from(payload) });
      }
    }
    if (framesInBatch > 0) {
      console.log(`[h2-bidi:PARSE] Parsed ${framesInBatch} frame(s), remaining buffer: ${this.responseBuffer.length} bytes`);
    }
  }

  /**
   * Nudge the H2 session to diagnose if Cursor's server resumes streaming
   * after receiving client-side activity. This is NOT a workaround — it's
   * a diagnostic mechanism to test the hypothesis that Cursor's server
   * pauses sending streaming frames until the client sends something.
   *
   * Hypothesis: Cursor's server flushes its write buffer only in response
   * to incoming client messages. This PING tests if H2-level activity
   * (not application-level) is sufficient to trigger a resume.
   *
   * @returns {boolean} true if ping was sent successfully
   */
  nudgeStream() {
    if (this.ended || !this.session || this.session.destroyed) {
      console.log(`[h2-bidi:NUDGE] Cannot nudge — session already ended`);
      return false;
    }

    const streamState = this.stream ? {
      destroyed: this.stream.destroyed,
      readable: this.stream.readable,
      readableFlowing: this.stream.readableFlowing,
      readableLength: this.stream.readableLength,
    } : 'no stream';
    console.log(`[h2-bidi:NUDGE] Stream state: ${JSON.stringify(streamState)}`);

    // Force resume in case the stream was auto-paused
    if (this.stream && !this.stream.destroyed && !this.stream.readableFlowing) {
      console.warn(`[h2-bidi:NUDGE] ⚠ Stream was NOT flowing! Calling resume()...`);
      this.stream.resume();
    }

    // Send an HTTP/2 PING to keep the connection alive and potentially
    // trigger the server to flush any buffered outgoing data
    try {
      this.session.ping((err, duration) => {
        if (err) {
          console.error(`[h2-bidi:NUDGE] PING failed: ${err.message}`);
        } else {
          console.log(`[h2-bidi:NUDGE] PING response received in ${duration}ms — server is alive`);
        }
      });
      console.log(`[h2-bidi:NUDGE] PING sent to keep H2 session active`);
      return true;
    } catch (err) {
      console.error(`[h2-bidi:NUDGE] Failed to send PING: ${err.message}`);
      return false;
    }
  }

  /**
   * Close the stream and session.
   */
  close() {
    if (this.stream && !this.stream.destroyed) {
      try { this.stream.end(); } catch (_) {}
    }
    if (this.session && !this.session.destroyed) {
      try { this.session.close(); } catch (_) {}
    }
    this.ended = true;
    // Clean up pending entries
    for (const proxyCallId of this.pendingToolCalls.keys()) {
      pendingStreams.delete(proxyCallId);
    }
    this.pendingToolCalls.clear();
  }
}

/**
 * Create a new bidirectional HTTP/2 stream to Cursor's API.
 *
 * @param {string} authToken - Bearer token
 * @param {Object} headers - Additional headers (checksum, session, etc.)
 * @param {Buffer} initialBody - Framed protobuf body from generateCursorBody
 * @returns {Promise<BidiStreamState>}
 */
async function createBidiStream(authToken, headers, initialBody) {
  return new Promise((resolve, reject) => {
    const session = http2.connect('https://api2.cursor.sh', {
      // Increase the initial window size to prevent HTTP/2 flow control stalls.
      // Default is 65535 (64KB). For bidi streaming, a larger window ensures the
      // server can send many frames without waiting for WINDOW_UPDATE from us.
      // NOTE: This is a standard HTTP/2 SETTINGS parameter — works on all Node.js versions.
      settings: {
        initialWindowSize: 1024 * 1024, // 1MB stream-level window
      },
    });

    // Try to increase the session-level flow control window if supported.
    // setLocalWindowSize() was added in Node.js 15.3.0 — older versions don't have it.
    if (typeof session.setLocalWindowSize === 'function') {
      try {
        session.setLocalWindowSize(4 * 1024 * 1024); // 4MB session window
        console.log('[h2-bidi:FLOW] setLocalWindowSize(4MB) succeeded');
      } catch (err) {
        console.warn(`[h2-bidi:FLOW] setLocalWindowSize failed: ${err.message} — using defaults`);
      }
    } else {
      console.log('[h2-bidi:FLOW] setLocalWindowSize not available (Node.js < 15.3) — using default session window');
    }

    session.on('error', (err) => {
      console.error(`[h2-bidi] Session error: ${err.message}`);
      reject(err);
    });

    // Set timeout for connection (not for the stream lifetime)
    const connectTimeout = setTimeout(() => {
      session.destroy();
      reject(new Error('HTTP/2 connection timeout'));
    }, 30000);

    session.on('connect', () => {
      clearTimeout(connectTimeout);

      // Log negotiated settings to diagnose flow control
      const localSettings = session.localSettings;
      const remoteSettings = session.remoteSettings;
      console.log(`[h2-bidi:FLOW] H2 connected — local initialWindowSize=${localSettings.initialWindowSize} remote initialWindowSize=${remoteSettings.initialWindowSize}`);

      const stream = session.request({
        // Pseudo-headers (Node.js http2 auto-sets :authority and :scheme)
        ':method': 'POST',
        ':path': '/aiserver.v1.ChatService/StreamUnifiedChatWithTools',
        // Auth
        'authorization': `Bearer ${authToken}`,
        // ConnectRPC protocol headers
        // connect-content-encoding MUST be 'gzip' — it tells the server we may
        // send gzip-compressed frames (flag byte 0x01). Without it, the server
        // returns "received compressed envelope, but do not know how to decompress"
        // when generateCursorBody gzips the body (3+ messages).
        // The per-frame flag byte (0x00 uncompressed / 0x01 gzipped) is still
        // authoritative per-frame, so sending this header is always safe.
        'connect-content-encoding': 'gzip',
        'connect-accept-encoding': 'gzip',
        'connect-protocol-version': '1',
        'content-type': 'application/connect+proto',
        'user-agent': 'connect-es/1.6.1',
        // Cursor trace headers
        'x-amzn-trace-id': headers['x-amzn-trace-id'] || '',
        'x-client-key': headers['x-client-key'] || '',
        'x-cursor-checksum': headers['x-cursor-checksum'] || '',
        'x-cursor-client-version': headers['x-cursor-client-version'] || '2.4.28',
        // Client identity headers (from reference: cursor_bidi_client.py lines 140-143)
        'x-cursor-client-type': 'ide',
        'x-cursor-client-os': process.platform === 'win32' ? 'windows' : process.platform,
        'x-cursor-client-arch': process.arch,
        'x-cursor-client-device-type': 'desktop',
        // Session headers
        'x-cursor-config-version': headers['x-cursor-config-version'] || '',
        'x-cursor-timezone': headers['x-cursor-timezone'] || 'Asia/Shanghai',
        'x-ghost-mode': 'true',
        'x-request-id': headers['x-request-id'] || '',
        'x-session-id': headers['x-session-id'] || '',
      }, {
        // Do NOT end the stream after sending headers — we need to write more data
        endStream: false,
      });

      const bidiState = new BidiStreamState(session, stream);

      // Send the initial request body (don't end the stream)
      stream.write(initialBody, (err) => {
        if (err) {
          console.error(`[h2-bidi] Failed to write initial body: ${err.message}`);
          bidiState.close();
          reject(err);
          return;
        }
        console.log(`[h2-bidi] Initial request sent (${initialBody.length} bytes)`);
        resolve(bidiState);
      });
    });
  });
}

/**
 * Look up a pending stream by proxy-generated tool_call_id.
 * @param {string} proxyCallId
 * @returns {BidiStreamState|null}
 */
function findPendingStream(proxyCallId) {
  return pendingStreams.get(proxyCallId) || null;
}

/**
 * Remove a pending stream entry.
 * @param {string} proxyCallId
 */
function removePendingStream(proxyCallId) {
  pendingStreams.delete(proxyCallId);
}

module.exports = {
  createBidiStream,
  findPendingStream,
  removePendingStream,
  encodeToolResult,
  encodeToolResultError,
  encodeToolResultRequest,
  frameMessage,
  BidiStreamState,
  pendingStreams,
  TOOL_RESULT_FIELD_MAP,
};
