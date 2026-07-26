#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
EXPECTED_DIR="$XDG_CONFIG_HOME/pi"

[ -n "${PI_CODING_AGENT_DIR:-}" ] && EXPECTED_DIR="$PI_CODING_AGENT_DIR"

# Portable stand-in for `ln -sfnT`: BSD/macOS ln has no -T, and plain -sfn
# would place the link *inside* an existing directory instead of replacing it.
force_symlink() {
  local target="$1"
  local link="$2"

  if [ -L "$link" ]; then
    rm -f "$link"
  elif [ -e "$link" ]; then
    echo "⚠ $link exists as a real file/directory; move it aside and rerun setup."
    return 1
  fi

  ln -s "$target" "$link"
}

link_xdg_compat_paths() {
  # Pi itself respects PI_CODING_AGENT_DIR. Some third-party packages still
  # hardcode ~/.pi/agent, so keep that legacy path as a symlink into XDG config.
  local compat_root
  compat_root="$(dirname "$EXPECTED_DIR")/pi-compat"

  mkdir -p "$compat_root"
  # A failed compat symlink is a warning, not a reason to abort the setup.
  force_symlink "$EXPECTED_DIR" "$compat_root/agent" || true

  if [ -e "$HOME/.pi" ] && [ ! -L "$HOME/.pi" ]; then
    echo "⚠ $HOME/.pi exists as a real directory; move it aside and rerun setup to enable XDG compatibility symlink."
  else
    force_symlink "$compat_root" "$HOME/.pi" || true
  fi
}

if [ -d "$EXPECTED_DIR" ] || [ -L "$EXPECTED_DIR" ]; then
  if [ -f "$EXPECTED_DIR/settings.json" ]; then
    link_xdg_compat_paths
    echo "✓ pi is already configured."
  else
    echo "⚠ $EXPECTED_DIR exists, but does not have a settings.json!"
  fi

  exit 1
fi

echo "Setting up pi-config at ${EXPECTED_DIR/$HOME/\~}"
echo ""

ln -s "$SCRIPT_DIR" "$EXPECTED_DIR"

link_xdg_compat_paths

if [ -f "$EXPECTED_DIR/settings.json" ]; then
  echo "Installing packages from settings.json:"

  # Extract package sources and install them
  EXPECTED_DIR="$EXPECTED_DIR" node -e '
    const fs = require("fs");
    const { execSync } = require("child_process");
    const dir = process.env.EXPECTED_DIR;
    const config = JSON.parse(fs.readFileSync(`${dir}/settings.json`, "utf8"));
    const packages = config.packages || [];
    for (const pkg of packages) {
      if (typeof pkg === "string") {
        try { execSync(`pi install ${pkg}`, { stdio: "inherit" }); } catch(e) { console.log(`⚠ Already installed or failed: ${pkg}`); }
      }
    }
  ' 2>/dev/null || echo "  skipped — no packages to install."
  echo ""
fi

if [ -d "$EXPECTED_DIR/extensions" ]; then
  EXPECTED_DIR="$EXPECTED_DIR" node -e '
    const fs = require("fs");
    const path = require("path");
    const { execSync } = require("child_process");
    const extDir = path.join(process.env.EXPECTED_DIR, "extensions");
    const entries = fs.readdirSync(extDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink());
    const needs = [];
    for (const entry of entries) {
      const pkgPath = path.join(extDir, entry.name, "package.json");
      if (!fs.existsSync(pkgPath)) continue;
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { continue; }
      const deps = pkg.dependencies || {};
      if (Object.keys(deps).length > 0) needs.push(entry.name);
    }
    if (needs.length === 0) process.exit(0);
    console.log("Installing extension dependencies:");
    for (const name of needs) {
      const cwd = path.join(extDir, name);
      console.log(`  → ${name}`);
      try {
        execSync("npm install --omit=dev --no-audit --no-fund", { cwd, stdio: "inherit" });
      } catch (e) {
        console.log(`⚠ Failed to install deps for ${name}: ${e.message}`);
      }
    }
  '
  echo ""
fi

echo "✓ Setup complete!"
echo ""
echo "Restart pi to pick up all changes."
