# WhatsApp/Baileys refactor migration plan

## Baseline constraints

This refactor is behavior-preserving. It must not change the WhatsApp pairing protocol, pairing retry semantics, logout semantics, auth model, or user-facing ownership/authentication model.

Before this refactor branch, Baileys log-text privacy was fixed separately in commit `4756f7cac3fae2b331199f982b708a77493bf3e8` and covered by the existing logger privacy regression tests. That fix redacts WhatsApp JID/LID and phone-like identifiers from persisted top-level log messages and `error.message`.

The pairing finite-state-machine boundary ends at `REGISTERED/COMPLETED`. `CONNECTED`, `connection=open`, `connection=close`, 515/restartRequired, reconnect, and logged-out lifecycle belong to the connection lifecycle layer, not the pairing state machine.

## Current runtime mutation boundary

Production currently depends on this exact startup patch order:

1. `applyWhatsappPairingHardening`
2. `applyWhatsappPairingHelloAck`
3. `applyWhatsappPairingUx`
4. `applyWhatsappPairingFeedback`
5. `applyBaileysRawUiErrors`
6. `applyWhatsappRemoteLogout`
7. `applyBaileysRawLogging`

Each patch performs exact-string replacement against `src/whatsapp.js`. The order is therefore part of current behavior. Refactoring the canonical source while these patchers still run is unsafe because a harmless source edit can make `replaceExactlyOnce()` fail at startup.

## Safe migration strategy

No module extraction begins while runtime source patching is still an active boundary.

### Phase A: characterize the current patched runtime

Add tests that materialize the patch chain into an isolated temporary copy of `src/whatsapp.js` using the exact production order. The test must fail if any patch target stops matching or if the order in `index.js` diverges from the characterized order.

Use a fake Baileys transport and repository boundary to characterize these existing invariants without a real WhatsApp connection:

- early 408 increments `failureCount` and uses bounded retry;
- sufficiently old published code + 408 takes the natural-expiry path;
- 429 / `rate-overlimit` stops automatic retry and sets cooldown;
- concurrent pairing triggers result in exactly one pairing request;
- registration followed by 515 enters the lifecycle restart/reconnect path;
- logout calls Baileys-native `socket.logout()`;
- repeated reconnect triggers do not create duplicate active sessions;
- logger threshold/redaction behavior stays covered by logger tests.

### Phase B: canonicalize the final patched source

After Phase A is green, generate the FINAL patched source from the characterized patch chain in a temporary worktree. Do not hand-edit protocol behavior during this step.

In one dedicated canonicalization commit:

1. replace `src/whatsapp.js` with the exact materialized FINAL patched output;
2. remove all `apply*()` calls and patch imports from `index.js`;
3. keep the old `apply*.js` files temporarily in the repository, but unused, so the canonicalization diff can be reviewed independently from file deletion;
4. run the full characterization suite and syntax checks again;
5. verify the generated materialized output and canonical source are behavior-equivalent under the same tests.

This commit removes the runtime mutation boundary before structural extraction starts. After it lands, later source edits cannot break production merely because a textual patch target moved.

### Phase C: incremental extraction

Only after canonicalization is green, extract one responsibility at a time: logging, auth/filesystem helpers, socket factory, pairing state/retry, connection lifecycle, message handling, then public facade cleanup.

Unused `apply*.js` files are deleted in small cleanup commits after their behavior is proven to exist in canonical modules. No patch deletion is mixed with protocol changes.

## Security blocker

`requireUser()` currently proves only that the requested user row exists. It does not authenticate the caller or enforce ownership. This refactor must not hide that with a frontend API key workaround. A real Supabase Auth/JWT ownership check remains a separate security task.
