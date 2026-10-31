// On-demand WhatsApp history is transient: no rows, files, or durable message
// cache are created. The caller receives only text and useful metadata.
const historyRequests = new WeakSet();

export function historyMessageToApi(message) {
  const key = message?.key || {};
  let content = message?.message || null;
  for (let i = 0; i < 5; i += 1) {
    const nested = content?.ephemeralMessage?.message
      || content?.viewOnceMessage?.message
      || content?.viewOnceMessageV2?.message
      || content?.documentWithCaptionMessage?.message;
    if (!nested) break;
    content = nested;
  }
  const rawTime = message?.messageTimestamp;
  const seconds = Number(rawTime?.toNumber?.() ?? rawTime);
  const timestampMs = Number.isFinite(seconds) && seconds > 0
    ? (seconds > 1e12 ? seconds : seconds * 1000) : null;
  const text = content?.conversation
    || content?.extendedTextMessage?.text
    || content?.imageMessage?.caption
    || content?.videoMessage?.caption
    || content?.documentMessage?.caption
    || "";
  return {
    id: key.id || null,
    chatId: key.remoteJid || null,
    fromMe: Boolean(key.fromMe),
    participant: key.participant || null,
    timestamp: timestampMs ? new Date(timestampMs).toISOString() : null,
    timestampMs,
    text,
  };
}

export async function requestOnDemandHistory(socket, {
  chatId, oldestKey, oldestTimestampMs, count = 50, timeoutMs = 15000,
}) {
  if (historyRequests.has(socket)) {
    throw Object.assign(new Error("Another history request is already running for this session"), { status: 409 });
  }
  historyRequests.add(socket);
  try {
    return await new Promise((resolve, reject) => {
      let requestId = null;
      let finished = false;
      let buffered = [];
      const stop = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.ev.off("messaging-history.set", onHistory);
        if (error) reject(error);
        else resolve(value);
      };
      const onHistory = (event) => {
        const id = event?.peerDataRequestSessionId;
        if (!id || !Array.isArray(event.messages)) return;
        if (requestId === null) {
          if (buffered.length < 4) buffered.push(event);
          return;
        }
        if (id !== requestId) return;
        const received = event.messages
          .filter((m) => m?.key?.remoteJid === chatId)
          .map(historyMessageToApi)
          .filter((m) => m.id)
          .sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
        const oldest = received[0] || null;
        stop(null, {
          status: "received",
          messages: received,
          nextBefore: oldest && oldest.timestampMs ? {
            id: oldest.id,
            timestampMs: oldest.timestampMs,
            fromMe: oldest.fromMe,
            participant: oldest.participant,
          } : null,
          // WhatsApp does not attest to a complete conversation archive.
          complete: false,
        });
      };
      const timer = setTimeout(() => stop(
        Object.assign(new Error("WhatsApp did not return an on-demand history event"), { status: 504 }),
      ), timeoutMs);
      socket.ev.on("messaging-history.set", onHistory);
      Promise.resolve()
        .then(() => socket.fetchMessageHistory(count, oldestKey, oldestTimestampMs))
        .then((id) => {
          if (finished) return;
          if (typeof id !== "string" || !id) {
            stop(Object.assign(new Error("WhatsApp did not acknowledge the history request"), { status: 502 }));
            return;
          }
          requestId = id;
          for (const event of buffered) {
            onHistory(event);
            if (finished) break;
          }
          buffered = [];
        })
        .catch((error) => stop(error));
    });
  } finally {
    historyRequests.delete(socket);
  }
}
