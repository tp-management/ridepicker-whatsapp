import test from "node:test";
import assert from "node:assert/strict";
import { createContactNameIndex, reconcileExistingChatNames }
  from "../src/whatsapp/contactNames.js";

const pn = "37060000000@s.whatsapp.net";
const lid = "1234500000@lid";
const group = "1234@g.us";

test("saved phone contact name beats pushName and resolves its LID alias", () => {
  const index = createContactNameIndex();
  index.message({ remoteJid: lid, fromMe: false }, "Jonas");
  assert.equal(index.lookup(lid).name, "Jonas");
  index.contact({ id: pn, lid, name: "Andrius (Mamos Brolis)", notify: "Andrius" });
  assert.deepEqual(index.lookup(lid), { name: "Andrius (Mamos Brolis)", priority: 3 });
  assert.equal(index.lookup(pn).name, "Andrius (Mamos Brolis)");
  index.message({ remoteJid: lid, fromMe: false }, "New Push Name");
  assert.equal(index.lookup(lid).name, "Andrius (Mamos Brolis)");
});

test("separate contacts and updates merge when mapping arrives later", () => {
  const index = createContactNameIndex();
  index.contact({ id: pn, name: "Saved Person" });
  assert.equal(index.lookup(lid), null);
  assert.equal(index.mapping({ lid, pn }), true);
  assert.equal(index.lookup(lid).name, "Saved Person");
  index.contact({ id: lid, notify: "Other Push Name" });
  assert.equal(index.lookup(lid).name, "Saved Person");
  index.contact({ id: lid, name: "Renamed Saved Person" });
  assert.equal(index.lookup(pn).name, "Renamed Saved Person");
});

test("message remoteJidAlt can associate PN to LID without guesswork", () => {
  const index = createContactNameIndex();
  index.contact({ id: pn, name: "Known Contact" });
  index.message({ remoteJid: lid, remoteJidAlt: pn, fromMe: true }, null);
  assert.equal(index.lookup(lid).name, "Known Contact");
});

test("group participant names never become group chat names", () => {
  const index = createContactNameIndex();
  index.message({ remoteJid: group, participant: lid,
    participantAlt: pn, fromMe: false }, "Participant");
  assert.equal(index.lookup(group), null);
});

test("updates only existing named/missing private chat rows; no new chat records", async () => {
  const index = createContactNameIndex();
  index.contact({ id: lid, name: "Saved Name" });
  index.contact({ id: "other@lid", notify: "Profile Name" });
  const writes = [];
  const result = await reconcileExistingChatNames(index, {
    listChats: async () => [
      { chat_id: lid, name: "Old Push Name" },
      { chat_id: "other@lid", name: null },
      { chat_id: group, name: null },
      { chat_id: "unknown@lid", name: null },
    ],
    updateName: async (chatId, name) => writes.push({ chatId, name }),
  });
  assert.equal(result.updated, 2);
  assert.deepEqual(writes, [
    { chatId: lid, name: "Saved Name" },
    { chatId: "other@lid", name: "Profile Name" },
  ]);
});

test("never overwrites a preexisting name with a pushName", async () => {
  const index = createContactNameIndex();
  index.contact({ id: lid, notify: "Push Name" });
  let writes = 0;
  const result = await reconcileExistingChatNames(index, {
    listChats: async () => [{ chat_id: lid, name: "Saved Previously" }],
    updateName: async () => { writes += 1; },
  });
  assert.equal(result.updated, 0);
  assert.equal(writes, 0);
});

test("rejects invalid identifiers and contact names", () => {
  const index = createContactNameIndex();
  assert.equal(index.contact({ id: group, name: "Group" }), false);
  assert.equal(index.contact({ id: "123@lid", name: "  " }), false);
  assert.equal(index.lookup(group), null);
});
