#!/usr/bin/env node
/**
 * Protobuf Decode Utility
 * Decodes raw protobuf captures from Reqable (or any network proxy) into readable JSON.
 *
 * Usage:
 *   node tools/decode-proto.js <file.bin>              # Decode a binary protobuf capture
 *   node tools/decode-proto.js <file.bin> --response    # Decode as response (not request)
 *   node tools/decode-proto.js <file.bin> --hex          # Input is hex string file
 *
 * The binary file should contain the raw request/response body from
 * api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools
 *
 * To capture with Reqable:
 *   1. Enable HTTPS decryption in Reqable (install root CA cert)
 *   2. In Cursor, make an Agent mode request (e.g. ask to run a command)
 *   3. In Reqable, find the request to api2.cursor.sh with path containing StreamUnifiedChatWithTools
 *   4. Right-click request body → Save as binary file
 *   5. Run: node tools/decode-proto.js captured-body.bin
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const $root = require(path.join(__dirname, '..', 'src', 'proto', 'message.js'));

const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
const isResponse = args.includes('--response');
const isHex = args.includes('--hex');
const showFull = args.includes('--full');

if (!inputFile) {
  console.log(`
Cursor Protobuf Decoder
=======================
Decodes raw protobuf captures from Reqable into readable JSON.

Usage:
  node tools/decode-proto.js <file.bin>               Decode request
  node tools/decode-proto.js <file.bin> --response     Decode response
  node tools/decode-proto.js <file.bin> --hex           Input is hex-encoded text
  node tools/decode-proto.js <file.bin> --full          Don't truncate content

Example workflow with Reqable:
  1. Open Reqable → enable HTTPS decryption → install root CA
  2. Open Cursor → Agent mode → ask it to run "ls"
  3. In Reqable, find POST to api2.cursor.sh/.../StreamUnifiedChatWithTools
  4. Save request body as binary → captured-request.bin
  5. Run: node tools/decode-proto.js captured-request.bin
  `);
  process.exit(0);
}

let rawBuffer;
try {
  if (isHex) {
    const hexStr = fs.readFileSync(inputFile, 'utf-8').replace(/[\s\n\r]/g, '');
    rawBuffer = Buffer.from(hexStr, 'hex');
  } else {
    rawBuffer = fs.readFileSync(inputFile);
  }
} catch (err) {
  console.error(`Error reading ${inputFile}: ${err.message}`);
  process.exit(1);
}

console.log(`Input: ${inputFile} (${rawBuffer.length} bytes)`);

/**
 * Try to decode a buffer as protobuf, with multiple strategies:
 * 1. Raw protobuf
 * 2. Framed format (magic byte + 4-byte length + data)
 * 3. Gzipped protobuf
 * 4. Framed + gzipped
 */
function tryDecode(buffer, MessageType) {
  // Strategy 1: Raw protobuf
  try {
    const decoded = MessageType.decode(buffer);
    const obj = MessageType.toObject(decoded, { longs: Number, enums: String, bytes: String, defaults: true });
    return { strategy: 'raw', obj };
  } catch (_) {}

  // Strategy 2: Framed format (skip 5-byte header)
  if (buffer.length > 5) {
    const magic = buffer[0];
    const len = buffer.readUInt32BE(1);
    if (5 + len <= buffer.length) {
      let data = buffer.subarray(5, 5 + len);

      // Strategy 2a: Framed, raw data
      try {
        const decoded = MessageType.decode(data);
        const obj = MessageType.toObject(decoded, { longs: Number, enums: String, bytes: String, defaults: true });
        return { strategy: `framed(magic=${magic})`, obj };
      } catch (_) {}

      // Strategy 2b: Framed, gzipped data
      if (magic === 1 || magic === 3) {
        try {
          data = zlib.gunzipSync(data);
          const decoded = MessageType.decode(data);
          const obj = MessageType.toObject(decoded, { longs: Number, enums: String, bytes: String, defaults: true });
          return { strategy: `framed+gzip(magic=${magic})`, obj };
        } catch (_) {}
      }
    }
  }

  // Strategy 3: Entire buffer is gzipped
  try {
    const gunzipped = zlib.gunzipSync(buffer);
    const decoded = MessageType.decode(gunzipped);
    const obj = MessageType.toObject(decoded, { longs: Number, enums: String, bytes: String, defaults: true });
    return { strategy: 'gzipped', obj };
  } catch (_) {}

  return null;
}

const MessageType = isResponse
  ? $root.StreamUnifiedChatWithToolsResponse
  : $root.StreamUnifiedChatWithToolsRequest;

const result = tryDecode(rawBuffer, MessageType);

if (!result) {
  console.error('Failed to decode with any strategy.');
  console.error('First 32 bytes (hex):', rawBuffer.subarray(0, 32).toString('hex'));
  process.exit(1);
}

console.log(`Decoded using strategy: ${result.strategy}\n`);

// Truncate long content for readability (unless --full)
function truncate(obj) {
  if (!showFull && typeof obj === 'object' && obj !== null) {
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string' && val.length > 300) {
        obj[key] = val.substring(0, 300) + `... [${val.length} chars total]`;
      } else if (typeof val === 'object') {
        truncate(val);
      }
    }
  }
  return obj;
}

console.log(JSON.stringify(truncate(result.obj), null, 2));
