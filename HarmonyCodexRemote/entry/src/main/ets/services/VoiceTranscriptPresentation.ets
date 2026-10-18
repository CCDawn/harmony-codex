import type { VoiceTranscriptEntry } from '../model/BridgeModels';

/** Presentation only: keep original text and identity intact for storage/retry. */
export class VoiceTranscriptPresentation {
  static text(entry: VoiceTranscriptEntry): string {
    if (entry.role !== 'user' || (entry.phoneTranscript !== true
      && (entry.itemId ?? '').indexOf('room:') === 0)) {
      return entry.text;
    }
    // Only known bracketed sound annotations. Quoted annotations and normal
    // English words are content; do not remove them or arbitrary bracketed text.
    let visible = entry.text;
    let previous = '';
    while (previous !== visible) {
      previous = visible;
      visible = visible.replace(/(^|[^"'`“‘])\[(?:sniff|sniffing|cough|coughing|sigh|sighing|breathing)\]/gi, '$1');
      // The provider also emits repeated unclosed annotations: "[sniff [sniff".
      visible = visible.replace(/(^|[^"'`“‘])\[(?:sniff|sniffing|cough|coughing|sigh|sighing|breathing)(?=\s*\[|\s*$)/gi, '$1');
    }
    if (!entry.final) {
      const tail = /(^|[^"'`“‘])\[([a-z]*)$/i.exec(visible);
      if (tail !== null) {
        const fragment = tail[2].toLowerCase();
        const markers = ['sniff', 'sniffing', 'cough', 'coughing', 'sigh', 'sighing', 'breathing'];
        if (markers.some((marker: string) => marker.indexOf(fragment) === 0)) {
          visible = visible.substring(0, visible.length - fragment.length - 1);
        }
      }
    }
    if (visible === entry.text) {
      return visible;
    }
    if (/^[\s.,!?，。！？…、]*$/.test(visible)) {
      return '';
    }
    return visible.replace(/[ \t]{2,}/g, ' ').trim();
  }

  static visible(entries: VoiceTranscriptEntry[]): VoiceTranscriptEntry[] {
    return entries.filter((entry: VoiceTranscriptEntry) => VoiceTranscriptPresentation.text(entry).trim().length > 0);
  }
}
