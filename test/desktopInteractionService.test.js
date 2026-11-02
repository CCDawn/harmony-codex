import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopInteractionService } from '../src/desktopInteractionService.js';

function fixture(requests = [command()]) {
  const calls = [];
  const client = {
    requests,
    async listRequests() { return structuredClone(this.requests); },
    async respond(threadId, request, result) {
      calls.push({ threadId, request, result });
      this.requests = this.requests.filter(item => item.id !== request.id);
    }
  };
  return { service: new DesktopInteractionService(client), client, calls };
}
function command(overrides = {}) {
  return { id: 7, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'echo test', cwd: 'C:/test',
      availableDecisions: ['accept', 'decline'] },
    __desktopGeneration: 'generation-a', ...overrides };
}
function input() {
  return { id: 8, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-1', questions: [{ id: 'q', question: '请选择', isOther: false,
      options: [{ label: '甲', description: '方案甲' }, { label: '乙' }] }]
  }};
}

test('desktop-origin request needs no bridge run and only explicit response forwards to owner', async () => {
  const { service, calls } = fixture();
  const first = await service.list('thread-1');
  assert.equal(calls.length, 0);
  assert.equal(first[0].kind, 'approval');
  assert.match(first[0].detail, /echo test/);
  assert.equal((await service.list('thread-1'))[0].id, first[0].id);
  assert.deepEqual(await service.respond(first[0].id, { threadId: 'thread-1', decision: 'approved' }), { resolved: true });
  assert.deepEqual(calls[0].result, { decision: 'accept' });
  assert.equal(calls[0].threadId, 'thread-1');
  assert.equal((await service.list('thread-1')).length, 0);
});

test('native command accepts once or cancels when the desktop offers cancel without decline', async () => {
  for (const [decision, expected] of [['approved', 'accept'], ['denied', 'cancel']]) {
    const request = command({ id: 18, params: { ...command().params,
      command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command Get-Date',
      availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['Get-Date'] } }, 'cancel'] } });
    const { service, calls } = fixture([request]);
    const [ticket] = await service.list('thread-1');
    assert.equal(ticket.supportsResponse, true);
    assert.equal(ticket.rejectLabel, '取消');
    assert.match(ticket.detail, /Get-Date/);
    await service.respond(ticket.id, { threadId: 'thread-1', decision });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].result, { decision: expected });
  }
});

test('command decline wins over cancel and incomplete explicit decisions cannot be submitted', async () => {
  const both = command({ params: { ...command().params, availableDecisions: ['accept', 'cancel', 'decline'] } });
  const f = fixture([both]);
  const [ticket] = await f.service.list('thread-1');
  assert.equal(ticket.rejectLabel, undefined);
  await f.service.respond(ticket.id, { threadId: 'thread-1', decision: 'denied' });
  assert.deepEqual(f.calls[0].result, { decision: 'decline' });
  for (const decisions of [[], ['accept'], ['cancel'], ['acceptForSession', 'cancel'], 'accept']) {
    const h = fixture([command({ params: { ...command().params, availableDecisions: decisions } })]);
    const [request] = await h.service.list('thread-1');
    assert.equal(request.supportsResponse, false);
    await assert.rejects(h.service.respond(request.id, { threadId: 'thread-1', decision: 'approved' }), { statusCode: 422 });
    assert.equal(h.calls.length, 0);
  }
});

test('legacy commands without an available decision list keep accept and decline behavior', async () => {
  for (const decisions of [undefined, null]) {
    for (const [decision, expected] of [['approved', 'accept'], ['denied', 'decline']]) {
      const request = command({ params: { ...command().params, availableDecisions: decisions } });
      const h = fixture([request]);
      const [ticket] = await h.service.list('thread-1');
      assert.equal(ticket.supportsResponse, true);
      assert.equal(ticket.rejectLabel, undefined);
      await h.service.respond(ticket.id, { threadId: 'thread-1', decision });
      assert.deepEqual(h.calls[0].result, { decision: expected });
    }
  }
});

test('only async user input carries its original message and turn identity', async () => {
  const asyncRequest = input();
  asyncRequest.method = 'desktop/asyncUserInput';
  asyncRequest.params.itemId = 'message-1';
  asyncRequest.params.turnId = 'turn-1';
  const syncRequest = input();
  syncRequest.params.itemId = 'sync-message';
  syncRequest.params.turnId = 'sync-turn';
  const { service } = fixture([asyncRequest, { ...syncRequest, id: 9 }]);
  const [asyncTicket, syncTicket] = await service.list('thread-1');
  assert.equal(asyncTicket.itemId, 'message-1');
  assert.equal(asyncTicket.turnId, 'turn-1');
  assert.equal(syncTicket.itemId, undefined);
  assert.equal(syncTicket.turnId, undefined);
});

test('desktop dismissal and changed request with reused id reject old phone action', async () => {
  for (const change of [[], [command({ params: { ...command().params, command: 'different' } })],
    [command({ __desktopGeneration: 'generation-b' })]]) {
    const { service, client, calls } = fixture();
    const [ticket] = await service.list('thread-1');
    client.requests = change;
    await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', decision: 'approved' }), { statusCode: 409 });
    assert.equal(calls.length, 0);
  }
});

test('concurrent duplicate decisions send exactly once and cannot cross threads', async () => {
  const { service, calls } = fixture();
  const [ticket] = await service.list('thread-1');
  await assert.rejects(service.respond(ticket.id, { threadId: 'thread-2', decision: 'approved' }), { statusCode: 409 });
  const results = await Promise.allSettled([1, 2].map(() =>
    service.respond(ticket.id, { threadId: 'thread-1', decision: 'denied' })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].result, { decision: 'decline' });
});

test('read transport failure expires tickets; ambiguous write never retries', async () => {
  const { service, client, calls } = fixture();
  const [ticket] = await service.list('thread-1');
  client.listRequests = async () => { throw new Error('sensitive transport contents'); };
  await assert.rejects(service.list('thread-1'), error => error.statusCode === 503 && !error.message.includes('sensitive'));
  await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', decision: 'approved' }), { statusCode: 409 });
  assert.equal(calls.length, 0);
  client.listRequests = async () => client.requests;
  const [next] = await service.list('thread-1');
  let attempts = 0;
  client.respond = async () => { attempts++; throw new Error('secret'); };
  await assert.rejects(service.respond(next.id, { threadId: 'thread-1', decision: 'approved' }), { statusCode: 503 });
  await assert.rejects(service.respond(next.id, { threadId: 'thread-1', decision: 'approved' }), { statusCode: 409 });
  assert.equal(attempts, 1);
});

test('read failures preserve fixed diagnostic stage with a sanitized cause and expire old tickets', async () => {
  const { service, client } = fixture();
  const [ticket] = await service.list('thread-1');
  client.listRequests = async () => {
    throw Object.assign(new Error('PRIVATE_BODY_AND_SOURCE'), { code: 'PRIVATE_CODE',
      stage: 'mounted-manager-ambiguous', cause: new Error('PRIVATE_CAUSE') });
  };
  await assert.rejects(service.list('thread-1'), error => {
    assert.equal(error.statusCode, 503);
    assert.deepEqual(error.diagnostic, { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'mounted-manager-ambiguous' });
    assert.equal(error.cause.message, 'DESKTOP_INTERACTIONS_UNAVAILABLE');
    assert.equal(error.cause.stage, 'mounted-manager-ambiguous');
    assert.equal(error.cause.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
    return true;
  });
  await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', decision: 'approved' }), { statusCode: 409 });
  client.listRequests = async () => { throw Object.assign(new Error('PRIVATE'), { stage: 'PRIVATE_STAGE' }); };
  await assert.rejects(service.list('thread-1'), { stage: 'transport' });
  client.listRequests = async () => { throw Object.assign(new Error('PRIVATE'), { stage: 'mounted-manager-scan-timeout' }); };
  await assert.rejects(service.list('thread-1'), error => {
    assert.deepEqual(error.diagnostic, { code: 'DESKTOP_INTERACTIONS_UNAVAILABLE', stage: 'mounted-manager-scan-timeout' });
    assert.equal(error.cause.stage, 'mounted-manager-scan-timeout');
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
    return true;
  });
});

test('structured questions validate completeness, option membership and original ids', async () => {
  const { service, calls } = fixture([input()]);
  const [ticket] = await service.list('thread-1');
  assert.equal(ticket.questions[0].options[1].description, '');
  for (const answers of [{}, { q: ['invalid'] }, { q: ['甲'], alien: ['甲'] }, { q: ['甲', '乙'] }]) {
    await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', answers }), { statusCode: 400 });
  }
  assert.equal(calls.length, 0);
  await service.respond(ticket.id, { threadId: 'thread-1', answers: { q: ['乙'] } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].result)), { answers: { q: { answers: ['乙'] } } });
});

test('free text and secret question accepted without reflecting answers in response', async () => {
  const request = input();
  request.params.questions[0].isOther = true;
  request.params.questions[0].isSecret = true;
  const { service } = fixture([request]);
  const [ticket] = await service.list('thread-1');
  const result = await service.respond(ticket.id, { threadId: 'thread-1', answers: { q: ['private answer'] } });
  assert.deepEqual(result, { resolved: true });
});

test('permission approvals grant exact requested permissions for current turn only', async () => {
  for (const decision of ['approved', 'denied']) {
    const permissions = { network: { enabled: true }, fileSystem: { read: ['C:/test'] } };
    const { service, calls } = fixture([command({ method: 'item/permissions/requestApproval',
      params: { threadId: 'thread-1', permissions } })]);
    const [ticket] = await service.list('thread-1');
    await service.respond(ticket.id, { threadId: 'thread-1', decision, scope: 'session', permissions: { any: true } });
    assert.deepEqual(calls[0].result, { permissions: decision === 'approved' ? permissions : {}, scope: 'turn' });
  }
});

test('unknown methods, incomplete file context and limited decisions remain visible without approval', async () => {
  for (const request of [command({ method: 'future/requestApproval' }),
    command({ method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1' } }),
    command({ params: { ...command().params, availableDecisions: ['cancel'] } })]) {
    const { service, calls } = fixture([request]);
    const [ticket] = await service.list('thread-1');
    assert.equal(ticket.supportsResponse, false);
    assert.match(ticket.detail, /电脑|桌面/);
    await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', decision: 'approved' }), { statusCode: 422 });
    assert.equal(calls.length, 0);
  }
});

test('multiple requests are stable, independently answered and scoped to selected conversation', async () => {
  const { service, calls } = fixture([command(), input(), command({ id: 9, params: { threadId: 'other' } })]);
  const tickets = await service.list('thread-1');
  assert.equal(tickets.length, 2);
  await service.respond(tickets[1].id, { threadId: 'thread-1', answers: { q: ['甲'] } });
  assert.equal((await service.list('thread-1'))[0].id, tickets[0].id);
  assert.equal(calls.length, 1);
});

test('native file-change context is displayed and permits explicit one-time approval', async () => {
  const { service, calls } = fixture([command({
    method: 'item/fileChange/requestApproval',
    __fileChanges: [{ path: 'test.txt', diff: '+reviewed content' }]
  })]);
  const [ticket] = await service.list('thread-1');
  assert.equal(ticket.supportsResponse, true);
  assert.match(ticket.detail, /test.txt/);
  assert.match(ticket.detail, /reviewed content/);
  await service.respond(ticket.id, { threadId: 'thread-1', decision: 'approved' });
  assert.deepEqual(calls[0].result, { decision: 'accept' });
});

test('async question answers use original question keys and conflict does not retry', async () => {
  const request = input();
  request.method = 'desktop/asyncUserInput';
  const { service, client } = fixture([request]);
  const [ticket] = await service.list('thread-1');
  let attempts = 0;
  client.respond = async () => {
    attempts++;
    throw Object.assign(new Error('conflict'), { statusCode: 409, code: 'DESKTOP_ASYNC_ANSWER_CONFLICT' });
  };
  await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', answers: { q: ['乙'] } }),
    error => error.statusCode === 409 && /不同答案/.test(error.message));
  assert.equal(attempts, 1);
});


test('only native-writable async questions advertise and forward per-question skip', async () => {
  const request = input();
  request.method = 'desktop/asyncUserInput';
  request.__skipBindings = [['owner', 'binding']];
  request.params.questions.push({ id: 'second', question: '第二题' });
  request.__skipBindings.push(['owner', 'binding2']);
  const { service, calls } = fixture([request]);
  const [ticket] = await service.list('thread-1');
  assert.equal(ticket.supportsSkip, true);
  for (const body of [{ skipQuestionId: 'alien' }, { skipQuestionId: 'q', answers: { q: ['甲'] } },
    { skipQuestionId: null }]) {
    await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', ...body }), { statusCode: 400 });
  }
  assert.deepEqual(await service.respond(ticket.id, { threadId: 'thread-1', skipQuestionId: 'second' }), { resolved: true });
  assert.deepEqual(calls[0].result, { skipQuestionId: 'second' });
});

test('missing capability and synchronous input never permit skip', async () => {
  for (const method of ['desktop/asyncUserInput', 'item/tool/requestUserInput']) {
    const request = input(); request.method = method;
    const { service, calls } = fixture([request]);
    const [ticket] = await service.list('thread-1');
    assert.notEqual(ticket.supportsSkip, true);
    await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', skipQuestionId: 'q' }), { statusCode: 422 });
    assert.equal(calls.length, 0);
  }
});


test('failed native skip expires its ticket and is never automatically retried', async () => {
  const request = input(); request.method = 'desktop/asyncUserInput';
  request.__skipBindings = [['owner', 'binding']];
  const { service, client } = fixture([request]);
  const [ticket] = await service.list('thread-1');
  let attempts = 0;
  client.respond = async () => { attempts++; throw new Error('unconfirmed'); };
  await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', skipQuestionId: 'q' }), { statusCode: 503 });
  await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', skipQuestionId: 'q' }), { statusCode: 409 });
  assert.equal(attempts, 1);
});

test('skip cannot turn into an approval when a decision is also supplied', async () => {
  const { service, calls } = fixture();
  const [ticket] = await service.list('thread-1');
  await assert.rejects(service.respond(ticket.id, { threadId: 'thread-1', decision: 'approved', skipQuestionId: 'q' }),
    { statusCode: 422 });
  assert.equal(calls.length, 0);
});
