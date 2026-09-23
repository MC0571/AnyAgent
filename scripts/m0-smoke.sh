#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
runtime="$(pwd)/.anyagent-runtime"
marker="$runtime/smoke-start"
baseline_file="$runtime/smoke-last-message"
db="$runtime/home/.zcode/cli/db/db.sqlite"
log="$runtime/m0-desktop.log"

case "${1:-}" in
  before)
    mkdir -p -m 700 "$runtime"
    if [[ -f "$db" ]]; then
      sqlite3 -readonly "$db" 'SELECT COALESCE(MAX(time_created),0) FROM message;' > "$baseline_file"
    else
      printf '0\n' > "$baseline_file"
    fi
    : > "$log"
    touch "$marker"
    echo "M0 smoke marker: $marker"
    ;;
  after)
    [[ -f "$marker" && -f "$baseline_file" && -f "$db" && -s "$log" ]] || { echo "Run 'bash scripts/m0-smoke.sh before' before the first launch and complete a logged chat." >&2; exit 1; }
    baseline="$(cat "$baseline_file")"
    [[ "$baseline" =~ ^[0-9]+$ ]] || { echo "Invalid smoke baseline." >&2; exit 1; }
    for path in "$HOME/.zcode" "$HOME/Library/Application Support/ZCode" "$HOME/Library/Application Support/ZCode Dev" "$HOME/Library/Application Support/ZCode Preview"; do
      if [[ -e "$path" && -n "$(find "$path" -newer "$marker" -print -quit)" ]]; then
        echo "Upstream data changed after M0 launch: $path" >&2
        exit 1
      fi
    done
    result="$(sqlite3 -readonly "$db" "SELECT EXISTS(SELECT 1 FROM message u JOIN part up ON up.message_id=u.id JOIN message a ON a.session_id=u.session_id AND a.sequence=u.sequence+1 JOIN part ap ON ap.message_id=a.id WHERE u.time_created > $baseline AND json_extract(u.data,'$.role')='user' AND json_extract(up.data,'$.text')='Reply exactly M0_GO_OK_9243' AND json_extract(a.data,'$.role')='assistant' AND json_extract(ap.data,'$.text')='M0_GO_OK_9243');")"
    [[ "$result" == "1" ]] || { echo "Expected native chat response was not found in the isolated database." >&2; exit 1; }
    if grep -Eq 'client-config\.getSnapshot FAIL|\[community\] failed to fetch remote config' "$log"; then
      echo "An unselected upstream configuration request failed during the smoke run." >&2
      exit 1
    fi
    echo "M0 smoke passed: upstream data unchanged; isolated native chat recorded; no public config fetch failure in log."
    ;;
  *)
    echo "Usage: bash scripts/m0-smoke.sh before|after" >&2
    exit 2
    ;;
esac
