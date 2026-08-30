# Concepts

Words that mean something specific in this codebase. Definitions here are the shared
vocabulary that `docs/` and `AGENTS.md` can cite without redefining.

## Routing

### Root-capable pool

The accounts admitted by a capability profile because each can serve the profile's root
logical model through its expected provider and physical model. Membership establishes the
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

### Trusted internal helper

A Claude Code side request, such as WebSearch, whose authenticated caller and session lineage
validate through the same private authority as the parent request even when it carries no
subagent marker. Helper classification grants no capability by itself: the chosen provider
route must still hold an exact reviewed proof.

## Usage measurement

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

## Flagged ambiguities

- *Active* on a usage window means "currently binding" only in the shapes that report an
  explicit array of limits; in every other shape it is just the default and carries no
  information. A fixture for the limits-array shape that marks every entry active
  describes a payload that shape does not send — a real trap, because that is precisely
  the shape whose active flag is supposed to mean something.
- *Utilization* is always a 0–100 percentage once past normalization, never a 0–1 fraction,
  even though several providers report it as a fraction natively.
