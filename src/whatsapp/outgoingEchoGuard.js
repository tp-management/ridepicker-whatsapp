// Prevent replies sent through RidePicker's /send endpoint from being
// re-queued to n8n when N8N_FORWARD_FROM_ME=true.
//
// Baileys may emit the outgoing echo either before sendMessage resolves or
// afterwards. Track the in-flight chat during send and then the returned WA ID.
// This cache is scoped to one runtime, bounded, and expires automatically.
const DEFAULT_ECHO_TTL_MS = 60 * 60 * 1000;
const MAX_TRACKED_ECHOES = 4_096;

export function createOutgoingEchoGuard({
  now = Date.now,
  ttlMs = DEFAULT_ECHO_TTL_MS,
} = {}) {
  const activeChats = new Map();
  const sentIds = new Map();

  function chatKey(sessionId, chatId) {
    return JSON.stringify([sessionId, chatId]);
  }

  function messageKey(sessionId, whatsappMessageId) {
    return JSON.stringify([sessionId, whatsappMessageId]);
  }

  function prune() {
    const timestamp = now();
    for (const [key, expiresAt] of sentIds) {
      if (expiresAt <= timestamp) sentIds.delete(key);
    }
    while (sentIds.size > MAX_TRACKED_ECHOES) {
      sentIds.delete(sentIds.keys().next().value);
    }
  }

  function beginSend(sessionId, chatId) {
    const key = chatKey(sessionId, chatId);
    activeChats.set(key, (activeChats.get(key) || 0) + 1);
    let finished = false;
    return (whatsappMessageId = null) => {
      if (finished) return;
      finished = true;

      if (whatsappMessageId) {
        prune();
        sentIds.set(messageKey(sessionId, whatsappMessageId), now() + ttlMs);
        prune();
      }

      const remaining = (activeChats.get(key) || 1) - 1;
      if (remaining > 0) activeChats.set(key, remaining);
      else activeChats.delete(key);
    };
  }

  function shouldSuppress(sessionId, chatId, whatsappMessageId) {
    prune();
    if (whatsappMessageId && sentIds.has(messageKey(sessionId, whatsappMessageId))) {
      return true;
    }
    return (activeChats.get(chatKey(sessionId, chatId)) || 0) > 0;
  }

  return { beginSend, shouldSuppress };
}
