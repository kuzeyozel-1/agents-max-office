#!/usr/bin/env bash
# Agent Farm'ı Mac açılışında kendiliğinden başlatır ve çökerse yeniden ayağa kaldırır (7/24).
# Sunucu yalnızca 127.0.0.1'de dinler ve ~/.claude altını OKUR; kaldırmak için: launchd/uninstall-launchd.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/dev.agentsmax.office.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.agentsmax.office</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HERE/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/agents-max-office.log</string><key>StandardErrorPath</key><string>$HOME/Library/Logs/agents-max-office.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Kuruldu. Ofis: http://localhost:4747  (log: $HOME/Library/Logs/agents-max-office.log)"
