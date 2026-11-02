export interface MobilePushRegistration {
  id: string;
  registered: boolean;
  ready: boolean;
  threadCount: number;
}

export interface MobilePushResponse {
  version: number;
  configured: boolean;
  setup: string;
  registration?: MobilePushRegistration;
}

export class MobilePushRegistrationPayload {
  installationId: string;
  token: string;
  threadIds: string[];

  constructor(installationId: string, token: string, threadIds: string[]) {
    this.installationId = installationId;
    this.token = token;
    this.threadIds = threadIds;
  }
}
