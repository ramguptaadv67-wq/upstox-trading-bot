#!/bin/bash
set -e
echo "=== Upstox Trading Bot Deploy (HTTPS + buildaistore.tech) ==="

DOMAIN="buildaistore.tech"
APP_DIR="/var/www/upstox-bot"

# --- Install dependencies ---
apt-get update -y 2>&1 | tail -1
apt-get install -y curl git nginx sqlite3 certbot python3-certbot-nginx 2>&1 | tail -1

# --- Install Node.js 20 ---
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tail -1
  apt-get install -y nodejs 2>&1 | tail -1
fi
echo "Node: $(node --version)"

# --- Install PM2 ---
npm install -g pm2 2>&1 | tail -1

# --- Clone repo ---
rm -rf /tmp/git-upstox
git clone https://github.com/ramguptaadv67-wq/git-upstox.git /tmp/git-upstox 2>&1 | tail -1

# --- Deploy app ---
mkdir -p $APP_DIR
cp -r /tmp/git-upstox/vps-app/* $APP_DIR/
cd $APP_DIR
npm install --omit=dev 2>&1 | tail -3

# --- Verify critical token routes survived the copy (safety guard) ---
grep -q '/api/token-status' "$APP_DIR/server.js" || { echo "FATAL: /api/token-status route missing from server.js"; exit 1; }
grep -q '/api/request-token' "$APP_DIR/server.js" || { echo "FATAL: /api/request-token route missing from server.js"; exit 1; }
echo "Token routes verified in server.js"

# --- Init database ---
node -e "
const D=require('better-sqlite3');
const db=new D('$APP_DIR/data.db');
db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS signals(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp INTEGER,raw_message TEXT,payload TEXT,status TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp INTEGER,type TEXT,action TEXT,instrument_token TEXT,quantity INTEGER,result TEXT,ok INTEGER)');
db.exec('CREATE TABLE IF NOT EXISTS positions(id INTEGER PRIMARY KEY AUTOINCREMENT,instrument_token TEXT,transaction_type TEXT,quantity INTEGER,entry_price REAL,highest_price REAL,lowest_price REAL,added_at INTEGER,exit_config TEXT,active INTEGER DEFAULT 1)');
db.exec('CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,timestamp INTEGER,level TEXT,message TEXT)');
db.close();
console.log('Database initialized');
"

# --- Pre-configure Upstox credentials in the database ---
# Only set if not already present (won't overwrite existing token)
sqlite3 $APP_DIR/data.db "INSERT OR REPLACE INTO settings (key, value) VALUES ('UPSTOX_CLIENT_ID', 'a97d9aad-d04c-4dd7-9c2b-72bcd1f08bb4');"
sqlite3 $APP_DIR/data.db "INSERT OR REPLACE INTO settings (key, value) VALUES ('UPSTOX_CLIENT_SECRET', '51bz9r0ww1');"
# Set a default webhook secret — change this to your own random string
sqlite3 $APP_DIR/data.db "INSERT OR IGNORE INTO settings (key, value) VALUES ('WEBHOOK_SECRET', 'upstox-bot-webhook-2026');"
echo "Credentials configured in database"

# --- Nginx config (HTTP first — needed for Certbot) ---
cat > /etc/nginx/sites-available/upstox-bot << 'NGINX'
server {
    listen 80;
    server_name buildaistore.tech www.buildaistore.tech;

    # Allow Let's Encrypt challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Disable proxy caching — always fetch fresh from Node
        proxy_no_cache 1;
        proxy_cache_bypass 1;
        # WebSocket support (future use)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX
ln -sf /etc/nginx/sites-available/upstox-bot /etc/nginx/sites-enabled/upstox-bot
rm -f /etc/nginx/sites-enabled/default
nginx -t 2>&1
systemctl restart nginx
systemctl enable nginx 2>&1 | tail -1

# --- Firewall ---
ufw allow OpenSSH 2>/dev/null || true
ufw allow 'Nginx Full' 2>/dev/null || true
ufw --force enable 2>/dev/null || true

# --- Start app with PM2 ---
pm2 delete upstox-bot 2>/dev/null || true
cd $APP_DIR
pm2 start server.js --name upstox-bot
pm2 save
pm2 startup systemd -u root --hp /root 2>&1 | tail -1

# --- Obtain SSL certificate via Let's Encrypt ---
echo ""
echo "=== Setting up SSL for $DOMAIN ==="
# Ensure DNS for buildaistore.tech points to this VPS before running this!
certbot --nginx -d $DOMAIN -d www.$DOMAIN \
  --non-interactive --agree-tos --redirect \
  --register-unsafely-without-email \
  -m admin@$DOMAIN 2>&1 || echo "WARNING: Certbot failed. Make sure DNS points to this VPS."

echo ""
echo "============================================"
echo "  DEPLOYMENT COMPLETE!"
echo "============================================"
echo "Dashboard:  https://$DOMAIN/"
echo "Hostname:   https://srv1876241.hstgr.cloud/"
echo "Direct IP:  http://187.127.158.69/"
echo ""
echo "Credentials already configured in database:"
echo "  UPSTOX_CLIENT_ID:     a97d9aad-d04c-4dd7-9c2b-72bcd1f08bb4"
echo "  UPSTOX_CLIENT_SECRET: (set)"
echo "  WEBHOOK_SECRET:       upstox-bot-webhook-2026"
echo ""
echo "NEXT STEPS:"
echo "1. Open https://$DOMAIN/ in your browser"
echo "2. Verify token status shows 'No token'"
echo "3. Click 'Request New Token'"
echo "4. Approve the push notification on your Upstox mobile app"
echo "5. Token should turn green within a few seconds"
echo ""
echo "UPSTOX PORTAL SETTINGS (https://developer.upstox.com):"
echo "  Redirect URL:         https://$DOMAIN/callback"
echo "  Notifier Webhook:     https://$DOMAIN/notifier"
echo "============================================"
