import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DesktopInteractionClient } from './desktopInteractionClient.js';

const COMMAND = 'item/commandExecution/requestApproval';
const FILE = 'item/fileChange/requestApproval';
const PERMISSIONS = 'item/permissions/requestApproval';
const INPUT = 'item/tool/requestUserInput';
const ASYNC_INPUT = 'desktop/asyncUserInput';

// These tickets belong to the desktop owner, never to a parallel app-server run.
export class DesktopInteractionService {
  constructor(client = new DesktopInteractionClient()) {
    this.client = client;
    this.tickets = new Map();
    this.threadQueues = new Map();
  }

  async list(threadId) {
    validateThread(threadId);
    return this.exclusive(threadId, () => this.refresh(threadId));
  }

  async refresh(threadId) {
    let requests;
    try {
      requests = await this.client.listRequests(threadId);
      if (!Array.isArray(requests)) throw new Error('Invalid desktop request snapshot');
    } catch {
      this.expireThread(threadId);
      throw statusError('无法读取桌面待处理请求，请检查桌面连接后重试', 503);
    }
    const retained = new Set();
    const result = [];
    for (const request of requests) {
      if (!request || request.id === undefined || request.id === null || !request.method) continue;
      // Never project a request belonging to another conversation.
      if (request.params?.threadId && request.params.threadId !== threadId) continue;
      let ticket = [...this.tickets.values()].find(entry =>
        entry.threadId === threadId && isDeepStrictEqual(entry.request, request));
      if (!ticket) {
        ticket = { id: randomUUID(), threadId, request: structuredClone(request) };
        this.tickets.set(ticket.id, ticket);
      }
      retained.add(ticket.id);
      result.push(projectRequest(ticket));
    }
    for (const [id, ticket] of this.tickets) {
      if (ticket.threadId === threadId && !retained.has(id)) this.tickets.delete(id);
    }
    return result;
  }

  async respond(id, body) {
    validateThread(body?.threadId);
    return this.exclusive(body.threadId, async () => {
      const ticket = this.tickets.get(id);
      if (!ticket || ticket.threadId !== body.threadId) throw stale();
      const result = responseFor(ticket, body);
      await this.refresh(ticket.threadId);
      if (!this.tickets.has(id)) throw stale();
      try {
        await this.client.respond(ticket.threadId, ticket.request, result);
      } catch (error) {
        // A failed/ambiguous write must never be automatically replayed.
        this.tickets.delete(id);
        if (error?.code === 'DESKTOP_ASYNC_ANSWER_CONFLICT') {
          throw statusError('检测到另一端已提交不同答案，请先查看会话内容；不会自动重发', 409);
        }
        if (error?.statusCode === 409) throw stale();
        throw statusError('桌面未确认处理结果，请刷新状态后再操作', 503);
      }
      this.tickets.delete(id);
      return { resolved: true };
    });
  }

  expireThread(threadId) {
    for (const [id, ticket] of this.tickets) if (ticket.threadId === threadId) this.tickets.delete(id);
  }

  close() {
    this.tickets.clear();
    this.client.close?.();
  }

  async exclusive(threadId, operation) {
    const previous = this.threadQueues.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.threadQueues.set(threadId, current);
    try { return await current; }
    finally { if (this.threadQueues.get(threadId) === current) this.threadQueues.delete(threadId); }
  }
}

function projectRequest(ticket) {
  const { request, id, threadId } = ticket;
  const params = request.params ?? {};
  let kind = 'unsupported';
  let title = '需要在电脑上处理';
  let supportsResponse = false;
  let questions = [];
  const details = [];
  if (params.reason) details.push(String(params.reason));
  if (request.method === COMMAND) {
    kind = 'approval';
    title = params.kind === 'stdin' ? '允许向终端输入？' : '允许执行此操作？';
    if (params.command) details.push('命令：\n' + String(params.command));
    if (params.cwd) details.push('工作目录：' + String(params.cwd));
    if (params.networkApprovalContext) details.push('网络访问：\n' + JSON.stringify(params.networkApprovalContext, null, 2));
    if (params.additionalPermissions) details.push('附加权限：\n' + JSON.stringify(params.additionalPermissions, null, 2));
    const decisions = params.availableDecisions;
    supportsResponse = (!decisions || (Array.isArray(decisions) && decisions.includes('accept') && decisions.includes('decline')))
      && Boolean(params.command || params.networkApprovalContext);
    details.push('同意仅用于这一次操作。');
  } else if (request.method === FILE) {
    kind = 'approval';
    title = '允许修改文件？';
    if (params.grantRoot) details.push('请求写入目录：' + String(params.grantRoot));
    const changes = request.__fileChanges ?? params.changes;
    if (changes) details.push('文件变更：\n' + JSON.stringify(changes, null, 2));
    // Do not offer blind approval when the native request has no file context.
    supportsResponse = Boolean(params.grantRoot || changes);
    details.push('同意仅用于本次文件修改。');
  } else if (request.method === PERMISSIONS) {
    kind = 'approval';
    title = '允许使用这些权限？';
    if (params.cwd) details.push('工作目录：' + String(params.cwd));
    if (params.environmentId) details.push('目标环境：' + String(params.environmentId));
    details.push('请求权限：\n' + JSON.stringify(params.permissions ?? {}, null, 2));
    details.push('授权仅在当前轮次有效。');
    supportsResponse = !!params.permissions && typeof params.permissions === 'object' && !Array.isArray(params.permissions);
  } else if (request.method === INPUT || request.method === ASYNC_INPUT) {
    kind = 'user-input';
    title = '需要你回答';
    questions = normalizeQuestions(params.questions);
    supportsResponse = questions.length > 0 && questions.length === params.questions?.length;
  }
  if (!supportsResponse) details.push('此请求暂不能在手机安全处理，请在 Codex 桌面中查看并处理。');
  return { id, threadId, kind, status: 'pending', title, detail: details.join('\n\n'), questions, supportsResponse };
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap(question => {
    if (typeof question?.id !== 'string' || !question.id || seen.has(question.id)
      || typeof question.question !== 'string' || !question.question) return [];
    seen.add(question.id);
    const options = Array.isArray(question.options) ? question.options.filter(option =>
      typeof option?.label === 'string' && option.label.trim()).map(option => ({
        label: option.label, description: String(option.description ?? '')
      })) : null;
    return [{ id: question.id, header: String(question.header ?? ''), question: question.question,
      isOther: question.isOther === true, isSecret: question.isSecret === true,
      options: options?.length ? options : null }];
  });
}

function responseFor(ticket, body) {
  const projected = projectRequest(ticket);
  if (!projected.supportsResponse) throw statusError('该请求需要在电脑上处理', 422);
  const request = ticket.request;
  if (projected.kind === 'approval') {
    if (!['approved', 'denied'].includes(body.decision)) throw statusError('请选择同意或拒绝', 400);
    if (request.method === PERMISSIONS) return {
      permissions: body.decision === 'approved' ? structuredClone(request.params.permissions) : {},
      scope: 'turn'
    };
    return { decision: body.decision === 'approved' ? 'accept' : 'decline' };
  }
  const value = body.answers;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw statusError('请填写问题答案', 400);
  const answers = Object.create(null);
  if (Object.keys(value).some(key => !projected.questions.some(question => question.id === key))) {
    throw statusError('回答包含不属于当前请求的问题', 400);
  }
  for (const question of projected.questions) {
    const items = value[question.id];
    if (!Array.isArray(items) || items.length !== 1 || typeof items[0] !== 'string' || !items[0].trim()) {
      throw statusError('请回答每一个问题', 400);
    }
    const answer = items[0].trim();
    if (question.options && !question.isOther && !question.options.some(option => option.label === answer)) {
      throw statusError('请选择当前问题提供的选项', 400);
    }
    answers[question.id] = { answers: [answer] };
  }
  return { answers };
}

function validateThread(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw statusError('会话标识无效', 400);
}
function statusError(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }
function stale() { return statusError('此请求已在桌面处理或已失效，请刷新会话', 409); }
