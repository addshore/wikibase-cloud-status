#!/bin/sh
set -eu

# Run in the Toolforge account after the site's files are in public_html.
# For a first PHP-to-Caddy migration, stop the old webservice first:
#   webservice stop
#   sh setup-webservice.sh start
action=${1:-start}
case "$action" in
  start|restart) ;;
  *) echo 'Usage: setup-webservice.sh [start|restart]' >&2; exit 1 ;;
esac

mkdir -p "$HOME/bin"
download=$(mktemp "$HOME/bin/caddy.XXXXXX")
trap 'rm -f "$download"' EXIT HUP INT TERM

curl -fL 'https://caddyserver.com/api/download?os=linux&arch=amd64' -o "$download"
chmod +x "$download"
mv "$download" "$HOME/bin/caddy"

cat > "$HOME/Caddyfile" <<'EOF'
{
  admin off
}

:{$PORT:8000} {
  root * "{$HOME}/public_html"

  header {
    Access-Control-Allow-Origin "*"
    Access-Control-Allow-Methods "GET, HEAD, OPTIONS"
    Access-Control-Allow-Headers "Content-Type"
  }
  @csv path *.csv
  header @csv Cache-Control "no-cache"

  @preflight method OPTIONS
  handle @preflight {
    respond "" 204
  }
  handle {
    file_server
  }
}
EOF

cat > "$HOME/serve-status.sh" <<'EOF'
#!/bin/sh
exec "$HOME/bin/caddy" run --config "$HOME/Caddyfile" --adapter caddyfile
EOF
chmod +x "$HOME/serve-status.sh"

webservice --backend=kubernetes trixie "$action" "$HOME/serve-status.sh"
