#!/bin/bash
set -euo pipefail

# Deploy Ratatoskr to the Hugin-Munin Pi
# Usage: ./scripts/deploy-pi.sh [hostname]
# If hostname is "local" or omitted when running on the Pi, deploys in-place.

PI_HOST="${1:-}"
DEPLOY_USER="${DEPLOY_USER:-magnus}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REMOTE_DIR="/home/$DEPLOY_USER/repos/ratatoskr"
REQUESTED_COMMIT="${DEPLOY_COMMIT:-}"

# Detect if we're already on the Pi
IS_LOCAL=false
if [ -z "$PI_HOST" ] || [ "$PI_HOST" = "local" ]; then
  if [ -f /etc/hostname ] && grep -qi "huginmunin" /etc/hostname 2>/dev/null; then
    IS_LOCAL=true
  elif [ "$PI_HOST" = "local" ]; then
    IS_LOCAL=true
  else
    PI_HOST="huginmunin.local"
  fi
fi

if [ "$IS_LOCAL" = true ]; then
  # The Pi's .git is intentionally excluded from laptop rsync deploys and may
  # be stale forever. Never infer provenance from it: the caller/Hugin task must
  # pass the source SHA that produced the files being deployed in place.
  DEPLOY_COMMIT="$REQUESTED_COMMIT"
  if [ -z "$DEPLOY_COMMIT" ]; then
    echo "ERROR: local deploy requires DEPLOY_COMMIT=<source-sha>" >&2
    exit 1
  fi
else
  GIT_COMMIT="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ -z "$GIT_COMMIT" ]; then
    echo "ERROR: remote deploy requires a Git source checkout" >&2
    exit 1
  fi
  if [ -n "$(git -C "$PROJECT_DIR" status --porcelain --untracked-files=normal)" ]; then
    echo "ERROR: refusing to deploy a dirty working tree" >&2
    exit 1
  fi
  if [ -n "$REQUESTED_COMMIT" ] && [ "$REQUESTED_COMMIT" != "$GIT_COMMIT" ]; then
    echo "ERROR: DEPLOY_COMMIT does not match the checked-out HEAD" >&2
    exit 1
  fi
  DEPLOY_COMMIT="$GIT_COMMIT"
fi

if [[ ! "$DEPLOY_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: DEPLOY_COMMIT must be a full 40-character lowercase Git SHA" >&2
  exit 1
fi

echo "==> Building TypeScript..."
cd "$PROJECT_DIR"
npm run build

if [ "$IS_LOCAL" = true ]; then
  echo "==> Local deploy (already on Pi)"

  # A deployment in progress must never retain a stale marker. The new marker
  # is written only after the restart/status check succeeds.
  rm -f "$PROJECT_DIR/.deployed-commit"

  echo "==> Installing production dependencies..."
  npm ci --omit=dev

  echo "==> Installing systemd service..."
  sudo cp "$PROJECT_DIR/ratatoskr.service" /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable ratatoskr

  echo "==> Checking for .env file..."
  if [ -f "$PROJECT_DIR/.env" ]; then
    echo "  .env exists"
  else
    echo "  WARNING: No .env file found at $PROJECT_DIR/.env"
    echo "  Create one based on .env.example"
  fi

  echo "==> Restarting service..."
  sudo systemctl restart ratatoskr && sleep 2 && sudo systemctl status ratatoskr --no-pager

  printf '%s\n' "$DEPLOY_COMMIT" > "$PROJECT_DIR/.deployed-commit"

else
  REMOTE="$DEPLOY_USER@$PI_HOST"

  # Remove stale provenance before changing code. A failed deployment remains
  # visibly unmarked instead of falsely claiming either the old or new SHA.
  # The target is a deployed artifact directory, never a Git checkout: remove
  # stale/dangling metadata defensively before rsync so it cannot masquerade as
  # a source checkout or retain a workstation worktree pointer.
  ssh "$REMOTE" "rm -f '$REMOTE_DIR/.deployed-commit' && rm -rf '$REMOTE_DIR/.git'"

  echo "==> Syncing to $REMOTE:$REMOTE_DIR..."
  rsync -av --delete \
    --exclude='node_modules/' \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='.deployed-commit' \
    --exclude='tests/' \
    --exclude='.DS_Store' \
    "$PROJECT_DIR/" "$REMOTE:$REMOTE_DIR/"

  echo "==> Installing dependencies on Pi..."
  ssh "$REMOTE" "cd $REMOTE_DIR && npm ci --omit=dev"

  echo "==> Installing systemd service..."
  ssh "$REMOTE" "sudo cp $REMOTE_DIR/ratatoskr.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable ratatoskr"

  echo "==> Checking for .env file..."
  if ssh "$REMOTE" "test -f $REMOTE_DIR/.env"; then
    echo "  .env exists"
  else
    echo "  WARNING: No .env file found at $REMOTE_DIR/.env"
    echo "  Create one based on .env.example"
  fi

  echo "==> Restarting service..."
  ssh "$REMOTE" "sudo systemctl restart ratatoskr && sleep 2 && sudo systemctl status ratatoskr --no-pager"

  echo "==> Recording deployed commit $DEPLOY_COMMIT..."
  printf '%s\n' "$DEPLOY_COMMIT" | \
    ssh "$REMOTE" "cat > '$REMOTE_DIR/.deployed-commit'"
fi

echo ""
echo "Deploy complete!"
echo "Health check: curl http://${PI_HOST:-localhost}:3034/health"
echo "Logs: journalctl -u ratatoskr -f"
