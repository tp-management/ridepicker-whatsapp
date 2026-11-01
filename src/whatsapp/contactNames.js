// Contact *names*, not chat history. Nothing from this module is persisted
// except names on existing RidePicker whatsapp_chats rows.
const jid = (id) => {
  if (typeof id !== "string") return null;
  const value = id.trim().replace(/@c\\.us$/, "@s.whatsapp.net");
  return /^[^@\\s]+@(lid|s\\.whatsapp\\.net)$/.test(value) ? value : null;
};
const display = (value) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 250) : null;

export function createContactNameIndex() {
  const names = new Map();
  const aliases = new Map();
  const lookup = (id) => names.get(jid(id)) || null;
  const related = (id) => {
    const key = jid(id);
    return key ? (aliases.get(key) || new Set([key])) : new Set();
  };

  // A new LID <-> phone mapping may unlock a name already seen under
  // the other identifier. Never attempt to infer this from numeric digits.
  function link(a, b) {
    const first = jid(a), second = jid(b);
    if (!first || !second || first === second) return false;
    const group = new Set([...related(first), ...related(second)]);
    const best = [...group].map((id) => names.get(id))
      .filter(Boolean)
      .sort((x, y) => y.priority - x.priority)[0] || null;
    let changed = !aliases.get(first)?.has(second);
    for (const id of group) {
      aliases.set(id, group);
      if (best && (!names.has(id) || names.get(id).priority < best.priority)) {
        names.set(id, best);
        changed = true;
      }
    }
    return changed;
  }

  function remember(id, name, priority) {
    const key = jid(id), value = display(name);
    if (!key || !value) return false;
    let changed = false;
    for (const alias of related(key)) {
      const old = names.get(alias);
      if (!old || priority > old.priority ||
        (priority === old.priority && old.name !== value)) {
        names.set(alias, { name: value, priority });
        changed = true;
      }
    }
    return changed;
  }

  function contact(contact) {
    if (!contact || typeof contact !== "object") return false;
    const ids = [contact.id, contact.phoneNumber, contact.lid]
      .map(jid).filter(Boolean);
    if (!ids.length) return false;
    let changed = false;
    for (let i = 1; i < ids.length; i += 1) {
      changed = link(ids[0], ids[i]) || changed;
    }
    const candidate =
      display(contact.name) ? { name: contact.name, priority: 3 } :
      display(contact.verifiedName) ? { name: contact.verifiedName, priority: 2 } :
      display(contact.notify) ? { name: contact.notify, priority: 1 } : null;
    if (candidate) {
      changed = remember(ids[0], candidate.name, candidate.priority) || changed;
    }
    return changed;
  }

  function mapping(data) {
    if (!data) return false;
    return link(data.lid, data.pn);
  }

  function message(key, pushName) {
    const id = key?.remoteJid;
    if (typeof id !== "string") return false;
    if (id.endsWith("@g.us")) {
      // For groups these identify a participant, NOT the group name.
      return link(key.participant, key.participantAlt);
    }
    let changed = link(id, key?.remoteJidAlt);
    if (!key.fromMe) changed = remember(id, pushName, 1) || changed;
    return changed;
  }

  return { lookup, contact, mapping, message };
}

export async function reconcileExistingChatNames(index, {
  listChats, updateName, isCurrent = () => true,
}) {
  if (!isCurrent()) return { updated: 0, matches: 0 };
  const rows = await listChats();
  let updated = 0, matches = 0;
  for (const chat of rows || []) {
    if (!isCurrent()) break;
    // No group titles are modified by a contact event.
    if (typeof chat.chat_id !== "string" || chat.chat_id.endsWith("@g.us")) continue;
    const match = index.lookup(chat.chat_id);
    if (!match) continue;
    matches += 1;
    const currentName = display(chat.name);
    // A pushName is a lower-confidence fallback. Never overwrite a
    // previously saved title unless WhatsApp supplied an address-book name.
    if (currentName && (currentName === match.name || match.priority < 3)) continue;
    await updateName(chat.chat_id, match.name);
    updated += 1;
  }
  return { updated, matches };
}
