#!/bin/zsh
# Interactive subscription login for CANVASync's terminal AI backends.
# Opened in Terminal by the dashboard; never asks for or stores an API key.

set -u

provider="${1:-}"
case "$provider" in
  claude)
    command_name="claude"
    login_label="Claude Code"
    login_args=(auth login)
    status_args=(auth status)
    ;;
  codex)
    command_name="codex"
    login_label="Codex"
    login_args=(login)
    status_args=(login status)
    ;;
  *)
    echo "CANVASync terminal AI setup"
    echo "Usage: $0 claude|codex"
    read -k 1 "?Press any key to close."
    exit 2
    ;;
esac

echo "CANVASync — $login_label account login"
echo ""
echo "This uses your existing subscription account. No API key is requested or stored."
echo ""

if ! command -v "$command_name" >/dev/null 2>&1; then
  echo "$login_label is not installed or is not on this terminal's PATH."
  if [ "$provider" = "codex" ]; then
    echo "Install Codex, then return to CANVASync Settings and try again:"
    echo "  curl -fsSL https://chatgpt.com/codex/install.sh | sh"
  else
    echo "Install Claude Code, then return to CANVASync Settings and try again."
    echo "  https://code.claude.com/docs/en/quickstart"
  fi
  echo ""
  read -k 1 "?Press any key to close."
  exit 1
fi

is_signed_in() {
  if [ "$provider" = "claude" ]; then
    "$command_name" "${status_args[@]}" 2>/dev/null | grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true'
  else
    "$command_name" "${status_args[@]}" >/dev/null 2>&1
  fi
}

if is_signed_in; then
  echo "$login_label is already signed in."
else
  "$command_name" "${login_args[@]}"
fi

echo ""
if is_signed_in; then
  "$command_name" "${status_args[@]}"
  echo ""
  echo "Success. CANVASync can now use $login_label for pipeline and class-chat work."
else
  echo ""
  echo "Login was not completed. You can leave this window open and try again."
fi
echo ""
read -k 1 "?Press any key to close."
