import test from "node:test";
import assert from "node:assert/strict";

import {
  createUserApiRepository,
  messageActivityToApi,
  messageToApi,
  preferencesToApi,
} from "../src/userApiRepository.js";

const session = { id: "session-1", user_id: "user-1", status: "CONNECTED" };

function makeAdapter({ select, update, remove, core = {} } = {}) {
  const coreRepository = {
    async getWhatsappSessionByUser() {
      return session;
    },
    async getDriverPreferences() {
      return null;
    },
    async getJob() {
      return null;
    },
    async getSubscription() {
      return null;
    },
    async addActivity() {
      return null;
    },
    async createJob() {
      return null;
    },
    ...core,
  };

  return createUserApiRepository({
    coreRepository,
    select: select || (async () => []),
    update: update || (async () => []),
    remove: remove || (async () => []),
  });
}

test("message mapper exposes the user-facing message contract", () => {
  const mapped = messageToApi({
    id: 7,
    whatsapp_message_id: "wamid-7",
    chat_id: "chat@lid",
    chat_name: "Airport jobs",
    sender_id: "sender@lid",
    sender_name: "Driver",
    body: "LHR to Mayfair £90",
    is_group: true,
    from_me: false,
    message_type: "text",
    has_media: false,
    media: null,
    message_timestamp: "2026-08-23T01:00:00.000Z",
    processing_status: "new",
    forwarded_to_n8n_at: null,
    created_at: "2026-08-23T01:00:01.000Z",
  });

  assert.equal(mapped.id, "7");
  assert.equal(mapped.chatId, "chat@lid");
  assert.equal(mapped.senderName, "Driver");
  assert.equal(mapped.body, "LHR to Mayfair £90");
  assert.equal(mapped.processingStatus, "new");
});

test("message activity mapper turns persisted WhatsApp messages into Activity UI events", () => {
  const activity = messageActivityToApi({
    id: 9,
    whatsapp_message_id: "wamid-9",
    chat_id: "chat@lid",
    chat_name: "Jobs",
    sender_id: "sender@lid",
    sender_name: "Alex",
    body: "Need Heathrow pickup",
    is_group: false,
    from_me: false,
    message_type: "text",
    has_media: false,
    message_timestamp: "2026-08-23T02:00:00.000Z",
    processing_status: "parsed",
    created_at: "2026-08-23T02:00:00.100Z",
  });

  assert.equal(activity.type, "message");
  assert.equal(activity.title, "Message from Alex");
  assert.equal(activity.detail, "Need Heathrow pickup");
  assert.equal(activity.metadata.messageId, "9");
});

test("listMessages scopes every read to the user's WhatsApp session", async () => {
  let seenQuery = null;
  const adapter = makeAdapter({
    select: async (table, query) => {
      assert.equal(table, "messages");
      seenQuery = query;
      return [];
    },
  });

  await adapter.listMessages("user-1", {
    chatId: "chat@lid",
    limit: 25,
    before: "2026-08-23T03:00:00Z",
    fromMe: false,
    processingStatus: "new",
  });

  assert.equal(seenQuery.session_id, "eq.session-1");
  assert.equal(seenQuery.chat_id, "eq.chat@lid");
  assert.equal(seenQuery.limit, 25);
  assert.equal(seenQuery.from_me, "eq.false");
  assert.equal(seenQuery.processing_status, "eq.new");
  assert.match(seenQuery.message_timestamp, /^lt\./);
});

test("listMessages rejects ambiguous cursor direction", async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    adapter.listMessages("user-1", {
      before: "2026-08-23T03:00:00Z",
      after: "2026-08-23T01:00:00Z",
    }),
    (error) => error?.status === 400
  );
});

test("activity read merges database activity with persisted WhatsApp messages", async () => {
  const adapter = makeAdapter({
    select: async (table) => {
      if (table === "activity") {
        return [
          {
            id: 1,
            user_id: "user-1",
            job_id: null,
            type: "ridepicker",
            title: "RidePicker enabled",
            description: "Monitoring",
            metadata: {},
            created_at: "2026-08-23T01:00:00Z",
          },
        ];
      }
      if (table === "messages") {
        return [
          {
            id: 2,
            whatsapp_message_id: "wamid-2",
            chat_id: "chat@lid",
            chat_name: "Jobs",
            sender_id: "sender@lid",
            sender_name: "Sam",
            body: "New airport run",
            is_group: true,
            from_me: false,
            message_type: "text",
            has_media: false,
            message_timestamp: "2026-08-23T02:00:00Z",
            processing_status: "new",
            created_at: "2026-08-23T02:00:00Z",
          },
        ];
      }
      return [];
    },
  });

  const activity = await adapter.listActivity("user-1");
  assert.equal(activity.length, 2);
  assert.equal(activity[0].type, "message");
  assert.equal(activity[1].type, "ridepicker");
});

test("preferences mapper and updater use camelCase API without leaking DB naming", async () => {
  const raw = {
    user_id: "user-1",
    base_location: "London",
    default_vehicle: "Mercedes V-Class",
    minimum_job_price: "75.00",
    preferred_areas: ["Heathrow"],
    blocked_areas: [],
    working_hours: { mon: true },
    autopilot_rules: {},
    created_at: "2026-08-23T00:00:00Z",
    updated_at: "2026-08-23T00:00:00Z",
  };
  assert.equal(preferencesToApi(raw).minimumJobPrice, 75);

  let body = null;
  const adapter = makeAdapter({
    update: async (table, patch) => {
      assert.equal(table, "driver_preferences");
      body = patch;
      return [{ ...raw, ...patch }];
    },
  });

  const result = await adapter.updatePreferences("user-1", {
    baseLocation: "Manchester",
    minimumJobPrice: 90,
  });

  assert.deepEqual(body, {
    base_location: "Manchester",
    minimum_job_price: 90,
  });
  assert.equal(result.baseLocation, "Manchester");
  assert.equal(result.minimumJobPrice, 90);
});
