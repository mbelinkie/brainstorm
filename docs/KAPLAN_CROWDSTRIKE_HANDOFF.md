# Kaplan proxy: CrowdStrike build and deployment handoff

Updated October 8, 2026 for issues #94 (build/push), #19 (private deployment
and SecOps review), and #21 (Worker/live-host acceptance). This record reflects
the Cloud Shell build and the private Cloud Run attempts. It does not mark
any of those issues complete.

## Current result

The initial laptop Docker requirement was replaced with an authorized Google
Cloud Shell session. The exact #94 source was rebuilt, the Falcon sensor was
downloaded with the supplied Secret Manager credentials, the application image
was patched with the official `falconutil`, and both images were pushed to the
existing Artifact Registry repository. The build was reproducible from source
commit `0404395682f477a25e641f9ab4ee906378b4b019`.

The private Gen 2 Cloud Run service was created with the dedicated runtime
identity and the application secret. Its first revision,
`kaplan-image-proxy-00001-5pw`, did not become ready because Falcon could not
read the Cloud Run service metadata: the runtime identity lacked
`run.services.get`. David's service-level `roles/run.viewer` grant was then
verified. The retry reached revision `kaplan-image-proxy-00002-sr8` but failed
with `EACCES` reading `/app/server.mjs`: the prior image had root-owned mode
0600 application files, which UID 1000 (`node`) cannot read.

A derived chmod layer corrected those three files and was pushed and read back
as the immutable application image
`us-central1-docker.pkg.dev/quiz-platform-image-generation/quiz-app-repo/kaplan-image-proxy@sha256:8ff9cef50f8397a803092bb22038196cc2d9c6c06fce6f3cf43731e84b4e55c6`.
Private Gen 2 revision `kaplan-image-proxy-00003-spz` is ready with 100% traffic.
The authoritative Cloud Run URL is
`https://kaplan-image-proxy-wqifulzssq-uc.a.run.app` (the CLI also reports the
stable project-number alias
`https://kaplan-image-proxy-796189298588.us-central1.run.app`).

The future base-image fix is the one-line Dockerfile normalization
`COPY --chmod=0644 core.mjs vertex.mjs server.mjs ./`. It prevents recurrence,
preserves the non-root `node` user and Falcon entrypoint, and changes no
application logic or security boundary. The current service remains private;
no public IAM binding was added.

## Verified build and registry artifacts

- Build environment: authorized Google Cloud Shell, x86_64 Linux, Docker
  29.8.2, Git 2.43.0. The Cloud Shell VM is ephemeral.
- Source: `mbelinkie/brainstorm`, detached at
  `0404395682f477a25e641f9ab4ee906378b4b019`; the checkout was clean before
  the build and after the checks.
- Official CrowdStrike pull script: version `1.14.0`, source commit
  `d9207abc0577828b83fe3c2e6d464c287b79c6cc`, SHA-256
  `05591f78ccb7ef5b7c60a47e152a79f09c103252745756c556ae31325ea85710`.
- Sensor download: automatic region discovery selected `us-1`; the vendor
  image was `registry.crowdstrike.com/falcon-container/release/falcon-container:8.11.0-8103`
  with vendor repository digest
  `sha256:ef329bc7fcb3a375d7a8a6a756f869c1030220a5e196e0c083a79895bf67af51`.
- Mirrored sensor image:
  `us-central1-docker.pkg.dev/quiz-platform-image-generation/quiz-app-repo/falcon-container-sensor@sha256:1a51851dd9b8a44197fe45dda51ea9c678323415a9d7939b6fd250ca723639ac`.
- Previous patched application image (provenance only; its baked files were
  unreadable by the runtime user):
  `us-central1-docker.pkg.dev/quiz-platform-image-generation/quiz-app-repo/kaplan-image-proxy@sha256:fcf5e31a6aaabea749ecb40ec4e33f000daf834843e0cb181d6c374094e0d981`.
- Current derived chmod-layer image, read back from Artifact Registry:
  `us-central1-docker.pkg.dev/quiz-platform-image-generation/quiz-app-repo/kaplan-image-proxy@sha256:8ff9cef50f8397a803092bb22038196cc2d9c6c06fce6f3cf43731e84b4e55c6`.
- The patch used `--cloud-service CLOUDRUN`, x86_64, and
  `--image-pull-policy IfNotPresent`. No provisioning-token placeholder was
  supplied or baked into the image.
- The future base-image rebuild uses `COPY --chmod=0644` for exactly
  `core.mjs`, `vertex.mjs`, and `server.mjs`. Its Cloud Shell regression passed:
  mode-0600 input files became mode-0644 image files and UID 1000 successfully
  imported the application modules with networking disabled. The current
  deployed digest came from the derived chmod layer, not a full source rebuild.

The patched image reports Linux/amd64, configured user `node`, and entrypoint
`/opt/CrowdStrike/rootfs/bin/falcon-entrypoint docker-entrypoint.sh`, with
`node server.mjs` as its command.

## Checks performed

- The base image's existing proxy suite passed with 40 tests, 0 failures and 0
  skips, with outbound networking disabled.
- The patched image's application suite also passed with 40 tests, 0 failures
  and 0 skips, using the Node entrypoint and no network. This intentionally
  bypassed the Falcon entrypoint and proves application behavior only.
- A local default-entrypoint smoke could not start the sensor because local
  Docker has no Cloud Run metadata service. The redacted error was an invalid
  `CLOUDRUN` metadata input; this is not evidence that the Cloud Run
  configuration is invalid.
- The first private Cloud Run revision, `kaplan-image-proxy-00001-5pw`,
  accepted `CLOUDRUN` but failed at startup when Falcon's metadata helper
  received `run.services.get` denied for
  `quiz-platform-image-gen-sa@quiz-platform-image-generation.iam.gserviceaccount.com`.
- After David's service-level `roles/run.viewer` grant was verified, the
  second revision, `kaplan-image-proxy-00002-sr8`, failed with `EACCES` on
  `/app/server.mjs`. Offline image inspection found `/app` mode 0755 and all
  three copied `.mjs` files root-owned mode 0600. The earlier 40-test runs
  mounted the source checkout and therefore did not test baked-file access as
  UID 1000 (`node`).
- A repaired baked-application probe ran as UID 1000 (`node`) and imported all
  application modules. Its offline assertions passed: missing application
  bearer returned 401 `UNAUTHORIZED`, an authenticated invalid
  model returned 400 `BAD_REQUEST`, and both responses included
  `Cache-Control: no-store`.
- The live private service passed the same 401/400/no-store assertions using a
  Google identity token in `X-Serverless-Authorization` plus the separate
  application bearer. The probe made zero Vertex calls.
- Cloud Run remains IAM-private: there are no public invoker bindings and
  `invoker-iam-disabled=false`. The ready revision is receiving 100% traffic,
  but Falcon console reporting and public-access approval are still pending.
- Ready revision logs show successful Falcon TLS connection and TCP startup,
  with no metadata permission denial or application `EACCES` in the queried
  records. These do not replace SecOps console verification.
- A later read-only Cloud Shell CrowdStrike check authenticated successfully
  (OAuth 201), but the inventory request for the exact deployed image digest
  returned 403. No secret values were printed and no additional scope was
  requested; this cannot substitute for SecOps verification in the Falcon
  console.
- No real Vertex generation or paid call occurred. No prompt, Falcon secret,
  application secret, or provisioning token was printed into the evidence.

## Future builds

The service-level `roles/run.viewer` grant is verified and the derived chmod
image is now running successfully. The `COPY --chmod=0644` regression passed.
For later full source rebuilds, retain the updated
`kaplan-image-proxy/Dockerfile`, verify the baked files are readable by UID
1000 (`node`), then repatch and push an immutable image. Do not redeploy
the previous digest listed above; it is retained for provenance only.

The fix requires no project-wide Viewer, Run Admin, Invoker, public access, or
sensor bypass. It only normalizes the three application file modes while
retaining `USER node` and the Falcon entrypoint.

## Deployment and acceptance gates

The service configuration already uses the approved values: Gen 2,
`us-central1`, the dedicated runtime identity, `VERTEX_LOCATION=us`, pinned
`KAPLAN_PROXY_SHARED_SECRET` version 1, `CS_CLOUD_SERVICE=CLOUDRUN`,
`CS_CONTAINER=crowdstrike-secured`, min instances 0, and max instances 1.
The runtime identity's Secret Manager access to the application secret was
confirmed. Revision `kaplan-image-proxy-00003-spz` is ready with 100% traffic,
but the service remains private and Falcon's console reporting is not yet
verified. The required tenant provisioning-token policy remains subject to
runtime/SecOps verification; no literal placeholder may be used.

Remaining acceptance steps:

1. Give SecOps the ready revision and confirm Falcon host reporting.
2. Keep the service IAM-private until SecOps approves the public-facing
   architecture and an authorized administrator grants public invocation.
3. After public access is approved, merge and deploy the reviewed PR #103 with
   the deployed URL and matching `KAPLAN_PROXY_SECRET`; the main Worker
   deployment below is already complete.
4. Use the live host test to record the returned images, `costUsd`, and the
   two-variant result. Keep the #19 paid-generation ledger at five or fewer
   cumulative calls, counting retries; #21's live-host acceptance is separate.

The proposed Cloud Storage counter in PR #102 is waived for this pilot because
Kaplan already tracks spending and Analytics is building the Redshift view.
That provides reporting, not an automatic proxy spending cap.

## Worker and #21 readiness

The approved schema deployment is complete. Production and the local migration
ledger now pair through `0001`–`0045`; `0044_battle_score_event_identity.sql`
and `0045_player_battle_submission_state.sql` were applied successfully.
Post-schema checks are all true: `battle_identity_column_exists`,
`matchup_index_exists` (`score_events_battle_matchup_once_idx`),
`prior_index_removed` (`score_events_battle_once_idx`), and
`submission_status_present` in `get_player_battle_state`.

The main Worker production deployment is also complete. Cloudflare build
`1b11694c-769e-4e89-945c-80228b818ce6` used the corrected command
`npm test && npm run prepare:deploy` from main commit
`2ca966729250d4e96b99af867ac4ad0bc78f98b2`, with 977/977 CI tests and 25
prepared top-level assets plus fonts. Live version
`24d6a606-8a26-4d04-8164-14de57d17189` has 100% traffic.

Both `https://brainstorm.matthewbelinkie.com` and
`https://wild-haze-73b3.matthew-belinkie-3af.workers.dev` return that version.
All 47 recursive public files return HTTP 200 and match the prepared release
byte-for-byte by SHA-256. Anonymous `POST /battle/generate {}` returns 401
`Player authorization is required` with `Cache-Control: no-store` on both
hosts; no provider call occurred. Evidence is retained in
`cloudflare-live-verification.json` and `cloudflare-production-deployed.jpg`
in the existing durable artifact root.

This completes the main Worker deployment, not the future Kaplan wiring. Draft
PR #103 is not merged or deployed, `OPENROUTER_API_KEY` remains unconfigured,
and paid model-test approval is pending. After SecOps verifies Falcon reporting
and an authorized administrator approves public invocation, configure and
deploy PR #103 with the proxy URL and matching `KAPLAN_PROXY_SECRET`, then run
authenticated live-host acceptance. No authenticated gameplay, paid model
test, or Kaplan Worker deployment is claimed complete.

## Reproducibility and privacy

The detailed Cloud Shell evidence is retained privately by Matthew in the
dated deployment record `kaplan-cloud-shell-build.md`. Machine-local paths,
raw logs and credential material are not part of this public handoff.
The Cloud Shell checkout, temporary logs, and local images are disposable.
Rebuild from the pinned source and verify the immutable registry digest before
retrying. Retrieve Falcon and application secrets only into a temporary shell
with tracing disabled; never put them in Docker arguments, source, email,
committed files, or retained output. Do not use the root Dockerfile: the build
context is `kaplan-image-proxy/`.
The previous patched digest is retained for provenance, not as a deployment
candidate. The derived chmod digest is the current private runtime candidate;
the next routine build should come from the corrected Dockerfile.

## References

- [Kaplan CrowdStrike Cloud Run SOP](https://drive.google.com/file/d/1eC_myi7xOK1_CKrAZjLg568QI8V6dxpt/view)
- [CrowdStrike container pull script documentation](https://developer.crowdstrike.com/falcon-sensor/scripts/bash/container-sensor-pull/)
- [CrowdStrike falconutil action](https://github.com/CrowdStrike/falconutil-action)
- [Cloud Run secret references](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- [Cloud Run IAM roles and permissions](https://docs.cloud.google.com/iam/docs/roles-permissions/run#cloud_run_viewer)
- [PR #101](https://github.com/mbelinkie/brainstorm/pull/101)
- [PR #103](https://github.com/mbelinkie/brainstorm/pull/103)

The remaining proof is Falcon console reporting, the SecOps/public-access
decision, authorized public invocation, Kaplan Worker wiring/configuration and
deployment, authenticated live-host acceptance, and the bounded paid-generation
checks.
