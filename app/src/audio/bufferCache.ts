/** Bound inactive decoded PCM memory. Active players retain their own buffers. */
export class AudioBufferCache extends Map<string, AudioBuffer> {
  private used = 0;
  constructor(readonly limitBytes = 256 * 1024 * 1024) {
    super();
    if (!Number.isFinite(limitBytes) || limitBytes < 0) throw new Error("Invalid PCM cache size");
  }
  get bytes(): number { return this.used; }
  private sizeOf(buffer: AudioBuffer): number { return buffer.length * buffer.numberOfChannels * 4; }
  override get(id: string): AudioBuffer | undefined {
    const buffer = super.get(id);
    if (buffer) { super.delete(id); super.set(id, buffer); }
    return buffer;
  }
  override set(id: string, buffer: AudioBuffer): this {
    this.delete(id);
    const bytes = this.sizeOf(buffer);
    if (!Number.isFinite(bytes) || bytes > this.limitBytes) return this;
    while (this.used + bytes > this.limitBytes && this.size) this.delete(this.keys().next().value!);
    super.set(id, buffer); this.used += bytes; return this;
  }
  override delete(id: string): boolean {
    const buffer = super.get(id);
    if (!buffer) return false;
    this.used -= this.sizeOf(buffer); return super.delete(id);
  }
  override clear(): void { super.clear(); this.used = 0; }
}
