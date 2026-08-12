# Validate provider logic against live payloads, not hand-built fixtures

**Applies to:** anything reading `usageData` / `limits[]` — `usage-throttling.ts`,
`rate-limit-scope.ts`, `usage-fetcher.ts`, and their tests.
**Cost of ignoring it:** two production incidents on 2026-08-11, plus a five-reviewer code
review that passed a change with a real bug in it.

## The short version

Every hand-written Anthropic usage fixture in this repo modelled the payload incorrectly,
all in the same way, for a long time. Tests built on them passed while describing a shape
Anthropic does not send. Pull a real payload before trusting a fixture:

```bash
curl -s localhost:8789/api/accounts | python3 -m json.tool | less
```

Read-only, no upstream traffic, no scripted requests to Anthropic accounts (see AGENTS.md).

## The two things fixtures got wrong

### Only the BINDING limit carries `is_active: true`

Anthropic marks the limit that is actually constraining the account, and leaves the others
inactive **regardless of their percentages**. On the three accounts wrongly benched on
2026-08-11 the only active row was `weekly_scoped` Fable, while `session` and `weekly_all`
sat inactive holding 72-92% headroom.

Fixtures set all three rows `is_active: true`. That is not a shape the API produces, and it
hid the branch the incident actually took.

### Real payloads carry the flat windows AND `limits[]`

A live payload has `five_hour` and `seven_day` objects *alongside* the `limits[]` array.
`collectWindows` skips `is_active: false` rows and then **supplements** the account windows
from those flat fields. A fixture with only `limits[]` therefore silently loses all
account-wide context, and any function reading it sees a different world.

## Where this actually bit

- The classifier fix (#156) was validated against all five production accounts before
  merge. That run is what proved the two genuinely-exhausted accounts still bench
  account-wide while the three Fable-capped ones narrow — the exact split the fixtures
  could not express.
- A test written for `getBindingConstraint` (#159) failed on its first run because its
  fixture omitted the flat windows. The failure was the fixture, not the code.
- The `/ce-code-review` pass on #156 — five reviewers, zero surviving findings — did not
  catch the cold-start hole that took the pool down two hours later. Reviewers reason about
  the code; only real data shows which branch production actually takes.

## The pattern that works

Write the unit tests, then run the real thing through the same function before merging:

```ts
// scratch, not committed
const accounts = JSON.parse(await Bun.file("/tmp/accounts.json").text());
for (const a of accounts) {
  if (a.provider !== "anthropic") continue;
  console.log(a.name, classifyPreByte429({ /* ... */ snapshot: { observedAt: Date.now(), data: a.usageData } }));
}
```

Print one line per account and eyeball whether the verdicts match what you believe about
each account. Both times this was done it found something; both times it took a few minutes.

## Related

The batch-vs-solo test artifact is a different trap worth knowing: `packages/proxy` reports
7 failures in a full run that pass 7/7 when the file runs alone
(`request-handler-client-abort.test.ts`, a bun `mock.module` isolation artifact). Always
baseline-compare a failure count against the unmodified base before believing your change
caused it:

```bash
git stash push -u -m baseline && bun test packages/proxy | tail -4 && git stash pop
```

See [rate-limit-scope-and-duration.md](./rate-limit-scope-and-duration.md) for the code
these lessons came from.
