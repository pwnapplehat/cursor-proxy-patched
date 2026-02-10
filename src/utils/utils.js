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
  const instruction = processedMessages
    .filter(msg => isSystemRole(msg.role))
    .map(msg => normalizeContent(msg.content))
    .join('\n')

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
        version: "6.8.0-100-generic",
        path: "/bin/bash",
        timestamp: new Date().toISOString(),
      },
      unknown27: 0,
      messageIds: messageIds,
      largeContext: 0,
      unknown38: 0,
      chatModeEnum: 2,
      // unknown47 might be workspace_root_path — Cursor's system prompt template
      // includes <<user_info>> with "The absolute path of the user's workspace is {workspace_path}"
      // If this is the right field, the model will see our OpenClaw workspace path.
      unknown47: "/home/node/.openclaw/workspace",
      unknown48: 0,
      unknown49: 0,
      unknown51: 0,
      unknown53: 1,
      chatMode: "Agent"
    }
  };

  // Debug: log instruction head and metadata so we can verify identity override reaches Cursor
  if (instruction) {
    console.log(`[generateCursorBody] instruction (first 300 chars): ${instruction.substring(0, 300)}`);
  }
  console.log(`[generateCursorBody] metadata: os=${body.request.metadata.os}, path=${body.request.metadata.path}, unknown47=${body.request.unknown47}`);

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
