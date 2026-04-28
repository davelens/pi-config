#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
EXPECTED_DIR="$XDG_CONFIG_HOME/pi"

[ -n "${PI_CODING_AGENT_DIR:-}" ] && EXPECTED_DIR="$PI_CODING_AGENT_DIR"

if [ -d "$PI_CODING_AGENT_DIR" ] || [ -L "$PI_CODING_AGENT_DIR" ]; then
  if [ -f "$PI_CODING_AGENT_DIR/settings.json" ]; then
    echo "✓ pi is already configured."
  else
    echo "⚠ $EXPECTED_DIR exists, but does not have a settings.json!"
  fi

  exit 1
fi

echo "Setting up pi-config at ${EXPECTED_DIR/$HOME/\~}"
echo ""

ln -s "$SCRIPT_DIR" "$EXPECTED_DIR"

if [ -f "$EXPECTED_DIR/settings.json" ]; then
  echo "Installing packages from settings.json:"

  # Extract package sources and install them
  node -e 'const fs = require("fs");
    const { execSync } = require("child_process");
    const config = JSON.parse(fs.readFileSync("$EXPECTED_DIR/settings.json", "utf8"));
    const packages = config.packages || [];
    for (const pkg of packages) {
      if (typeof pkg === "string") {
        try { execSync(`pi install ${pkg}`, { stdio: "inherit" }); } catch(e) { console.log(`⚠ Already installed or failed: ${pkg}`); }
      }
    }' 2>/dev/null || echo "  skipped — no packages to install."
  echo ""
fi

echo "✓ Setup complete!"
echo ""
echo "Restart pi to pick up all changes."
