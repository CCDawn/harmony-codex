export interface SseFrame {
  event: string;
  data: string;
  id: string;
}

/** Incremental SSE framing; transport chunk boundaries carry no meaning. */
export class SseParser {
  private line: string = '';
  private data: string[] = [];
  private event: string = '';
  private id: string = '';
  private skipLf: boolean = false;
  private first: boolean = true;
  private size: number = 0;

  push(text: string): SseFrame[] {
    const frames: SseFrame[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const ch = text[index];
      if (this.first) {
        this.first = false;
        if (ch === '\uFEFF') continue;
      }
      if (this.skipLf && ch === '\n') { this.skipLf = false; continue; }
      this.skipLf = false;
      if (ch === '\r' || ch === '\n') {
        this.consumeLine(frames);
        this.skipLf = ch === '\r';
      } else {
        this.line += ch;
        this.size += 1;
        if (this.size > 1024 * 1024) throw new Error('实时事件超过接收上限');
      }
    }
    return frames;
  }

  private consumeLine(frames: SseFrame[]): void {
    const line = this.line;
    this.line = '';
    if (line.length === 0) {
      if (this.data.length > 0) frames.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
      this.data = [];
      this.event = '';
      this.id = '';
      this.size = 0;
      return;
    }
    if (line[0] === ':') { this.size -= line.length; return; }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && value.indexOf('\u0000') < 0) this.id = value;
  }
}
