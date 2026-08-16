# Deploying

Three workflows, in the order they run:

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every push and PR to `main` | Builds, typechecks, runs 1096 unit tests and three e2e suites against real services. |
| `deploy.yml` | **CI finishing successfully** on `main` | Builds five images, pushes them tagged by commit SHA, ships them, verifies health, rolls back if unhealthy. |
| `rollback.yml` | manual | Puts production back on a named earlier release. |

## The one design decision worth reading

`deploy.yml` triggers on `workflow_run` — it waits for CI to *finish* and
reads its conclusion — rather than on `push` alongside CI.

The `push` form is the obvious shape and it is subtly wrong: it makes CI and
deploy two independent reactions to the same event. They start together, so a
commit whose tests are still running, or have already failed, gets built and
shipped anyway. The gate exists and gates nothing.

That is the whole of item 1 in `docs/TODO.md`: "CI is green" should mean the
thing that is green is the thing that shipped.

The `build` job additionally checks `github.event.workflow_run.conclusion ==
'success'`, because `workflow_run` fires on failure too.

## Current state: images build, nothing deploys

No deploy target is configured, so `deploy.yml` builds and pushes images and
then **stops, with a warning annotation and a job summary naming the missing
secrets**.

It deliberately does not fail. A workflow that is red on every run trains
everyone to ignore a red X, and the first genuine failure then goes unnoticed.
It also deliberately does not pass silently — a pipeline reporting success
without deploying is the exact failure item 1 describes, one layer down.

Building on every commit is worth having on its own: it proves the production
Dockerfiles still build from a clean checkout, which CI does not check. CI
builds with `npm run build` on the runner, not through the multi-stage image.

## Turning the deploy on

### 1. A host

Any Linux box with Docker and Docker Compose, reachable over SSH. It never
compiles anything — it pulls images and runs them — so it needs no Node
toolchain and no source checkout beyond `infra/`.

### 2. Repository secrets

`Settings → Secrets and variables → Actions → Secrets`

| Secret | What it is |
|---|---|
| `DEPLOY_SSH_HOST` | Hostname or IP of the box. |
| `DEPLOY_SSH_USER` | User to connect as. Must be able to run `docker`. |
| `DEPLOY_SSH_KEY` | **Private** key, full PEM including the header and footer lines. Generate a dedicated one: `ssh-keygen -t ed25519 -f deploy_key -N ""`, then append `deploy_key.pub` to the box's `~/.ssh/authorized_keys`. |
| `DEPLOY_SSH_KNOWN_HOSTS` | Output of `ssh-keyscan -H <host>`. Optional but recommended — see below. |
| `SERVICE_AUTH_SECRET` | Signs internal service-to-service requests. |
| `LAUNCH_TOKEN_SECRET` | Signs launch tokens. Must differ from the above. |
| `BACKOFFICE_JWT_SECRET` | Signs backoffice sessions. |
| `BOOTSTRAP_ADMIN_PASSWORD` | First administrator's password. Change it after the first sign-in. |

The three signing secrets have startup guards that refuse weak or missing
values, so a bad one fails at boot rather than silently. Generate them with
`openssl rand -hex 32`.

**On `DEPLOY_SSH_KNOWN_HOSTS`:** without it the workflow falls back to
`ssh-keyscan` at deploy time, which trusts whatever answers on the day. That
is how a deploy lands on the wrong box. The workflow warns when it is missing.

**Why a key rather than a password:** a key is revocable without changing a
human's login, cannot be shoulder-surfed, and does not appear in a process
list on the runner.

### 3. Repository variables

`Settings → Secrets and variables → Actions → Variables` — these are not
secret and are visible in logs, which is correct for all of them.

| Variable | Default | What it is |
|---|---|---|
| `DEPLOY_PATH` | `/opt/slots-engine` | Where `infra/` is synced on the box. |
| `BOOTSTRAP_ADMIN_EMAIL` | — | First administrator's email. |
| `MONGO_DB` | `slots_engine` | Database name. |
| `GAME_CORS_ORIGINS` | — | Origins allowed to call game-backend. |
| `SOCKET_ALLOWED_ORIGINS` | — | Origins allowed to open a WebSocket. |
| `BACKOFFICE_CORS_ORIGINS` | — | Origins allowed to call backoffice-api. |
| `PUBLIC_GAME_BACKEND_URL` | — | Baked into the game frontend **at build time**. |
| `PUBLIC_GAME_SOCKET_URL` | — | Baked into the game frontend **at build time**. |
| `PUBLIC_BACKOFFICE_API_URL` | — | Baked into the backoffice frontend **at build time**. |

The three `PUBLIC_*` values are compiled into the JavaScript bundle by Vite,
so they **cannot be changed by restarting a container**. Pointing a frontend
at a different backend is a rebuild. Set these before the first deploy.

### 4. A `production` environment

`Settings → Environments → New environment → production`

The workflows already name it. Creating it gives you a deployment history
page, and lets you add a required reviewer if you want a human to approve
each deploy.

## How a release is identified

Every image is tagged with the **full commit SHA**, and `latest` alongside it.
Only the SHA is used for deploying and rolling back: `latest` is a moving
target and cannot be rolled back *to*.

The box keeps the SHA it is running in `$DEPLOY_PATH/.released`, written only
after a successful start — so it always names a release that actually ran.
That file is what makes automatic rollback possible.

## Rollback

**Automatic.** If the health check fails after a deploy, the workflow puts
the previous release back without being asked. The moment production is
broken is the worst time to ask someone to find the right SHA and type it
correctly.

**Manual**, for the more common case — a deploy that started cleanly and
turned out to be wrong an hour later, which no automation can detect:

`Actions → Rollback → Run workflow`, and give it the full 40-character SHA.

The rollback:

- refuses anything that is not a full SHA, and refuses `latest` explicitly;
- **verifies every image exists in the registry before stopping anything**,
  so rolling back to a pruned tag cannot take production down and leave it
  there;
- does not rebuild — it pulls the exact bytes that ran before. A rebuild of
  the same source is not necessarily the same image: base layers and
  transitive dependencies move underneath an unchanged Dockerfile.

`rollback.yml` shares a concurrency group with `deploy.yml`, so the two can
never run at once and leave the box half on each release.

## Local development is unchanged

Every service in `infra/docker-compose.yml` carries both `image:` and
`build:`. `docker compose up --build` compiles from source exactly as before
and tags the result `slots-engine/<service>:local`.

That default name is chosen so it cannot be confused with a released image,
and so a `docker compose pull` without `REGISTRY` set fails loudly rather
than quietly fetching someone else's image.

## What this pipeline still does not do

Stated because a deploy pipeline that overstates itself is the problem item 1
was written about.

- **No staging environment.** It deploys straight to production, gated on
  CI. For a single-box deployment that is the honest trade; a staging tier
  would need somewhere to put it.
- **No zero-downtime deploy.** `docker compose up -d` recreates changed
  containers, so there is a short gap. Real zero-downtime needs a load
  balancer and two instances per service — which is also blocked on item 3b,
  since the rate limiters count in each process's own memory.
- **No database migrations.** `applySchemas` runs at boot and is
  additive-only. A change needing real data migration has no path here yet.
- **Secrets are environment variables**, injected from GitHub Actions. That
  is better than a committed file and is not a secret manager with rotation
  — item 4.
- **The rollback does not roll back the database.** Restoring old code
  against a schema the new code changed is only safe while migrations remain
  additive, which is true today and is worth re-checking when it stops being.
