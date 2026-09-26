# Concepts

Words that mean something specific in this codebase. Definitions here are the shared
vocabulary that `docs/` and `AGENTS.md` can cite without redefining.

## Routing

### Route profile

A named routing choice, offered to the client as a pickable model, that sends a Claude Code
session tree to a chosen account or pool instead of ordinary routing. A pinned profile names
one account; a capability profile admits every account that can serve it (see Root-capable
pool). A profile names a logical model and may also assert the expected provider and physical
model.

Those assertions are checked when an account is selected, against the account's own configured
model mapping. They are not checked against a default the provider fills in later, when it
builds the upstream request. An account that relies on its provider's default model therefore
fails a physical-model assertion even when the model it would send is right, and a family that
turns automatic stops satisfying one. A pinned profile meant to follow a provider's newest model
should assert only the provider; a capability profile meant to follow it names a catalog role
instead of a physical model.

### Force route

A request's demand that one exact account serve it, carried by the account header or by a
pinned route profile. Selection fails closed: when that account is paused, rate-limited, out of
capacity, or cannot satisfy the profile's model assertions, the request is rejected rather than
routed to any other account, so a forced request never lands on a provider the caller did not
name. The rejection happens before any provider code runs, so it leaves no provider-side trace.

### Logical model

The model a request names in Claude's vocabulary, before any account or provider translates
it. Distinct from the physical model an upstream serves.

### Physical model

The model an upstream provider actually serves for a request, after the account's model
mapping or the provider's default has translated the logical model.

### Catalog role

The physical model an account's own provider catalog currently offers for a logical model
family, derived from how that catalog ranks its models rather than named in any configuration.

A catalog role moves whenever the provider re-ranks or replaces its models, with no
configuration change. A route profile that follows a catalog role admits an account only on
evidence from that account's own catalog, never another account's listing, and refuses an
account with no current evidence for the role rather than guessing a model.

### Automatic family

A logical model family on an account that no configuration fixes, so the account serves whatever
its own catalog role resolves to, or, without one, another account's catalog or a built-in
default. Its opposite is a
pinned family, fixed by an account mapping, a fallback list, a custom-endpoint or environment
mapping, or a provider-wide override.
*Avoid:* unmapped family

Turning a pinned family automatic changes what route-profile checks see even when the served
model stays the same (see Route profile).

### Upstream client identity

The client software version and origin metadata a provider adapter advertises to an
upstream service, distinct from account credentials and the version of any separately
installed command-line client.

Catalog discovery and inference can use different identity formats while sharing the
same version. A model advertised to one client identity is not proof that a request
from another identity will be accepted. The identity follows an installed client only
through an explicitly configured, verified version record, never by running or
inspecting that client; without one it stays at the adapter's built-in version.

### Root-capable pool

The accounts admitted by a capability profile because each can serve the profile's root
logical model through its expected provider and physical model, or through the model at the
profile's catalog role in that account's own catalog. Membership establishes the
preferred pool for descendants; it does not force every child family onto the root physical
model.

### Commit-bound routing

A route policy that may walk authorized fallbacks before provider work begins, then preserves
the selected lane once an irreversible dispatch or meaningful response makes replay unsafe.
Availability is flexible while candidates are hypothetical and strict after work may have
happened.

### Child route home

The first successful provider, account class, and physical-model lane selected for one child
conversation. Later turns prefer that home for cache and turn continuity; a genuine
availability failure may establish a new home without remapping the parent or siblings.

### Fallback rung

A semantically ordered tier of authorized routes in a capability descendant's candidate plan.
Ranking may reorder accounts within one rung but cannot move a lower-authority rung ahead of a
higher-authority rung or add a route that authorization did not admit.

### Agent attribution

The proxy's decision of which agent, if any, a request belongs to, recorded together with how
it was decided: a registered agent matched on the request's system prompt, an explicit agent-id
header, or, when neither matches, the request's own Claude Code session id. That session
fallback exists so per-conversation alerting can key on a conversation; it identifies a
session, not an agent, and is never agent evidence for containment.

### Attributed descendant

A request the Codex provider contains as a subagent: it loses its Agent and Task tool
declarations without entering orchestration election. A request earns this status only from a
real agent identity, meaning a registered agent matched on its prompt, an explicit agent-id
header, or Claude Code's own subagent markers. The proxy's session-id attribution fallback
identifies a session, not an agent, and never confers it.

### Orchestration election

The Codex provider's per-session claim of the single conversation allowed to keep its
orchestration tools. The first eligible request in a session becomes the root; a later request
keeps root when it continues as the same conversation the root already recognizes, or, as a new
conversation, when it shares the root's instructions and continues its lineage; any other later
request is admitted as non-root and loses those tools for that turn. A rejected claim never
renews the root, so the root lapses only when it goes idle past the session TTL, after which a
new claim can win. Attributed descendants and requests that offer no orchestration tools never
enter the election.

### Trusted internal helper

A Claude Code side request, such as WebSearch, whose authenticated caller and session lineage
validate through the same private authority as the parent request even when it carries no
subagent marker. Helper classification grants no capability by itself: the chosen provider
route must still hold an exact reviewed proof.

## Usage measurement

### Cache parity

A sustained cache-reuse verdict for qualified Codex follow-up traffic, requiring the
project's cache-read and hit-rate floors, physical-model checks, a contemporaneous Anthropic
comparison when sufficiently sampled, and non-regressing request outcomes.

A short-window recovery or absence of a degradation alert is not parity. First-observed
turns remain visible but do not determine the follow-up verdict; insufficient evidence is
not success.

### Logical-final usage

Usage attributed to a client request's final accounted result, rather than to every upstream
attempt made while serving it.

Retries and failovers can produce several physical attempts for one logical request, so
logical-final usage and physical-attempt usage are not interchangeable populations.

### Physical-attempt usage

Usage reported for one upstream dispatch, including attempts that a retry or failover may
hide from a logical request's final accounted result.

Comparing it with logical-final usage requires matching the populations and respecting each
source's token semantics: a cache-inclusive input total already includes cache reads, while
an additive input count must be combined with the separate cache-read and cache-write counts.

### Canonical usage window

One provider-reported capacity measurement, normalized into the single shape the rest of
the system consumes: which window it describes, how much of it is used as a percentage on
a 0–100 scale, when it resets if it ever does, and whether the provider flags it as active.

Providers disagree wildly about how to express this — some send fractions rather than
percentages, some nest windows inside an array, some name the same window differently, and
some report a balance with no reset at all. Normalization runs through a single shared
function, invoked at each of the several boundaries where a poll result enters the system,
so that adding a provider never means editing persistence, alerting, or display. There is
one implementation of the parsing rules even though there is more than one entry point.
Anything downstream that re-parses a native provider payload is a bug: it means two
components can disagree about the same number.

### Window key

The identifier naming *which* capacity window a measurement describes — a short rolling
window, a multi-day window, a multi-day window narrowed to a single model family, or a
resetless credit balance.

Keys are stable across providers, which is what lets history and alerts compare one
account against another. A key scoped to a model family is not interchangeable with the
account-wide key of the same duration: they can hold very different values at the same
instant, and treating one as the other is how an account gets withheld from lanes it could
still serve.

### Usage snapshot

One poll's worth of canonical usage windows for a single account, recorded as one row per
window against a shared timestamp.

Every successful poll is recorded, with no deduplication of unchanged values. This is
deliberate: both the trend prediction and the chart need a faithful, near-uniform series,
and collapsing flat stretches to a single row makes idle windows fall out of range queries
and biases the fit. Volume is bounded by retention pruning rather than by skipping writes.

### Binding limit

The one capacity window a provider marks as currently constraining an account, in those
provider shapes that express such a thing at all.

Only the shapes reporting an explicit array of limits carry this distinction. There, the
provider marks just the binding entry active and leaves the others inactive *regardless of
their percentages* — an inactive window sitting at high headroom is normal and expected,
not a data error. Every other provider shape marks all of its windows active by default,
so an active flag is load-bearing information in the first case and merely a default in
the second; read it accordingly. Inactive windows are worth recording for historical
completeness, but must not drive routing or alerting decisions.

### Point budget

A ceiling on how many measurement points a single fleet-wide history read may return.

When the budget is reached, whole series are dropped in rank order — never silently
thinned — and the response says what was omitted. A budgeted response must be presented as
a partial view, because rendering it as a complete one would tell an operator the fleet has
no data when in fact the read was truncated.

## Process supervision

### Memory recycle

A deliberate stop-and-restart of the supervised upstream, triggered because its own memory
footprint stayed above a configured ceiling for a sustained run of consecutive samples —
not because it crashed and not because an operator asked.

A recycle drains before it stops (see *Guard-first drain*) and deliberately does not consume
the ordinary child-failure circuit, so it never feeds restart backoff: a recycled process
returns immediately, while a crash-looping one is held off. Recycles are bounded per rolling
window. Exhausting that budget is recorded and then leaves the process uncontained rather
than restarting forever, which makes budget exhaustion an incident signal rather than routine
noise. The counter lives in the supervisor process itself, so a supervisor restart resets the
window — a subtlety worth remembering before reading a low recycle count as evidence of a
quiet day.

### Guard-first drain

The shutdown ordering a memory recycle follows: the admission guard sitting in front of the
upstream is stopped first so it admits no new work, and the upstream is stopped only once
in-flight requests have settled.

The reverse order would destroy work the guard could have let finish. A drain that completes
on its own is recorded distinctly from one that hit its deadline and was forced, and the two
are never collapsed into one outcome, because a forced drain means clients saw errors while a
natural one means they did not.

### Managed pin

The deploy-owned block of service configuration binding a running deployment to one exact
build, guard, runner, and policy set, written and replaced only by the deploy tool.

Operator policy belongs in a separate, later-loading fragment; anything an operator writes
inside the managed block is overwritten by the next deploy without warning. The pin is what
makes a deployment verifiable after the fact — the running service is checked against the
exact artifacts the pin names rather than inferred from a filename. A pin can drift from what
the current source expects, and not every verification path inspects every value it carries,
so confirming a specific policy value means reading the pin rather than trusting a green
pre-flight check.

Merging does not move the pin. Deployment is a separate, deliberate act, so the pinned build
routinely lags the default branch — which makes the pin, not the branch, the correct answer to
"what produced this behavior." Any measurement taken against the running system is scoped to
the pinned build and can already be stale with respect to fixes that have merged but not
shipped.

## Flagged ambiguities

- *Active* on a usage window means "currently binding" only in the shapes that report an
  explicit array of limits; in every other shape it is just the default and carries no
  information. A fixture for the limits-array shape that marks every entry active
  describes a payload that shape does not send — a real trap, because that is precisely
  the shape whose active flag is supposed to mean something.
- *Pinned* describes both a route profile that names one account and an account family whose
  model is fixed by configuration. These are distinct: a pinned profile can route to an
  automatic family.
- *Utilization* is always a 0–100 percentage once past normalization, never a 0–1 fraction,
  even though several providers report it as a fraction natively.
