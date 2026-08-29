#!/bin/bash
# setup-local-model.sh — install the local model backend, or switch which model
# it uses.
#
# The app works without this: with no local model it falls back to the `claude`
# CLI, and with neither it degrades to the deterministic paths. But mining a
# syllabus for the work Canvas never lists needs a model, and the local one is
# the option that costs nothing and sends nothing anywhere.
#
# Two tiers, because a 23 GB model is not a reasonable ask of every machine:
#
#   standard  Qwen3.6-35B-A3B (4-bit MLX), ~23 GB on disk, wants 32 GB of RAM.
#             The default, and what this machine already runs.
#   light     Qwen3-4B-Instruct (4-bit MLX), ~2.5 GB on disk, fine on 16 GB.
#             Noticeably weaker at long syllabus extraction; adequate for chat.
#
# Idempotent: re-running with the same tier verifies and exits without
# re-downloading. Safe to run while the app is open — it never loads the model,
# so it cannot collide with a job that has the machine-wide model lock.
#
# Usage:
#   ./setup-local-model.sh                 # standard tier
#   ./setup-local-model.sh --tier light    # small machines
#   ./setup-local-model.sh --model <hf-repo-id>
#   ./setup-local-model.sh --check         # report state, change nothing

set -u -o pipefail

VENV="${CSYNC_LOCAL_VENV:-$HOME/mlx-env}"
DATA_ROOT="${CANVAS_SYNC_HOME:-$HOME/canvas-sync-data}"
STANDARD_MODEL="mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit"
LIGHT_MODEL="mlx-community/Qwen3-4B-Instruct-2507-4bit"

TIER="standard"
MODEL=""
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tier)  TIER="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$MODEL" ]; then
  case "$TIER" in
    standard) MODEL="$STANDARD_MODEL" ;;
    light)    MODEL="$LIGHT_MODEL" ;;
    *) echo "Unknown tier '$TIER' (expected: standard, light)" >&2; exit 2 ;;
  esac
fi

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# --- Report ---------------------------------------------------------------
cache_dir_for() {
  # huggingface_hub's on-disk name for a repo is models--<org>--<name>: only the
  # SLASH becomes a double dash. Rewriting every hyphen turns
  # Qwen3.6-35B-A3B-OptiQ-4bit into a directory that does not exist, and the
  # script then offers to re-download 23 GB that is already on disk.
  printf '%s/.cache/huggingface/hub/models--%s' "$HOME" "$(printf '%s' "$1" | sed 's|/|--|g')"
}

report() {
  say "Local model setup"
  say "  venv:       $VENV"
  if [ -x "$VENV/bin/python" ]; then
    say "  python:     $("$VENV/bin/python" --version 2>&1)"
    if "$VENV/bin/python" -c 'import mlx_lm' >/dev/null 2>&1; then
      say "  mlx-lm:     installed"
    else
      say "  mlx-lm:     NOT installed"
    fi
  else
    say "  python:     no venv yet"
  fi
  say "  model:      $MODEL"
  local d; d="$(cache_dir_for "$MODEL")"
  if [ -d "$d" ]; then
    say "  downloaded: yes ($(du -sh "$d" 2>/dev/null | cut -f1))"
  else
    say "  downloaded: no"
  fi
  say "  free disk:  $(df -h "$HOME" | awk 'NR==2 {print $4}')"
}

if [ "$CHECK_ONLY" = "1" ]; then
  report
  exit 0
fi

report

# --- 1. Python ------------------------------------------------------------
step "Python environment"
if [ ! -x "$VENV/bin/python" ]; then
  PY=""
  for cand in python3.13 python3.12 python3.11 python3; do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
  done
  if [ -z "$PY" ]; then
    say "No python3 found. Install it first:  brew install python@3.12"
    exit 1
  fi
  say "Creating a virtual environment at $VENV using $PY"
  "$PY" -m venv "$VENV" || { say "Could not create the virtual environment."; exit 1; }
else
  say "Already present."
fi

# --- 2. mlx-lm ------------------------------------------------------------
step "MLX runtime"
if "$VENV/bin/python" -c 'import mlx_lm' >/dev/null 2>&1; then
  say "mlx-lm already installed."
else
  # Apple silicon only — MLX has no CUDA or x86 build, and failing here with a
  # clear sentence beats a pip resolver error thirty lines long.
  if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    say "MLX runs only on Apple silicon Macs. This machine is $(uname -s)/$(uname -m)."
    say "Use a subscription CLI instead: sign in to Claude Code or Codex from the app's Settings."
    exit 1
  fi
  say "Installing mlx-lm (a few minutes)..."
  "$VENV/bin/python" -m pip install --quiet --upgrade pip || exit 1
  "$VENV/bin/python" -m pip install --quiet --upgrade mlx-lm huggingface_hub || {
    say "pip install failed. Re-run without --quiet to see why:"
    say "  $VENV/bin/python -m pip install mlx-lm huggingface_hub"
    exit 1
  }
fi

# --- 3. Weights -----------------------------------------------------------
step "Model weights: $MODEL"
CACHE="$(cache_dir_for "$MODEL")"
if [ -d "$CACHE" ]; then
  say "Already downloaded ($(du -sh "$CACHE" 2>/dev/null | cut -f1))."
else
  say "Downloading. This is large — 23 GB for the standard tier, about 2.5 GB for light."
  say "It resumes if interrupted, so re-run this script if the connection drops."
  "$VENV/bin/python" - "$MODEL" <<'PY' || { echo "Download failed."; exit 1; }
import sys
from huggingface_hub import snapshot_download
repo = sys.argv[1]
try:
    path = snapshot_download(repo)
except Exception as err:
    print(f"Could not download {repo}: {err}", file=sys.stderr)
    raise SystemExit(1)
print(f"Downloaded to {path}")
PY
fi

# --- 4. Record the choice -------------------------------------------------
# The pipeline reads settings.json's env block on every spawn, and the bridge
# resolves the same key per call, so writing it here is enough — nothing needs
# restarting.
step "Recording the choice"
SETTINGS="$DATA_ROOT/settings.json"
if [ -d "$DATA_ROOT" ]; then
  if command -v node >/dev/null 2>&1; then
    MODEL="$MODEL" SETTINGS="$SETTINGS" node -e '
      const fs = require("node:fs");
      const p = process.env.SETTINGS;
      let cfg = { env: {} };
      try { cfg = JSON.parse(fs.readFileSync(p, "utf8")) ?? { env: {} }; } catch {}
      if (!cfg.env || typeof cfg.env !== "object") cfg.env = {};
      cfg.env.CSYNC_LOCAL_MODEL = process.env.MODEL;
      const tmp = p + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, p);
      console.log("CSYNC_LOCAL_MODEL = " + process.env.MODEL + "  ->  " + p);
    ' || say "Could not write $SETTINGS — set CSYNC_LOCAL_MODEL by hand."
  else
    say "node not on PATH; set CSYNC_LOCAL_MODEL=$MODEL yourself in $SETTINGS"
  fi
else
  say "No data root at $DATA_ROOT yet — run the app once, then re-run this."
fi

step "Done"
say "The model is installed but not loaded. It loads on the first job that needs it,"
say "which takes a minute; after that it stays warm."
say ""
say "Verify it end to end from the app: Settings -> run the pipeline, or ask the"
say "class chat a question."
