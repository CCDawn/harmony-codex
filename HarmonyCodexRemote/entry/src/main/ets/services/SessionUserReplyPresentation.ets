export interface SessionUserReply {
  questionItemId: string;
  question: string;
  answer: string;
}

/**
 * Recognize only complete, known question-reply envelopes. An empty result
 * means the caller must retain the original message presentation in full.
 * Values are display data; their contents never change parsing or app behavior.
 */
export function parseSessionUserReplies(text: string): SessionUserReply[] {
  const opening = '<send_user_message_question_reply>';
  const closing = '</send_user_message_question_reply>';
  const envelope = text.trim();
  if (!envelope.startsWith(opening) || !envelope.endsWith(closing)) {
    return [];
  }

  let parsed: Object;
  try {
    parsed = JSON.parse(envelope.slice(opening.length, envelope.length - closing.length)) as Object;
  } catch (_) {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [];
  }

  const replies: SessionUserReply[] = [];
  const entries = parsed as Object[];
  for (let index = 0; index < entries.length; index += 1) {
    const raw = entries[index];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return [];
    }
    const entry = raw as Record<string, Object>;
    const keys = Object.keys(entry);
    if (keys.length !== 3 || keys.indexOf('questionItemId') < 0
      || keys.indexOf('question') < 0 || keys.indexOf('answer') < 0) {
      return [];
    }
    if (typeof entry['questionItemId'] !== 'string' || typeof entry['question'] !== 'string'
      || typeof entry['answer'] !== 'string') {
      return [];
    }
    const questionItemId = entry['questionItemId'] as string;
    const question = entry['question'] as string;
    const answer = entry['answer'] as string;
    // Do not silently hide unanswered items or discard their context.
    if (questionItemId.trim().length === 0 || question.trim().length === 0 || answer.trim().length === 0) {
      return [];
    }
    replies.push({ questionItemId, question, answer });
  }
  return replies;
}
