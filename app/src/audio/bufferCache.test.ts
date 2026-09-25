import { expect, it } from "vitest";
import { AudioBufferCache } from "./bufferCache";
const buffer = (length: number) => ({ length, numberOfChannels: 2 } as AudioBuffer);
it("evicts least recently used PCM but leaves active references usable", () => {
  const cache = new AudioBufferCache(160);
  const active = buffer(10);
  cache.set("a", active).set("b", buffer(10));
  cache.get("a"); cache.set("c", buffer(10));
  expect(cache.has("b")).toBe(false);
  expect(cache.get("a")).toBe(active);
  expect(cache.bytes).toBe(160);
  cache.delete("a"); expect(cache.bytes).toBe(80);
  expect(active.length).toBe(10);
  cache.clear(); expect(cache.bytes).toBe(0);
});
it("does not retain oversized tracks or evict useful buffers for them", () => {
  const cache = new AudioBufferCache(80);
  cache.set("short", buffer(10)); cache.set("long", buffer(100));
  expect(cache.has("long")).toBe(false); expect(cache.has("short")).toBe(true);
  cache.set("short", buffer(5)); expect(cache.bytes).toBe(40);
});
