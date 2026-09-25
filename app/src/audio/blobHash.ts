import { sha256 } from "@noble/hashes/sha2.js";

/** Bound renderer input memory even for multi-gigabyte original files. */
export async function hashBlob(blob: Blob): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
  }
  return Array.from(hash.digest(), value => value.toString(16).padStart(2, "0")).join("");
}
