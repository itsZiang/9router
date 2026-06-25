#!/usr/bin/env bash
# Qoder MITM capture setup.
#
# Qoder CLI uses Alibaba HttpDNS (it resolves api2/openapi/center.qoder.sh
# internally and connects by IP directly), which bypasses /etc/hosts.
# 9router's normal MITM relies on /etc/hosts, so for Qoder we additionally
# redirect traffic to the resolved Alibaba IPs back to localhost:443 (where
# the 9router MITM server listens) via iptables OUTPUT DNAT.
#
# Usage:
#   NODE_ENV=development npm run dev        # in terminal 1 — 9router + MITM
#   ./qoder-mitm-capture.sh start           # in terminal 2 — adds iptables rules
#   # (in terminal 3) unset OPENAI_API_BASE; qoder -p "hi"   # generate traffic
#   ls data/logs/mitm/*qoder*               # inspect captures
#   ./qoder-mitm-capture.sh stop            # remove iptables rules when done
#
# Requires: sudo (9router MITM already needs it for /etc/hosts + port 443).

set -euo pipefail

DOMAINS=(openapi.qoder.sh api2.qoder.sh center.qoder.sh)
PORT=443
MARK="9router-qoder-mitm"  # comment tag for grepping iptables -L output

resolve_ips() {
  # Use 8.8.8.8 to avoid any local resolver shenanigans
  for d in "$@"; do
    python3 -c "
import socket
try:
    print('\n'.join(socket.gethostbyname_ex('$d')[2]))
except Exception as e:
    import sys; sys.stderr.write(f'resolve $d failed: {e}\n')
"
  done
}

add_rules() {
  local ips
  ips=$(resolve_ips "${DOMAINS[@]}" | sort -u)
  if [[ -z "$ips" ]]; then
    echo "ERROR: could not resolve any qoder.sh domain" >&2
    exit 1
  fi

  echo "Adding iptables REDIRECT rules for Qoder IPs -> 127.0.0.1:${PORT}"
  local added=0
  for ip in $ips; do
    # Skip if rule already present
    if sudo iptables -t nat -C OUTPUT -p tcp -d "$ip" --dport 443 \
         -j REDIRECT --to-ports "$PORT" 2>/dev/null; then
      echo "  [exists] $ip"
      continue
    fi
    sudo iptables -t nat -A OUTPUT -p tcp -d "$ip" --dport 443 \
         -j REDIRECT --to-ports "$PORT"
    echo "  [added]  $ip"
    added=$((added + 1))
  done
  echo "Done. Added $added rules. MITM captures will land in data/logs/mitm/ when NODE_ENV=development."
  echo ""
  echo "Now run (in another terminal):"
  echo "  unset OPENAI_API_BASE OPENAI_API_KEY"
  echo "  qoder -p \"hi\"    # or any prompt; even quota-exhausted prompts emit the request"
}

remove_rules() {
  echo "Removing iptables REDIRECT rules for Qoder IPs..."
  local removed=0
  # Iterate over a snapshot of rules; -D until none match
  local ips
  ips=$(resolve_ips "${DOMAINS[@]}" | sort -u)
  for ip in $ips; do
    while sudo iptables -t nat -D OUTPUT -p tcp -d "$ip" --dport 443 \
          -j REDIRECT --to-ports "$PORT" 2>/dev/null; do
      echo "  [removed] $ip"
      removed=$((removed + 1))
    done
  done
  # Also remove by re-resolving in case IPs changed; fallback: grep comment-less
  echo "Done. Removed $removed rules."
}

status_rules() {
  echo "Current Qoder iptables REDIRECT rules:"
  sudo iptables -t nat -L OUTPUT -n --line-numbers 2>/dev/null \
    | grep -E "REDIRECT.*to:${PORT}" || echo "  (none)"
}

case "${1:-status}" in
  start)  add_rules ;;
  stop)   remove_rules ;;
  status) status_rules ;;
  *)
    echo "Usage: $0 {start|stop|status}" >&2
    exit 1
    ;;
esac
