import { EventEmitter } from 'node:events';

export class CodexAppServerStabilityProbe extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.client) {
      throw new Error('CodexAppServerStabilityProbe requires a client');
    }
    this.client = options.client;
    this.approvalDecision = options.approvalDecision ?? null;
    this.observing = false;
    this.state = createInitialState();
    this.onNotification = (message) => this.handleNotification(message);
    this.onServerRequest = (message) => {
      void this.handleServerRequest(message);
    };
    this.onReconnected = (event) => {
      this.state.reconnect.count += 1;
      this.state.reconnect.lastGeneration = Number(event?.generation ?? 0);
    };
  }

  startObserving() {
    if (this.observing) {
      return;
    }
    this.observing = true;
    this.client.on('notification', this.onNotification);
    this.client.on('serverRequest', this.onServerRequest);
    this.client.on('reconnected', this.onReconnected);
  }

  stopObserving() {
    if (!this.observing) {
      return;
    }
    this.observing = false;
    this.client.off('notification', this.onNotification);
    this.client.off('serverRequest', this.onServerRequest);
    this.client.off('reconnected', this.onReconnected);
  }

  async sendTurn({ threadId, text, cwd = null, approvalPolicy = 'on-request' }) {
    const response = await this.client.request('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: String(text ?? ''),
        text_elements: []
      }],
      cwd,
      approvalPolicy
    });
    this.state.send.ok = true;
    this.state.send.threadId = threadId;
    this.state.send.turnId = String(response?.turn?.id ?? '');
    return response.turn;
  }

  async interruptTurn({ threadId, turnId }) {
    await this.client.request('turn/interrupt', { threadId, turnId });
    this.state.interrupt.ok = true;
    this.state.interrupt.threadId = threadId;
    this.state.interrupt.turnId = turnId;
  }

  report() {
    return structuredClone(this.state);
  }

  handleNotification(message) {
    const method = normalizeMethod(message?.method);
    if (isStreamEvent(method)) {
      this.state.stream.eventCount += 1;
      this.state.stream.lastMethod = String(message.method);
    }
    if (isToolEvent(method)) {
      this.state.tools.eventCount += 1;
      this.state.tools.lastMethod = String(message.method);
    }
  }

  async handleServerRequest(message) {
    const method = normalizeMethod(message?.method);
    if (!isApprovalRequest(method)) {
      this.emit('unhandledServerRequest', message);
      return;
    }

    this.state.approvals.requestCount += 1;
    this.state.approvals.lastMethod = String(message.method);
    if (!this.approvalDecision) {
      this.emit('approvalRequired', message);
      return;
    }

    try {
      const result = await this.approvalDecision(message);
      this.client.respond(message.id, result);
      this.state.approvals.responseCount += 1;
      this.emit('approvalResponded', { request: message, result });
    } catch (error) {
      this.client.respond(message.id, null, {
        code: -32000,
        message: error?.message ?? String(error)
      });
      this.emit('approvalResponseFailed', { request: message, error });
    }
  }
}

function createInitialState() {
  return {
    send: {
      ok: false,
      threadId: '',
      turnId: ''
    },
    stream: {
      eventCount: 0,
      lastMethod: ''
    },
    tools: {
      eventCount: 0,
      lastMethod: ''
    },
    approvals: {
      requestCount: 0,
      responseCount: 0,
      lastMethod: ''
    },
    interrupt: {
      ok: false,
      threadId: '',
      turnId: ''
    },
    reconnect: {
      count: 0,
      lastGeneration: 0
    }
  };
}

function normalizeMethod(value) {
  return String(value ?? '').toLowerCase().replace(/[\s_-]/g, '');
}

function isStreamEvent(method) {
  return method.includes('agentmessage')
    || method.includes('reasoning')
    || method.endsWith('/delta')
    || method.endsWith('/textdelta');
}

function isToolEvent(method) {
  return method.includes('commandexecution')
    || method.includes('filechange')
    || method.includes('mcptoolcall')
    || method.includes('dynamictoolcall');
}

function isApprovalRequest(method) {
  return method.includes('requestapproval')
    || method.includes('requestuserinput')
    || method.includes('elicitation');
}

