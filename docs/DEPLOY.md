# Deploying

Three workflows, in the order they run:

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every push and PR to `main` | Builds, typechecks, runs 1180 unit tests and three e2e suites against real services. |
| `deploy.yml` | **CI finishing successfully** on `main` | Builds six images, pushes them tagged by commit SHA, ships them, verifies health, rolls back if unhealthy. |
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

**The app ports are closed to everyone except CloudFront** — by a security
group, not by a host firewall, and a host firewall can no longer close them
anyway. This section prescribed one until item 26:

```bash
# DO NOT RUN THIS on the current box — it takes the public stack down.
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw --force enable
```

It is kept here, struck, rather than deleted, because it reads exactly like
the security hardening it was written as and someone will otherwise
reintroduce it. `6ea0288` put six CloudFront distributions in front of the
browser-facing ports (see **1c** below), and **CloudFront reaches the origin
from outside the box, over those same ports** — `<ip>.nip.io:9102` and
friends. Denying those ports denies CloudFront, every distribution starts
failing to reach its origin, and the whole public stack goes dark while the
command that did it looks like a precaution.

So the honest statement of where this stands:

- **9102–9108 accept traffic only from CloudFront**, enforced by security
  group `sg-076d5586e14f1459e`, which allows `tcp/9102–9108` from AWS's
  managed prefix list `pl-a3a144ca`
  (`com.amazonaws.global.cloudfront.origin-facing`). Verified from off the
  box: a direct `curl` to `63.187.144.212:9102` times out while the same
  service answers 200 through its distribution.
- **SSH on port 22 is open to `0.0.0.0/0`** in the other group,
  `sg-0a8b8a22be7cf9909` — see **1e**. That is now the widest thing on this
  box.
- **`integration-api` on 9107 is reachable by nothing external.** It is
  inside the allowlisted range, but no distribution fronts it, so CloudFront
  never calls it and the prefix list denies everyone else. Internally
  `operator-demo` reaches it over the compose network, which is why nothing
  appears broken — see **1e**.
- **The end state is still item E** — a gateway terminating TLS on the box
  itself, at which point the app ports stop being published at all and the
  health check goes through the proxy. The security group narrows *who* can
  reach the published ports; it does not stop them being published, and the
  traffic from CloudFront to the origin is still plain HTTP.

Mongo, Redis and MinIO are closed outright — no published port at all on a
deployed box, by the overlay below rather than by a firewall, because Mongo
has no authentication.

### 1b. The staging overlay

`infra/docker-compose.staging.yml` is what makes the stack safe on a box that
is not a laptop. Two changes: **Mongo gets no published port** (this stack
runs it with no authentication, so a public address means anyone can read or
drop every collection), and every service gets `restart: always`.

You do not pass it by hand. The deploy writes
`COMPOSE_FILE=docker-compose.yml:docker-compose.staging.yml` into
`infra/.env`, and compose reads that exactly as if the `-f` flags had been
given — so every `docker compose` in both workflows stays bare and none of
them can disagree about which files are in play. If you run compose on the
box manually, `cd $DEPLOY_PATH/infra` first and it applies automatically.

It is called `staging` rather than `production` on purpose. Nothing here has
served a real player yet, and a deployment history claiming production makes
the first genuine one indistinguishable from this. Rename it when that stops
being true.

### 1c. TLS, and where it actually lives

**Nothing in this repository creates or configures the TLS layer.** That is
the single most important thing to know about it: the six CloudFront
distributions in front of this stack were created by hand in the AWS
console, they are not in `deploy.yml`, not in any compose file, and not in
Terraform. A clean clone plus the secrets below reproduces the *box*, not
the HTTPS in front of it. Recorded here because it existed only in
`6ea0288`'s commit message until item 26, which meant the only way to learn
the deployment had a TLS layer was to read git log.

Why CloudFront rather than the gateway item E describes: that gateway needs
a hostname and a certificate, and this account has neither — Route 53
Domains refuses Free Tier accounts, and Let's Encrypt will not issue for the
`ec2-*.amazonaws.com` name AWS assigns. CloudFront hands out a trusted
`*.cloudfront.net` certificate for free, so each distribution fronts one
published port and terminates HTTPS there.

Each row below was confirmed against what the distribution actually answers
today — the two API rows by their `/health/ready` payload naming the
service, the three page rows by their `<title>` — rather than inferred from
the variable names, which is how the port column came out wrong the first
time.

| Distribution | Fronts | Host port | Repository variable |
|---|---|---:|---|
| `d39x0089nxs6ls` | game-frontend | 9104 | `PUBLIC_GAME_FRONTEND_URL` |
| `dk0v1coh4j76p` | backoffice-frontend | 9106 | `BACKOFFICE_CORS_ORIGINS` |
| `doznfrj38w1op` | operator-demo | 9108 | — |
| `d3o61up86kzcn` | game-backend | 9102 | `PUBLIC_GAME_BACKEND_URL` |
| `d377drvfmw1hda` | game-socket | 9103 | `PUBLIC_GAME_SOCKET_URL` |
| `d3tecd275gihq4` | backoffice-api | 9105 | `PUBLIC_BACKOFFICE_API_URL` |

Note the range is **9102–9106 plus 9108**, not the contiguous "9102–9106"
this document said throughout. `integration-api` on 9107 is the one
published port with no distribution in front of it, because operators call
it server-to-server with a signed request and never from a browser.

Two things follow from this that are easy to get wrong:

- **The origin hostname is `<ip>.nip.io`, not the bare IP**, because a
  CloudFront custom origin must be a DNS name. `nip.io` resolves
  `1.2.3.4.nip.io` to `1.2.3.4`, so it is a way of spelling the address, not
  a third party in the request path — but it *is* a public DNS service this
  deployment now depends on for name resolution.
- **The APIs had to be fronted too, not just the pages.** An HTTPS page
  cannot call an `http://` endpoint, so serving the frontends over TLS while
  leaving 9102/9103/9105 bare would produce pages that load and then
  silently fail every request. That is why there are six distributions and
  not two.

**If the box's IP changes, every distribution breaks**, because the origin
is the IP spelled as a hostname. Recreating them is manual, and so is
updating the six repository variables above. An Elastic IP is the obvious
guard and is not currently attached.

### 1d. The origin allowlist — already applied, by a route worth knowing

**This is done, and it was done before the script that generates it was
written.** Security group `sg-076d5586e14f1459e` allows `tcp/9102–9108` from
`pl-a3a144ca` and nothing else. Two documents claimed otherwise for a day
(item 26 and the first version of this section), because both were written
from reading the repository rather than from reading the box.

**The applied rule uses AWS's own managed prefix list**, which is better
than what the script below proposes building: `pl-a3a144ca` is
`com.amazonaws.global.cloudfront.origin-facing`, maintained by AWS, 46
entries matching the script's output exactly. **AWS updates it**, so the
"nothing watches for the ranges changing" caveat does not apply to the rule
that is actually in force — it applies only to a hand-built copy. Prefer the
managed list; it is one rule, it never drifts, and it costs no maintenance.

The script remains useful for the `ufw` form (a box outside AWS has no
prefix lists), for `--check`, and for the traps below, which are exactly the
mistakes a hand-built list invites.

```bash
node scripts/cloudfront-origin-allowlist.mjs              # ufw rules
node scripts/cloudfront-origin-allowlist.mjs --format=sg  # AWS security group
ORIGIN_HOST=63.187.144.212 \
  node scripts/cloudfront-origin-allowlist.mjs --check    # verify the live box
```

The script prints rules and never applies them, and has no `--apply` flag on
purpose: the ordering below is the difference between a hardened box and one
nobody can SSH into, and that belongs in a human's hands with the output in
front of them.

**Three traps, each measured against the live `ip-ranges.json` rather than
reasoned about.** Each produces a rule that looks right and takes the stack
down:

1. **Do not filter by the box's region.** The intuitive rule — "the box is
   in `eu-central-1`, so take `eu-central-1` prefixes" — yields **zero**
   prefixes. 44 of the 46 origin-facing ranges are `GLOBAL`; the only two
   regional ones are `ap-northeast-2` and `me-central-1`. An empty allowlist
   denies everything and reads like a successful run. An earlier draft of
   this document said `AWS_REGION`/`CLOUDFRONT_ORIGIN_FACING`, which implied
   exactly this filter.
2. **`CLOUDFRONT_ORIGIN_FACING`, not `CLOUDFRONT`.** Different sets, and not
   by inclusion — **34 of the 46 origin-facing prefixes are absent from the
   211-prefix `CLOUDFRONT` set**. `CLOUDFRONT` is the edge ranges that serve
   *viewers*; the origin-facing set is the one that talks to *you*. Using
   the bigger list is both wrong and more permissive.
3. **IPv6 is a real branch.** There are 3 origin-facing IPv6 prefixes. If
   the box has a v6 address, a v4-only allowlist leaves v6 either wide open
   or fully closed depending on the default policy.

**The script omits 9107 and the applied rule does not**, which is a real
difference rather than a rounding error. The rule is a single
`9102–9108` range, so it includes `integration-api`; the script lists the
six fronted ports individually and leaves 9107 out on the reasoning that
operators call it server-to-server and allowlisting CloudFront to it would
close it to its only callers. That reasoning is sound and the applied rule
still has the effect the script was trying to avoid — see **1e**.

**Verify from off the box, and verify both halves.** That CloudFront still
answers proves the allowlist did not lock it out; that a direct request no
longer answers proves the rule does anything. Either alone is consistent
with a broken configuration, which is why `--check` reports the direct half
as SKIPPED rather than passing when `ORIGIN_HOST` is unset. Current result:
all three distributions 200, all six ports refused directly.

**Re-running matters only for a hand-built list.** The applied rule
references AWS's managed prefix list, which AWS keeps current. A copy made
by the script is a snapshot and does go stale.

### 1e. Two things the security groups say that nothing else does

Both found by reading the live groups after `aws login`, having previously
described this box's network posture from the repository alone.

**SSH is open to the entire internet.** `sg-0a8b8a22be7cf9909` allows
`tcp/22` from **both** `91.151.137.4/32` and `0.0.0.0/0`. The specific
address is inert — the wildcard beside it already admits everyone — so the
rule reads like it restricts SSH to one office while doing nothing of the
kind. Confirmed reachable: a TCP connect to port 22 from an unrelated
address succeeds.

With the app ports now narrowed to CloudFront, **this is the widest opening
on the box**, and it is the one an attacker would actually work on. The fix
is to drop the `0.0.0.0/0` entry and keep the `/32`, which is a one-line
change with a real hazard attached: doing it from an address not covered by
the remaining rule ends the session applying it, and the deploy's own SSH
would break if it runs from a GitHub-hosted runner whose address is not in
the list. That makes it a decision about how the deploy reaches this box,
not a quick tidy — recorded in `docs/TODO.md` item 29 rather than done
casually.

**No external operator can reach `integration-api`.** Port 9107 is inside
the allowlisted range, so the security group permits CloudFront to it — but
no distribution fronts 9107, so CloudFront never calls it, and the prefix
list denies everyone else. The port is therefore reachable by nothing
outside the box.

Nothing looks broken, because the only current caller is `operator-demo`,
which reaches it as `http://integration-api:9006` over the compose network
and never touches the published port. So the integration surface — the
signed wallet, launch and catalogue calls that item 10 built, and the whole
point of `docs/INTEGRATION.md` — is currently unreachable by a real
operator, and every internal test of it passes. `docs/TODO.md` item 30.

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
| `SECRETS_ENCRYPTION_KEY` | Encrypts operator API secrets at rest. **Exactly 64 hex characters** (`openssl rand -hex 32`) — integration-api refuses to boot on anything else, so a truncated paste fails the deploy rather than the first operator request. Losing this value makes every stored operator credential unrecoverable; they must be re-issued through the backoffice. |
| `ASSET_ACCESS_KEY` | Object-storage access key. Uploads fail with `storage_not_configured` without it; nothing else breaks. |
| `ASSET_SECRET_KEY` | Object-storage secret key. |
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
| `MONGO_URI` | `mongodb://mongo:27017/slots_engine?replicaSet=rs0` | Only needed to point the stack at a database **outside** this compose file — a managed cluster, say. The default addresses the `mongo` service in-network and is right for the bundled one. Do **not** add `directConnection=true`: it suppresses replica-set topology discovery, and the money path's transactions depend on that surviving a failover. |
| `REDIS_URL` | `redis://redis:6379` | Where the HTTP rate limiters keep their counters. Absent is supported — each service counts in its own memory, which is correct for **one** instance. Set it before running two behind a load balancer, or the effective ceiling is double the configured value because neither instance sees the other's count. Required for a zero-downtime deploy, which runs two instances at once by definition. |
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

- **No second tier.** There is one box, and `docker-compose.staging.yml` is
  what it runs — the name says the deploy does not claim to be production,
  not that a separate production tier exists behind it. Promoting a release
  between two tiers would need somewhere to put the second one.
- **TLS at CloudFront, no reverse proxy on the box.** Browsers reach the
  stack over HTTPS through six CloudFront distributions (see *TLS* above);
  the services themselves still speak plain HTTP on their published ports,
  and those ports are still reachable directly. So TLS is real for anyone
  using the HTTPS URLs and absent for anyone who goes straight to the
  origin — CloudFront is in front, not in the way.

  The right shape remains a gateway terminating TLS on the box, routing over
  the compose network, which then lets the app ports be unpublished the way
  Mongo's already is and lets the health check go through the proxy instead
  of `localhost:9102`. That needs a hostname and a certificate the account
  cannot currently get (item E), which is why CloudFront is standing in.
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
