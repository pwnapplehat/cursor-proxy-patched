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
    // ReadSemsearchFilesResult proto (cursor-rpc):
    //   repeated CodeResult code_results = 1;
    // CodeResult: code_block(1 CodeBlock), score(2 float)
    // CodeBlock: contents(4 string)
    // FIX: Field 1 is a repeated submessage. Wrap text as CodeBlock.contents.
    field: 2,
    encode: (text) => {
      const contents = pbEncodeField(4, 2, Buffer.from(text, 'utf-8')); // CodeBlock.contents
      const codeBlock = pbEncodeField(1, 2, contents); // CodeResult.code_block
      return pbEncodeField(1, 2, codeBlock); // code_results[0]
    },
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
    // SemanticSearchFullResult proto (TASK-26):
    //   repeated CodeResult code_results = 1;
    //   repeated FileInfo all_files = 2;
    //   ...
    // CodeResult: code_block(1 CodeBlock), score(2 float)
    // CodeBlock: contents(4 string)
    // FIX: Field 1 is a repeated submessage, NOT a string.
    // Wrap text as CodeBlock.contents inside a CodeResult.
    field: 18,
    encode: (text) => {
      const contents = pbEncodeField(4, 2, Buffer.from(text, 'utf-8')); // CodeBlock.contents
      const codeBlock = pbEncodeField(1, 2, contents); // CodeResult.code_block
      return pbEncodeField(1, 2, codeBlock); // code_results[0]
    },
  },
  11: { // DELETE_FILE → DeleteFileResult at field 20
    // DeleteFileResult proto (TASK-26):
    //   bool rejected = 1;
    //   bool file_non_existent = 2;
    //   bool file_deleted_successfully = 3;
    // BUG FIX: Was sending field 1 = true which means rejected=true (WRONG!)
    // Must send field 3 = true for file_deleted_successfully.
    // ENHANCEMENT: Check result text for error indicators to set the right field.
    field: 20,
    encode: (text) => {
      const t = (text || '').toLowerCase();
      if (t.includes('no such file') || t.includes('enoent') || t.includes('not found')) {
        return pbEncodeField(2, 0, 1); // file_non_existent = true
      }
      if (t.includes('permission denied') || t.includes('eacces') || t.includes('eperm') ||
          t.includes('cannot remove') || t.includes('is a directory')) {
        return pbEncodeField(1, 0, 1); // rejected = true
      }
      return pbEncodeField(3, 0, 1); // file_deleted_successfully = true
    },
  },
  12: { // REAPPLY → ReapplyResult at field 21
    field: 21,
    encode: (_text) => pbEncodeField(1, 0, 1), // applied = true
  },

  // ─── Terminal and system tools ─────────────────────────────────────
  15: { // RUN_TERMINAL_COMMAND_V2 → RunTerminalCommandV2Result at field 24
    // RunTerminalCommandV2Result proto (TASK-26):
    //   string output = 1;
    //   int32 exit_code = 2;
    //   optional bool rejected = 3;
    //   bool popped_out_into_background = 4;
    //   bool is_running_in_background = 5;
    //   bool not_interrupted = 6;
    //   string resulting_working_directory = 7;
    //   ...
    field: 24,
    encode: (text) => {
      const output = pbEncodeField(1, 2, Buffer.from(text, 'utf-8'));
      const exitCode = pbEncodeField(2, 0, 0); // exit_code = 0
      const notInterrupted = pbEncodeField(6, 0, 1); // not_interrupted = true
      return Buffer.concat([output, exitCode, notInterrupted]);
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
    // MCPResult proto (TASK-26):
    //   string selected_tool = 1;
    //   string result = 2;
    // FIX: Text should go in field 2 (result), not field 1 (selected_tool).
    field: 28,
    encode: (text) => pbEncodeField(2, 2, Buffer.from(text, 'utf-8')), // result
  },

  // ─── Code intelligence tools ───────────────────────────────────────
  23: { // SEARCH_SYMBOLS → SearchSymbolsResult at field 32
    // SearchSymbolsResult proto (TASK-26):
    //   repeated SymbolMatch matches = 1;
    //   optional bool rejected = 2;
    // SymbolMatch: name(1 string), uri(2 string), secondary_text(4 string)
    // FIX: Field 1 is a repeated submessage. Wrap text as SymbolMatch.name.
    field: 32,
    encode: (text) => {
      const name = pbEncodeField(1, 2, Buffer.from(text, 'utf-8')); // SymbolMatch.name
      return pbEncodeField(1, 2, name); // matches[0]
    },
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
    // TodoWriteResult proto (TASK-26):
    //   bool success = 1;
    //   repeated string ready_task_ids = 2;
    //   bool needs_in_progress_todos = 3;
    //   repeated TodoItem final_todos = 4;
    //   repeated TodoItem initial_todos = 5;
    //   bool was_merge = 6;
    // FIX: Field 1 is a bool (success), not a string. Sending text as field 1
    // would cause a wire type mismatch. Send success=true instead.
    field: 45,
    encode: (_text) => pbEncodeField(1, 0, 1), // success = true
  },

  // ─── V2 tools ──────────────────────────────────────────────────────
  38: { // EDIT_FILE_V2 → EditFileV2Result at field 51
    //
    // Full EditFileV2Result proto (from TASK-26-tool-schemas.md, verified against
    // eisbaw/cursor_api_demo reveng_2.3.41 and everestmz/cursor-rpc):
    //
    //   message EditFileV2Result {
    //     optional string contents_before_edit = 1;
    //     bool file_was_created = 2;
    //     optional FileDiff diff = 3;
    //     optional bool rejected = 4;
    //     repeated LinterError linter_errors = 5;
    //     bool sent_back_linter_errors = 6;
    //     optional HumanReview human_review_v2 = 7;
    //     bool should_auto_fix_lints = 8;
    //     optional string eol_sequence = 9;
    //     string result_for_model = 10;        ← THE KEY FIELD
    //     optional string detected_language = 11;
    //     optional string contents_after_edit = 12;
    //     optional string before_content_id = 13;
    //     string after_content_id = 14;
    //   }
    //
    // ROOT CAUSE: Previously we ONLY sent file_was_created=true (field 2).
    // The model saw a bare boolean with ZERO text confirmation. In Cursor's
    // native IDE, field 10 (result_for_model) contains a human-readable
    // description like "The file was created successfully" which the model
    // uses to confirm the write. Without it, the model doesn't trust the
    // result and retries with exec/shell commands.
    //
    // FIX: Populate field 10 (result_for_model) with the descriptive text.
    field: 51,
    encode: (text) => {
      // Detect if this is a CREATE/WRITE operation or an EDIT/REPLACE operation.
      // Both `write` and `search_replace` use EDIT_FILE_V2 (enum 38), but:
      //   - file_was_created (field 2) should be TRUE only for create/write
      //   - file_was_created should be FALSE for edit/replace operations
      // The model distinguishes these — sending file_was_created=true for an
      // edit confuses it and erodes trust in the search_replace tool.
      const lowerText = (text || '').toLowerCase();
      const isEditOp = lowerText.includes('edited') || lowerText.includes('replaced') ||
                        lowerText.includes('edit') || lowerText.includes('replace');
      const isCreateOp = !isEditOp; // default to create if ambiguous

      // field 2: file_was_created (bool) — only true for create/write
      const createdField = isCreateOp ? pbEncodeField(2, 0, 1) : Buffer.alloc(0);

      // field 10: result_for_model = text (string) — THE CRITICAL FIELD
      // This is the string Cursor's server passes to the model as the
      // human-readable result of the edit/write operation. Without this,
      // the model has no text confirmation and falls back to exec.
      //
      // Normalize: OpenClaw may return empty string or "no result from tool"
      // for successful writes. Replace these with a clear success message.
      let resultText = (text || '').trim();
      if (!resultText || resultText.includes('no result from tool')) {
        resultText = isEditOp ? 'The file was edited successfully.' : 'The file was created successfully.';
      }
      const resultForModel = pbEncodeField(10, 2, Buffer.from(resultText, 'utf-8'));

      return Buffer.concat([createdField, resultForModel]);
    },
  },
  39: { // LIST_DIR_V2 → ListDirV2Result at field 52
    // ListDirV2Result proto (TASK-26):
    //   repeated DirectoryTreeNode children = 1;
    //   DirectoryTreeNode: name(1 string), children(2 repeated DirectoryTreeNode),
    //                      file_info(3 File)
    //   File: size(1 int64)
    // Encoding: wrap text as the name of a single root tree node.
    field: 52,
    encode: (text) => {
      // DirectoryTreeNode { name = text }
      const nameField = pbEncodeField(1, 2, Buffer.from(text, 'utf-8'));
      return pbEncodeField(1, 2, nameField); // children[0] = root node
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
    // GlobFileSearchResult proto (TASK-26):
    //   repeated Directory directories = 1;
    //   Directory: abs_path(1 string), files(2 repeated File),
    //             total_files(3 int32), ripgrep_truncated(4 bool)
    //   File: rel_path(1 string)
    // BUG FIX: Was using FILE_SEARCH format (uri field). Real format uses
    // Directory/File nesting with rel_path, not uri.
    field: 55,
    encode: (text) => {
      // File { rel_path = text }
      const relPath = pbEncodeField(1, 2, Buffer.from(text, 'utf-8'));
      const file = pbEncodeField(2, 2, relPath); // Directory.files[0]
      const totalFiles = pbEncodeField(3, 0, 1); // Directory.total_files
      const directory = Buffer.concat([file, totalFiles]);
      return pbEncodeField(1, 2, directory); // directories[0]
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
    // TaskV2Result proto (TASK-26):
    //   optional string agent_id = 1;
    //   bool is_background = 2;
    // Field 1 is agent_id (string) — encodeTextField puts text there which works.
    field: 61,
    encode: encodeTextField, // text → agent_id (field 1)
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
 * ToolResultError proto (TASK-26):
 *   string client_visible_error_message = 1;  // Shown to user
 *   string model_visible_error_message = 2;   // Sent to LLM for context
 * FIX: Must populate BOTH fields — field 2 is what the model sees.
 * Previously only field 1 was set, so the model never received error details.
 * @param {string} errorMessage
 * @returns {Buffer}
 */
function encodeToolResultError(errorMessage) {
  const errBuf = Buffer.from(errorMessage, 'utf-8');
  const clientVisible = pbEncodeField(1, 2, errBuf); // field 1: user-visible
  const modelVisible = pbEncodeField(2, 2, errBuf);  // field 2: model-visible
  const inner = Buffer.concat([clientVisible, modelVisible]);
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
 * Clean up expired pending streams based on LAST ACTIVITY time.
 * Runs periodically to prevent memory leaks from abandoned streams.
 *
 * CRITICAL FIX (2026-02-14): Previously used createdAt which killed
 * active long-running streams after 10 minutes. A single bidi session
 * can run for hours with hundreds of tool calls. Now uses lastActivityAt
 * (updated on every data chunk, tool result send, and tool call registration)
 * so active streams are never killed. TTL increased to 60 minutes for
 * 24-hour bot operation — only truly abandoned streams get cleaned up.
 */
const STREAM_TTL_MS = 60 * 60 * 1000; // 60 minutes of INACTIVITY before cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of pendingStreams) {
    const idleMs = now - state.lastActivityAt;
    if (idleMs > STREAM_TTL_MS) {
      console.log(`[h2-bidi] Cleaning up idle pending stream: ${id} (idle ${Math.round(idleMs / 1000)}s)`);
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
    this.lastActivityAt = Date.now(); // Updated on every data/send/register event
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
      this.lastActivityAt = now; // Keep stream alive while data flows
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

    // ─── HTTP/2 Keepalive PING ──────────────────────────────────────────
    // During tool execution (which can take seconds to minutes), the H2
    // connection sits idle. Cloud infrastructure (NAT gateways, firewalls,
    // load balancers, AWS ALBs) commonly drop idle TCP connections after
    // 60-300 seconds of silence. If the connection is dropped, the next
    // stream.write() for the tool result fails silently, causing
    // ERROR_USER_ABORTED_REQUEST.
    //
    // Fix: Send an HTTP/2 PING frame every 30 seconds to keep the TCP
    // connection alive through any NAT/firewall/LB idle timeout.
    // PINGs are H2-level (not application-level) and don't affect the
    // stream data or Cursor's server behavior — they're just keepalive.
    this._keepAliveInterval = setInterval(() => {
      if (this.ended || !this.session || this.session.destroyed) {
        clearInterval(this._keepAliveInterval);
        return;
      }
      try {
        this.session.ping((err, duration) => {
          if (err) {
            console.warn(`[h2-bidi:KEEPALIVE] PING failed: ${err.message} — session may be dead`);
          } else {
            console.log(`[h2-bidi:KEEPALIVE] PING OK (${duration}ms)`);
          }
        });
      } catch (err) {
        console.warn(`[h2-bidi:KEEPALIVE] PING error: ${err.message}`);
        clearInterval(this._keepAliveInterval);
      }
    }, 30 * 1000); // every 30 seconds
  }

  /**
   * Send a tool result back on this stream.
   * @param {number} toolEnum
   * @param {string} cursorToolCallId
   * @param {string} outputText
   */
  sendToolResult(toolEnum, cursorToolCallId, outputText) {
    // Stop heartbeat if any (no-op since heartbeat is disabled, kept for safety)
    this._stopWaitHeartbeat();

    if (this.ended || !this.stream || this.stream.destroyed) {
      console.warn('[h2-bidi] Cannot send tool result — stream already ended');
      return false;
    }

    const resultMsg = encodeToolResultRequest(toolEnum, cursorToolCallId, outputText);
    const framed = frameMessage(resultMsg);

    try {
      this.stream.write(framed);
      this.lastActivityAt = Date.now(); // Keep stream alive on outbound data
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
    this.lastActivityAt = Date.now(); // Keep stream alive on tool registration
    // Also register in global map
    pendingStreams.set(proxyCallId, this);
    console.log(`[h2-bidi] Registered pending tool call: ${proxyCallId} → ${cursorToolCallId} (enum=${toolEnum})`);
  }

  /**
   * Start buffering frames (while waiting for OpenClaw to execute tool).
   *
   * NOTE (2026-02-14): Application-level heartbeats REMOVED.
   * We previously sent empty ConnectRPC frames every 8s while waiting
   * for tool results. However, native Cursor clients ONLY send two types
   * of client-to-server messages: (1) the initial request and (2) tool
   * result messages. Our empty heartbeat frames were extra data that
   * Cursor's server doesn't expect. After 20+ tool calls with many
   * heartbeats, the accumulated unexpected frames likely triggered
   * Cursor's server to abort with ERROR_USER_ABORTED_REQUEST.
   *
   * H2-level PINGs (every 30s, transport layer) are sufficient to keep
   * the TCP connection alive through NAT/firewalls/LBs without sending
   * any application-level data that Cursor's server might misinterpret.
   */
  startBuffering() {
    this._waitingForToolResult = true;
    this.bufferedFrames = [];
    // Heartbeat intentionally NOT started — see comment above
  }

  /**
   * Send a lightweight application-level heartbeat on the bidi stream.
   *
   * In the Cursor IDE, tool results are sent directly on the bidi stream
   * with zero intermediate hops. Our proxy introduces an HTTP break
   * (OpenClaw executes the tool and sends a NEW request with the result).
   * During this break, the bidi stream is idle at the application level —
   * only H2 PINGs (transport-level) flow. Cursor's server may interpret
   * this application-level silence as "client abandoned the request" and
   * abort with ERROR_USER_ABORTED_REQUEST.
   *
   * This heartbeat sends a minimal empty ConnectRPC envelope (5 bytes:
   * [0x00][0x00000000]) on the stream. It's a valid ConnectRPC frame
   * with an empty protobuf payload — most servers ignore empty messages
   * but the DATA frame on the H2 stream keeps the connection alive at
   * the application level.
   *
   * @returns {boolean} true if sent successfully
   */
  sendHeartbeat() {
    if (this.ended || !this.stream || this.stream.destroyed) return false;

    // Empty ConnectRPC frame: flag=0 (uncompressed), length=0, no payload
    const emptyFrame = frameMessage(Buffer.alloc(0));
    try {
      this.stream.write(emptyFrame);
      this.lastActivityAt = Date.now();
      console.log(`[h2-bidi:HEARTBEAT] Sent empty frame (${emptyFrame.length} bytes) to keep stream active`);
      return true;
    } catch (err) {
      console.warn(`[h2-bidi:HEARTBEAT] Failed to send: ${err.message}`);
      return false;
    }
  }

  /**
   * Start periodic heartbeat while waiting for tool results from OpenClaw.
   * Sends an application-level signal every 8 seconds to prevent Cursor's
   * server from aborting due to idle stream detection.
   */
  _startWaitHeartbeat() {
    this._stopWaitHeartbeat();
    this._waitHeartbeatInterval = setInterval(() => {
      if (!this._waitingForToolResult || this.ended) {
        this._stopWaitHeartbeat();
        return;
      }
      this.sendHeartbeat();
    }, 8 * 1000); // every 8 seconds
  }

  /**
   * Stop the wait-heartbeat interval.
   */
  _stopWaitHeartbeat() {
    if (this._waitHeartbeatInterval) {
      clearInterval(this._waitHeartbeatInterval);
      this._waitHeartbeatInterval = null;
    }
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
    // Stop all intervals first
    this._stopWaitHeartbeat();
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }
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

    // ─── GOAWAY handling ─────────────────────────────────────────────
    // Cursor's server (or intermediate proxies) may send GOAWAY frames
    // for session rotation, maintenance, or overload. Active streams
    // should continue per HTTP/2 spec (only new streams are rejected),
    // but logging is essential for diagnosing 24-hour disconnections.
    session.on('goaway', (errorCode, lastStreamID, opaqueData) => {
      const errName = errorCode === 0 ? 'NO_ERROR (graceful)' : `code=${errorCode}`;
      console.warn(`[h2-bidi:SESSION] GOAWAY received: ${errName} lastStreamID=${lastStreamID}` +
        (opaqueData && opaqueData.length > 0 ? ` data=${opaqueData.toString('utf-8').substring(0, 200)}` : ''));
    });

    // Session close — fires when the H2 session is fully torn down.
    // This happens after GOAWAY + all streams finish, or on network failure.
    session.on('close', () => {
      console.warn(`[h2-bidi:SESSION] Session CLOSED — TCP connection to Cursor is gone`);
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
