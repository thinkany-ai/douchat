#!/bin/sh
# douchat-host installer (remote-connections.md 7.2, 11).
#
#   curl -fsSL '<base>/install.sh' | DOUCHAT_HOST_URL='<base>' DOUCHAT_ENROLL='dch1_...' sh
#
# Installs into ~/.douchat-host for the current user (never root), registers
# with Douchat when DOUCHAT_ENROLL is set, and keeps it running as a user
# service. Without DOUCHAT_ENROLL on an existing install it upgrades in place.
#
# <base>/latest.txt names the newest version; <base>/<version>/ is immutable.
# The bundle must match the sha256 in that version's manifest.json, and Node.js
# downloads must match the hashes pinned below. Like most install scripts this
# guards against broken or mixed-up downloads, not against a compromised
# download address.
#
# Environment:
#   DOUCHAT_HOST_URL      Download base holding latest.txt and <version>/ (required)
#   DOUCHAT_HOST_VERSION  Version to install (default: latest.txt)
#   DOUCHAT_ENROLL        One-time install token from Douchat
#   DOUCHAT_HOST_HOME     Install folder (default ~/.douchat-host)
#   DOUCHAT_NODE_MIRROR   Node.js download mirror (default https://nodejs.org/dist)
#   DOUCHAT_HOST_YES=1    Skip the fingerprint question
#   DOUCHAT_HOST_SERVICE=background   Do not use systemd or launchd
#   DOUCHAT_HOST_FORCE=1  Replace a registration with another account instead of refusing
set -eu

NODE_VERSION="v22.20.0"
NODE_MAJOR_MIN=20
# sha256 of the official $NODE_VERSION archives (nodejs.org SHASUMS256.txt).
node_sha256() {
  case "$1" in
    node-v22.20.0-darwin-arm64) echo cc04a76a09f79290194c0646f48fec40354d88969bec467789a5d55dd097f949 ;;
    node-v22.20.0-darwin-x64) echo 00df9c5df3e4ec6848c26b70fb47bf96492f342f4bed6b17f12d99b3a45eeecc ;;
    node-v22.20.0-linux-arm64) echo 4181609e03dcb9880e7e5bf956061ecc0503c77a480c6631d868cb1f65a2c7dd ;;
    node-v22.20.0-linux-x64) echo eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29 ;;
    *) echo "" ;;
  esac
}

say() { printf '%s\n' "douchat-host: $*"; }
fail() { printf '%s\n' "douchat-host: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] && [ "${DOUCHAT_HOST_ALLOW_ROOT:-}" != "1" ] && fail "Do not install as root. Run this as the user agents should run as."
BASE="${DOUCHAT_HOST_URL:-}"
[ -n "$BASE" ] || fail "DOUCHAT_HOST_URL is not set. Copy the install command from Douchat again."
BASE="${BASE%/}"
case "$BASE" in
  https://*) ;;
  http://localhost|http://localhost[:/]*|http://127.0.0.1|http://127.0.0.1[:/]*|http://\[::1\]|http://\[::1\][:/]*) ;;
  *) fail "The download address must use HTTPS: $BASE" ;;
esac
WANT="${DOUCHAT_HOST_VERSION:-}"
case "$WANT" in
  '') ;;
  *[!0-9A-Za-z.-]*) fail "Invalid DOUCHAT_HOST_VERSION: $WANT" ;;
esac
HOST_HOME="${DOUCHAT_HOST_HOME:-$HOME/.douchat-host}"
case "$HOST_HOME" in *\'*|'') fail "Unsupported install folder: $HOST_HOME" ;; esac
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else openssl dgst -sha256 -r "$1" | cut -d' ' -f1; fi
}
fetch() { curl --noproxy 'localhost,127.0.0.1,::1' -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1" || fail "Could not download $1"; }

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) fail "Unsupported system $(uname -s). Linux and macOS are supported." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "Unsupported CPU $(uname -m)." ;;
esac

umask 077
mkdir -p "$HOST_HOME/bin" "$HOST_HOME/versions" "$HOST_HOME/logs"
chmod 700 "$HOST_HOME"
WORK="$(mktemp -d "$HOST_HOME/.install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

# ── Node.js: use the system one when new enough, else a private copy ──
node_ok() { "$1" -e "process.exit(Number(process.versions.node.split('.')[0]) >= $NODE_MAJOR_MIN ? 0 : 1)" >/dev/null 2>&1; }
NODE=""
if [ -x "$HOST_HOME/runtime/bin/node" ] && node_ok "$HOST_HOME/runtime/bin/node"; then NODE="$HOST_HOME/runtime/bin/node"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then NODE="$(command -v node)"
else
  MIRROR="${DOUCHAT_NODE_MIRROR:-https://nodejs.org/dist}"
  NAME="node-$NODE_VERSION-$OS-$ARCH"
  EXPECTED="$(node_sha256 "$NAME")"
  [ -n "$EXPECTED" ] || fail "No pinned Node.js build for $OS-$ARCH. Install Node.js $NODE_MAJOR_MIN+ and run the command again."
  say "Node.js $NODE_MAJOR_MIN+ not found; downloading $NAME…"
  fetch "$MIRROR/$NODE_VERSION/$NAME.tar.gz" "$WORK/node.tar.gz"
  [ "$(sha256 "$WORK/node.tar.gz")" = "$EXPECTED" ] || fail "The Node.js download failed verification."
  tar -xzf "$WORK/node.tar.gz" -C "$WORK"
  rm -rf "$HOST_HOME/runtime"
  mv "$WORK/$NAME" "$HOST_HOME/runtime"
  NODE="$HOST_HOME/runtime/bin/node"
  node_ok "$NODE" || fail "The downloaded Node.js does not run on this system."
fi

# ── douchat-host bundle: the version's manifest, then the bundle it names ──
if [ -z "$WANT" ]; then
  fetch "$BASE/latest.txt" "$WORK/latest.txt"
  WANT="$(tr -d ' \r\n' < "$WORK/latest.txt")"
  case "$WANT" in ''|*[!0-9A-Za-z.-]*) fail "The latest-version pointer is invalid." ;; esac
fi
fetch "$BASE/$WANT/manifest.json" "$WORK/manifest.json"
VERSION="$("$NODE" -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\$/.test(m.version)||!/^[0-9a-f]{64}\$/.test(m.sha256))process.exit(1);console.log(m.version)" "$WORK/manifest.json")" || fail "The release manifest is invalid."
[ "$VERSION" = "$WANT" ] || fail "The manifest is for $VERSION, not the requested $WANT."
SHA="$("$NODE" -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).sha256)" "$WORK/manifest.json")"
fetch "$BASE/$VERSION/douchat-host.mjs" "$WORK/douchat-host.mjs"
[ "$(sha256 "$WORK/douchat-host.mjs")" = "$SHA" ] || fail "The douchat-host download failed verification."
"$NODE" "$WORK/douchat-host.mjs" version >/dev/null 2>&1 || fail "douchat-host $VERSION does not run with $("$NODE" --version)."

PREVIOUS=""
[ -L "$HOST_HOME/current" ] && PREVIOUS="$(readlink "$HOST_HOME/current")"
mkdir -p "$HOST_HOME/versions/$VERSION"
mv "$WORK/douchat-host.mjs" "$HOST_HOME/versions/$VERSION/douchat-host.mjs"
ln -sfn "versions/$VERSION" "$HOST_HOME/current.new"
# Rename the link itself (-T on GNU, -h on BSD). A plain mv follows the old
# link to its version folder and moves the new link into it, leaving the old version current.
mv -Tf "$HOST_HOME/current.new" "$HOST_HOME/current" 2>/dev/null \
  || mv -hf "$HOST_HOME/current.new" "$HOST_HOME/current" 2>/dev/null \
  || { rm -f "$HOST_HOME/current"; mv "$HOST_HOME/current.new" "$HOST_HOME/current"; }
[ "$(readlink "$HOST_HOME/current")" = "versions/$VERSION" ] || fail "Could not switch to $VERSION."

cat > "$HOST_HOME/bin/douchat-host.new" <<EOF
#!/bin/sh
DOUCHAT_HOST_HOME='$HOST_HOME'
export DOUCHAT_HOST_HOME
exec '$NODE' '$HOST_HOME/current/douchat-host.mjs' "\$@"
EOF
chmod 700 "$HOST_HOME/bin/douchat-host.new"
mv -f "$HOST_HOME/bin/douchat-host.new" "$HOST_HOME/bin/douchat-host"
"$NODE" -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({ base: process.argv[2], node: process.argv[3], version: process.argv[4] }, null, 2) + '\n', { mode: 0o600 })" \
  "$HOST_HOME/install.json" "$BASE" "$NODE" "$VERSION"
BIN="$HOST_HOME/bin/douchat-host"
export DOUCHAT_HOST_HOME="$HOST_HOME" DOUCHAT_HOST_INSTALLER=1

# Keep only the current and previous versions.
for dir in "$HOST_HOME"/versions/*; do
  [ -d "$dir" ] || continue
  case "versions/$(basename "$dir")" in "versions/$VERSION"|"$PREVIOUS") ;; *) rm -rf "$dir" ;; esac
done

if [ -n "${DOUCHAT_ENROLL:-}" ]; then
  # Reuses this server's registration for the same account; DOUCHAT_HOST_FORCE=1 replaces it.
  "$BIN" setup ${DOUCHAT_HOST_FORCE:+--force} || fail "Registration failed."
  "$BIN" service install || fail "douchat-host was registered but the service did not start. Run: $BIN doctor"
elif [ -f "$HOST_HOME/state.json" ]; then
  if "$BIN" service status | grep -q '^no service installed'; then "$BIN" service install
  else "$BIN" service restart || fail "Upgraded to $VERSION but the restart failed. Run: $BIN doctor"; fi
  say "Upgraded to $VERSION."
  exit 0
else
  say "Installed $VERSION but not registered. Copy the install command from Douchat to connect this server."
  exit 0
fi

say "Installed $VERSION. Return to Douchat to finish adding this server."
say "Manage it with: $BIN status | doctor | service restart | upgrade | uninstall --purge"
