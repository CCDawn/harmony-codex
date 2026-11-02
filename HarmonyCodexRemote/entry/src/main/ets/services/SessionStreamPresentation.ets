import { BridgeEvent } from '../model/BridgeModels';

interface StreamMessage {
  key: string;
  text: string;
  completed: boolean;
}

/** Select the newest assistant item; completed older commentary cannot mask it. */
export function latestSessionStreamText(events: BridgeEvent[]): string {
  const messages: StreamMessage[] = [];
  const byKey: Map<string, StreamMessage> = new Map<string, StreamMessage>();
  let anonymousSequence = 0;
  let anonymousKey = '';
  const update = (turnId: string, itemId: string, text: string, complete: boolean): void => {
    let key: string;
    if (itemId.length > 0) {
      key = JSON.stringify([turnId, itemId]);
    } else {
      if (anonymousKey.length === 0) {
        anonymousSequence += 1;
        anonymousKey = `anonymous:${anonymousSequence}`;
      }
      key = anonymousKey;
    }
    let message = byKey.get(key);
    if (message === undefined) {
      message = { key, text: '', completed: false };
      byKey.set(key, message);
      messages.push(message);
    }
    if (complete) {
      message.text = text;
      message.completed = true;
      anonymousKey = '';
    } else if (!message.completed) {
      message.text += text;
    }
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const method = event.payload['method'];
    const params = event.payload['params'] as Record<string, Object> | undefined;
    if (params !== undefined && params !== null) {
      const turnId = typeof params['turnId'] === 'string' ? params['turnId'] as string : '';
      if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string') {
        update(turnId, typeof params['itemId'] === 'string' ? params['itemId'] as string : '',
          params['delta'] as string, false);
      } else if (method === 'item/completed') {
        const item = params['item'] as Record<string, Object> | undefined;
        if (item && item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
          update(turnId, typeof item['id'] === 'string' ? item['id'] as string : '', item['text'] as string, true);
        }
      } else if (method === 'turn/completed') {
        const turn = params['turn'] as Record<string, Object> | undefined;
        const items = turn?.['items'] as Object[] | undefined;
        if (Array.isArray(items)) {
          const id = typeof turn?.['id'] === 'string' ? turn['id'] as string : turnId;
          items.forEach((raw: Object) => {
            const item = raw as Record<string, Object>;
            if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
              update(id, typeof item['id'] === 'string' ? item['id'] as string : '', item['text'] as string, true);
            }
          });
        }
      }
    }
    if (event.type === 'codex.exec.event' && event.payload['type'] === 'item.completed') {
      const item = event.payload['item'] as Record<string, Object> | undefined;
      if (item && (item['type'] === 'agent_message' || item['type'] === 'agentMessage')
        && typeof item['text'] === 'string') {
        update('', typeof item['id'] === 'string' ? item['id'] as string : '', item['text'] as string, true);
      }
    }
  }
  return messages.length > 0 ? messages[messages.length - 1].text.trim() : '';
}
