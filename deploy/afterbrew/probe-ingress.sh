#!/usr/bin/env bash
# Negative probes for the C4 ingress boundary. rayf P-0007 C4.
#
# Run on the deployment host. Asserts what an external client CAN reach through the
# ingress (one POST route, which then refuses an invalid signature) and what it
# cannot (everything else), plus that no datastore is published on a host port.
#
#   ./probe-ingress.sh
#
# Exits non-zero on the first category that fails, with the observed value. A pass
# here is the evidence C4 asks for, so it prints what it checked rather than only a
# summary -- "27 checks passed" is not evidence of anything if nobody can see what
# they were.
set -uo pipefail

INGRESS="http://127.0.0.1:${OCTOPUS_INGRESS_PORT:-43310}"
pass=0
fail=0

ok()   { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  FAIL  %s\n    -> %s\n' "$1" "$2"; fail=$((fail + 1)); }

# A denied route is answered by Caddy itself: status 404 AND an empty body. The
# status alone is not enough -- Next.js also answers 404, with an HTML page, which
# would mean the request reached the application and the allowlist did not hold.
deny() {
  local method="$1" path="$2"
  local status body rc
  status=$(curl -sS -m 5 -o "/tmp/probe-body.$$" -w '%{http_code}' \
    -X "$method" "$INGRESS$path" 2>"/tmp/probe-err.$$")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "$method $path" "curl failed (rc=$rc): $(cat "/tmp/probe-err.$$")"
    rm -f "/tmp/probe-body.$$" "/tmp/probe-err.$$"
    return
  fi
  body=$(cat "/tmp/probe-body.$$"); rm -f "/tmp/probe-body.$$" "/tmp/probe-err.$$"
  if [ "$status" != "404" ]; then
    bad "$method $path denied" "expected 404, got $status"
  elif [ -n "$body" ]; then
    bad "$method $path denied at the edge" "404 carried a ${#body}-byte body, so the application answered it"
  else
    ok "$method $path -> 404, empty body (refused by the allowlist)"
  fi
}

# HEAD needs its own probe. `curl -X HEAD` sends the method but still waits for a
# body that a HEAD response never has, so it hangs until the timeout and reports a
# curl failure rather than the status. `-I` is the correct spelling, and it puts
# headers in the output file, so the empty-body discriminator does not apply here --
# the status alone is the assertion.
deny_head() {
  local path="$1" status
  status=$(curl -sS -m 5 -I -o /dev/null -w '%{http_code}' "$INGRESS$path" 2>/dev/null)
  [ "$status" = "404" ] && ok "HEAD $path -> 404" \
                        || bad "HEAD $path" "expected 404, got $status"
}

echo "== the one admitted route reaches the application and is refused there =="
resp=$(curl -sS -m 10 -o /tmp/probe-wh.$$ -w '%{http_code}' \
  -X POST "$INGRESS/api/github/webhook" \
  -H 'content-type: application/json' \
  -H 'x-github-event: ping' \
  -H 'x-hub-signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' \
  -d '{"zen":"probe"}' 2>&1)
wh_body=$(cat /tmp/probe-wh.$$ 2>/dev/null); rm -f /tmp/probe-wh.$$
if [ "$resp" = "401" ] && printf '%s' "$wh_body" | grep -q 'Invalid signature'; then
  ok "POST /api/github/webhook with a bad signature -> 401 Invalid signature"
else
  bad "POST /api/github/webhook" "expected 401 + 'Invalid signature' from the app, got $resp: $wh_body"
fi

# No signature header at all. Same refusal: absent is not a special case.
resp=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "$INGRESS/api/github/webhook" \
  -H 'content-type: application/json' -d '{"zen":"probe"}' 2>&1)
[ "$resp" = "401" ] && ok "POST /api/github/webhook unsigned -> 401" \
                    || bad "POST /api/github/webhook unsigned" "expected 401, got $resp"

# The handler must read the whole body before it can check the HMAC, so without a
# limit an unauthenticated caller decides how much memory the application allocates.
echo "== an oversized body is refused at the edge, before the application reads it =="
big=$(mktemp)
head -c 26000000 /dev/zero | tr '\0' 'a' >"$big"
resp=$(curl -sS -m 60 -o /dev/null -w '%{http_code}' -X POST "$INGRESS/api/github/webhook" \
  -H 'content-type: application/json' --data-binary "@$big" 2>&1)
rm -f "$big"
[ "$resp" = "413" ] && ok "POST /api/github/webhook with a 26 MB body -> 413" \
                    || bad "POST /api/github/webhook oversized" "expected 413, got $resp"

echo "== the dashboard and every other route are not reachable =="
deny GET  /
deny GET  /dashboard
deny GET  /api/health
deny GET  /api/ready
deny GET  /api/version
deny GET  /api/status
deny GET  /api/github/webhook          # correct path, wrong method
deny_head /api/github/webhook
deny GET  /api/github/webhook/         # trailing slash is a different path
deny POST /api/github/webhook/x        # exact-match, so no prefix creep
deny GET  /api/admin/service-tokens
deny POST /api/admin/reviews/probe/retry
deny GET  /api/cli/repos
deny GET  /api/agent/status
deny POST /api/agent/register
deny GET  /api/auth/session
deny POST /api/stripe/webhook
deny POST /api/gitlab/webhook

echo "== no datastore is published on a host port =="
for port in 5432 6333 6334 43332 43333 43334; do
  if curl -sS -m 2 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
    bad "port $port" "something answered on the host loopback"
  elif command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$port" 2>/dev/null; then
    bad "port $port" "TCP connect succeeded on the host loopback"
  else
    ok "port $port is not listening on the host"
  fi
done

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
