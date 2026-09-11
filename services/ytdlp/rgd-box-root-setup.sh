#!/bin/bash
# Root setup for the yt-dlp service on the RGD box (46.62.229.239).
#
# The service is ALREADY INSTALLED and running as `deploy` on 127.0.0.1:8090.
# Everything here is the part that needs root: a TLS front door, and a unit so
# it survives a reboot.
#
# WHY A SUBDOMAIN AND NOT THE BARE IP. Erik asked whether the static IP could
# be used directly. It cannot, safely: Let's Encrypt does not issue
# certificates for bare IP addresses, so an IP endpoint would be plain http —
# and the bearer token is the ONLY thing in front of something that spawns
# processes. Sending it in cleartext on every run defeats the whole design.
#
# So ytdlp.vdmdigital.io was added in Namecheap, pointing at this box, and gets
# its own certificate below. It is a VDM hostname rather than a client's, which
# is what the service actually is.
#
# RUN THIS ONLY AFTER the A record resolves. Verified 2026-09-05:
#     ytdlp.vdmdigital.io -> 46.62.229.239
# certbot validates over port 80 against that name and fails without it.
#
# Nothing here touches the nine existing sites: one new vhost file, one new
# unit, and a reload rather than a restart.
set -euo pipefail

DOMAIN=ytdlp.vdmdigital.io
PORT=8090

# ------------------------------------------------------------- systemd first
# Before nginx points at it, make the thing it points at durable.
cat > /etc/systemd/system/ytdlp.service <<'UNIT'
[Unit]
Description=yt-dlp service for shorts-scraper (Lucky35)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/home/deploy/apps/ytdlp
# Localhost only. nginx terminates TLS in front; nothing reaches this port
# from outside the box.
Environment=HOST=127.0.0.1
Environment=PORT=8090
Environment=YTDLP_BINARY=/home/deploy/bin/yt-dlp
# The token is read from its file at start rather than written into this unit,
# so rotating it is `echo new > token && systemctl restart ytdlp`, and the
# secret never shows up in `systemctl cat` or the journal.
ExecStart=/bin/bash -c 'YTDLP_SERVICE_TOKEN="$(cat /home/deploy/apps/ytdlp/token)" exec /usr/bin/node /home/deploy/apps/ytdlp/server.mjs'
Restart=always
RestartSec=5

# It reads its own directory and runs one binary. Nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/home/deploy/apps/ytdlp

[Install]
WantedBy=multi-user.target
UNIT

# The hand-started copy holds the port; stop it before systemd claims it.
#
# MATCH ON THE BARE FILENAME, not the path. The first version of this used
# 'ytdlp/server[.]mjs' and matched nothing: run.sh cd's into the directory and
# execs `node server.mjs`, so the process's command line is a RELATIVE path.
# The stray survived, held :8090, and systemd then crash-looped on EADDRINUSE
# for as long as it took to notice — while the endpoint kept answering, served
# by the very process that was supposed to be gone. It looked completely
# healthy from outside and would have died at the next reboot.
pkill -u deploy -f 'server[.]mjs' || true
sleep 2

systemctl daemon-reload
systemctl enable --now ytdlp.service
sleep 2

if ! curl -sf --max-time 10 "http://127.0.0.1:${PORT}/health" > /dev/null; then
  echo "FAILED: the service is not answering on 127.0.0.1:${PORT}. nginx not touched." >&2
  systemctl --no-pager --lines=20 status ytdlp.service >&2 || true
  exit 1
fi
echo "service: healthy on 127.0.0.1:${PORT}"

# -------------------------------------------------------------- nginx vhost
# Its OWN vhost file. Nothing in the nine existing sites is opened or edited,
# so there is no way for this to break one of them.
cat > /etc/nginx/sites-available/ytdlp.conf <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # certbot rewrites this block to add TLS and a redirect.
    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        # A --flat-playlist walk of a large channel legitimately takes tens of
        # seconds; nginx's 60s default would cut it off and the app would blame
        # a timeout on a service that was working fine.
        proxy_connect_timeout 15s;
        proxy_send_timeout    200s;
        proxy_read_timeout    200s;

        client_max_body_size  1m;
        proxy_buffering       off;
    }
}
NGINX

ln -sfn /etc/nginx/sites-available/ytdlp.conf /etc/nginx/sites-enabled/ytdlp.conf
nginx -t
systemctl reload nginx
echo "nginx: vhost live on port 80"

# ----------------------------------------------------------------------- TLS
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos         --redirect -m erikerikvdmerwe@outlook.com
systemctl reload nginx

# ---------------------------------------------------------------- verify
echo
echo "--- from the public internet ---"
curl -s --max-time 20 "https://${DOMAIN}/health"; echo
echo -n "unauthenticated POST (want 401): "
curl -s -o /dev/null -w "%{http_code}
" --max-time 20 -X POST "https://${DOMAIN}/run"      -H "content-type: application/json" -d '{"args":["--version"]}'

echo
echo "---------------------------------------------------------------"
echo "Set these two in Vercel:"
echo "  YTDLP_SERVICE_URL=https://${DOMAIN}"
echo "  YTDLP_SERVICE_TOKEN=$(cat /home/deploy/apps/ytdlp/token)"
echo "---------------------------------------------------------------"
