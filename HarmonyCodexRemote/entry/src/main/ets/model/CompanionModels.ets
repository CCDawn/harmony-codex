import type { VoiceTranscriptEntry } from './BridgeModels';

export interface CompanionProfile {
  id: string;
  name: string;
  roomId: string;
  avatarUrl: string | null;
}

export interface CompanionProfileResponse {
  profile: CompanionProfile;
}

export interface CompanionTextReceipt {
  requestId: string;
  state: 'submitted' | 'uncertain';
  itemId: string | null;
}

/** Local text outbox, separate from phone voice transcripts and normal threads. */
export interface CompanionTextMessage {
  requestId: string;
  text: string;
  state: 'pending' | 'submitted' | 'uncertain' | 'failed';
  itemId: string | null;
  createdAt: number;
  detail: string;
}

export interface CompanionMessagesResponse {
  entries: VoiceTranscriptEntry[];
  calls: CompanionCallRecord[];
  nextCursor: string | null;
}

/** Official call metadata returned by the Codex companion room history endpoint. */
export interface CompanionCallRecord {
  messageId: string;
  callId: string;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: string;
  transcriptStatus: string;
  summary: string | null;
}

/** Complete voice identity supplied by the bridge for the currently paired assistant room. */
export interface CompanionVoiceIdentity {
  profileId: string;
  roomId: string;
  callId: string;
}
