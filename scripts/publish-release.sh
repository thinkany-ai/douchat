#!/usr/bin/env bash
# Upload a published GitHub Release to the public Douchat R2 bucket.
#
# Versioned installers, archives and blockmaps are uploaded first with immutable
# cache headers. The latest*.yml feed files are uploaded last and are never
# cached. Finally latest.json advertises the verified installer URLs to the site.
#
# Required environment:
#   CLOUDFLARE_ACCOUNT_ID
#   AWS_ACCESS_KEY_ID       bucket-scoped R2 Object Read & Write token id
#   AWS_SECRET_ACCESS_KEY   bucket-scoped R2 token secret
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"

command -v aws >/dev/null 2>&1 || {
  echo "aws CLI is required to publish release artifacts" >&2
  exit 1
}

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/publish-release.sh <release files...>" >&2
  exit 1
fi

R2_BUCKET="douchat"
R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
CDN_BASE="https://cdn.douchat.ai"
MAC_CDN_PREFIX="${MAC_CDN_PREFIX-thinkany}"
MAC_CDN_PREFIX="${MAC_CDN_PREFIX%/}"
if [[ "$MAC_CDN_PREFIX" = /* || "$MAC_CDN_PREFIX" = *..* || "$MAC_CDN_PREFIX" = *//* || "$MAC_CDN_PREFIX" =~ [^a-zA-Z0-9/_-] ]]; then
  echo "Invalid MAC_CDN_PREFIX" >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILES=("$@")
ARTIFACTS=()
MANIFESTS=()

content_type() {
  case "$1" in
    *.json) echo "application/json; charset=utf-8" ;;
    *.yml) echo "text/yaml; charset=utf-8" ;;
    *.dmg) echo "application/x-apple-diskimage" ;;
    *.zip) echo "application/zip" ;;
    *.exe) echo "application/vnd.microsoft.portable-executable" ;;
    *.AppImage) echo "application/vnd.appimage" ;;
    *.deb) echo "application/vnd.debian.binary-package" ;;
    *) echo "application/octet-stream" ;;
  esac
}

for file in "${FILES[@]}"; do
  [ -f "$file" ] || {
    echo "release input is not a file: $file" >&2
    exit 1
  }
  case "$(basename "$file")" in
    latest.json) ;; # Regenerated from the live per-platform feeds below.
    latest.yml|latest-mac.yml|latest-linux.yml) MANIFESTS+=("$file") ;;
    *) ARTIFACTS+=("$file") ;;
  esac
done

if [ "${#ARTIFACTS[@]}" -eq 0 ] || [ "${#MANIFESTS[@]}" -eq 0 ]; then
  echo "a release must contain at least one artifact and one latest*.yml manifest" >&2
  exit 1
fi

upload() {
  local file="$1"
  local cache_control="$2"
  local name
  name="$(basename "$file")"
  local key="$name"
  case "$name" in
    Douchat-*-mac-*|latest-mac.yml)
      if [ -n "$MAC_CDN_PREFIX" ]; then key="$MAC_CDN_PREFIX/$name"; fi
      ;;
  esac
  echo "==> Uploading $name"
  AWS_EC2_METADATA_DISABLED=true aws s3 cp "$file" "s3://${R2_BUCKET}/${key}" \
    --endpoint-url "$R2_ENDPOINT" \
    --region auto \
    --content-type "$(content_type "$name")" \
    --cache-control "$cache_control" \
    --no-progress \
    --only-show-errors
}

for file in "${ARTIFACTS[@]}"; do
  upload "$file" "public, max-age=31536000, immutable"
done

for file in "${MANIFESTS[@]}"; do
  upload "$file" "no-store, max-age=0"
done

# Read all three live feeds so a Mac-only release preserves Windows/Linux.
# The legacy root Mac feed remains pinned to its original-team bridge.
catalog_dir=$(mktemp -d)
trap 'rm -rf "$catalog_dir"' EXIT
mac_feed="${MAC_CDN_PREFIX:+$MAC_CDN_PREFIX/}latest-mac.yml"
for manifest in latest-mac.yml latest.yml latest-linux.yml; do
  source="$manifest"
  if [ "$manifest" = latest-mac.yml ]; then source="$mac_feed"; fi
  curl --fail --silent --show-error --retry 5 --retry-all-errors \
    "$CDN_BASE/$source" -o "$catalog_dir/$manifest"
done
MAC_CDN_PREFIX="$MAC_CDN_PREFIX" node "$SCRIPT_DIR/generate-download-catalog.mjs" "$catalog_dir"
while IFS= read -r url; do
  curl --fail --silent --show-error --head --retry 5 --retry-all-errors "$url" >/dev/null
done < <(node -e 'const c=require(process.argv[1]);for(const p of Object.values(c.platforms))for(const u of Object.values(p.downloads))console.log(u)' "$catalog_dir/latest.json")
upload "$catalog_dir/latest.json" "no-store, max-age=0"

echo "Published ${#ARTIFACTS[@]} artifact(s) and ${#MANIFESTS[@]} update manifest(s)"
echo "Website catalog: $CDN_BASE/latest.json"
