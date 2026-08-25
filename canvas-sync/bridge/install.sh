#!/usr/bin/env bash
# bridge/install.sh — bootstrap ~/Documents/CANVASync and bridge deps.
# Local-only. No network calls except `npm install` for pinned bridge deps.
set -euo pipefail

# ---------- CLI flags ----------
BASE_PATH=""
ACCEPT_UNENCRYPTED=0
AUTO_LAUNCHD=""   # "", "y", "n"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-path)           BASE_PATH="$2"; shift 2 ;;
    --base-path=*)         BASE_PATH="${1#*=}"; shift ;;
    --accept-unencrypted)  ACCEPT_UNENCRYPTED=1; shift ;;
    --launchd)             AUTO_LAUNCHD="y"; shift ;;
    --no-launchd)          AUTO_LAUNCHD="n"; shift ;;
    -h|--help)
      cat <<EOF
Usage: bridge/install.sh [--base-path <dir>] [--accept-unencrypted] [--launchd|--no-launchd]

  --base-path DIR       Use DIR instead of ~/canvas-sync-data as the data root.
                        Must be outside ~/Documents, ~/Desktop and ~/Downloads.
  --accept-unencrypted  Continue even if FileVault is off (macOS).
  --launchd             Install launchd auto-start without prompting.
  --no-launchd          Skip launchd prompt.
EOF
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------- helpers ----------
red()    { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

# ---------- Node version ----------
if ! command -v node >/dev/null 2>&1; then
  red "Node.js is not installed. Install Node 20+ and re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  red "Node $NODE_MAJOR detected. Node 20+ required."
  exit 1
fi

# ---------- Resolve data root ----------
# Default is ~/canvas-sync-data, matching data-root.js and app/main.js — change
# all three together. It is deliberately NOT under ~/Documents: macOS gates that
# folder behind TCC (the unsigned app gets EPERM with no permission prompt), and
# iCloud "Desktop & Documents Folders" evicts files to .icloud placeholders and
# forks concurrent writes into "name 2.json" conflict copies.
if [[ -z "$BASE_PATH" ]]; then
  BASE_PATH="$HOME/canvas-sync-data"
fi
# Normalize to absolute
BASE_PATH="$(cd "$(dirname "$BASE_PATH")" 2>/dev/null && pwd)/$(basename "$BASE_PATH")" || true
BASE_PATH="${BASE_PATH%/}"

# ---------- Cloud-sync refusal checks ----------
check_cloud_path() {
  local p="$1"
  local real
  real="$(cd "$p" 2>/dev/null && pwd -P || true)"
  if [[ -n "$real" ]]; then
    case "$real" in
      *"/Library/Mobile Documents/com~apple~CloudDocs"*)
        red "Refusing to install: '$p' resolves inside iCloud Drive ($real)."
        yellow "Either disable 'Desktop & Documents Folders' in System Settings"
        yellow "→ [your name] → iCloud → iCloud Drive → Options, or pass"
        yellow "--base-path ~/Documents-Local to pick a non-synced location."
        exit 1 ;;
      *Dropbox*|*OneDrive*|*"Google Drive"*|*"GoogleDrive"*)
        red "Refusing to install: '$p' is inside a cloud-sync folder ($real)."
        yellow "Pick a location outside Dropbox/OneDrive/Google Drive, e.g.:"
        yellow "  --base-path ~/canvas-sync-data"
        exit 1 ;;
    esac
  fi
}

if is_macos; then
  # TCC-protected folders. macOS gates these per-file, and an unsigned bundle
  # with a shell-script CFBundleExecutable has no stable identity for a TCC
  # grant to key to — so the denial arrives as EPERM with NO permission prompt
  # and no entry the user can add in System Settings. Refuse outright; there is
  # no "grant access and continue" path to offer.
  case "$BASE_PATH" in
    "$HOME/Documents"|"$HOME/Documents/"*|\
    "$HOME/Desktop"|"$HOME/Desktop/"*|\
    "$HOME/Downloads"|"$HOME/Downloads/"*)
      red "Refusing to install: '$BASE_PATH' is inside a macOS TCC-protected folder."
      yellow "Documents, Desktop and Downloads are permission-gated; the app is"
      yellow "denied silently there. Use a plain home-directory location:"
      yellow "  --base-path ~/canvas-sync-data"
      exit 1 ;;
  esac

  # iCloud Desktop & Documents check — kept as a second net for --base-path
  # values that dodge the case above but still land in a synced tree.
  if defaults read com.apple.finder FXICloudDriveDesktop 2>/dev/null | grep -q '^1$'; then
    yellow "Note: iCloud 'Desktop & Documents Folders' is enabled on this Mac."
    yellow "The data root at $BASE_PATH is outside those folders, so it is unaffected."
  fi
fi

PARENT_DIR="$(dirname "$BASE_PATH")"
mkdir -p "$PARENT_DIR"
check_cloud_path "$PARENT_DIR"

# ---------- FileVault check (macOS only) ----------
if is_macos && command -v fdesetup >/dev/null 2>&1; then
  if ! fdesetup status 2>/dev/null | grep -q 'FileVault is On'; then
    yellow "FileVault is OFF. Data at rest in $BASE_PATH will be unencrypted."
    if (( ACCEPT_UNENCRYPTED == 0 )); then
      red "Refusing to continue. Enable FileVault, or re-run with --accept-unencrypted."
      exit 1
    fi
  fi
fi

# ---------- Create data layout ----------
bold "Creating data layout at $BASE_PATH"
mkdir -p "$BASE_PATH/classes" "$BASE_PATH/raw" "$BASE_PATH/logs"
chmod 700 "$BASE_PATH"
touch "$BASE_PATH/.nogit"

# ---------- Generate secret + install token ----------
if command -v openssl >/dev/null 2>&1; then
  SECRET="$(openssl rand -hex 32)"
  TOKEN="$(openssl rand -hex 16)"
else
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
fi

CONFIG_PATH="$BASE_PATH/config.json"
if [[ -f "$CONFIG_PATH" ]]; then
  yellow "config.json already exists at $CONFIG_PATH — preserving existing bridgeSecret."
  EXISTING_SECRET="$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).bridgeSecret || "") } catch { console.log("") }' "$CONFIG_PATH")"
  if [[ -n "$EXISTING_SECRET" ]]; then
    SECRET="$EXISTING_SECRET"
  fi
fi

# Write config.json atomically with chmod 600.
TMP_CFG="$CONFIG_PATH.tmp.$$"
node -e '
  const fs = require("fs");
  const [out, secret] = process.argv.slice(1);
  const cfg = { version: "1.0.0", bridgeSecret: secret, bridgePort: 3847, extensionId: null };
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2), { mode: 0o600 });
' "$TMP_CFG" "$SECRET"
mv "$TMP_CFG" "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"

# Write install-token.txt with chmod 600 (10-minute TTL enforced by bridge via mtime).
TOKEN_PATH="$BASE_PATH/install-token.txt"
umask 077
printf '%s\n' "$TOKEN" > "$TOKEN_PATH"
chmod 600 "$TOKEN_PATH"
umask 022

# ---------- Install bridge dependencies ----------
bold "Installing bridge dependencies (no audit/fund phone-home)"
cd "$SCRIPT_DIR"
npm install --no-audit --no-fund --loglevel=error

# Run a local audit pass; fail on high/critical.
set +e
AUDIT_OUT="$(npm audit --omit=dev --audit-level=high --json 2>/dev/null)"
AUDIT_STATUS=$?
set -e
if (( AUDIT_STATUS != 0 )); then
  HIGH=$(node -e 'try { const d=JSON.parse(process.argv[1]); const m=d.metadata?.vulnerabilities||{}; console.log((m.high||0)+(m.critical||0)); } catch { console.log(0); }' "$AUDIT_OUT" 2>/dev/null || echo 0)
  if (( HIGH > 0 )); then
    red "npm audit found $HIGH high/critical vulnerabilities in bridge deps."
    red "Review and remediate before continuing."
    exit 1
  fi
fi

# ---------- launchd (macOS optional) ----------
install_launchd() {
  local plist="$HOME/Library/LaunchAgents/com.canvas-sync.bridge.plist"
  local node_bin
  node_bin="$(command -v node)"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.canvas-sync.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$SCRIPT_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$SCRIPT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$BASE_PATH/logs/bridge.out.log</string>
  <key>StandardErrorPath</key><string>$BASE_PATH/logs/bridge.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CANVAS_SYNC_HOME</key><string>$BASE_PATH</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST
  chmod 644 "$plist"
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  green "launchd agent installed and loaded."
  green "Bridge will auto-start on login. Logs: $BASE_PATH/logs/bridge.*.log"
}

if is_macos; then
  if [[ -z "$AUTO_LAUNCHD" ]]; then
    echo
    read -r -p "Install launchd agent to auto-start bridge on login? [y/N] " answer
    AUTO_LAUNCHD="${answer:0:1}"
  fi
  case "$AUTO_LAUNCHD" in
    y|Y) install_launchd ;;
    *)   yellow "Skipping launchd. Start bridge manually with: node $SCRIPT_DIR/server.js" ;;
  esac
fi

# ---------- Final instructions ----------
echo
green "============================================================"
green "  Canvas Sync bridge ready"
green "============================================================"
echo
bold  "Next steps:"
echo
echo  "  1. Load the extension in Chrome:"
echo  "       chrome://extensions → Developer mode ON → Load unpacked"
echo  "       Select: $REPO_ROOT/extension"
echo
echo  "  2. If the bridge is not running, start it:"
echo  "       node $SCRIPT_DIR/server.js"
echo
echo  "  3. Click the extension icon and paste this install token"
echo  "     (valid 10 minutes — do NOT share):"
echo
bold  "     $TOKEN"
echo
echo  "  4. Open canvas.rice.edu. Sync fires automatically within seconds."
echo
echo  "Data folder: $BASE_PATH"
echo  "Config:      $CONFIG_PATH  (chmod 600)"
echo  "Logs:        $BASE_PATH/logs/"
echo
yellow "The install token file will be deleted by the bridge after handshake."
yellow "Never commit $BASE_PATH to git. The .nogit marker is there to remind you."
