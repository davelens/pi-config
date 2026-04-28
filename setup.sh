#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Detect config directory: prefer PI_CODING_AGENT_DIR, fall back to ~/.pi/agent or ~/.config/pi
if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  EXPECTED_DIR="$PI_CODING_AGENT_DIR"
elif [ -d "$HOME/.pi/agent" ]; then
  EXPECTED_DIR="$HOME/.pi/agent"
else
  EXPECTED_DIR="$HOME/.config/pi"
fi

# Verify we're in the right place
if [ "$SCRIPT_DIR" != "$EXPECTED_DIR" ]; then
  echo "⚠️  This repo should be cloned to $EXPECTED_DIR"
  echo "   Current location: $SCRIPT_DIR"
  echo ""
  echo "   Run: git clone git@github.com:davelens/pi-config $EXPECTED_DIR"
  exit 1
fi

echo "Setting up pi-config at $EXPECTED_DIR"
echo ""

# Install packages listed in settings.json (if any)
if [ -f "$EXPECTED_DIR/settings.json" ]; then
  echo "Installing packages from settings.json..."
  # Extract package sources and install them
  node -e '
    const fs = require("fs");
    const { execSync } = require("child_process");
    const config = JSON.parse(fs.readFileSync("$EXPECTED_DIR/settings.json", "utf8"));
    const packages = config.packages || [];
    for (const pkg of packages) {
      if (typeof pkg === "string") {
        try { execSync(`pi install ${pkg}`, { stdio: "inherit" }); } catch(e) { console.log(`  ⚠️  Already installed or failed: ${pkg}`); }
      }
    }
  ' 2>/dev/null || echo "  (skipped — no packages to install)"
  echo ""
fi

echo "✅ Setup complete!"
echo ""
echo "Restart pi to pick up all changes."
