/** Preserve accepted updates while limiting UI commits; callers choose urgent flushes. */
export class StreamUiBatch<T> {
  private pending: T[] = [];
  private timer: number = -1;
  private cancelled: boolean = false;
  private commit: (updates: T[]) => void;

  constructor(commit: (updates: T[]) => void) { this.commit = commit; }

  enqueue(update: T, immediate: boolean = false): void {
    if (this.cancelled) return;
    this.pending.push(update);
    if (immediate) {
      this.flush();
    } else if (this.timer < 0) {
      // A fixed deadline from the oldest pending update; never debounce a busy stream.
      this.timer = setTimeout(() => { this.flush(); }, 40);
    }
  }

  flush(): void {
    if (this.timer >= 0) clearTimeout(this.timer);
    this.timer = -1;
    if (this.cancelled || this.pending.length === 0) return;
    const updates = this.pending;
    this.pending = [];
    this.commit(updates);
  }

  cancel(): void {
    if (this.timer >= 0) clearTimeout(this.timer);
    this.timer = -1;
    this.pending = [];
    this.cancelled = true;
  }
}
