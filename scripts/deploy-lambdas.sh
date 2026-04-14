#!/usr/bin/env bash
# scripts/deploy-lambdas.sh
# Build and deploy AWS Lambda functions for GullyBite.
# NOTE: Lambda package.json AWS SDK deps are pinned to 3.0.0 (no caret)
# for reproducibility — verify before next Lambda deploy.
#
# Usage:
#   ./scripts/deploy-lambdas.sh              # Build + deploy all lambdas
#   ./scripts/deploy-lambdas.sh build        # Build zips only (no deploy)
#   ./scripts/deploy-lambdas.sh deploy       # Deploy pre-built zips only
#   ./scripts/deploy-lambdas.sh wsConnect    # Build + deploy one lambda

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAMBDA_DIR="$ROOT_DIR/aws/lambda"
AWS_REGION="${AWS_REGION:-ap-south-1}"

# Lambda name → AWS function name mapping
declare -A FUNCTION_NAMES=(
  [wsConnect]="gullybite-wsConnect"
  [wsDisconnect]="gullybite-wsDisconnect"
  [wsBroadcast]="gullybite-wsBroadcast"
  [imageResize]="gullybite-imageResize"
)

# ── Helpers ────────────────────────────────────────────────────

log()  { echo "  → $*"; }
info() { echo -e "\n🔧 $*"; }
ok()   { echo "  ✅ $*"; }
err()  { echo "  ❌ $*" >&2; }

build_lambda() {
  local name="$1"
  local src="$LAMBDA_DIR/$name"
  local zipfile="$LAMBDA_DIR/$name/build/${name}.zip"

  if [ ! -d "$src" ]; then
    err "Lambda directory not found: $src"
    return 1
  fi

  info "Building $name"
  mkdir -p "$src/build"

  # Install production dependencies into a temp directory
  local tmpdir
  tmpdir=$(mktemp -d)
  cp "$src/package.json" "$tmpdir/"
  [ -f "$src/package-lock.json" ] && cp "$src/package-lock.json" "$tmpdir/"

  log "Installing production dependencies..."
  (cd "$tmpdir" && npm ci --omit=dev --quiet 2>/dev/null || npm install --omit=dev --quiet)

  # Copy source files (not node_modules, not build/, not package-lock)
  for f in "$src"/*; do
    local base
    base=$(basename "$f")
    [ "$base" = "node_modules" ] && continue
    [ "$base" = "build" ] && continue
    [ "$base" = "package-lock.json" ] && continue
    cp -r "$f" "$tmpdir/"
  done

  # Create zip
  log "Packaging → $zipfile"
  (cd "$tmpdir" && zip -qr "$zipfile" .)

  rm -rf "$tmpdir"
  local size
  size=$(du -h "$zipfile" | cut -f1)
  ok "Built $name ($size)"
}

deploy_lambda() {
  local name="$1"
  local zipfile="$LAMBDA_DIR/$name/build/${name}.zip"
  local fn_name="${FUNCTION_NAMES[$name]:-gullybite-$name}"

  if [ ! -f "$zipfile" ]; then
    err "Zip not found: $zipfile — run 'build' first"
    return 1
  fi

  info "Deploying $name → $fn_name"
  log "Uploading to AWS Lambda (region: $AWS_REGION)..."

  aws lambda update-function-code \
    --function-name "$fn_name" \
    --zip-file "fileb://$zipfile" \
    --region "$AWS_REGION" \
    --no-cli-pager \
    > /dev/null

  ok "Deployed $name"
}

# ── Main ───────────────────────────────────────────────────────

ACTION="${1:-all}"
TARGET="${2:-}"

# Determine which lambdas to process
if [ -n "$TARGET" ]; then
  LAMBDAS=("$TARGET")
elif [ "$ACTION" != "build" ] && [ "$ACTION" != "deploy" ] && [ "$ACTION" != "all" ]; then
  # First arg is a lambda name, not an action
  LAMBDAS=("$ACTION")
  ACTION="all"
else
  LAMBDAS=()
  for dir in "$LAMBDA_DIR"/*/; do
    [ -f "$dir/package.json" ] && LAMBDAS+=("$(basename "$dir")")
  done
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GullyBite Lambda Deploy"
echo "  Action: $ACTION | Targets: ${LAMBDAS[*]}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

FAILED=0

for name in "${LAMBDAS[@]}"; do
  if [ "$ACTION" = "build" ] || [ "$ACTION" = "all" ]; then
    build_lambda "$name" || ((FAILED++))
  fi
  if [ "$ACTION" = "deploy" ] || [ "$ACTION" = "all" ]; then
    deploy_lambda "$name" || ((FAILED++))
  fi
done

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "✅ Done — ${#LAMBDAS[@]} lambda(s) processed successfully"
else
  echo "⚠️  Done with $FAILED failure(s)"
  exit 1
fi
