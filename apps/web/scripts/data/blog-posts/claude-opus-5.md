---
title: Claude Opus 5 is now available in Octopus
slug: claude-opus-5-now-available
excerpt: Anthropic's new top coding model is now a review option in Octopus. It's an opt-in premium tier, not the new default, and here's why.
category: Product
tags: [Claude, Models, Code Review]
authorName: Octopus Team
---

Anthropic released Claude Opus 5 today, and it's already available as a review model in Octopus.

The short version: Opus 5 is Anthropic's new top model for coding. On their published numbers it lands close to Fable 5, their frontier model, at half the price, and it's a step up from Opus 4.8 on software engineering. For something whose entire job is reading your code and finding what's wrong with it, that's the number worth caring about.

Octopus has let you choose your review model since day one, and you can run it on your own key. Opus 5 fits straight into that. You can select it for a single repository or your whole org.

## Why it's a premium option and not the new default

We didn't switch everyone over. The default reviewer stays on the faster Sonnet-class model, which does a good job on most pull requests and keeps credit spend low. Opus 5 costs more per review, $5/$25 per million tokens against $3/$15 for the default, so making it the blanket default would raise everyone's bill whether they asked for it or not. That's not an upgrade. That's a surprise invoice.

So Opus 5 is there for the reviews where you want the deepest read: gnarly concurrency, a security-sensitive change, a big refactor, the kind of pull request where a missed bug is the expensive kind. Point a repo at it and every review on that repo runs on it.

If you want the absolute frontier, Fable 5 is selectable too, at the top of the range ($10/$50 per million tokens). Most teams won't reach for it on everyday review, but it's there for the rare change where you want the strongest read Anthropic ships.

## What it changes for a review

Better reasoning on the subtle stuff, mostly. The logic error that only shows up on the third read. A race condition. The bug that's technically two functions away from the diff. Anthropic also reports Opus 5 as their most-aligned model so far, and for a reviewer that shows up as fewer confidently-wrong findings, which is the failure mode developers actually hate.

It also builds on the review work we shipped over the last few weeks: per-language rule packs, checks that read the pull request's stated intent, and a validation pass that makes each finding defend itself with evidence. Hand a stronger model that much structure and you get a better review, not just a pricier one.

## Turning it on

Open settings, pick your repository, and set the review model to Claude Opus 5. That's the whole setup. Prefer your own Anthropic key? That works too.

The default doesn't move. Opus 5 is there for the changes that earn the deeper look.
