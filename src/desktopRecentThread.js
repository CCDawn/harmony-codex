// Official pages are newest first; adapter consumers expect chronological order.
// Summary pages suffice for status, but message verification requires full items.
export async function readRecentDesktopThread(client, threadId, options = {}) {
  const [detail, page] = await Promise.all([
    client.request('thread/read', { threadId, includeTurns: false }),
    client.request('thread/turns/list', {
      threadId, limit: 10, itemsView: options.itemsView ?? 'summary'
    })
  ]);
  if (!detail?.thread || !Array.isArray(page?.data)) {
    throw new Error('Codex 官方轮次分页响应无效，已停止发送');
  }
  return { thread: { ...detail.thread, turns: [...page.data].reverse() } };
}
