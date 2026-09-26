# Unified Ads visitor and sales attribution

Status: implementation candidate, not activated in LIVE. It extends the existing
business-event producer; it does not change cash identities, forward sales to ad
networks, calculate profit, or change campaigns. Successful sales and individual
refunds keep their original currency and integer monetary values.

## Consent and capture

The hosted app offers separate usage-analytics and advertising-measurement
choices. Both start off. Existing GA and X scripts are gated by the relevant
choice and the production origin. Google advertising consent is separate from
analytics consent; personalization stays denied. Preference changes reload the
page to unload previously running scripts. Withdrawal clears the first-party
visit, attribution permission and tab identity, including across open tabs.

`GET /api/marketing/visit` exposes only a current enabled boolean with no caching.
The client creates no tracking identifier until consent and this activation
check succeed. `POST` requires the exact configured public Origin header and
its canonical Host header; the internal request URL may use the proxy's backend
listen address. Forwarded host/protocol headers are not trusted. Query strings
are rejected. Requests require JSON no larger than 512 bytes within two seconds and the
existing Redis limiter in fail-closed mode. Its source-wide budget is 600 visits
per minute; rate-limited visits are not collected. It accepts only consent,
a random tab UUID and an optional opaque campaign-link UUID. It does not accept
account, campaign, customer or payment identities, full URLs, emails or IPs.

The shared limiter waits up to two seconds for a connecting Redis client before
issuing commands. Concurrent requests share that wait. A readiness timeout or
Redis error still rejects capture with HTTP 429 and `Retry-After: 60`; this
response can indicate Redis unavailability as well as an exhausted budget.
No request is collected or replayed by the limiter after rejection.

The server creates a random visitor identity and hashes visitor/session IDs with
the source namespace. It persists a visit before setting the 30-day
`__Host-octopus_visit` cookie, which contains only an unguessable event reference.
The immutable saved visit provides consent evidence; it is not a separate
visitor database. A separate current-permission cookie prevents a late visit
response from restoring attribution after withdrawal. Neither cookie is an
authentication credential. The visit cookie is readable by the client so it can
be deleted immediately even if withdrawal happens offline.

With attribution consent, the backend validates a new tag using the receiver's
supported `GET /api/conversion-tracking/links/{linkId}`. It checks exact binding,
requested link, validity and creation time. Validation failure produces no
visit. Untagged visits carry no campaign link; the receiver applies its declared
last-tagged-visit model. This is tagged-link attribution, not proof of a paid
click. Persisted retries never change when later link validity changes.

## Verified associations

The Better Auth user-creation hook stamps a private, non-client-writable visit
reference in the same user insertion. The database prevents later changes.
A reconciler creates registration context using the existing subject hash and
original user creation timestamp. Login and later organisation membership are
never sources of registration attribution.

Hosted Checkout and user-initiated saved-card purchases/subscription starts save
an immutable nullable visitor snapshot before asking Stripe to charge. Existing
payment parameters and idempotency keys are unchanged. A retry cannot upgrade
an initially absent consent snapshot. Only a fresh Stripe API response can bind
the processor reference; cached `Idempotent-Replayed` responses and responses
without proof cannot create an association. See [Stripe's retry contract](https://docs.stripe.com/error-low-level#idempotency).
A crash or lost first response can therefore leave a sale unattributed; the
business sale still reports normally. We never repair this by guessing from a
later browser session. Recurring charges and auto-reloads do not take a browser
association.

The separate `marketing-contexts` scheduled job reconciles up to 50 signups and
one payment per minute. It reuses the existing read-only Stripe normalizer,
checks organisation/environment and initiation time, and writes the exact
canonical successful-payment ID and occurrence time. No refund context is
created: each refund follows the original purchase. Missing association,
processor failures and consent failures do not mutate billing or block the
independent `marketing-conversions` delivery job.

An open payment-mode Checkout in the configured environment without a
PaymentIntent remains pending. Retryable reconciliation failures defer the next
attempt by five minutes; successful reconciliation or a terminal source failure
completes the snapshot.

## Durable delivery

Tracking uses the existing outbox with immutable IDs and payload bytes. Every
attempt checks authenticated source, environment, enrollment, project, origin,
model and record types with the same key used for POST. Mismatch means zero
POST. Business events keep their separate preflight. Redirects, cookies and
Origin headers are never sent to the receiver. Lost responses retry identical
bytes and accept only the matching duplicate receipt.

See [business-event delivery](unified-ads-conversions.md#durable-delivery) for
the shared claim priority, batch limits and disabled-tracking behavior.

## Configuration and release

Apply both additive migrations before deploying:

- `20260917100000_marketing_tracking_outbox`
- `20260917110000_marketing_capture`

Additional to existing business-event configuration:

- `UNIFIED_ADS_TRACKING_ENABLED`: off by default.
- `UNIFIED_ADS_TRACKING_ID`: receiver-provisioned enrollment UUID.
- `UNIFIED_ADS_PROJECT_ID`: receiver-provisioned project UUID.
- `UNIFIED_ADS_TRACKING_ORIGIN`: `https://octopus-review.ai`.
- `UNIFIED_ADS_TRACKING_FROM`: explicit UTC new-events cutoff, no earlier than
  the business-event cutoff. Never advance it to discard pending records.

Capture requires an active binding and elapsed cutoff. Production refuses TEST
sources. Self-hosted capture remains disabled. Keep migrations on rollback;
disable tracking before reverting code. User signup associations and payment
snapshots are immutable, including null snapshots. Disabling visitor tracking
does not disable the business-event worker.

Before LIVE, complete normal review/CI and actual TEST capture/outbox/receiver
acceptance, obtain independent receipt corroboration, and agree the LIVE
binding and new-events cutoff with the receiver owner. No synthetic LIVE
records, campaign URL edits or budget changes. Synthetic processor facts do
not establish real Stripe cash acceptance. After activation, verify actual
eligible visits and sales; if none occur, report that limitation.

## Validation

```sh
bun test apps/web/lib/__tests__/marketing-tracking.test.ts apps/web/lib/__tests__/marketing-conversions.test.ts apps/web/lib/__tests__/marketing-stripe.test.ts
RUN_MARKETING_DB_TESTS=1 bun test apps/web/lib/__tests__/marketing-outbox.db.test.ts
```

Database checks require a disposable local database as described in
[the business-event integration](unified-ads-conversions.md#validation). They
apply real migrations and execute consent/capture, signup/payment snapshots,
hosted Checkout initiation with a synthetic processor response, source fences,
body/deadline/admission rejection, replay and business-priority behaviour.
Normal tests never call external receivers. Live TEST acceptance uses separately
provided credentials kept outside the repository and records sanitized receipts
against an exact candidate SHA.
