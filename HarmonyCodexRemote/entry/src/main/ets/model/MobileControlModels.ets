export interface MobileControlVerification {
  bridge: boolean;
  sessions: boolean;
  targetSession: boolean;
  desktopRequired: boolean;
  desktop: boolean;
}

export interface MobileControlJob {
  version: number;
  id: string;
  requestId: string;
  mode: string;
  sessionId: string;
  status: string;
  phase: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  verification?: MobileControlVerification;
}

export interface MobileControlAgent {
  online: boolean;
  targetId: string;
  version: number;
}

export interface MobileControlStatus {
  version: number;
  agent: MobileControlAgent;
  activeJob: MobileControlJob | null;
  lastJob: MobileControlJob | null;
}

export interface MobileControlJobResponse {
  version: number;
  job: MobileControlJob;
}
