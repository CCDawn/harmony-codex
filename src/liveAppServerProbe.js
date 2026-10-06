import { ManagedCodexAppServerClient } from './managedCodexAppServerClient.js';

export async function runLiveAppServerProbe(options = {}) {
  const client = options.client ?? new ManagedCodexAppServerClient(options);
  const startedAt = new Date().toISOString();

  try {
    const firstConnection = await client.ensureStarted();
    const firstList = await client.request('thread/list', {
      limit: 1,
      archived: false
    });
    const secondConnection = await client.restart();
    const secondList = await client.request('thread/list', {
      limit: 1,
      archived: false
    });

    return {
      ok: true,
      mode: 'read-only',
      startedAt,
      finishedAt: new Date().toISOString(),
      checks: {
        initialize: {
          ok: true,
          generation: Number(firstConnection?.generation ?? 1),
          userAgent: String(firstConnection?.initialize?.userAgent ?? '')
        },
        threadList: {
          ok: true,
          itemCount: Array.isArray(firstList?.data) ? firstList.data.length : 0,
          hasNextCursor: Boolean(firstList?.nextCursor)
        },
        reconnect: {
          ok: Number(secondConnection?.generation ?? 0) >= 2,
          generation: Number(secondConnection?.generation ?? 0),
          itemCountAfterReconnect: Array.isArray(secondList?.data) ? secondList.data.length : 0
        }
      },
      capabilityEvidence: {
        send: 'contract-tested-not-live',
        stream: 'contract-tested-not-live',
        tools: 'contract-tested-not-live',
        approvals: 'contract-tested-not-live',
        interrupt: 'contract-tested-not-live',
        reconnect: 'live-read-only'
      }
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'read-only',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error?.message ?? String(error)
    };
  } finally {
    await client.close().catch(() => {});
  }
}

