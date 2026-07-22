# Combos and Managed Family Routing

Combos route a model family through an ordered set of account/model candidates. A family can use hand-maintained **Manual** slots, server-derived **Managed** membership, or both. The server's effective-routing view is authoritative; the dashboard and CLI display that view instead of reimplementing routing decisions.

## Contents

1. [Families and concepts](#families-and-concepts)
2. [Manual and Managed membership](#manual-and-managed-membership)
3. [Routing precedence](#routing-precedence)
4. [Priority, balancing, and affinity](#priority-balancing-and-affinity)
5. [Capabilities and route classes](#capabilities-and-route-classes)
6. [Availability is not membership](#availability-is-not-membership)
7. [Managing combos and Manual slots](#managing-combos-and-manual-slots)
8. [Preview, apply, and rollback](#preview-apply-and-rollback)
9. [Excluding and restoring an account](#excluding-and-restoring-an-account)
10. [Dashboard and CLI workflows](#dashboard-and-cli-workflows)
11. [Management API](#management-api)
12. [Controlled rollout](#controlled-rollout)
13. [Upgrade and troubleshooting notes](#upgrade-and-troubleshooting-notes)

## Families and concepts

Exactly one combo can be assigned to each supported family:

| Family | Matches requests for |
| --- | --- |
| **Fable** | Fable-family models |
| **Opus** | Opus-family models |
| **Sonnet** | Sonnet-family models |
| **Haiku** | Haiku-family models |

A family route is active only when the family assignment, its assigned combo, and the relevant member or rule are enabled. If no active combo applies, the existing session-based router handles the request.

The main persisted objects are:

- **Combo**: a named route shared by one or more family assignments.
- **Manual slot**: an explicit account, logical model, and priority tier inside a combo.
- **Family policy**: the assigned combo, enabled state, `membership_mode`, and family-compatible `managed_model`.
- **Enrollment rule**: a Managed selector over provider plus route class.
- **Exclusion**: an account-specific opt-out from a Managed family route.
- **Effective member**: a server-resolved candidate admitted to the route, with source, model, tier, reason, and a separate availability state.

## Manual and Managed membership

### Manual mode

`membership_mode: "manual"` uses enabled persisted slots only. Each slot keeps its own account, logical model, and priority tier. This is the compatibility mode for existing installations and for routes that require an explicit provider-specific model override.

### Managed mode

`membership_mode: "managed"` keeps the Manual slots and adds virtual members derived from enabled enrollment rules. A rule matches an account by provider and route class, then the capability resolver confirms that the account supports the family's `managed_model`.

Managed membership is dynamic in the intended sense: a newly added compatible account automatically joins an enabled matching rule. It is not inferred from account name, current traffic, or availability.

The resolver reads current persisted accounts regardless of whether they were created by dashboard OAuth, API-key setup, CLI, import, or a future provider flow. It never copies a virtual member into `combo_slots`. For example, a fourth matching Anthropic OAuth/subscription account joins Managed Opus and Fable rules at its current account priority without a separate Combo edit.

Existing family assignments migrate as Manual. Upgrading therefore does not silently enroll accounts or change routing behavior.

## Routing precedence

The membership resolver applies these rules in order:

1. An enabled Manual slot is included with its persisted slot model and tier.
2. That Manual slot suppresses a virtual Managed duplicate for the same account in the same family. The decision reason is `manual_override`.
3. An account exclusion suppresses the matching Managed candidate. It does not remove an enabled Manual slot.
4. A disabled enrollment rule does not enroll accounts.
5. A matching enabled rule enrolls only accounts whose capability is explicitly supported.
6. Unsupported, unknown, ambiguous, or invalid candidates fail closed and remain outside the route.

A disabled Manual slot is not a Manual override. If a matching Managed rule is enabled, that account may still appear as a Managed member.

This precedence lets an operator preserve a precise per-account exception without giving up automatic enrollment for the rest of a provider/route class.

## Priority, balancing, and affinity

Lower numeric tiers are preferred.

- A **Manual member** uses its persisted slot priority.
- A **Managed member** uses the account's global priority as its effective tier.

Global account priority does **not** grant combo membership. It affects a Managed candidate only after a matching enabled rule, family capability, and exclusion checks have admitted the account. It also does not rewrite a Manual slot's persisted tier.

The router never lets same-tier balancing or affinity leapfrog a currently routable better numeric tier. Within the best routable tier, comparable quota pressure, utilization, and session/cache affinity can distribute work and preserve a warm upstream. Managed candidates use deterministic virtual identities, so their affinity identity is stable across policy reads and service restarts.

When a better tier becomes routable again, it can replace a sticky lower-tier owner. Temporary anti-thrash suppression prevents a repeatedly failing recovered candidate from continuously stealing the session.

## Capabilities and route classes

Managed rules select by both:

- **Provider**, such as an Anthropic or OpenAI-compatible integration.
- **Route class**, one of `oauth-subscription`, `api-key`, `local`, or `cloud-credential`.

The route class prevents accounts with materially different authentication and billing paths from being swept into one rule. Setup-time billing metadata, such as subscription/plan versus pay-as-you-go API use, helps the server identify safe proposals; the persisted rule selector remains provider plus route class.

Account names are presentation labels, never rule selectors.

Capability resolution is pure and network-free. An account is admitted only when its explicit mapping, provider default, or native passthrough declares support for the logical family model. `unsupported` and `unknown` results fail closed. A Manual slot remains the operator escape hatch for an intentional mapping the server cannot safely infer.

## Availability is not membership

Membership describes who belongs to a route. Availability describes who can serve a request right now.

Pausing, cooldown, rate limiting, model exhaustion, or a reauthentication requirement makes an effective member temporarily unavailable; it does not delete its slot, enrollment rule, or exclusion and does not churn Managed membership. The router skips the unavailable member and tries the next eligible candidate. After reauthentication or reset, the same member can serve again without re-enrollment.

If every effective combo candidate is unavailable or fails, the existing combo-to-session fallback path continues to handle the request as before.

Removing an account is different: deletion removes the account and cascades its account-specific exclusions.

## Managing combos and Manual slots

Create a named combo before assigning it to a family. A combo's enabled state and a family's enabled assignment are separate controls; both must be active for the family route to run.

Manual slots remain useful in both membership modes. Each slot stores:

- one account;
- one pinned model for that candidate path;
- a numeric priority tier from 0 through 100, where lower is preferred;
- an enabled state.

Slots can share a tier when they should participate in same-tier balancing. Disabling a slot preserves it for later use. Reordering or editing priorities changes Manual precedence only; it does not change any account's global priority.

Deleting a slot cannot delete the account. Deleting a combo removes its owned slots, so inspect every assigned family before doing so.

## Preview, apply, and rollback

Managed conversion is a server-owned two-step workflow.

### Preview

A preview is read-only. It returns:

- the current effective route;
- one or more server-generated proposals;
- the proposed provider and route class;
- the reviewed `managed_model`;
- confidence and selection guidance;
- the exact added, removed, changed, and unchanged member delta;
- stable reason codes for included and rejected candidates.

The dashboard selects only high-confidence proposals by default. Ambiguous or new-billing-class proposals require explicit operator review. A preview never edits policy, probes a provider, or sends inference.

### Apply

Apply requires the exact `preview_id`, `proposal_id`, family-compatible `managed_model`, and preview scope that the operator reviewed. Account-scoped apply also requires the same persisted account subject. A stale preview is rejected; request a fresh preview and review its new delta.

The server rejects an enabled Managed route with zero effective candidates. The previous family mode and policy remain unchanged. This fail-closed guard also applies to direct family-policy updates.

### Roll back to Manual

Rollback is a partial family-policy update:

```json
{
  "membership_mode": "manual"
}
```

Do not replace the whole assignment when rolling back. The partial update immediately stops virtual enrollment while retaining the combo assignment, Manual slots, enrollment rules, Managed model, and exclusions for inspection or a later retry.

## Excluding and restoring an account

An exclusion removes one account's virtual Managed candidate from one active family route. It does not pause the account globally, affect other families, or remove an enabled Manual slot.

Use an exclusion when a broadly correct provider/route-class rule has one account-specific exception. Restore the exclusion to let the same account rejoin automatically if the rule and capability still match.

Both operations return the updated authoritative effective route. Creating an exclusion for a disabled family route is rejected.

## Dashboard and CLI workflows

### Dashboard

The **Combos** page exposes all four family routes and separates Manual members from Managed members. Use it to:

1. assign and enable a combo for a family;
2. review effective source, logical model, tier, reason, and availability;
3. preview a Manual-to-Managed conversion and inspect its member delta;
4. apply one reviewed proposal;
5. add, edit, or disable Manual overrides;
6. exclude or restore an individual Managed account;
7. roll the family back to Manual without deleting policy state.

The **Accounts** page uses the server's coherent account-routing overview. A low global priority alone is never displayed as membership. Compatible outside-route accounts can show a server-approved routing opportunity that points back to the Combos workflow.

### CLI

The managed-routing CLI workflow uses the running server's same effective, family/account preview and apply, and rollback contracts. It does not open the local database or run a second resolver. Read-only listing and preview are safe reporting operations; mutation requires explicit reviewed identifiers and confirmation. Use the dashboard or management API for account exclusion and restore.

```bash
better-ccflare routing list [--api-url <loopback-url>] [--json]
better-ccflare routing detail <account-id> [--api-url <loopback-url>] [--json]
better-ccflare routing preview <family> [--managed-model <model>] [--api-url <loopback-url>] [--json]
better-ccflare routing apply <family> --preview-id <id> --proposal-id <id> --managed-model <model> --yes [--api-url <loopback-url>] [--json]
better-ccflare routing manual <family> --yes [--api-url <loopback-url>] [--json]
```

`<family>` is `fable`, `opus`, `sonnet`, or `haiku`. Interactive apply may omit the tuple and `--yes`: the CLI prints the full preview, requires explicit proposal selection, and asks for confirmation. Non-TTY and JSON mutations never auto-select; apply requires the complete displayed preview/proposal/model tuple plus `--yes`, and Manual rollback requires `--yes`.

`--api-url` accepts only a loopback HTTP(S) origin. The optional admin key is environment-only through `BETTER_CCFLARE_ADMIN_API_KEY`; there is no credential flag. `--add-account --json` is rejected before creation, while the five `routing` commands retain `--json`. Non-TTY text account creation prints the persisted immutable ID and follow-up detail/preview commands without requesting a routing preview or sending a routing write.

After interactive account creation, the CLI prints the initial persisted-account previews and requires an explicit proposal-or-skip choice. It then processes selected families sequentially. Before each write it requests and displays a fresh family preview, verifies the selected proposal is still present and materially unchanged, and asks for confirmation. This refresh is required because each policy write advances the global routing revision. Missing or changed proposals and unavailable API/review/apply steps fail closed. If an earlier family already succeeded, the CLI reports those results honestly as `partial`, names the stopped family/reason, and neither retries nor automatically rolls back the reviewed write.

See [CLI documentation](cli.md#managed-routing-live-server) for the full command and post-create contracts.

## Management API

All routes operate on the running server and return secret-free routing views. Effective responses omit tokens, custom endpoints, raw model mappings, and credential material. If server API authentication is configured, use an admin API key; API-only keys cannot mutate dashboard policy.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/families` | Read family assignments and modes |
| `PUT` | `/api/families/:family` | Partially update assignment, enabled state, mode, or Managed model |
| `GET` | `/api/routing/effective` | Read all authoritative effective family routes |
| `GET` | `/api/routing/effective/:family` | Read one authoritative effective route |
| `GET` | `/api/routing/accounts` | Read one coherent, name-free account-routing overview plus opportunities |
| `POST` | `/api/routing/preview` | Preview account- or family-scoped Managed changes |
| `POST` | `/api/routing/apply/:family` | Apply one exact reviewed proposal |
| `POST` | `/api/routing/exclusions/:family` | Exclude one account from Managed membership |
| `DELETE` | `/api/routing/exclusions/:family/:accountId` | Restore one Managed account |

Combo and Manual-slot management remains available through:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/combos` | List combos |
| `POST` | `/api/combos` | Create a combo |
| `GET` | `/api/combos/:id` | Read a combo and its slots |
| `PUT` | `/api/combos/:id` | Update combo metadata or enabled state |
| `DELETE` | `/api/combos/:id` | Delete a combo and its owned slots |
| `POST` | `/api/combos/:id/slots` | Add a Manual slot |
| `PUT` | `/api/combos/:id/slots/:slotId` | Update a Manual slot |
| `DELETE` | `/api/combos/:id/slots/:slotId` | Remove a Manual slot |
| `PUT` | `/api/combos/:id/slots/reorder` | Persist Manual-slot order |

### Family-scoped preview

```json
{
  "scope": "family",
  "family": "opus",
  "managed_model": "<an Opus-family logical model>"
}
```

Omit `managed_model` to let the server resolve the valid assignment model or current family default. A family-scoped preview and apply do not accept an account subject.

### Account-scoped preview

For an existing account:

```json
{
  "scope": "account",
  "account_id": "<persisted account id>",
  "family": "fable"
}
```

Account setup can instead preview one non-secret `draft` containing provider, priority, route class, billing type, and optional model mappings. The API requires exactly one of `account_id` or `draft` and never echoes draft credentials. A draft must be persisted before its proposal can be applied.

Omit `family` to receive previews for all families. `managed_model` is accepted only with an explicit family.

### Apply a reviewed proposal

```json
{
  "scope": "family",
  "preview_id": "<reviewed preview id>",
  "proposal_id": "<reviewed proposal id>",
  "managed_model": "<the reviewed family model>"
}
```

For account scope, include `subject` with the same persisted `account_id`. Never guess or auto-select identifiers from multiple proposals in unattended automation.

### Exclude an account

```json
{
  "account_id": "<persisted account id>"
}
```

Send that body to `POST /api/routing/exclusions/:family`. Restore it with the corresponding `DELETE` endpoint.

## Controlled rollout

Managed routing changes which accounts can receive real traffic. Roll it out as a one-family canary:

1. Deploy only a canonical `refs/heads/main` commit and verify the live embedded Git SHA.
2. Confirm `/accounts` and `/combos` load, storage and the async writer are healthy, and upgraded families are still Manual before deliberate conversion.
3. Preview one family and verify every intended account, provider, route class, logical model, and tier. In particular, verify intended Anthropic subscription accounts for Opus or Fable and reject unexpected billing classes.
4. Preserve explicit Manual Codex/xAI fallback slots while enabling Managed enrollment for the chosen family.
5. Apply only the reviewed high-confidence proposal for that family.
6. Keep the first family as a canary until at least 20 clean natural requests span more than one conversation and more than one eligible account, with no Managed-specific terminal regression.
7. Compare aggregate selected-source counts, account/tier distribution, fallback count, terminal-error count, latency, cache behavior, and capability/exclusion reasons before and after enablement. Keep prompts, custom endpoints, raw mappings, and credentials out of diagnostics.
8. Continue through at least one account priority/mapping refresh or operational availability transition to verify dynamic recomputation.
9. Never send scripted inference to Anthropic or Codex for validation.
10. If routing regresses, set only `membership_mode` back to `manual`, then inspect the retained rules and exclusions before trying again.

Enable the next family only after the first family meets that evidence threshold.

## Upgrade and troubleshooting notes

- SQLite and PostgreSQL migrations both default existing assignments to Manual.
- `manual_override` means an enabled Manual slot won over a matching virtual candidate; it is not an error.
- `excluded` means an explicit family exclusion suppressed Managed membership.
- `disabled` can refer to an inactive family/combo, disabled Manual slot, or disabled rule.
- `unsupported` and `unknown` are capability decisions and intentionally fail closed.
- `ambiguous` means the server cannot safely choose a model, tier, or unique rule.
- `new_billing_class` requires explicit review rather than automatic enrollment.
- An unavailable member remains visible with a separate reason such as paused, rate limited, requires reauthentication, or model exhausted.
- A Managed enable that reports `managed_route_empty` has made no mode change; correct the combo/rule/capability inputs and preview again.
- A stale preview must be regenerated rather than force-applied.

For general account priority and server operation commands, see [CLI documentation](cli.md).
