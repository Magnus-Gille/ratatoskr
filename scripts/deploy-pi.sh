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

echo "==> Building TypeScript..."
cd "$PROJECT_DIR"
npm run build

if [ "$IS_LOCAL" = true ]; then
  echo "==> Local deploy (already on Pi)"

  echo "==> Installing production dependencies..."
  npm install --omit=dev

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

else
  REMOTE="$DEPLOY_USER@$PI_HOST"

  echo "==> Syncing to $REMOTE:$REMOTE_DIR..."
  rsync -av --delete \
    --exclude='node_modules/' \
    --exclude='.git/' \
    --exclude='.env' \
    --exclude='tests/' \
    --exclude='.DS_Store' \
    "$PROJECT_DIR/" "$REMOTE:$REMOTE_DIR/"

  echo "==> Installing dependencies on Pi..."
  ssh "$REMOTE" "cd $REMOTE_DIR && npm install --omit=dev"

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
fi

echo ""
echo "Deploy complete!"
echo "Health check: curl http://${PI_HOST:-localhost}:3034/health"
echo "Logs: journalctl -u ratatoskr -f"
