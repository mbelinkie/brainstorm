# DeepSeek coding workflows: research and evidence

Researched October 1, 2026. Deliverable: [Sol's dispatch guide](../DEEPSEEK_CODING_GUIDE.md).

## Scope and access limitations

The research focused on Reddit discussions in r/DeepSeek, r/opencode, and r/LocalLLaMA, with official DeepSeek documentation used for model and API facts. Direct Reddit access encountered a humanity challenge. The Reddit evidence below consists **only of Google-indexed titles, excerpts, and displayed top-answer excerpts**, not fully read threads. Links deliberately point to reproducible title searches because the accessible index exposed opaque redirect links rather than verified thread permalinks.

Excerpts can omit qualifications or pick up related-thread content. Only clearly attributable excerpts are used below. Exact dates, authors, model configurations, and outcomes were generally unavailable. Promotional SEO videos and unrelated discussions were excluded. This is useful exploratory evidence, not a systematic survey, verified consensus, or proof that the proposed workflow will rescue Pro.

## What the Reddit evidence supports

| Source, subreddit, and index date label | Evidence actually visible | Practical implication and limit |
| --- | --- | --- |
| [“New to this, found a multimodel procedure to reliably …”](https://www.google.com/search?q=site%3Areddit.com%2Fr%2Fopencode%2F+%22New+to+this%22+%22multimodel+procedure%22), r/opencode, “2 months ago” | “Plan with a top tier model, implement with deepseek flash or something.” | Supports trying a stronger planner with a cheaper implementer. A suggestion, not a controlled comparison; refers to Flash. |
| [“Has anyone ever tried kimi k3 (to plan) + Deepseek v4 …”](https://www.google.com/search?q=site%3Areddit.com%2Fr%2Fopencode%2F+%22kimi+k3%22+%22to+plan%22+%22Deepseek%22), r/opencode, “2 months ago” | “Kimi K3 prepared very detailed plan so that DS v4 flash had to just follow …” following a claim of a large refactor. | A firsthand anecdote favoring concrete implementation plans. The snippet cannot establish the refactor's correctness or transfer its outcome to Pro. |
| [“Deepseek-v4-Flash is more than enough. I don't feel like …”](https://www.google.com/search?q=site%3Areddit.com%2Fr%2Fopencode%2F+%22Deepseek-v4-Flash+is+more+than+enough%22), r/opencode, “2 months ago” | “I let Deepseek-v4-Flash implement the plans in build mode.” | Another report of using plans as implementation input. Does not prove DeepSeek can reliably make the plan or independently validate it. |
| [“Thread to discuss the problems with Deepseek handling …”](https://www.google.com/search?q=site%3Areddit.com%2Fr%2Fopencode%2F+%22problems+with+Deepseek+handling%22), r/opencode, “1 month ago” | “Do you ask it to output the plan in a file, then attach the plan file in a new session and ask it to implement it?” | Suggests an explicit written handoff and a fresh context. This is a question, not evidence that the technique solved the reported problem. |
| [“DeepSeek V4 Flash for fullstack coding with …”](https://www.google.com/search?q=site%3Areddit.com%2Fr%2Fopencode%2F+%22DeepSeek+V4+Flash+for+fullstack+coding%22), r/opencode, “5 months ago” | Execution “still has to reread the codebase and figure out how to implement the plan.” | Useful counterpoint: planning does not remove implementation discovery or its cost. Give source/caller pointers and allow relevant reading. |
| [“Need help no bias just genuine advice.”](https://www.google.com/search?q=site%3Areddit.com+deepseek+coding+small+tasks+instructions), r/DeepSeek, “4 months ago” | Initial search excerpt: “You can't depend on it to write the correct and clean code just by giving vague instructions. You'll have to walk it through the technical …” A title search identifies the question as V4 versus GPT 5.5 for bugs/coding. | Supports making contracts and expected behavior explicit. The full answer and exact V4 variant were unavailable. |
| [“Deepseek for coding is outright dangerous. It skips tasks …”](https://www.google.com/search?q=site%3Areddit.com+%22Deepseek+for+coding+is+outright+dangerous%22), r/DeepSeek, “3 months ago” | Title alleges skipped tasks, ignored instructions, broken guardrails, and false claims. | Evidence that users report these problems, not independent verification of the allegations. Closely matches the user's failure report; motivates checks independent of self-report. |
| [“If DeepSeek V4 can do the same coding task for $5, why …”](https://www.google.com/search?q=site%3Areddit.com+%22If+DeepSeek+V4+can+do+the+same+coding+task%22), r/DeepSeek, “4 months ago” | “For low-context tasks, DeepSeek and Claude is basically the same.” Displayed top answer says DeepSeek requires greater knowledge. | Favorable anecdote about bounded context and knowledgeable supervision. Neither a measured parity result nor evidence for complex recovery workflows. |
| [“The new model is amazing!”](https://www.google.com/search?q=site%3Areddit.com%2Fr%2FDeepSeek%2F+%22The+new+model+is+amazing%22), r/DeepSeek, “3 weeks ago” | “Absolutely loving DeepSeek V4.1 Flash” and favorable C#, Python, and Rust coding claims. | Current positive counterevidence to blanket dismissal. It concerns a different named version and lacks independently verified acceptance results. |

The useful recurring pattern in these excerpts is **planning separately from implementation**, with explicit plans and knowledgeable supervision. The evidence on reliability is mixed. The research does not establish an optimal task size, ideal prompt length, or universal model ranking.

## Official facts and version caveats

The following first-party documentation was inspected by the research agent. Prefer the current documentation for the configured endpoint over Reddit advice about an older release or a different provider.

**Correction after checking the changelog:** the [September 10 release announcement](https://api-docs.deepseek.com/news/news260910) still says requests to `deepseek-v4-pro` would switch to V4.1 Flash after September 14. However, the [official changelog](https://api-docs.deepseek.com/updates) explicitly reverses that plan: “In response to user demand, we have decided to continue providing API services for DeepSeek V4 Pro after September 14, 2026, with the billing method remaining unchanged.” The [current pricing page](https://api-docs.deepseek.com/quick_start/pricing) also lists Pro separately as DeepSeek-V4-Pro-0813. Use `deepseek-v4-pro` at `https://api.deepseek.com` to request Pro. The earlier conclusion that all current official Pro requests route to Flash was incorrect; it relied on the unrevised announcement without checking this reversal.

Do not assume the user's “Pro” label identifies the backend version. Record the requested model, provider, returned model identifier when exposed, execution date, thinking mode/effort, and relevant harness settings. A displayed alias and a model's verbal self-identification are not reliable version evidence. Changing routing now does not establish which backend handled the earlier attempts.

| Official source | Finding and practical implication |
| --- | --- |
| [Changelog](https://api-docs.deepseek.com/updates), [pricing](https://api-docs.deepseek.com/quick_start/pricing), and [list models](https://api-docs.deepseek.com/api/list-models) | Current IDs include `deepseek-flash` and `deepseek-v4-pro`. Pro remains available after September 14; the original retirement plan was reversed. The pricing page lists Flash as V4.1-Flash and Pro as V4-Pro-0813. Legacy `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` route to V4.1 Flash. Check the endpoint and current routing, not merely the UI label or an unrevised announcement. |
| [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) | Thinking defaults to enabled and effort to `high`. The documentation describes `low` for simple work, `high` for daily agent work, and `max` for complex work. In current thinking mode, temperature is ignored and `top_p` is supported only in 0.95–1.0. Copying an old temperature recipe will not necessarily affect the current endpoint. |
| [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) and [tool calls](https://api-docs.deepseek.com/guides/tool_calls) | Thinking-mode tool loops require replaying full `reasoning_content`; omissions can produce a 400 error. Validate that the harness satisfies the message protocol before attributing every tool failure to coding ability. |
| [Tool calls](https://api-docs.deepseek.com/guides/tool_calls) and [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion) | Tool arguments can be invalid or contain hallucinated parameters; validate before execution. Strict tool schemas are beta. Prompt instructions do not replace permission and argument enforcement. The response schema includes `model` and `system_fingerprint` for recording returned metadata. |
| [DeepSeek-R1 usage recommendations](https://github.com/deepseek-ai/DeepSeek-R1#usage-recommendations) | Older R1 guidance recommends temperature 0.5–0.7, advises putting instructions in the user prompt instead of a system prompt, and discusses forcing a thinking prefix. These recommendations are specific to that model family; do not remove current harness/system instructions on their authority. |
| [Official Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex) | Its configuration advertises a 1M context window and disables built-in web search. Large capacity does not establish an optimal task size or eliminate the need for relevant context. This configuration does not prove the user's previous harness used the same settings. |

The inspected official documentation does not prescribe ticket size or the Sol/DeepSeek division of responsibility. Those are local workflow recommendations, with the provenance identified below.

## Recommendations and their provenance

| Recommendation | Basis |
| --- | --- |
| Sol designs the solution; DeepSeek implements a written slice. | Repeated indexed Reddit planner/implementer anecdotes. A workflow hypothesis to evaluate with Pro. |
| Supply current source paths, callers, contracts, and runnable expected outcomes. | Reddit specificity advice and the fullstack-plan caveat; also follows from the user's failed experiment. |
| Start with one behavior and approximately 1–3 production files. | Our conservative pilot heuristic. No sourced optimal threshold. |
| Use fresh slice context with a concise accepted handoff. | An indexed Reddit suggestion, plus a local operational choice; no demonstrated superiority in this research. |
| Sol controls acceptance tests and exercises real boundaries. | The user's report that 563 tests mocked away critical behavior. This requirement is more directly grounded in that experiment than in the Reddit anecdotes. |
| Keep billing/recovery/security/destructive policy and execution with Sol initially. | Risk-based response to the specific reported failures, not a claim that DeepSeek cannot ever work on those domains. |
| One localized repair, then reclaim or shrink; immediate escalation for critical violations. | Proposed experiment budget and control policy, not a vendor instruction. |
| Measure accepted correctness, review time, and failed-attempt costs. | A way to test whether the proposed workflow actually helps; cheap generation alone does not answer that question. |

## Application to the user's experiment

The supplied account says both attempts used Pro, so attributing the failure to Flash is unsupported. The reported defects span several independently important contracts: spend accounting, restart semantics, child environments, and worktree ownership. Breaking the ticket at those boundaries makes its acceptance criteria easier to specify and makes failures easier to localize.

However, decomposition alone would not catch a wrapper restoring stripped credentials or cleanup operating on the wrong worktree. Those need integration checks of the actual side effects. The guide therefore combines smaller assignments with independent boundary verification and retains the sensitive integration with Sol during the first retry.

No retry was run as part of this research. The guide remains an experiment until results show which slices DeepSeek completes correctly and economically.
