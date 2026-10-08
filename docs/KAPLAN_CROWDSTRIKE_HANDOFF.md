# Kaplan proxy: CrowdStrike build and deployment handoff

Prepared October 8, 2026 for issues #94 (build/push) and #19 (deployment).
Docker execution stays on Matthew's work machine. This is preparation, not
evidence of an image build, secret access, deployment or successful model call.

## What changed

Authenticated Secret Manager now confirms `CS_FALCON_CLIENT_ID`,
`CS_FALCON_CLIENT_SECRET`, and `CS_FALCON_CID` exist in
`quiz-platform-image-generation`. Selecting all three shows
`matthew.belinkie@kaplan.com` with Secret Manager Secret Accessor on **3 of 3**.
Each secret has an **enabled version 1**. Values have not been retrieved;
sensor-download authentication remains untested.
The existing Artifact Registry destination is
`us-central1-docker.pkg.dev/quiz-platform-image-generation/quiz-app-repo`.

The [Kaplan CrowdStrike SOP](https://drive.google.com/file/d/1eC_myi7xOK1_CKrAZjLg568QI8V6dxpt/view)
patches an application image using `falconutil`; it does not supply a replacement
application Dockerfile. Keep the minimal `kaplan-image-proxy/Dockerfile`, build
it, then inject the sensor into that image. The root Dockerfile packages a
different application. Deploy only the patched image, with Gen 2.

The old #94 procedure's unpatched push is insufficient. An offline smoke check
proves application behavior; it cannot prove sensor reporting. David requires
SecOps review and verified Falcon reporting before public access.

## Inputs to settle before patching/deployment

- Confirm the work-machine OS. The SOP extracts a Linux x86_64 `falconutil`
  binary. Bash on Windows or macOS alone does not make it executable; use an
  approved Linux environment with access to the Docker daemon. Do not improvise
  a new privileged container or broaden daemon access.
- Confirm the CrowdStrike tenant region and API download scopes with Security.
  The pull script's default region is not evidence of Kaplan's region.
- Resolve the SOP's `{token}` placeholders: Security must say whether this
  tenant requires a sensor provisioning token and provide the approved secure
  source if it does. The API client secret is not a provisioning token. Do not
  bake a provisioning token into the patched image without Security's explicit
  instruction on that handling. A literal placeholder must never be deployed.
- Confirm the approved live `VERTEX_LOCATION`: `global`, `us`, or `eu`.
  Artifact storage and Cloud Run region `us-central1` do not choose it.
- Arrange the separate application `PROXY_SHARED_SECRET`, whose exact value
  becomes the Worker's `KAPLAN_PROXY_SECRET`. None of the Falcon credentials
  serves this purpose. Keep values out of source, command-line literals and
  retained output. If runtime secrets are referenced from Secret Manager,
  verify the attached service account's access; Matthew's grant is not its grant.

## Work-machine build/push (#94)

1. Use the fresh checkout and pinned source from #94:
   `0404395682f477a25e641f9ab4ee906378b4b019`. Verify the exact commit and clean
   checkout. Authenticate only as `matthew.belinkie@kaplan.com`; do not download
   a service-account key. Verify Docker CLI/daemon, gcloud and curl.
2. Build from `kaplan-image-proxy/` for `linux/amd64`. Run the existing 40
   fixture tests under the base image's Node runtime with outbound networking
   disabled, mounting `test/` and `kaplan-image-proxy/` read-only as in #94
   (the Dockerfile does not copy test files). Verify the base application runs
   as `node`.
3. With shell tracing disabled, retrieve the three Falcon secrets into the
   temporary task shell, mapping names as follows. Check exit status and
   nonempty values before continuing; never print them or ask an AI to read
   their values. Do not add Docker `ARG`/`ENV` credentials or secret files to
   the build context.

   | Secret Manager name | Pull/patch shell variable |
   | --- | --- |
   | `CS_FALCON_CLIENT_ID` | `FALCON_CLIENT_ID` |
   | `CS_FALCON_CLIENT_SECRET` | `FALCON_CLIENT_SECRET` |
   | `CS_FALCON_CID` | `FALCON_CID` |

4. Follow SOP sections 3.2–3.4 using Kaplan's confirmed tenant region and
   token instructions. Use the vendor's official pull script, retain its
   version/checksum and the actual sensor image digest, and select x86_64.
   Substitute the existing `quiz-app-repo` for the SOP's sample repositories;
   do not create `falcon-repo` or `app-repo`. Patching requires
   `--cloud-service CLOUDRUN`. Keep source and sensor images cached locally
   and use `--image-pull-policy IfNotPresent`: the vendor documents that
   `falconutil` does not support the gcloud Docker credential helper.
5. Inspect the patched image's actual architecture, configured user and
   entrypoint. Verify sensor injection and retain redacted evidence. Do not
   assume the patched entrypoint or user is identical to the base image, or
   change user/permissions to work around a failed sensor startup.
6. Smoke-test the **patched** image's default entrypoint with a synthetic
   application secret and no external network. Verify 401 without the bearer
   secret, 400 for an invalid model, and `Cache-Control: no-store` on both;
   inspect logs for prompt/credential exposure. No valid generation request.
   If the sensor cannot start offline, report the result and follow Security's
   approved verification instructions; do not bypass the sensor to call the
   patched-image check passed. The base-image tests remain separate evidence.
7. Push the approved sensor mirror and patched application image only to the
   existing repository, under unique tags. Stop on tag collisions; do not
   overwrite earlier images. Return the **patched registry manifest digest**,
   not the base image ID, alongside source commit, sensor digest, tool versions,
   test/smoke results and sanitized errors. Unset task credential variables.

Sensor download/registry access uses network. Fixture tests and offline smoke
do not call Vertex. All build, patch and push commands remain Matthew's action.
This updated handoff prepares the sensor steps; it does not establish that
Security's unresolved inputs are available or that every command is executable
on the work machine.

## Private deployment, review and final acceptance (#19)

Matthew deploys the returned patched digest with the approved attached identity
`quiz-platform-image-gen-sa@quiz-platform-image-generation.iam.gserviceaccount.com`.
Use `--execution-environment gen2`, `--region us-central1`, min instances 0
and a bounded max-instance setting. Keep the service IAM-private. The SOP's
`--no-allow-unauthenticated` flag can itself require `run.services.setIamPolicy`;
if that operation is refused, stop and have the administrator apply the setting.
A new service is private by default, but verify its actual authentication
policy after deployment rather than treating omission of a flag as evidence.
Preserve both the application's required environment variables and the SOP's
sensor settings (`CS_CLOUD_SERVICE=CLOUDRUN`, `CS_CONTAINER`, and any approved
runtime provisioning-token mapping). Secret references should pin a version;
do not put secret values into `--set-env-vars` or public logs.

Gen 2 alone does not prove the sensor is working. Record the Cloud Run revision,
inspect redacted container logs, and have Security verify that revision's host
in Falcon. Prepare the deployment notification for Matthew to send; this guide
does not authorize an agent to email David or Security.

The external Worker uses application-level bearer authentication and cannot
invoke the initial IAM-private service. After SecOps clears public access, an
authorized administrator must configure invocation on this one service.
Matthew's last observed grants lacked `run.services.setIamPolicy`. Do not grant
broader project access or change the architecture to bypass that gate.

Then retain #19's live 401/400/200 results, image and `costUsd`, exact revision,
attached-account Vertex permission, selected serving endpoint and redacted logs.
The shared bearer value stays secret. Keep a cumulative ledger of at most five
paid generation calls for #19, including earlier attempts; retries count.
Issue #21's live host test is a separate pending acceptance step under its
existing ten-per-session cap. Neither issue is complete from offline fixtures.

## Sources and current verification

- Kaplan SOP: four pages read in authenticated Chrome on October 8, 2026.
- A later read-only GCP check selected the existing Kaplan account and reached
  OneLogin's password screen. Matthew restored the session, and the subsequent
  check verified all three secret names, enabled version 1 on each, and the
  3-of-3 Secret Accessor grant.
  No secret value was opened and no access request was submitted.
- [CrowdStrike image patching and credential-helper limitation](https://github.com/CrowdStrike/falconutil-action).
- [CrowdStrike pull-script variables](https://developer.crowdstrike.com/falcon-sensor/scripts/bash/container-sensor-pull/).
- [Cloud Run secret references and service identity access](https://docs.cloud.google.com/run/docs/configuring/services/secrets).
- [Cloud Run deployment flags](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy).
- [Cloud Run authentication permission](https://docs.cloud.google.com/run/docs/securing/managing-access).

The unchanged proxy suite at source base
`2ca966729250d4e96b99af867ac4ad0bc78f98b2` passed locally: 40 tests,
0 failures, 0 skips (`node --test test/kaplan-proxy.test.js`). There is no diff
in the proxy or its tests between that base and #94's pinned source. This
Node check does not verify a Docker image or the injected sensor.

No secret values were retrieved, no Docker commands ran, no cloud resources
changed and no real generation calls were made while preparing this handoff.
