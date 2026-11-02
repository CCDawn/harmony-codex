import { PickedMobileFile } from './AttachmentService';

export interface SessionDraftScope {
  bridgeUrl: string;
  bridgeToken: string;
  sessionId: string;
  projectId: string;
}

export interface SessionDraftImage {
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
}

export interface SessionDraft {
  text: string;
  images: SessionDraftImage[];
  files: PickedMobileFile[];
}

export class SessionDraftStore {
  // Pairing credentials and draft contents stay in this instance's memory only.
  private drafts: Map<string, SessionDraft> = new Map<string, SessionDraft>();

  has(scope: SessionDraftScope): boolean {
    return this.drafts.has(this.key(scope));
  }

  // False means the caller must retain the composer and cancel navigation.
  // Never evict an unsent draft to make room for another conversation.
  save(scope: SessionDraftScope, draft: SessionDraft): boolean {
    const key = this.key(scope);
    if (draft.text.length === 0 && draft.images.length === 0 && draft.files.length === 0) {
      this.drafts.delete(key);
      return true;
    }
    if (!this.drafts.has(key) && this.drafts.size >= 64) {
      return false;
    }
    this.drafts.set(key, this.copy(draft));
    return true;
  }

  load(scope: SessionDraftScope): SessionDraft | null {
    const draft = this.drafts.get(this.key(scope));
    return draft === undefined ? null : this.copy(draft);
  }

  remove(scope: SessionDraftScope): void {
    this.drafts.delete(this.key(scope));
  }

  private key(scope: SessionDraftScope): string {
    const isSession = scope.sessionId.length > 0;
    return JSON.stringify([
      scope.bridgeUrl,
      scope.bridgeToken,
      isSession ? 'session' : 'new',
      isSession ? scope.sessionId : scope.projectId
    ]);
  }

  private copy(draft: SessionDraft): SessionDraft {
    return {
      text: draft.text,
      images: draft.images.map((image: SessionDraftImage): SessionDraftImage => ({
        id: image.id,
        uri: image.uri,
        fileName: image.fileName,
        mimeType: image.mimeType
      })),
      files: draft.files.map((file: PickedMobileFile): PickedMobileFile => ({
        id: file.id,
        uri: file.uri,
        fileName: file.fileName,
        mimeType: file.mimeType,
        bytes: file.bytes
      }))
    };
  }
}
