# Kaplan proxy spend control: decision record for issue #43

Status: pilot implementation deferred by Matthew, 2026-10-08. The design below is retained for later reconsideration. No durable counter or automatic proxy spending cap has been implemented. This document does not authorize deployment or paid calls.

## Pilot waiver — 2026-10-08

Matthew decided to waive the proposed Cloud Storage counter for the Kaplan pilot after David confirmed existing spend tracking and an Analytics/Redshift reporting interface in progress. The current pilot therefore proceeds without new counter storage or further #43 implementation work. The historical options, invariants and tests below are future design material, not outstanding pilot implementation instructions.

Spend reporting does not refuse generation requests. The existing $75 monthly budget remains an alert, not a hard cap; the proxy has no durable cross-instance daily/monthly reservation counter. This waiver does not satisfy the original automated circuit-breaker acceptance and does not waive SecOps/Falcon/public-access gates in #19 or live host acceptance in #21. Reconsider this design before expanding beyond the pilot or if Kaplan requires an enforced proxy limit; any new GCP storage still needs approval.

## Outcome and boundary

[Issue #43](https://github.com/mbelinkie/brainstorm/issues/43) asks the proxy to refuse generation past daily or monthly limits so a leaked shared secret cannot exhaust the $75 monthly Kaplan budget. The approved $75 budget is **alerts only**. The approval permits short employee-written prompts for an internal Kaplan activity and says no data is stored in GCP; it calls for consulting the approver before adding a GCP data service. The current proxy has no durable counter. Its `costUsd` counts returned 1K images only; [Vertex also bills input and text/reasoning output](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing). A failed, blocked, partial, or timed-out call cannot safely be treated as free.

The literal $75 **whole-project** guarantee is wider than a proxy Vertex counter. Public Cloud Run ingress and counter reads can still incur charges after generation is refused, and any other project usage is outside this proxy. [Cloud Run pricing](https://cloud.google.com/run/pricing) and [Cloud Storage pricing](https://cloud.google.com/storage/pricing) include usage charges. Proposed revised acceptance is a conservative proxy-side limit on *authorized Vertex calls*, with separate controls and budget headroom for other services. Do not claim an exact total-project cap.

## Choice pending approval

| Option | Decision |
| --- | --- |
| Hard Vertex request quota | Not viable for this model: Google's [Gemini 3.1 Flash Image model page](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-flash-image) says **Fixed quota: Not supported**. Standard PayGo throughput can burst past baseline; throughput is not dollars. |
| Native GCP spend-cap budget | Useful defense in depth for `aiplatform.googleapis.com`, without a new datastore. It is a separate monthly, single-project, single-service budget; the existing alerts-only budget cannot be converted in place. [Enforcement is delayed, in-flight calls complete, and overages are billed](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps). It cannot satisfy the proxy's daily refusal test or guarantee $75. A Cloud Run cap would be separate. Admin billing permission and availability for this billing account remain unverified. |
| Firestore transaction | Atomic read-modify-write works across instances, but needs a new database, API, IAM, client integration, and billable reads/writes. [Transactions retry contention and can still fail](https://docs.cloud.google.com/firestore/native/docs/manage-data/transactions). |
| Cloud Storage generation precondition | Smallest likely counter backend: a tiny current-month object with integer daily/monthly reservations, updated only when its generation matches. A competing write fails with 412; retry from the latest object, then fail closed. [Preconditions support safe read-modify-write](https://docs.cloud.google.com/storage/docs/request-preconditions). Needs a new bucket/API/IAM and billable operations; an abandoned reservation is deliberately retained. |

Prefer a Cloud Storage counter **if** the approver explicitly authorizes storage of aggregate numbers and dates (no prompts, images, employee identifiers, or request bodies), the bucket, API, narrowly scoped service-account access, and its operating costs. Record the bucket region and retention/versioning settings. A native Vertex spend cap set below the $75 alert may reduce damage from non-proxy calls, subject to its documented delay and separate Cloud Run costs. The approver must decide whether the resulting bounded-risk control meets the business requirement; neither option makes a strict whole-project dollar ceiling.

## Implementation invariants after authorization

1. Check authentication and validate the fixed model, prompt length, and 1–4 variants before touching the counter. Keep the counter private to the proxy service account.
2. Establish and document a conservative **upper charge per Vertex call** from the approved location, model prices, input/output token limits, and generation settings. Add an explicit output-token ceiling if needed. The current image-only estimate is not this bound; the model can return multiple images per call. Revalidate prices and response usage in the authorized pilot before enabling paid traffic. If a safe bound cannot be established, fail closed.
3. Atomically reserve the full worst-case cost of all requested calls against both daily and monthly limits **before** the first Vertex call. Use integer money units and one conditional update containing both windows. Deny when either limit would be exceeded; no successful reservation means no Vertex call. Cloud Run instance count does not substitute for atomicity.
4. Keep reservations after crashes, timeouts, provider errors, safety blocks, malformed responses, and partial success. A call might have been billed even when the proxy receives no usable image. This conservatively reduces available allowance. Do not release an uncertain reservation.
5. Fail closed on missing, corrupt, stale, or unavailable counter state and after bounded contention retries. Return a structured budget refusal (proposed HTTP 402, `SPEND_LIMIT_REACHED`) for exhausted limits; distinguish backend unavailability with a sanitized structured 503. Do not log prompts, tokens, secrets, images, or raw provider bodies.
6. Fix UTC day/month boundaries and define first-object creation with a create-only precondition. Re-read after conflicts; do not overwrite a newer month or reset a day's reservations by racing at midnight. Configure every deployed revision with the same limits and backend.

## Deterministic acceptance scenarios

Use a fake atomic store and fake Vertex client; make no paid calls in automated tests.

- A request below both limits reserves its full maximum then generates; a reservation reaching either cap succeeds, and the next request is refused without a Vertex call. Exercise 1 and 4 variants.
- Two simultaneous requests against capacity for only one reservation admit exactly one, across independent server instances. A 412 conflict retries against fresh state; exhausted retries make zero Vertex calls.
- Store read/write failure, malformed state, and stale state each fail closed. A timeout, blocked result, partial result, and process stop after reservation never restore allowance.
- Requests spanning UTC midnight and month rollover charge exactly their intended windows; the first writer creates the new month once. A zero-image result is not assumed unbilled.
- Tests assert both daily and monthly caps, no prompt/image/secret in stored data or error bodies, and `npm test` output plus tested commit ID as required by #43.

## Unverified before implementation or launch

The live project has not been checked for a suitable existing bucket, storage API, IAM permissions, billing-account eligibility for native spend caps, actual region pricing, or non-proxy spend. The model's documented 131,072 input / 32,768 output token limits and separate image/text prices do **not** by themselves prove a per-call billing maximum; verify `maxOutputTokens` and thought/image accounting before choosing the reservation amount. The counter's storage/operation cost, Cloud Run cost under refused-request abuse, billing delay, and pricing changes need explicit headroom and monitoring. [Google says spend-cap enforcement is not instantaneous](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps).
