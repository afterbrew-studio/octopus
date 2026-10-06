# Isolated upstream cash audit candidate

This explicitly invoked audit is separate from capture and dispatch. It has no
default transport, credentials, database client, receiver client or scheduler.
The transcript command below reads synthetic input only and cannot contact Stripe.
For the separately invoked operator, see [real transport](#explicit-real-transport-candidate-execution-and-release-held).
No production use or upstream completeness acceptance is implied by this candidate.

```sh
bun apps/web/scripts/marketing-upstream-audit.ts /new/path/result.json < fixture.json
```

The result path must not exist. It is created exclusively with mode 0600 and
flushed; this is local retained evidence, not database immutability. Retain its
printed SHA-256 separately. Never put credentials in the transcript. The driver
rejects LIVE fixtures and consumes stdin up to 8 MiB. Failures are not retried.

## Input and observation boundary

`AuditInput` pins account, environment, API version `2026-06-24.dahlia`, canonical
UTC activation and `[from,to)` timestamps, independently retained expected receiver
source/key/project/version/capabilities, ownership projection digest, exact retained
inventory body digest and nullable predecessor digest. `transportBinding` is a
separately retained expectation; an object response does not prove credential mode.
`ownership` contains retained organization/customer pairs, not a customer scan.
`retainedBody` is the exact sealed `retained-cash/v1` inventory for that interval.
No source selection is inferred from processor results. QA classifications are
neither rewritten nor interpreted as cash exclusions.

The transcript adds a synthetic `now` and ordered `responses` of exact GET `url`,
HTTP `status` and JSON `body`. Responses must cover account identity, independent
charge and refund lists, and only the exact payment/charge/checkout dependencies
needed by in-range objects. No authorization headers or network are used. Lists
are independent of retained ledger membership. Original-payment dependencies may
precede activation; they retain their actual timestamps and do not trigger capture.

The core enforces 100 objects/page, 10 pages/list endpoint (including filtered Checkout pages), 500 total reads,
10 seconds/read and five minutes overall with zero retries. Invalid input or
authority pins reject before any read. Page, read, deadline, identity or HTTP
failures during observation produce partial evidence; an oversized final packet
is rejected. Transcript mismatches or unused responses also reject without writing
a result. Each read has its own times;
list exhaustion is not an atomic processor snapshot. The fixture clock does not
turn local tests into real provider or temporal acceptance.

## Output schema `upstream-cash-audit/v1`

The packet contains pins (account hashed), limits, observation times, per-read
request digests/status/request IDs, page cursor/count/exhaustion and projection
digests, sanitized processor projections, dispositions, gaps and canonical members.
Raw customer, organization and processor object IDs are hashed. Canonical members
reuse `resolveStripeConversion`, `serializeConversion` and
`normalizeMarketingCash`; they carry semantic digest, original-payment relation,
exact occurrence, dependency flag, retained receipt and ledger aliases.

- A stays `not_observed`: no receiver comparison occurs here.
- B copies the sealed retained inventory's bounded assessment, not upstream coverage.
- C stays `unknown` in every result.
- `processorEnumeration` describes only exhaustion of declared account/time lists.
- `captureAgreement` can match only the observed supported scope without gaps.

Failed or canceled candidates retain a terminal disposition after identity,
ownership, customer and mode checks, before the latest-charge capture check.
An earlier failed attempt therefore does not make a later successful charge a
multiple-capture gap. Successful candidates still require the capture checks.

A successful processor fact missing ledger remains
`missing_ledger_activation_unresolved`. Unknown ownership, manual/multiple capture,
unsupported currency, alias conflicts, pending refunds, missing retained evidence
and delivery discrepancies remain gaps. An empty ledger or outbox is not evidence
of no cash. There is no customer-zero, learning admission, paid-causality, settlement
or whole-history completeness claim. Charge creation-time enumeration cannot by
itself prove capture-time completeness for unsupported delayed capture paths.

Late facts require a new packet with a new knowledge time and the old digest as
`predecessorDigest`; the earlier file remains unchanged. A later refund success
retains its original creation timestamp and may require an explicitly scoped
overlapping successor interval. No historical sweep runs automatically.

## Future receiver fixture requirements

Root owns setup and cleanup after reviewing exact source and driver hashes. Supply
only synthetic retained inventory, independently expected TEST binding, ownership
projection and bounded processor transcript. Include CS/PI aliases, a purchase and
individual refunds, a pre-interval original dependency, missing ledger, lost ACK,
pending-to-success and unsupported cases. Receiver comparison, if separately
authorized, must use a new fixture and keep its observation times and A assessment
separate. This driver needs no backend key and sends no ingestion or comparison.
For the refund lifecycle's exact-commit acceptance and rollout boundary, see
[isolated readiness](refund-completion.md#isolated-readiness-only).

Input pin, binding, project, transport and ownership projections reject unknown
fields before any reads. The retained inventory must use the current normalization
contract and include its sealed `producerObservation` interval, retained separately
from audit read times. This offline command consumes an already prepared inventory;
it does not acquire a fresh post-enumeration snapshot or prove cross-system atomicity.
Any future operational snapshot/scan ordering remains a separate owner-reviewed step.

## Explicit real-transport candidate (execution and release held)

`apps/web/scripts/marketing-upstream-transport.ts` is a separate, manually invoked
operator. It does not alter the offline transcript driver or run on import, build,
startup, cron, capture or dispatch. No migration or dependency is added. Tests
inject synthetic responses; no Stripe account, production DB or receiver is read.

The candidate is based on 1.2.8 (`d1af546`), which includes the accepted d687 audit
and d2def refund handler ancestry. The only audit-core change extracts its existing
pure preflight for reuse; canonical resolution/serialization and A/B/C semantics
are unchanged. The transport uses the same server `STRIPE_SECRET_KEY` as billing,
read only at explicit execution, rather than the retrying SDK or a second key.
It never prints it or sends the Unified Ads key anywhere. Existing
`UNIFIED_ADS_*` settings, including `UNIFIED_ADS_CASH_EXPECTED_BINDING`, must agree
with the retained input and independently approved authority. No settings change
is performed by the operator.

Prepare two protected local artifacts through the existing owner workflow:

1. `input.json`: the existing `AuditInput`, including exact retained inventory
   bytes, ownership projection and digests. No newly acquired inventory is implied.
2. `authority.json`: `{ expectedPins: AuditPins, issuedAt, expiresAt }`, retained
   independently by the owner. Pins must match exactly, including account, mode,
   API, source/key-ID/project/version/capabilities, activation, interval and digests.
   Field order is part of this exact JSON contract. This is operator trust, not a
   provider attestation or automatic proof of ownership completeness.

The authority window and inventory age are each capped at 15 minutes. Expiry is
checked before execution and every GET. Outdated evidence requires new separately
scoped preparation, never automatic refresh. The fixed `[from,to)` and activation
must validate before any network access. Missing or ambiguous ownership remains
a gap even when both lists exhaust. Unsupported delayed capture, late transitions
and broader processor/settlement completeness remain unknown.

Planning and execution reject ambiguous retained inventory before provider IO:
duplicate canonical members, ledger/outbox identities or aliases, conflicting
payloads, receipts, origins or scope, and malformed or unrecognized gaps. Consistent
aliases and exact older refund-original dependencies remain valid. An incomplete
B alone does not reject the inventory: missing capture, unresolved payload or
original, incomplete delivery, truncation and unaccounted retained origins remain
gaps. The regression cases live in
`apps/web/lib/__tests__/marketing-upstream-transport.test.ts`.

Offline planning requires no credentials and makes no requests:

```sh
bun apps/web/scripts/marketing-upstream-transport.ts plan input.json authority.json /new/protected/evidence
```

The emitted plan declares exact initial endpoints/bounds, dependent lookup
families, limits, evidence destination, input/authority digests and no-retry rule.
Retain the SHA-256 of its exact JSON body (without the printed trailing newline)
for separate owner approval. The approved plan must be identical at execution.
The following is documentation only, **not authorization to run**:

```sh
bun apps/web/scripts/marketing-upstream-transport.ts execute input.json authority.json /new/protected/evidence APPROVED_PLAN_SHA256
```

Execution reserves a new 0700 directory and exclusively writes/fsyncs a 0600
`intent.json` before its first GET. An existing directory rejects before any provider read;
do not delete/reuse it after an ambiguous interruption. `result.json` contains
only the audit's sanitized projections, canonical identities, gaps and separate
observations. `receipt.json` pins its digest. Incomplete intent/result/receipt
sets require read-only reconciliation; there is no recovery replay or automatic
retry. Successful command completion can contain a **partial** audit: inspect
`failure`, `gaps` and `processorEnumeration`, not merely the process exit code.

Only `https://api.stripe.com` GETs are allowed. The credential-bearing boundary
rechecks endpoint/query/header allowlists, exact created bounds, page size,
API version and remaining budget, and explicitly supplies redirect:error,
credentials:omit and cache:no-store to fetch. It forwards no incoming cookies,
Origin, Stripe-Account, arbitrary headers or error bodies. It catches/sanitizes
network exceptions. HTTP 429, non-200, redirect and deadline failures do not retry.
The existing audit supplies per-read aborts, body limits and pagination caps.
Bun's Request.credentials getter may report include even when omit was supplied;
therefore the fetch call receives explicit options and a fresh header allowlist.

The existing owner must separately approve any future real run and its fresh
runtime/account/inventory baseline. No new receiver fixture is required for this
transport candidate; no accepted/destroyed fixture is reused. Late facts or refund
status transitions require a separately approved successor with predecessorDigest,
possibly an overlapping interval; old files remain untouched. The output's existing
"synthetic transport requires separately authorized real acceptance" limitation
remains a reminder that code/local tests alone do not establish real acceptance.

Official endpoint checks (2026-09-27): [charges list](https://docs.stripe.com/api/charges/list)
and [refunds list](https://docs.stripe.com/api/refunds/list) support created bounds,
100-item pages and starting_after; [Checkout list](https://docs.stripe.com/api/checkout/sessions/list)
supports payment_intent filtering. These are created-time enumerations, not atomic
cash snapshots. [Authentication](https://docs.stripe.com/api/authentication) uses
server secrets; no key creation or credential export is needed.
