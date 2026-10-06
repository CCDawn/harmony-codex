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

export interface CompanionMessagesResponse {
  entries: VoiceTranscriptEntry[];
  nextCursor: string | null;
}
