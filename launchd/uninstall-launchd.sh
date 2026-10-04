#!/usr/bin/env bash
PLIST="$HOME/Library/LaunchAgents/dev.agentsmax.office.plist"
launchctl unload "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "Kaldırıldı."
