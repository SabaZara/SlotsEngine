#!/usr/bin/env node
/**
 * Generates the firewall rules that close the app ports to everyone except
 * CloudFront — docs/TODO.md item 26's replacement for the `ufw` command
 * that would have taken the public stack down.
 *
 * The problem it solves. Six CloudFront distributions front this stack's
 * published ports and terminate HTTPS there, but they reach the origin
 * *from the internet*, over those same plain-HTTP ports. So the obvious
 * hardening — deny everything except 80/443 and SSH — denies CloudFront
 * too, and every distribution goes dark. The ports cannot be closed; they
 * can only be narrowed to the source that legitimately uses them.
 *
 * Why this is a script and not a documented command. The allowlist is ~46
 * prefixes, AWS changes them, and every failure mode below is silent in the
 * direction that matters: a wrong rule does not error, it makes the site
 * unreachable, and it does so minutes later when the run finishes rather
 * than while someone is watching. A hand-copied list is also a list that
 * ages without anyone noticing.
 *
 * THREE TRAPS, each of which produces a working-looking rule that breaks
 * the stack. All three were measured against the live ip-ranges.json rather
 * than reasoned about:
 *
 *   1. **Do not filter by the box's region.** The intuitive rule is "my box
 *      is in eu-central-1, so take eu-central-1 prefixes". There are
 *      ZERO origin-facing prefixes in eu-central-1 — 44 of the 46 are
 *      `GLOBAL`, and the two that are regional are ap-northeast-2 and
 *      me-central-1. Filtering by the box's region yields an EMPTY
 *      allowlist, which denies everything and reads like a successful run.
 *      docs/DEPLOY.md said `AWS_REGION`/`CLOUDFRONT_ORIGIN_FACING` before
 *      this script existed, which implied exactly that filter.
 *
 *   2. **`CLOUDFRONT_ORIGIN_FACING`, not `CLOUDFRONT`.** They are different
 *      sets, and not by inclusion: 34 of the 46 origin-facing prefixes are
 *      absent from the 211-prefix `CLOUDFRONT` set. `CLOUDFRONT` is the
 *      edge ranges that serve *viewers*; the origin-facing set is the one
 *      that talks to *you*. Using the bigger list is both wrong and more
 *      permissive, which is the worst pair.
 *
 *   3. **IPv6 is a real branch.** There are 3 origin-facing IPv6 prefixes.
 *      If the box has a v6 address, a v4-only allowlist leaves v6 either
 *      wide open or fully closed depending on the default policy, and which
 *      one is not knowable from here.
 *
 * Output is rules, never applied. This script prints; it does not touch a
 * firewall, and it deliberately has no `--apply`. Applying is a
 * one-way-ish change to a live box's reachability, and the ordering below
 * (allow before deny, SSH first) is the difference between a hardened box
 * and one nobody can log into. That belongs in a human's hands with the
 * output in front of them.
 *
 * Usage:
 *   node scripts/cloudfront-origin-allowlist.mjs                 # ufw, default ports
 *   node scripts/cloudfront-origin-allowlist.mjs --format=sg     # aws ec2 CLI calls
 *   node scripts/cloudfront-origin-allowlist.mjs --ports=9102,9105
 *   node scripts/cloudfront-origin-allowlist.mjs --check         # verify a live box
 */

const IP_RANGES_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";

/**
 * The browser-facing published ports, and the reason each is here.
 *
 * 9107 (integration-api) is deliberately ABSENT from this list, and the
 * rule actually applied to the box does NOT agree with that — it is a
 * single 9102–9108 range, so it includes 9107. The reasoning here is that
 * operators call integration-api server-to-server with a signed request and
 * never from a browser, so allowlisting *CloudFront* to it closes it to its
 * only real callers.
 *
 * That is exactly what has happened on the live box: 9107 is inside the
 * allowlisted range, no distribution fronts it, so CloudFront never calls
 * it and the prefix list denies everyone else — leaving the external
 * integration surface reachable by nothing. docs/TODO.md item 30. Keeping
 * this list at six ports rather than matching the applied rule is
 * deliberate: the applied rule is the one that is wrong.
 */
const FRONTED_PORTS = [
  { port: 9102, service: "game-backend" },
  { port: 9103, service: "game-socket" },
  { port: 9104, service: "game-frontend" },
  { port: 9105, service: "backoffice-api" },
  { port: 9106, service: "backoffice-frontend" },
  { port: 9108, service: "operator-demo" },
];

function parseArgs(argv) {
  const arg = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const ports = arg("ports", "");
  return {
    format: arg("format", "ufw"),
    check: argv.includes("--check"),
    ports: ports
      ? ports.split(",").map((p) => ({ port: Number(p.trim()), service: "(named on the command line)" }))
      : FRONTED_PORTS,
  };
}

async function fetchOriginFacingPrefixes() {
  const res = await fetch(IP_RANGES_URL);
  if (!res.ok) throw new Error(`ip-ranges.json returned ${res.status}`);
  const doc = await res.json();

  // Trap 2, enforced rather than trusted: select on the service name only.
  // No region filter — see trap 1. If AWS ever does publish an
  // origin-facing prefix in the box's region, it is already included here,
  // because every region is.
  const v4 = doc.prefixes.filter((p) => p.service === "CLOUDFRONT_ORIGIN_FACING").map((p) => p.ip_prefix);
  const v6 = (doc.ipv6_prefixes ?? [])
    .filter((p) => p.service === "CLOUDFRONT_ORIGIN_FACING")
    .map((p) => p.ipv6_prefix);

  // An empty result is the failure this whole script exists to prevent, and
  // it is silent: an allowlist of nothing denies everything, and every
  // command below would still run without error. Refuse to emit it.
  if (v4.length === 0) {
    throw new Error(
      "no CLOUDFRONT_ORIGIN_FACING IPv4 prefixes found — refusing to emit rules that would deny every origin request",
    );
  }

  return { v4: [...new Set(v4)].sort(), v6: [...new Set(v6)].sort(), syncToken: doc.syncToken, createDate: doc.createDate };
}

function emitUfw({ v4, v6, syncToken, createDate }, ports) {
  const lines = [];
  lines.push(`# CloudFront origin allowlist — ip-ranges.json syncToken ${syncToken} (${createDate})`);
  lines.push(`# ${v4.length} IPv4 + ${v6.length} IPv6 origin-facing prefixes, ${ports.length} ports.`);
  lines.push("#");
  lines.push("# ORDER MATTERS. SSH first, allows before the default-deny, and");
  lines.push("# `ufw enable` last. Enabling with a default-deny policy before the");
  lines.push("# SSH allow is in place ends the session that is applying it.");
  lines.push("");
  lines.push("sudo ufw allow OpenSSH");
  lines.push("");
  for (const { port, service } of ports) {
    lines.push(`# ${service}`);
    for (const cidr of v4) lines.push(`sudo ufw allow from ${cidr} to any port ${port} proto tcp`);
    for (const cidr of v6) lines.push(`sudo ufw allow from ${cidr} to any port ${port} proto tcp`);
    lines.push("");
  }
  lines.push("# Everything not allowed above is denied, including direct plain-HTTP");
  lines.push("# access to these same ports — which is the whole point.");
  lines.push("sudo ufw default deny incoming");
  lines.push("sudo ufw --force enable");
  lines.push("");
  lines.push("# Verify from OFF the box afterwards, not from on it:");
  lines.push("#   curl --max-time 10 http://<ip>:9102/health/ready   -> must time out");
  lines.push("#   curl --max-time 10 https://d3o61up86kzcn.cloudfront.net/health/ready?cb=$RANDOM -> must still be 200");
  return lines.join("\n");
}

function emitSecurityGroup({ v4, v6, syncToken, createDate }, ports) {
  const lines = [];
  lines.push(`# CloudFront origin allowlist — ip-ranges.json syncToken ${syncToken} (${createDate})`);
  lines.push("#");
  lines.push("# A security group is default-deny, so there is no deny rule to write");
  lines.push("# and no ordering hazard — but it caps at 60 rules per group by");
  lines.push(`# default, and this needs ${(v4.length + v6.length) * ports.length}. Use a prefix list:`);
  lines.push("#");
  lines.push("#   aws ec2 create-managed-prefix-list --address-family IPv4 \\");
  lines.push(`#     --max-entries ${v4.length} --prefix-list-name cloudfront-origin-facing \\`);
  lines.push("#     --entries " + v4.slice(0, 2).map((c) => `Cidr=${c}`).join(" ") + " ...");
  lines.push("#");
  lines.push("# then one rule per port referencing it:");
  lines.push("");
  for (const { port, service } of ports) {
    lines.push(`# ${service}`);
    lines.push("aws ec2 authorize-security-group-ingress \\");
    lines.push("  --group-id \"$SECURITY_GROUP_ID\" \\");
    lines.push(
      `  --ip-permissions 'IpProtocol=tcp,FromPort=${port},ToPort=${port},PrefixListIds=[{PrefixListId=$PREFIX_LIST_ID}]'`,
    );
    lines.push("");
  }
  lines.push("# Remove the old world-open rules only AFTER the above are in place:");
  for (const { port } of ports) {
    lines.push(
      `# aws ec2 revoke-security-group-ingress --group-id "$SECURITY_GROUP_ID" --protocol tcp --port ${port} --cidr 0.0.0.0/0`,
    );
  }
  return lines.join("\n");
}

/**
 * Confirms a live box is actually narrowed — the only check that establishes
 * anything, because every rule above can be applied successfully and still
 * be wrong.
 *
 * Two halves, and both are needed. That CloudFront still answers proves the
 * allowlist did not lock it out; that a direct request does NOT answer
 * proves the rule is doing something. Either alone is consistent with a
 * broken configuration.
 */
async function check() {
  const ORIGIN = process.env.ORIGIN_HOST;
  const distributions = [
    ["game-backend", "https://d3o61up86kzcn.cloudfront.net/health/ready"],
    ["backoffice-api", "https://d3tecd275gihq4.cloudfront.net/health/ready"],
    ["game-socket", "https://d377drvfmw1hda.cloudfront.net/health/ready"],
  ];

  let failures = 0;
  console.log("Through CloudFront — every one must still answer:\n");
  for (const [name, url] of distributions) {
    // Cache-busted, so a 200 is the origin answering rather than an edge
    // response cached before the rule was applied. Without this the check
    // reports success for as long as the cache lives.
    const bust = `${url}${url.includes("?") ? "&" : "?"}cb=${Math.random().toString(36).slice(2)}`;
    try {
      const res = await fetch(bust, { signal: AbortSignal.timeout(20_000) });
      const ok = res.status === 200;
      console.log(`  ${ok ? "✔" : "✘"} ${name} — ${res.status}`);
      if (!ok) failures++;
    } catch (err) {
      console.log(`  ✘ ${name} — ${err.message}`);
      failures++;
    }
  }

  if (!ORIGIN) {
    console.log("\nDirect to the origin — SKIPPED.");
    console.log("  Set ORIGIN_HOST=<ip> to check it. Without this half the run");
    console.log("  proves CloudFront still works and says NOTHING about whether");
    console.log("  the port is still open to everyone else, which is the half");
    console.log("  the allowlist exists for.");
    return failures;
  }

  console.log("\nDirect to the origin — every one must now REFUSE or time out:\n");
  for (const { port, service } of FRONTED_PORTS) {
    try {
      await fetch(`http://${ORIGIN}:${port}/health/ready`, { signal: AbortSignal.timeout(8000) });
      console.log(`  ✘ ${service} (${port}) — answered directly, so the port is still open to the internet`);
      failures++;
    } catch {
      console.log(`  ✔ ${service} (${port}) — refused or timed out`);
    }
  }
  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.check) {
    const failures = await check();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  }

  const prefixes = await fetchOriginFacingPrefixes();
  const emit = args.format === "sg" ? emitSecurityGroup : emitUfw;
  console.log(emit(prefixes, args.ports));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
