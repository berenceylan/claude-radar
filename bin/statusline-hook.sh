#!/bin/sh
# Claude Radar statusline hook
# Captures rate limit data from Claude Code's statusline JSON input
# and saves it for the dashboard to read.
#
# Usage: Set in ~/.claude/settings.json:
# "statusLine": { "type": "command", "command": "bash /path/to/statusline-hook.sh" }

RADAR_DIR="$HOME/.claude-radar"
RATE_FILE="$RADAR_DIR/rate-limits.json"

input=$(cat)

# Save rate limit data for Claude Radar dashboard
five_pct=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
resets_at=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')

if [ -n "$five_pct" ]; then
  mkdir -p "$RADAR_DIR"
  printf '{"usedPct":%s,"resetsAt":%s,"ts":%s}\n' \
    "${five_pct}" "${resets_at:-null}" "$(date +%s)" > "$RATE_FILE"
fi

# Output statusline (same format as before)
ctx_used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
if [ -n "$ctx_used" ]; then
  ctx_display=$(printf "%.0f" "$ctx_used")
  ctx_part="ctx: ${ctx_display}%"
else
  ctx_part="ctx: --%"
fi

if [ -n "$five_pct" ]; then
  five_display=$(printf "%.0f" "$five_pct")
  five_part="5h: ${five_display}%"
else
  five_part="5h: --%"
fi

if [ -n "$resets_at" ]; then
  reset_time=$(date -r "$resets_at" "+%H:%M" 2>/dev/null || date -d "@$resets_at" "+%H:%M" 2>/dev/null)
  reset_part="resets: ${reset_time}"
else
  reset_part="resets: --:--"
fi

printf "%s | %s | %s" "$ctx_part" "$five_part" "$reset_part"
