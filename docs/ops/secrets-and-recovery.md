# Secrets and Recovery Inventory

Documentation only. Names and procedures only — no credential values, no token examples, no private absolute paths. Owner: Matthew.

Related: [RUNBOOK.md](../../RUNBOOK.md), [DEPLOYMENT.md](../../DEPLOYMENT.md).

## Worker server-side secrets

| Name | Class | Provisioning |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | privileged | Reissue from Supabase project API settings; owner configures it as a Cloudflare Worker secret only. |
| `SUPABASE_URL` | publishable configuration, stored as a Worker secret | Owner sets it in Worker secret configuration. |
| `SUPABASE_PUBLISHABLE_KEY` | publishable browser configuration | Reissue/update in Supabase; safe to serve to browsers. |
| `SUPABASE_SECRET_KEY` | legacy admin name in `.env.example` | Never browser-served; not used for backup. No evidence it is currently deployed. |

Rules:

- Privileged service-role/admin credentials must never be served to browsers or included in backups.
- Worker-only values are set through the provider's secret workflow; see DEPLOYMENT.md.

## Local env files

- `.env.local` and `.dev.vars` are names only in this document.
- Recreate them manually from the issuing providers. They are never backed up, read, or copied by any procedure described here.

## AI binding

- Current Workers AI usage runs through the Cloudflare `AI` binding and needs no provider API key.
- The binding is restored/configured by the owner.
- No `OPENROUTER_KEY` deployed claim: an adapter exists, but the live Worker route currently uses Workers AI only.

## Kaplan image proxy

- Proxy code exists in the repository.
- Cloud Run deployment (#19) and deployed Worker enable/config (#21) are pending.
- Planned Worker-side names: `KAPLAN_PROXY_SECRET` (shared bearer secret) and `KAPLAN_PROXY_URL` (endpoint configuration).
- Proxy-side required env: `PROXY_SHARED_SECRET` — the same bearer value, provisioned by the owner on both sides. No value appears in this document.
- Rotation: rotate both ends coherently through owner-approved configuration, then verify through an authorized host check. No actual rotation or deployment is performed.
- `GOOGLE_CLOUD_PROJECT` and `VERTEX_LOCATION` are configuration, not secrets. The serving location must be the explicitly owner-approved one.
- Vertex access uses the attached Cloud Run service account via ADC. No downloaded service-account key file and no Workload Identity Federation are needed for this route.

## Owner CLI credentials

- Supabase CLI login/link, plus Docker as a prerequisite for dumps and media copy.
- GitHub CLI authentication with repo, read:org, and project access for the gate-backed roadmap export.
- Logins are reissued by the owner; CLI tokens are stored by the CLI itself and are not backed up or printed.

## Backup scope

Included:

- Supabase public schema and data.
- Author quiz media.
- Optional raw original copy.
- Roadmap JSON.

Excluded:

- No auth schema dump.
- No battle images (30-day retention).
- No secrets.

Restore order and rules:

- Recreate auth users before restoring public-schema data that references them by foreign key.
- Keep the media bucket private; restore through the documented procedure.

Important: database and media backup hashes do NOT restore credentials. Credentials are reissued from their issuers.

## Status and ownership

- Actual backup and restore remain unverified under #55; Kaplan Drive copy, location, access, retention, and a successful restore are tracked separately.
- Owner: Matthew. Never claim a real backup, policy acceptance, or successful restoration.
- No automated restore, upload, or schedule is added here.