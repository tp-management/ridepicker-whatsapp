// Deliberately narrow, temporary self-chat test gate.
// A WhatsApp message YOU send to YOURSELF with "#rp-test" is queued like an
// incoming offer. All other fromMe messages remain context-only, never AI work.
// Matching a stored PN/LID identity avoids sending ordinary outbound messages.
const SELF_TEST_MARKER = /^\s*#rp-test(?=\s|:|$)([\s\S]*)$/i;

function normalizeSelfJid(value) {
  const match = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/i.exec(
    String(value || "").trim()
  );
  if (!match) return null;
  return `${match[1]}@${match[2].toLowerCase()}`;
}

export function isMarkedSelfChatTestMessage({
  messageKey,
  body,
  socketUser,
  authMe,
  linkedPhone,
} = {}) {
  if (!messageKey?.fromMe) return false;

  const markerMatch = SELF_TEST_MARKER.exec(String(body || ""));
  if (!markerMatch || !markerMatch[1].replace(/^\s*:\s*/, "").trim()) {
    return false;
  }

  // Compare ONLY the target chat JID with verified identities belonging to
  // the connected account. Never infer identity from pushName or a sender.
  const chatJid = normalizeSelfJid(messageKey.remoteJid);
  if (!chatJid) return false;

  const phoneDigits = String(linkedPhone || "").replace(/\D/g, "");
  const ownJids = [
    socketUser?.id,
    socketUser?.lid,
    authMe?.id,
    authMe?.lid,
    phoneDigits ? `${phoneDigits}@s.whatsapp.net` : null,
  ];

  return ownJids.some((jid) => normalizeSelfJid(jid) === chatJid);
}
