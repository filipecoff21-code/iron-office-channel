#!/bin/bash
# claude falso da onda 68: estado em $FAKE_META_STATE (absent|needs|connected); cada chamada anotada em $FAKE_META_LOG
LOG="${FAKE_META_LOG:-/dev/null}"; ST="${FAKE_META_STATE:-}"
printf '%s\n' "$*" >> "$LOG"
estado() { if [ -n "$ST" ] && [ -f "$ST" ]; then cat "$ST"; else echo none; fi; }
if [ "$1 $2" = "mcp get" ]; then
  case "$(estado)" in
    connected) printf 'meta-ads:\n  Status: \xe2\x9c\x94 Connected\n';;
    needs) printf 'meta-ads:\n  Status: ! Needs authentication\n';;
    absent) echo 'No MCP server named "meta-ads". Configured servers: x'; exit 1;;
    *) exit 1;;
  esac
  exit 0
fi
if [ "$1 $2" = "mcp add" ]; then echo needs > "$ST"; echo added; exit 0; fi
if [ "$1 $2" = "mcp login" ]; then
  echo "If the browser didn't open, visit:"
  echo "  https://www.facebook.com/v27.0/dialog/oauth?response_type=code&client_id=1&state=abc"
  if [ "${FAKE_LOGIN:-ok}" = "ok" ]; then sleep 1; echo connected > "$ST"; echo 'Authenticated with "meta-ads".'; exit 0; fi
  sleep 600; exit 1
fi
exit 1
