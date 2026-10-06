# Refund completion lifecycle

The signed Stripe webhook admits `refund.updated` as the individual-refund
completion signal. Stripe documents that event for refund changes across payment
methods; `charge.refund.updated` covers only selected methods. Existing
`charge.refunded` deliveries use the same processing function.

References checked 2026-09-27: [Stripe event types](https://docs.stripe.com/api/events/types)
and [refund lifecycle](https://docs.stripe.com/refunds). This is a public contract
check, not inspection of an actual endpoint subscription or provider account.

The handler retrieves current refund state instead of trusting a stale status in
the event. Pending, failed, canceled and requires-action refunds do not debit.
Successful refunds must match the event's original charge and PaymentIntent,
the stored organization's Stripe customer, charge customer, environment and the
existing canonical resolver's status/amount/currency/original-payment checks.
Checkout ownership and purchase aliases must agree. Since credits are denominated
in USD, another currency must not be deducted as dollars.

Both event paths call existing `deductCredits` with the individual refund ID.
The unique ledger key and transaction rollback preserve duplicate/concurrent-event
idempotency; refund deductions do not trigger auto-reload. A nonduplicate failure
returns 500 for provider retry, rather than ACKing a missing debit.

Ledger creation and subsequent marketing capture are separate stages. This change
does not add inline outbox creation or dispatch: the existing retained-ledger
scanner/canonical capture and dispatcher remain responsible for the outbox. A
duplicate webhook does not fabricate an outbox row or replay the original payment.

## Isolated readiness only

Source tests exercise the actual route and credit transaction code with synthetic
provider/signature/database boundaries. They are not real financial acceptance.
The release owner reports isolated PostgreSQL/capture/dispatch/receiver acceptance
for `d2def992fe0a281c764191cad67aa9a6ad5d03e6`; both disposable databases were
removed. This is exact-commit isolated evidence, not production/provider acceptance.
Runtime changes require new isolated acceptance coordination before rollout, using
a new disposable fixture after reviewed pins. Verify
pending webhook creates no ledger/outbox, successful completion creates exactly one
ledger and (after normal capture) one canonical refund, and duplicate/out-of-order
delivery preserves the original purchase and refund receipts. Include an older
original outside the refund interval, ownership/amount/currency failures and QA
preservation. Keep A/B/C separate; C remains unknown.

Only the outer release owner performs the separately guarded application rollout.
The `refund.updated` destination subscription is absent and separately held under
the current release authorization; application rollout does not enable it. Any
future subscription activation requires separate coordination and verification.
This source change neither reads nor alters destination subscriptions and authorizes
no event replay or financial action. It does not backfill earlier missed
events or reverse previously processed refunds that later change state.
