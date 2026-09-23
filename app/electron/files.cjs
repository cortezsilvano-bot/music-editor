/**
 * Filesystem operations for the desktop build.
 *
 * Two rules govern everything here:
 *
 * 1. The renderer cannot reach an arbitrary path. Only folders the user has
 *    picked in a native dialog are granted, and every later path is checked to
 *    be inside one of them. A renderer bug therefore cannot read `C:\Windows`.
 * 2. A tag write never modifies the original in place. The file is backed up,
 *    rebuilt in a temporary copy, verified by re-reading, and only then moved
 *    over the original. A crash at any point leaves either the old file or the
 *    backup intact - never a half-written one.
 */
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const NodeID3 = require("node-id3");
const { writeFlacComments, readFlacComments } = require("./flac.cjs");

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".aiff", ".aif"]);
const BACKUP_DIR = ".music-editor-backups";
const MAX_SCAN_DEPTH = 8;

/** Folders the user has explicitly granted this session. */
const grantedRoots = new Set();

function grantRoot(folderPath) {
  grantedRoots.add(path.resolve(folderPath));
}

/** True when `target` sits inside a folder the user picked. */
function isPermitted(target) {
  const resolved = path.resolve(target);
  for (const root of grantedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

function assertPermitted(target) {
  if (!isPermitted(target)) {
    throw new Error("Path is outside any folder you have opened in this session.");
  }
}

/**
 * Recursively list audio files.
 *
 * Symlinks are not followed: a link pointing outside the granted root would
 * otherwise smuggle arbitrary files past the permission check, and a cyclic
 * link would hang the scan.
 */
async function scanFolder(folderPath) {
  assertPermitted(folderPath);
  const root = path.resolve(folderPath);
  const results = [];

  async function walk(current, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: skip it rather than fail the whole scan.
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (!AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        let size = 0;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          continue;
        }
        results.push({
          path: full,
          relativePath: path.relative(root, full).split(path.sep).join("/"),
          name: entry.name,
          sizeBytes: size,
        });
      }
    }
  }

  await walk(root, 0);
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { root, files: results };
}

async function readFile(filePath) {
  assertPermitted(filePath);
  const buffer = await fs.readFile(filePath);
  // Return a plain ArrayBuffer; Buffer does not survive structured cloning well.
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * Back up the original exactly once.
 *
 * Backing up on every write would, on the second write, overwrite the pristine
 * file with an already-modified one and lose the thing the backup is for.
 */
async function ensureBackup(filePath) {
  const directory = path.dirname(filePath);
  const backupDir = path.join(directory, BACKUP_DIR);
  const backupPath = path.join(backupDir, path.basename(filePath));
  if (fsSync.existsSync(backupPath)) return { backupPath, created: false };
  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(filePath, backupPath);
  return { backupPath, created: true };
}

/** Vorbis field names for the same three values. */
function toVorbisFields(payload) {
  const fields = {};
  if (typeof payload.bpm === "string" && payload.bpm.length > 0) fields.BPM = payload.bpm;
  if (typeof payload.initialKey === "string" && payload.initialKey.length > 0) {
    // Both spellings: different DJ tools read different ones.
    fields.KEY = payload.initialKey;
    fields.INITIALKEY = payload.initialKey;
  }
  if (typeof payload.comment === "string" && payload.comment.length > 0) {
    fields.COMMENT = payload.comment;
  }
  return fields;
}

/** Frames we are willing to write, mapped to node-id3's names. */
function toFrames(payload) {
  const frames = {};
  if (typeof payload.bpm === "string" && payload.bpm.length > 0) frames.bpm = payload.bpm;
  if (typeof payload.initialKey === "string" && payload.initialKey.length > 0) {
    frames.initialKey = payload.initialKey;
  }
  if (typeof payload.comment === "string" && payload.comment.length > 0) {
    frames.comment = { language: "eng", text: payload.comment };
  }
  return frames;
}

async function writeTags(filePath, payload) {
  // Every failure here reports as a result, including a refused path, so the
  // caller has one shape to handle rather than two.
  if (!isPermitted(filePath)) {
    return { ok: false, error: "Path is outside any folder you have opened in this session." };
  }

  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".mp3" && extension !== ".flac") {
    return {
      ok: false,
      error: `No tag writer for ${extension} files. MP3 and FLAC are supported.`,
    };
  }

  const frames = extension === ".flac" ? toVorbisFields(payload || {}) : toFrames(payload || {});
  if (Object.keys(frames).length === 0) {
    return { ok: false, error: "Nothing selected to write." };
  }

  const temporary = `${filePath}.musiceditor.tmp`;
  let backupPath = null;

  try {
    const backup = await ensureBackup(filePath);
    backupPath = backup.backupPath;

    // Build the new file beside the original so the final move stays on one
    // volume, where rename is atomic.
    await fs.copyFile(filePath, temporary);

    const mismatches = [];

    if (extension === ".flac") {
      const original = await fs.readFile(temporary);
      await fs.writeFile(temporary, writeFlacComments(original, frames));
      const readBack = readFlacComments(await fs.readFile(temporary));
      for (const [field, value] of Object.entries(frames)) {
        if (readBack[field] !== value) mismatches.push(field);
      }
    } else {
      const result = NodeID3.update(frames, temporary);
      if (result !== true) {
        throw new Error(
          typeof result === "object" && result?.message ? result.message : "Tag write failed.",
        );
      }
      // Verify before committing: a writer that silently no-ops is worse than
      // one that fails, because the user believes the tags are there.
      const readBack = NodeID3.read(temporary);
      if (frames.bpm !== undefined && String(readBack.bpm ?? "") !== String(frames.bpm)) {
        mismatches.push("BPM");
      }
      if (frames.initialKey !== undefined && (readBack.initialKey ?? "") !== frames.initialKey) {
        mismatches.push("key");
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Wrote the file but ${mismatches.join(", ")} did not read back correctly.`,
      );
    }

    await fs.rename(temporary, filePath);

    return {
      ok: true,
      backupPath,
      backupCreated: backup.created,
      written: Object.keys(frames),
    };
  } catch (error) {
    // The original has not been touched at this point; clean up the scratch file.
    await fs.rm(temporary, { force: true }).catch(() => {});
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      backupPath,
    };
  }
}

module.exports = { grantRoot, isPermitted, scanFolder, readFile, writeTags, AUDIO_EXTENSIONS };
