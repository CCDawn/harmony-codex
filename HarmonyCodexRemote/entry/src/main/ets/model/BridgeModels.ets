export interface BridgeProject {
  id: string;
  name: string;
  root: string;
}

export interface BridgeEvent {
  id: string;
  seq?: number;
  taskId: string;
  type: string;
  payload: Record<string, Object>;
  createdAt: string;
}

export interface BridgeProtocolHandshake {
  protocolVersion: number;
  minimumClientProtocol: number;
  bridgeVersion: string;
  clientProtocol: number | null;
  clientVersion: string;
  compatible: boolean;
  reason: string;
  capabilities: string[];
}

export interface BridgeDesktopSync {
  status: string;
  desktopLive: boolean;
  mode?: string;
  message?: string;
  reason?: string;
  currentSessionId?: string | null;
  targetSessionId?: string | null;
  sessionVerified?: boolean;
  targetVerified?: boolean;
}

export interface BridgeRuntime {
  kind: string;
  state: string;
  generation?: number;
  canInterrupt?: boolean;
  reconnecting?: boolean;
  pendingRequests?: number;
  pendingApprovals?: number;
  pendingUserInputs?: number;
}

export interface BridgeRuntimeStatus {
  mode: string;
  existingThreadExecution: string;
  protocol?: BridgeProtocolHandshake | null;
  appServer?: BridgeRuntime | null;
}

export interface DesktopLiveStatus {
  ok: boolean;
  desktopLive: boolean;
  status: string;
  message?: string;
  reason?: string;
  recoveryAttempted?: boolean;
  recoveryOk?: boolean;
  recoveryError?: string;
  mobileRecoverable?: boolean;
  requiresDesktopCdp?: boolean;
  failureClass?: string;
  desktopProcessMode?: string;
  codexProcessId?: number | null;
  codexProcessCount?: number | null;
  codexStartedAt?: string | null;
  liveHostRunning?: boolean | null;
  liveHostProcessId?: number | null;
  cdpPort?: number | null;
  candidateCdpPorts?: number[];
  lastInjectedCdpPort?: number | null;
  diagnosticsError?: string;
  recoveryHint?: string;
  currentSessionId?: string | null;
  targetSessionId?: string | null;
  sessionVerified?: boolean;
  targetVerified?: boolean;
  checkedAt?: string;
}

export interface SystemRepairStatus {
  ok: boolean;
  checkedAt: string;
  bridge?: Record<string, Object>;
  desktop?: DesktopLiveStatus;
  script?: Record<string, Object>;
  sessions?: Record<string, Object>;
  recommendedAction?: string;
  severity?: string;
  message?: string;
  recoverableFromPhone?: boolean;
  repaired?: boolean;
  repairMode?: string;
}

export interface SystemLinkStatus {
  ok: boolean;
  checkedAt: string;
  severity?: string;
  recommendedAction?: string;
  recoverableFromPhone?: boolean;
  message?: string;
  executionMode?: string;
  desktopRequired?: boolean;
  bridge?: Record<string, Object>;
  desktop?: DesktopLiveStatus;
  sessions?: Record<string, Object>;
  relay?: Record<string, Object>;
  hdc?: Record<string, Object>;
  repaired?: boolean;
  repairMode?: string;
  recoveryMessage?: string;
  recoveryResult?: Record<string, Object>;
}

export interface CodexAccountUsageItem {
  kind: string;
  label: string;
  value: string;
}

export interface CodexAccountUsage {
  ok: boolean;
  status: string;
  source: string;
  checkedAt: string;
  message?: string;
  planName?: string;
  usageText?: string;
  balanceText?: string;
  limitText?: string;
  resetText?: string;
  items: CodexAccountUsageItem[];
}

export interface MobileImageUpload {
  fileName: string;
  filePath: string;
  mimeType: string;
  bytes: number;
  messageText: string;
}

export interface MobileFileUpload {
  fileName: string;
  filePath: string;
  mimeType: string;
  bytes: number;
  messageText: string;
}

export interface RemoteSessionFile {
  fileName: string;
  bytes: number;
  mimeType: string;
  openType: string;
  modifiedAt: string;
}

export interface DesktopScreenshotImage {
  mimeType: string;
  base64: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  capturedAt?: string;
}

export interface SlashIndexItem {
  id: string;
  type: string;
  name: string;
  insertText: string;
  title: string;
  description: string;
  path?: string;
  root?: string;
}

export interface CodexModelOption {
  id: string;
  model?: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
}

export interface SessionSettings {
  model?: string;
  defaultModel?: string;
  effectiveModel?: string;
  modelSource?: string;
  modelOptions?: CodexModelOption[];
  modelCatalogSource?: string;
  modelCatalogRevision?: string;
  reasoningEffort: string;
  defaultReasoningEffort?: string;
  effectiveReasoningEffort?: string;
  reasoningEffortSource?: string;
  updatedAt?: string;
}

export interface BridgeTask {
  id: string;
  projectId: string;
  prompt: string;
  promptPreview?: string;
  promptLength?: number;
  codexSessionId?: string | null;
  sessionFingerprint?: CodexSessionFingerprint | null;
  verifiedSessionTarget?: CodexSessionFingerprint | null;
  createdCodexSessionId?: string | null;
  model?: string;
  reasoningEffort?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  activeCodexTurnId?: string | null;
  interruptReady?: boolean;
  interruptRequested?: boolean;
  interruptDispatching?: boolean;
  interruptError?: string | null;
  syntheticInterrupt?: boolean;
  desktopSync?: BridgeDesktopSync | null;
  runtime?: BridgeRuntime | null;
  pendingUserInput?: BridgeUserInput | null;
  submissionId?: string;
  session?: CodexSessionDetail | null;
  eventCount?: number;
  eventCursor?: number;
  eventGap?: boolean;
  hasMoreEvents?: boolean;
  latestEvent?: BridgeEvent | null;
  resultSummary?: Object | null;
  error?: string | null;
  events: BridgeEvent[];
}

export interface BridgeTaskSummary {
  id: string;
  projectId: string;
  prompt: string;
  promptPreview?: string;
  promptLength?: number;
  codexSessionId?: string | null;
  sessionFingerprint?: CodexSessionFingerprint | null;
  verifiedSessionTarget?: CodexSessionFingerprint | null;
  createdCodexSessionId?: string | null;
  model?: string;
  reasoningEffort?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  activeCodexTurnId?: string | null;
  interruptReady?: boolean;
  interruptRequested?: boolean;
  interruptDispatching?: boolean;
  interruptError?: string | null;
  syntheticInterrupt?: boolean;
  desktopSync?: BridgeDesktopSync | null;
  runtime?: BridgeRuntime | null;
  submissionId?: string;
  session?: CodexSessionDetail | null;
  eventCount: number;
  eventCursor?: number;
  eventGap?: boolean;
  hasMoreEvents?: boolean;
  latestEvent: BridgeEvent | null;
  error?: string | null;
}

export interface BridgeApproval {
  id: string;
  taskId: string;
  status: string;
  decision: string | null;
  command: string;
  reason: string;
  risk: string;
}

export interface BridgeUserInputOption {
  label: string;
  description: string;
}

export interface BridgeUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: BridgeUserInputOption[] | null;
}

export interface BridgeUserInput {
  id: string;
  taskId: string;
  runId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  status: string;
  questions: BridgeUserInputQuestion[];
  autoResolutionMs: number | null;
  createdAt: string;
  answeredAt?: string | null;
  expiredAt?: string | null;
  expireReason?: string;
}

export interface BridgeOutboxItem {
  id: string;
  kind: string;
  threadId: string;
  projectId: string;
  submissionId: string;
  text: string;
  status: string;
  order: number;
  attemptCount: number;
  retryable: boolean;
  error: string;
  nextAttemptAt: string;
  lastAttemptAt: string;
  submittedAt: string;
  resultId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  relativeTime?: string;
  projectRoot?: string;
  projectLabel?: string;
  sidebarSection?: string;
  source?: string;
  activitySource?: string;
  activityStatus?: string;
  activityUpdatedAt?: string;
  runtimeState?: string;
  runtimeSource?: string;
  runtimeUpdatedAt?: string;
  activeTurnId?: string;
  canInterrupt?: boolean;
  terminalReason?: string;
  lastVisibleRole?: string;
  pinned?: boolean;
  detailAvailable: boolean;
}

export interface CodexRuntimeSession {
  threadId: string;
  title: string;
  projectRoot: string;
  projectLabel: string;
  sidebarSection: string;
  pinned: boolean;
  updatedAt: string;
  relativeTime: string;
  state: string;
  stateUpdatedAt: string;
  source: string;
  activeTurnId: string;
  canInterrupt: boolean;
  terminalReason: string;
  lastVisibleRole: string;
  detailAvailable: boolean;
}

export interface CodexRuntimeSnapshot {
  schemaVersion: number;
  epoch: string;
  revision: number;
  generatedAt: string;
  stale: boolean;
  sessions: CodexRuntimeSession[];
}

export interface CodexSessionAgentRef {
  name: string;
  status: string;
  report?: string;
}

export interface CodexSessionToolItem {
  id: string;
  name: string;
  verb: string;
  target: string;
  detail: string;
  status: string;
  retryCount?: number;
  args?: string;
  taskName?: string;
  agents?: CodexSessionAgentRef[];
}

export interface CodexSessionEntry {
  timestamp: string;
  type: string;
  role: string;
  text: string;
  syncId?: string;
  syncStartOffset?: number;
  syncEndOffset?: number;
  liveKind?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  toolItems?: CodexSessionToolItem[];
}

export interface CodexSessionSync {
  mode: string;
  source: string;
  filePath: string;
  fileSize: number;
  fileUpdatedAt: string;
  cursorStart: string;
  cursorEnd: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  entryCount: number;
}

export interface CodexSessionFingerprint {
  id: string;
  title: string;
  projectRoot: string;
  projectLabel: string;
  filePath: string;
  entryCount: number;
  verifiedAt?: string;
}

export interface CodexSessionDetail {
  id: string;
  title: string;
  updatedAt: string;
  relativeTime?: string;
  projectRoot?: string;
  projectLabel?: string;
  source?: string;
  activitySource?: string;
  activityStatus?: string;
  activityUpdatedAt?: string;
  runtimeState?: string;
  runtimeSource?: string;
  runtimeUpdatedAt?: string;
  activeTurnId?: string;
  canInterrupt?: boolean;
  terminalReason?: string;
  lastVisibleRole?: string;
  pinned?: boolean;
  detailAvailable?: boolean;
  filePath: string;
  entries: CodexSessionEntry[];
  entryCount: number;
  sync?: CodexSessionSync;
}

export type VoiceCallStatus = 'idle' | 'connecting' | 'ready' | 'active' | 'closing' | 'error';

export interface VoiceTranscriptEntry {
  itemId?: string;
  role: string;
  text: string;
  final: boolean;
}
