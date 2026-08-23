# WhatsApp/Baileys refactor status

## Non-negotiable invariants

This refactor preserves WhatsApp pairing protocol behavior, bounded retry semantics, native logout behavior, message-processing behavior, and the pairing/lifecycle boundary. Pairing completes at `REGISTERED/COMPLETED`; connection open/close, 515 restart, reconnect, and logout belong to lifecycle handling.

Baileys log privacy remains protected by regression tests: raw args are not persisted, trace is dropped at the configured threshold, and JID/LID/phone-like identifiers are redacted from persisted message text and `error.message`.

## Canonical source migration completed

The historical runtime source-mutation mechanism has been fully retired. Its behavior was characterized first, the final materialized behavior was moved into canonical source, and `index.js` stopped mutating `src/whatsapp.js` at startup.

The temporary source-patch implementations, pre-canonical fixture, materializer, compatibility harness, and patch-boundary proof have now been deleted. Current behavior characterization runs directly against the current production source with fake Baileys/repository boundaries.

## Stateless persistence boundary

WhatsApp auth persistence is Supabase-only:

- Baileys credentials are stored through `src/whatsapp/auth/supabaseAuthStore.js`;
- Signal keys use the same Supabase store;
- auth payloads are encrypted before storage in `public.whatsapp_auth`;
- the encryption key lives in Supabase Vault;
- auth read/write/clear RPCs are service-role-only;
- no runtime auth directory, JSON credential file, local database, or Railway-volume state is used.

Legacy deployment variables such as `DATA_DIR` and `RESTORE_LEGACY_SESSIONS` are ignored by runtime and emit a warning. They cannot re-enable filesystem persistence because production source contains no filesystem persistence dependency. Operators should still remove these obsolete variables and any old Railway volume from infrastructure configuration.

`npm run audit:stateless` is the permanent regression gate for this boundary. It scans all production JavaScript under `index.js` and `src/`, rejects filesystem module dependencies and legacy auth/storage identifiers, verifies the Supabase-only auth interface, checks that obsolete source artifacts and the old `data/` convention are absent, and verifies that obsolete storage environment variables cannot block startup or reactivate local persistence.

## Current extraction path

With canonicalization and the storage migration complete, further modularization can continue incrementally: runtime/session registry, socket factory, pairing state/retry, connection lifecycle, message handling, then public facade cleanup. Each extraction remains behavior-preserving and must keep current-source characterization green.

User-facing authentication/ownership hardening remains a separate deployment concern from this WhatsApp architecture refactor.
