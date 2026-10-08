# Prompt Battle: OpenRouter comparison and agreed game contract

Owner-approved plan and revised model selection: Matthew, 2026-10-07. Quality and faithful execution of a player's prompt take priority over price. The benchmark has a $5 ceiling; games have no application dollar cap. After considering the real images and their speed, Matthew replaced the earlier four-model selection with the three models below, in preference order, with **x-ai/grok-imagine-image-quality as the default**.

## Approved game models and fixed profiles

| Order | Model ID | Menu label | Tested endpoint | Fixed request settings | Mean observed cost/image | Mean observed time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `x-ai/grok-imagine-image-quality` | Grok Imagine Image Quality (default) | `xai` | `n: 1`, `aspect_ratio: "1:1"`, `resolution: "1K"` | $0.050000 | 5.8s |
| 2 | `google/gemini-3.1-flash-image` | Gemini 3.1 Flash Image (more expensive) | `google-ai-studio` | `n: 1`, `aspect_ratio: "1:1"`, `resolution: "1K"` | $0.068556 | 8.1s |
| 3 | `black-forest-labs/flux-3-image` | FLUX 3 Image (less expensive) | `black-forest-labs` | `n: 1`, `aspect_ratio: "1:1"`, `resolution: "1K"` | $0.024000 | 22.3s |

These three IDs form the initial game allowlist in the order shown. #91 implements these supported fixed profiles and #92 presents the menu labels above with Grok selected by default. The price labels compare with Grok using observed request costs; they are not promised future rates or a new cost-estimate feature. The ten-model comparison remains intact in its cheapest-to-most-expensive order as evidence. Model changes and retries follow the agreed round contract below.

## Evidence and current status

Inspected integration baseline: `0404395682f477a25e641f9ab4ee906378b4b019` (remote main). The desktop checkout and local main are older; implementation must use the integration baseline, not infer status from those checkouts.

Public catalogue and every shortlisted endpoint were fetched on 2026-10-07 by `tools/openrouter-comparison.mjs --prepare`. All ten currently expose a compatible text-to-image, square, n:1 endpoint. Source records, chosen requests, complete endpoint pricing lines and retrieval timestamp are saved locally in `.local/openrouter-comparison/metadata.json`; the preparation performs no paid generation. Public metadata is not live-generation evidence. Sources: [Image API guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), [catalogue](https://openrouter.ai/api/v1/images/models).

| Exact candidate | Pinned provider tag | Fixed settings beyond n:1 and 1:1 | Listed output price |
| --- | --- | --- | --- |
| [openai/gpt-image-2.5-sunburst](https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-sunburst/endpoints) | openai | high quality; no resolution field | $0.00003/output token |
| [openai/gpt-image-2.5-flare](https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-flare/endpoints) | openai | high quality; no resolution field | $0.00003/output token |
| [google/gemini-nano-banana-2.1](https://openrouter.ai/api/v1/images/models/google/gemini-nano-banana-2.1/endpoints) | google-ai-studio | 1K | $0.00003/output token |
| [google/gemini-3.1-flash-image](https://openrouter.ai/api/v1/images/models/google/gemini-3.1-flash-image/endpoints) | google-ai-studio | 1K | $0.00006/output token |
| [google/gemini-3-pro-image](https://openrouter.ai/api/v1/images/models/google/gemini-3-pro-image/endpoints) | google-ai-studio/global | 1K | $0.00012/output token |
| [bytedance-seed/seedream-5-0-pro](https://openrouter.ai/api/v1/images/models/bytedance-seed/seedream-5-0-pro/endpoints) | seed | 1K | $0.045/image at 1K |
| [black-forest-labs/flux-3-image](https://openrouter.ai/api/v1/images/models/black-forest-labs/flux-3-image/endpoints) | black-forest-labs | 1K | $0.048/image at 1K |
| [qwen/qwen-image-3-pro](https://openrouter.ai/api/v1/images/models/qwen/qwen-image-3-pro/endpoints) | alibaba | 1K | $0.04/image at 1K |
| [x-ai/grok-imagine-image-quality](https://openrouter.ai/api/v1/images/models/x-ai/grok-imagine-image-quality/endpoints) | xai | 1K | $0.05/image at 1K |
| [sourceful/riverflow-v2.5-pro](https://openrouter.ai/api/v1/images/models/sourceful/riverflow-v2.5-pro/endpoints) | sourceful | 1K; PNG | $0.13/image at 1K |

The five image-priced candidates total $0.939 for their 15 planned outputs at current list prices. The other 15 outputs are token-priced; no finite per-image ceiling follows from those catalogue records. OpenAI also lists $0.000005/text-input token. These are documentary rates, not actual charges or a promised whole-benchmark total. Returned `usage.cost` is authoritative when finite; missing or invalid charges remain unknown. No model is approved merely because its rate or marketing description looks attractive.

## Run the comparison

1. On this Mac, double-click `scripts/setup-openrouter-comparison.command`. Create a dedicated generation key at [OpenRouter keys](https://openrouter.ai/settings/keys), limit $5, no reset, used only for this test. Enter it in the launcher's hidden prompt. It is saved in `.env.openrouter-comparison.local`, ignored by Git and mode 0600. The original `.env.local` is never read or changed. No key is needed for `--prepare`.
2. Run `node tools/openrouter-comparison.mjs --run`. Node and macOS's native `/usr/bin/sips` are required; no dependency is added. The script reads only its own local key file or `OPENROUTER_API_KEY` from the environment. No provider secret is placed in the grid, metadata, ledger, console output, or static application assets.
3. Open `.local/openrouter-comparison/index.html` in a browser. The exact three owner-approved prompts live in the runner and are reproduced in expandable prompt panels. Rows are models; columns are faces, text and action; click an image to view its unchanged original. Each cell shows dimensions, decoded MIME, aggregate reported cost, provider-request time, request count and outcome. Over 60 seconds is flagged; one sample per prompt is not a reliability study.

The runner rechecks a non-resetting key limit no greater than $5 and remaining usage before every paid dispatch. It sends requests sequentially, pins the documented endpoint and disables endpoint fallback for this benchmark. OpenRouter's key limit is the provider-side control; a local cost total alone cannot guarantee the cost of an in-flight token-priced image. The script stops on exhausted limits, key-check failure, transport/timeout, unreadable responses, malformed error envelopes or missing successful-response costs. It does not invent a zero cost for an unresolved outcome. Sources: [current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key), [key limits](https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key), [billing](https://openrouter.ai/docs/guides/overview/multimodal/image-generation).

Every request is durably recorded as pending **before** dispatch; after a crash its unknown charge blocks another paid run. Confirmed non-2xx OpenRouter error envelopes without returned images or a positive charge are treated as unbilled under the documented all-or-nothing billing contract. Temporary 429/5xx errors get at most two retries with 1s/3s minimum delays, respecting Retry-After up to 60s. Refusal codes, invalid requests, credentials/credit failures and unknown charges are not blindly retried. The request timeout is 180s so slow candidates can still be inspected; the target game wait remains roughly 60s.

The first successful response is final, including a disappointing image or a paid unusable raster. Originals are sniffed as PNG/JPEG/WebP and fully decoded using sips; declared MIME must match. Unsupported/malformed imagery is a visible failure and its charge remains in the ledger. Successful responses with unknown costs preserve any usable image and halt. Rerunning skips successful or terminal cells and never silently rerolls them. Unavailable candidates and unfinished cells retain placeholders.

Local receipts: `metadata.json`, `ledger.json`, `key-limit.json`, `status.json`, the grid and originals. JSON response receipts contain only allowlisted numeric usage, simple error codes and image count; raw provider diagnostics and base64 are excluded. Inspect OpenRouter activity to reconcile unknown charges before deliberately modifying the ledger. Do not equate an interrupted call with a refunded call.

Timing is recorded for every provider request, including failed requests and retries, from immediately before dispatch through reading/parsing its response. A grid cell sums those request times; it excludes the retry backoff, key-check requests and local image decoding. These are observed elapsed times on this Mac, not throughput measurements or production latency guarantees.

At Matthew's request, the grid orders models from cheapest to most expensive by their mean reported cost per usable image, including any request spending. Models with no usable images or unresolved costs appear last; confirmed unbilled failures do not count as a free image model. This only changes the display order, preserving request order, originals and receipts.

## Agreed game behavior

- One app-owned account, initially funded with $20. Friends/family are the initial users. Personally funded OpenRouter is an optional fallback for coworker games; the historic Kaplan proxy remains a separate route, not an assertion of blanket provider approval.
- Curated menu: the three approved models above, in preference order with Grok as default and relative-cost labels for Gemini and FLUX; no public catalogue or bring-your-own-key UI. One image per logical attempt, three attempts per player per round, fixed square/approximately 1K model settings. Existing legacy quiz settings remain valid; only the new MVP sample defaults change.
- No application dollar cap for the MVP sample (`maxSessionSpendUsd: null`). The $5 benchmark-key limit is separate from the eventual game key/account balance. Existing monetary-cap validation remains compatible for older quizzes. No new estimate UI or spend dashboard is required.
- Host may change the shared effective model between rounds. Once generation starts, model and settings are locked for that round, including refresh/reconnect. No silent model switch.
- Temporary failures get up to two same-model retries without consuming additional logical attempts. Log every provider request and retain unknown charges separately. Refusals, invalid requests and missing credits have clear errors; retries stop when the round closes.
- Host redo before voting restarts the round for everyone with the new selected model, original prompts/pairings, fresh three-attempt budgets and reset timer. Supersede old entries; retain their spending and audit history. Late results from the prior round run cannot become active submissions or restore old budgets. Existing awarded score events are never rewritten.
- Persist request-level facts for normal generation, automatic retries and host samples: session/round run, player where applicable, effective model/provider, start/time, outcome, request identity, returned cost or unknown status and produced-image count. Session totals expose distinct players, logical attempts, provider requests, images, known cost and unresolved charges. Totals include superseded runs and host samples. Preserve provider-reported precision; the current numeric(8,4) generation field alone is insufficient for a precise per-request ledger.
- Pre-game estimates are deferred until logged player/model/usage history supports them.

## Integration contract and bounded follow-ups

`#44` already provides the pure adapter contract. No production interface is changed by this local probe. `#91` enables the **owner-selected** shortlist through server allowlisting, safe provider error envelopes, resolved auth in the test route, raster-only storage and one host-authenticated catalogue. Add only the profile fields proved necessary by the selected models (square aspect, quality where required, supported resolution/output settings). A model-level capability union does not authorize unsupported parameters at a particular endpoint.

`#92` consumes that three-model catalogue and existing #18 selector/RPC persistence, selects Grok by default, uses the preferred model order and relative-price labels above, uses one image/three attempts/no dollar cap in the new sample, and displays paid/zero/unknown costs honestly. Remove the old exactly-two, variants=2 and $20 sample requirements.

The present Worker drops non-2xx bodies, and its test UI mislabels zero as Workers AI free tier. The generation table is tied to player entries, has no request-level retry/host-sample ledger and stores costs with four decimals. Unknown outcomes preserve reservations today; recovery must keep that audit evidence rather than overwrite a pending row. Opening a battle round is idempotent and does not implement a redo; an engine choice is session-level, so explicit round-run identity/locking is required for a safe restart. These gaps are observed at the baseline above, not claimed fixed here.

Keep three separate bounded work packages: request-level accounting and session summary (including host samples and superseded runs); same-model retry/recovery; host redo and round model locking. Accounting comes first; retry/redo must use its records. Append-only migrations and applied schema changes remain owner-operated. These are necessary follow-ups beyond #91/#92, not silently included in this research ticket. Deployment/auth/storage/real-service checks remain #36; real-player fun/recovery remains #37.

## Paid comparison results — 2026-10-07 (America/New_York)

The sequential $5-key probe is complete: 27 original images across nine successful models, all ten models attempted, 36 provider requests including six retry requests, $2.152507 reported spending and zero unresolved costs. The final dedicated-key usage check also reports $2.152507 used and $2.847493 remaining, matching the request ledger. No picture was rerolled. All 27 originals are 1024 × 1024 PNG/JPEG rasters and passed full native decoding. The browser grid contains all 30 cells, 27 matching original links and three visible 429 failure cells.

| Model ID | Images | Requests | Total reported cost | Mean cost/image | Faces / text / action time |
| --- | ---: | ---: | ---: | ---: | --- |
| openai/gpt-image-2.5-sunburst | 3/3 | 3 | $0.159290 | $0.053097 | 33.9s / 35.1s / 42.5s |
| openai/gpt-image-2.5-flare | 3/3 | 3 | $0.159290 | $0.053097 | 18.7s / 20.8s / 23.9s |
| google/gemini-nano-banana-2.1 | 0/3 | 9 | $0.000000 | Not measured | 0.4s / 0.4s / 0.3s |
| google/gemini-3.1-flash-image | 3/3 | 3 | $0.205669 | $0.068556 | 8.3s / 8.0s / 8.0s |
| google/gemini-3-pro-image | 3/3 | 3 | $0.409132 | $0.136377 | 14.6s / 15.1s / 15.2s |
| bytedance-seed/seedream-5-0-pro | 3/3 | 3 | $0.135000 | $0.045000 | 22.2s / 49.8s / 69.1s |
| black-forest-labs/flux-3-image | 3/3 | 3 | $0.072000 | $0.024000 | 20.5s / 24.9s / 21.4s |
| qwen/qwen-image-3-pro | 3/3 | 3 | $0.120000 | $0.040000 | 60.6s / 39.7s / 55.6s |
| x-ai/grok-imagine-image-quality | 3/3 | 3 | $0.150000 | $0.050000 | 5.7s / 6.5s / 5.2s |
| sourceful/riverflow-v2.5-pro | 3/3 | 3 | $0.742126 | $0.247375 | 118.1s / 124.2s / 138.7s |

Nano Banana 2.1 returned HTTP 429 for all three prompts, each after the initial request and two retries; its nine confirmed errors were unbilled. Its request-time figures above exclude retry backoff and are not successful image latencies. Five successful requests exceeded 60 seconds: Seedream action, Qwen faces and every Riverflow prompt. These three samples per model do not establish a reliable failure rate.

Catalog-versus-response discrepancies are retained explicitly: FLUX lists $0.048 at 1K but reported $0.024 per image; Riverflow lists $0.13 but reported $0.246867–$0.248375. Those are observed charges from this run, not promised future rates. Final key usage agrees with the full response-cost total.

The local grid, originals, dated endpoint metadata, sanitized response receipts, request ledger, summary and final key-limit receipt are preserved. Offline checks and the full suite pass (901/901). Matthew inspected the grid and selected the revised three-model shortlist, tested fixed profiles and Grok default listed above. Independent review and #36/#37 release gates remain open; this is not a completion/acceptance claim.

## Acceptance status

- Completed offline runner check (full suite 901/901): totals, unknown-charge preservation, no rerolls, two-retry ceiling, invalid/credit errors, budget stopping, secret exclusion and actual raster decoding.
- Completed real paid run: 27 originals, all 30 grid cells, dated metadata, every request receipt and reconciled final key usage, $2.152507 within the dedicated $5 key.
- Completed revised owner model selection: Grok default, followed by Gemini Flash (more expensive) and FLUX (less expensive), using the fixed profiles above.
- Independent review of the final accepted contract and published code; #36 production gates remain open. Synthetic test images are never counted as live evidence.
