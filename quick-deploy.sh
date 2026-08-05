#!/bin/bash
set -e
echo "=== Upstox Bot Fresh Deploy ==="

APP_DIR="/var/www/upstox-bot"
REPO_URL="https://github.com/ramguptaadv67-wq/upstox-trading-bot.git"

# 1. Stop PM2
echo "[1/8] Stopping PM2..."
pm2 delete upstox-bot 2>/dev/null || true

# 2. Backup database
echo "[2/8] Backing up database..."
if [ -f "$APP_DIR/data.db" ]; then
  cp "$APP_DIR/data.db" /tmp/data.db.bak
  echo "  Database backed up to /tmp/data.db.bak"
else
  echo "  No existing database found — starting fresh"
fi

# 3. Remove old files
echo "[3/8] Removing old files..."
rm -rf "$APP_DIR"
rm -rf /tmp/upstox-new

# 4. Clone fresh repo
echo "[4/8] Cloning fresh repo..."
git clone "$REPO_URL" /tmp/upstox-new

# 5. Copy files
echo "[5/8] Installing files..."
mkdir -p "$APP_DIR"
cp -r /tmp/upstox-new/vps-app/* "$APP_DIR/"

# 6. Restore database
if [ -f /tmp/data.db.bak ]; then
  echo "[6/8] Restoring database..."
  cp /tmp/data.db.bak "$APP_DIR/data.db"
else
  echo "[6/8] No backup to restore — starting fresh"
fi

# 7. Install dependencies
echo "[7/8] Installing npm dependencies..."
cd "$APP_DIR"
npm install --omit=dev 2>&1 | tail -3

# 8. Syntax check + start
echo "[8/8] Starting server..."
node --check server.js
echo "  server.js syntax OK"

# Update Nginx to disable caching
if [ -f /etc/nginx/sites-available/upstox-bot ]; then
  if ! grep -q "proxy_no_cache" /etc/nginx/sites-available/upstox-bot; then
    sed -i 's/proxy_pass http:\/\/127.0.0.1:3000;/proxy_pass http:\/\/127.0.0.1:3000;\n        proxy_no_cache 1;\n        proxy_cache_bypass 1;/' /etc/nginx/sites-available/upstox-bot
    echo "  Nginx cache disabled"
  fi
fi
nginx -t 2>&1
systemctl restart nginx

# Start PM2
pm2 start server.js --name upstox-bot
pm2 save

# Wait and test
sleep 3
echo ""
echo "=== TESTING ENDPOINTS ==="
echo ""
echo "--- /api/token-status ---"
curl -s http://127.0.0.1:3000/api/token-status
echo ""
echo ""
echo "--- /health ---"
curl -s http://127.0.0.1:3000/health
echo ""
echo ""
echo "--- Dashboard JS check ---"
curl -s http://127.0.0.1:3000/ | grep -c "catch" && echo "Dashboard JS has catch blocks (OK)" || echo "WARNING: Dashboard JS might be broken"
echo ""
echo "=== DEPLOY COMPLETE ==="
echo ""
echo "Open https://buildaistore.tech/ in a FRESH INCOGNITO tab"
echo "The token dot should be GREEN now"
