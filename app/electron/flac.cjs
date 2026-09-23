/**
 * FLAC Vorbis-comment writing.
 *
 * `node-id3` only handles MP3, so FLAC needed its own writer. The format is
 * simple enough to implement directly and that avoids adding a dependency for
 * a few hundred bytes of header work.
 *
 * Layout: the magic "fLaC", then a chain of metadata blocks, then the audio
 * frames. Each block header is one byte (top bit = "this is the last block",
 * low seven bits = type) followed by a 24-bit big-endian length.
 *
 * The one trap: block *lengths* are big-endian, but the Vorbis comment payload
 * inside is little-endian, because it came from Ogg Vorbis. Getting that
 * backwards produces a file that every decoder rejects.
 */

const MAGIC = "fLaC";
const TYPE_VORBIS_COMMENT = 4;
const TYPE_PADDING = 1;
const VENDOR = "Music Editor";

/**
 * Split a FLAC file into its metadata blocks and the audio that follows.
 *
 * @returns {{ blocks: {type: number, data: Buffer}[], audio: Buffer }}
 */
function parseBlocks(buffer) {
  if (buffer.length < 8 || buffer.toString("ascii", 0, 4) !== MAGIC) {
    throw new Error("Not a FLAC file (missing fLaC marker).");
  }
  const blocks = [];
  let offset = 4;

  for (;;) {
    if (offset + 4 > buffer.length) throw new Error("Truncated FLAC metadata.");
    const header = buffer[offset];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = buffer.readUIntBE(offset + 1, 3);
    const start = offset + 4;
    const end = start + length;
    if (end > buffer.length) throw new Error("FLAC metadata block runs past end of file.");
    blocks.push({ type, data: buffer.subarray(start, end) });
    offset = end;
    if (isLast) break;
  }

  return { blocks, audio: buffer.subarray(offset) };
}

/** Decode a VORBIS_COMMENT payload into ordered `KEY=value` entries. */
function parseComments(data) {
  let offset = 0;
  const vendorLength = data.readUInt32LE(offset);
  offset += 4;
  const vendor = data.toString("utf8", offset, offset + vendorLength);
  offset += vendorLength;

  const count = data.readUInt32LE(offset);
  offset += 4;

  const entries = [];
  for (let i = 0; i < count; i++) {
    const length = data.readUInt32LE(offset);
    offset += 4;
    entries.push(data.toString("utf8", offset, offset + length));
    offset += length;
  }
  return { vendor, entries };
}

function buildCommentBlock(vendor, entries) {
  const vendorBuffer = Buffer.from(vendor, "utf8");
  const entryBuffers = entries.map((e) => Buffer.from(e, "utf8"));

  const size =
    4 + vendorBuffer.length + 4 + entryBuffers.reduce((sum, b) => sum + 4 + b.length, 0);
  const out = Buffer.alloc(size);

  let offset = 0;
  out.writeUInt32LE(vendorBuffer.length, offset);
  offset += 4;
  vendorBuffer.copy(out, offset);
  offset += vendorBuffer.length;

  out.writeUInt32LE(entryBuffers.length, offset);
  offset += 4;
  for (const entry of entryBuffers) {
    out.writeUInt32LE(entry.length, offset);
    offset += 4;
    entry.copy(out, offset);
    offset += entry.length;
  }
  return out;
}

/** Field name of a `KEY=value` entry, upper-cased. */
function fieldOf(entry) {
  const index = entry.indexOf("=");
  return index === -1 ? entry.toUpperCase() : entry.slice(0, index).toUpperCase();
}

/**
 * Replace the named fields, leaving every other comment untouched.
 *
 * A track's existing ARTIST, TITLE and album art must survive a BPM write, so
 * only the fields being set are removed before the new values are appended.
 */
function mergeComments(existing, updates) {
  const replacing = new Set(Object.keys(updates).map((k) => k.toUpperCase()));
  const kept = existing.filter((entry) => !replacing.has(fieldOf(entry)));
  const added = Object.entries(updates)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([field, value]) => `${field.toUpperCase()}=${value}`);
  return [...kept, ...added];
}

/**
 * Return a new FLAC buffer with the given Vorbis comments applied.
 *
 * @param {Buffer} buffer original file
 * @param {Record<string,string>} updates field name -> value
 */
function writeFlacComments(buffer, updates) {
  const { blocks, audio } = parseBlocks(buffer);

  const commentIndex = blocks.findIndex((b) => b.type === TYPE_VORBIS_COMMENT);
  const current =
    commentIndex === -1
      ? { vendor: VENDOR, entries: [] }
      : parseComments(blocks[commentIndex].data);

  const merged = mergeComments(current.entries, updates);
  const payload = buildCommentBlock(current.vendor || VENDOR, merged);

  const rebuilt =
    commentIndex === -1
      ? [blocks[0], { type: TYPE_VORBIS_COMMENT, data: payload }, ...blocks.slice(1)]
      : blocks.map((b, i) => (i === commentIndex ? { type: b.type, data: payload } : b));

  // Padding exists to let a tagger grow in place; we rewrite the file anyway,
  // so carrying it forward only wastes space.
  const final = rebuilt.filter((b) => b.type !== TYPE_PADDING);

  const parts = [Buffer.from(MAGIC, "ascii")];
  final.forEach((block, index) => {
    if (block.data.length > 0xffffff) {
      throw new Error("Metadata block too large for FLAC.");
    }
    const header = Buffer.alloc(4);
    header[0] = (index === final.length - 1 ? 0x80 : 0) | block.type;
    header.writeUIntBE(block.data.length, 1, 3);
    parts.push(header, block.data);
  });
  parts.push(audio);

  return Buffer.concat(parts);
}

/** Read comments back, for verification after a write. */
function readFlacComments(buffer) {
  const { blocks } = parseBlocks(buffer);
  const block = blocks.find((b) => b.type === TYPE_VORBIS_COMMENT);
  if (!block) return {};
  const { entries } = parseComments(block.data);
  const out = {};
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index === -1) continue;
    out[entry.slice(0, index).toUpperCase()] = entry.slice(index + 1);
  }
  return out;
}

module.exports = { writeFlacComments, readFlacComments, parseBlocks };
