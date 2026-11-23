#!/bin/sh
# ci-sandbox-probe.sh - what the Linux CI runner lets the bots' sandbox do (1.5.63), printed
# before the smoke so a failing network check can be read against it. Only looks; changes
# nothing; every step has a timeout and never fails the job.
#
#   T1  bwrap inside bwrap (no network)            - expected refused on Ubuntu (bwrap-userns-restrict)
#   T2  unshare -Ur inside bwrap                   - the same question without a second bwrap
#   T3  one bwrap --unshare-net WITH --dev         - which user namespace its first process is in,
#   T4  one bwrap --unshare-net, /dev made by hand   and can slirp4netns / pasta join it (Lamplit uses T4)
#   T5  pasta -- bwrap (pasta makes the namespaces) - the other way round, for comparison

say() { printf '%s\n' "$*"; }
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT

say "== T1 bwrap inside bwrap"
timeout 10 bwrap --ro-bind / / --dev /dev --proc /proc -- bwrap --ro-bind / / --dev /dev -- true >/dev/null 2>&1 && say "T1 nested bwrap: works" || say "T1 nested bwrap: refused ($(timeout 10 bwrap --ro-bind / / --dev /dev --proc /proc -- bwrap --ro-bind / / --dev /dev -- true 2>&1 | tail -1))"

say "== T2 unshare -Ur inside bwrap"
timeout 10 bwrap --ro-bind / / --dev /dev --proc /proc -- unshare -Ur true >/dev/null 2>&1 && say "T2 unshare inside bwrap: works" || say "T2 unshare inside bwrap: refused ($(timeout 10 bwrap --ro-bind / / --dev /dev --proc /proc -- unshare -Ur true 2>&1 | tail -1))"

HANDDEV="--tmpfs /dev --dev-bind /dev/null /dev/null --dev-bind /dev/zero /dev/zero --dev-bind /dev/full /dev/full --dev-bind /dev/random /dev/random --dev-bind /dev/urandom /dev/urandom --dev-bind /dev/tty /dev/tty --symlink /proc/self/fd /dev/fd --tmpfs /dev/shm"

# $1 = label, $2 = the /dev options, $3 = helper (slirp4netns | pasta)
attach() {
  info="$DIR/info-$1-$3"
  # shellcheck disable=SC2086
  bwrap --unshare-user --unshare-net --unshare-pid --ro-bind / / $2 --proc /proc --info-fd 3 -- sleep 6 3>"$info" &
  bw=$!
  pid=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pid=$(sed -n 's/.*"child-pid": *\([0-9]*\).*/\1/p' "$info" 2>/dev/null | head -1)
    [ -n "$pid" ] && break
    sleep 0.3
  done
  if [ -z "$pid" ]; then say "$1 $3: bwrap did not start ($(cat "$info" 2>/dev/null | tr '\n' ' '))"; kill "$bw" 2>/dev/null; wait "$bw" 2>/dev/null; return; fi
  say "$1: first process $pid, uid_map: $(tr -s ' ' < /proc/"$pid"/uid_map 2>/dev/null | tr '\n' ';') userns $(readlink /proc/"$pid"/ns/user 2>/dev/null) netns $(readlink /proc/"$pid"/ns/net 2>/dev/null)"
  if [ "$3" = slirp4netns ]; then
    out=$(timeout 3 slirp4netns --configure --mtu=65520 --disable-host-loopback "$pid" tap0 2>&1 | head -5 | tr '\n' ' ')
    case "$out" in *"sent tapfd"*|*"Starting slirp"*) say "$1 slirp4netns: joined ($out)";; *) say "$1 slirp4netns: refused ($out)";; esac
  else
    # Into a file, not a pipe: pasta's background half may keep what it was given open.
    timeout 5 pasta --config-net --quiet --no-map-gw -t none -u none -T none -U none "$pid" >"$DIR/pasta.out" 2>&1
    out=$(head -3 "$DIR/pasta.out" | tr '\n' ' ')
    [ -z "$out" ] && say "$1 pasta: joined (exit 0)" || say "$1 pasta: refused ($out)"
    pkill -f "pasta --config-net --quiet --no-map-gw -t none -u none -T none -U none $pid\$" 2>/dev/null
  fi
  kill "$bw" 2>/dev/null; wait "$bw" 2>/dev/null
}

for helper in slirp4netns pasta; do
  command -v "$helper" >/dev/null || { say "$helper: not installed"; continue; }
  say "== T3 one bwrap --unshare-net with --dev ($helper)"
  attach T3 "--dev /dev" "$helper"
  say "== T4 one bwrap --unshare-net, /dev made by hand ($helper)"
  attach T4 "$HANDDEV" "$helper"
done

if command -v pasta >/dev/null; then
  say "== T5 pasta -- bwrap"
  # shellcheck disable=SC2086
  say "T5 with --dev: $(timeout 15 pasta --config-net --quiet -t none -u none -T none -U none -- bwrap --unshare-pid --ro-bind / / --dev /dev --proc /proc -- sh -c 'echo uid=$(id -u) net=$(readlink /proc/self/ns/net)' 2>&1 | tail -2 | tr '\n' ' ')"
  # shellcheck disable=SC2086
  say "T5 hand /dev: $(timeout 15 pasta --config-net --quiet -t none -u none -T none -U none -- bwrap --unshare-pid --ro-bind / / $HANDDEV --proc /proc -- sh -c 'echo uid=$(id -u) net=$(readlink /proc/self/ns/net)' 2>&1 | tail -2 | tr '\n' ' ')"
fi
say "host netns $(readlink /proc/self/ns/net)"
exit 0
