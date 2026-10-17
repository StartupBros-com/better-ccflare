---
title: Config preservation also requires a persisted OAuth recovery key
date: 2026-10-17
category: integration-issues
module: config-and-oauth-recovery
problem_type: integration_issue
component: authentication
symptoms:
  - "A rejected intermediate fix preserved malformed config bytes but still returned a newly generated memory-only local-control secret"
  - "A failed secret write could leave an unsaved key accepted by the next cached-secret read"
root_cause: incorrect_assumption
resolution_type: code_fix
severity: high
tags: [config-preservation, local-control-secret, oauth, recovery, encryption, persistence]
---

# Config preservation also requires a persisted OAuth recovery key

## Problem

Making configuration updates memory-only after a failed initial load protects the original file, but is not sufficient for values that protect persistent data. The local-control secret looks like a credential for CLI-to-server notifications; it also supplies the encryption key for OAuth rotation recovery records. Losing that key across restart can make the records unreadable even though the config-preservation tests pass.

This dependency matters to maintainers changing config recovery or secret creation. The lesson is the hidden consumer and the rejected fallback, not a new configuration-writing mechanism.

## Symptoms

During [PR #530](https://github.com/StartupBros-com/better-ccflare/pull/530), an intermediate implementation suppressed writes after an invalid initial config load but still allowed a generated secret to be returned. Regression checks also exposed a generated key being returned after a real filesystem write failure. These were pre-merge findings, not an observed production loss of OAuth records.

## What Didn't Work

**Treating a process-local key as harmless degraded operation.** A warning and intact config bytes addressed file preservation, but did not establish that a later process could decrypt records created with that key. Ordinary in-memory settings and a recovery encryption key have different persistence requirements.

**Assuming a setter completed because it returned.** Ordinary setters log save failures and retain in-memory values. Reusing that behavior for new key generation could return an unsaved key; caching it could then bypass persistence checks on retry.

## Solution

Trace the value beyond its authentication-oriented name. In `apps/server/src/server.ts:1501`, the result of `getLocalControlSecret()` feeds the recovery store:

```ts
const localControlSecret = config.getLocalControlSecret();
// Later in the same startup path:
configurePendingRotationPersistence(
    createPendingRotationWal({
        directory: join(dirname(resolveConfigPath()), "pending-rotations"),
        secret: localControlSecret,
    }),
);
```

The store derives its AES-GCM key from that secret in `packages/proxy/src/handlers/pending-rotation-wal.ts:53`. Its save/load paths use the derived key to encrypt and decrypt persistent rotation records. The adjacent internal-probe secret in `apps/server/src/server.ts:1490` is intentionally regenerated on each start; it is not an interchangeable source for this store.

The merged fix makes the new-key path consume a save acknowledgement in `packages/config/src/index.ts:1730`:

```ts
const secret = randomUUID();
this.data.local_control_secret = secret;
if (!this.saveConfig()) {
    this.data.local_control_secret = existing;
    throw new Error("Failed to persist local-control secret.");
}
```

After a failed initial load, a secret actually read from a repaired on-disk config may be adopted, but an injected or generated memory-only value cannot satisfy the secret getter. Adoption does not re-enable saving the incomplete config snapshot. Healthy-instance cached-secret behavior is retained.

## Why This Works

The fix separates two invariants: **do not overwrite a config snapshot that could not be loaded**, and **do not hand a persistent-data consumer a newly generated key whose save failed or was suppressed**. Failing before recovery-store construction is safer than accepting encrypted writes that a subsequent process cannot recover.

The save acknowledgement means the existing synchronous write returned successfully. It is not an added guarantee of atomic config replacement, fsync/power-loss durability, or safe arbitrary key rotation. The recovery store's own atomic file replacement cannot compensate for losing the separate secret used to derive its key.

## Prevention

Before weakening persistence behavior in a shared helper, trace consumers of its returned values—not just setters and change events. In particular, distinguish disposable process-local credentials from keys needed after restart.

Keep the paired checks in `packages/config/src/config-load-preservation.test.ts:141`: invalid bytes remain untouched **and** an unpersisted secret is rejected. The same suite covers memory-only secret injection, adoption without lifting suppression, and failed-save retries that must not accept a cached unsaved key. Those are isolated real-file regressions, not evidence of a live production recovery incident.

Retire or rewrite this dependency-specific guidance if OAuth recovery stops deriving its key from the local-control secret. Until then, preserving the file alone is incomplete acceptance evidence for changes to that secret's persistence.

## Related Issues

- [PR #530: merged config-preservation fix](https://github.com/StartupBros-com/better-ccflare/pull/530).
- [Issue #529: specification and functional-confirmation tracking](https://github.com/StartupBros-com/better-ccflare/issues/529).
