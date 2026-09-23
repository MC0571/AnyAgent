#!/usr/bin/env bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INDEX_FILE="$SCRIPT_DIR/index.md"

die() {
  printf '%s\n' "generate-index.sh: $*" >&2
  exit 1
}

date_shape() {
  case "$1" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

metadata() {
  sed -n "s/^[[:space:]]*\\*[[:space:]]*$1[[:space:]]*[：:][[:space:]]*//p" "$record_path" |
    sed -n '1s/[[:space:]]*$//p'
}

validate_structure() {
  awk -v current="$1" '
    function trim(value) {
      gsub(/^[[:space:]]+/, "", value)
      gsub(/[[:space:]]+$/, "", value)
      return value
    }
    BEGIN {
      expected[1] = "当前决定"
      expected[2] = "理由"
      expected[3] = "不采用"
      expected[4] = "关联事实载体"
      expected[5] = "修订记录"
    }
    /^##[[:space:]]+/ {
      section = $0
      sub(/^##[[:space:]]+/, "", section)
      section = trim(section)
      count++
      if (count > 5 || section != expected[count]) bad = 1
      in_revisions = (section == "修订记录")
      next
    }
    in_revisions && /^###[[:space:]]+/ {
      date = $0
      sub(/^###[[:space:]]+/, "", date)
      date = trim(date)
      if (date !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) {
        bad = 1
        next
      }
      key = date
      gsub(/-/, "", key)
      if (revision_count && key > previous_key) bad = 1
      if (!revision_count) first = date
      previous_key = key
      revision_count++
    }
    END { exit (bad || count != 5 || revision_count == 0 || first != current) }
  ' "$2"
}

parse_record() {
  record_path=$1
  record_name=$2
  filename_number=$3

  title=$(sed -n '1s/^#[[:space:]]*决策记录[[:space:]]*//p' "$record_path")
  case "$title" in
    [0-9][0-9][0-9][0-9][：:]* ) ;;
    *) die "$record_name: title must contain NNNN：主题" ;;
  esac
  title_number=$(printf '%s\n' "$title" | sed 's/[：:].*$//; s/[[:space:]]*$//')
  title_text=$(printf '%s\n' "$title" | sed 's/^[0-9][0-9][0-9][0-9][：:]//; s/[[:space:]]*$//')
  case "$title_number" in
    [0-9][0-9][0-9][0-9]) ;;
    *) die "$record_name: title must start with NNNN：主题" ;;
  esac
  [ "$title_number" = "$filename_number" ] || die "$record_name: title number does not match filename"
  [ -n "$title_text" ] || die "$record_name: title is empty"

  status=$(metadata '状态')
  decision_type=$(metadata '类型')
  summary=$(metadata '决策简述')
  current_revision=$(metadata '当前修订')
  [ "$status" = "Accepted" ] || die "$record_name: status must be Accepted"
  case "$decision_type" in
    Product|Architecture|Data|Design|AI|Implementation|Security|Operations|Governance|Other) ;;
    *) die "$record_name: invalid decision type" ;;
  esac
  [ -n "$summary" ] || die "$record_name: decision summary is empty"
  date_shape "$current_revision" || die "$record_name: invalid current revision date"
  if grep -Eq '^[[:space:]]*\*[[:space:]]*(替代|被替代)[[:space:]]*[：:]' "$record_path"; then
    die "$record_name: replacement metadata is not allowed"
  fi
  validate_structure "$current_revision" "$record_path" || die "$record_name: sections or revision history are invalid"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$filename_number" "$title" "$record_name" "$decision_type" "$status" "$current_revision" "$summary"
}

case "$#" in
  0) mode=generate ;;
  1) [ "$1" = "--check" ] || die "usage: $0 [--check]"; mode=check ;;
  *) die "usage: $0 [--check]" ;;
esac

temp_root=$(mktemp -d "${TMPDIR:-/tmp}/anyagent-decisions.XXXXXX")
trap 'rm -rf "$temp_root"' EXIT HUP INT TERM
rows="$temp_root/rows"
sorted_rows="$temp_root/rows.sorted"
generated="$temp_root/index.md"
: > "$rows"

for record_path in "$SCRIPT_DIR"/*.md; do
  [ -f "$record_path" ] || continue
  record_name=${record_path##*/}
  case "$record_name" in
    AGENTS.md|index.md) continue ;;
    [0-9][0-9][0-9][0-9]-*.md) ;;
    *) die "invalid decision filename: $record_name" ;;
  esac
  filename_number=${record_name%%-*}
  filename_topic=${record_name#*-}
  filename_topic=${filename_topic%.md}
  [ -n "$filename_topic" ] || die "$record_name: topic is empty"
  parse_record "$record_path" "$record_name" "$filename_number" >> "$rows"
done

if ! awk -F '\t' '{ seen[$1]++; if (seen[$1] > 1) bad = 1 } END { exit bad }' "$rows"; then
  die "duplicate decision number"
fi
LC_ALL=C sort -n "$rows" > "$sorted_rows"

{
  printf '%s\n\n' '# AnyAgent 决策索引'
  printf '%s\n\n' '> 本文件由 [决策记录规则](AGENTS.md) 规定并由 `generate-index.sh` 自动生成，请勿手工编辑。'
  printf '%s\n' '| 决策 | 类型 | 状态 | 当前修订 | 决策简述 |'
  printf '%s\n' '| --- | --- | --- | --- | --- |'
  while IFS="$(printf '\t')" read -r number title record_name decision_type status current_revision summary; do
    [ -n "$number" ] || continue
    escaped_title=$(printf '%s' "$title" | sed 's/|/\\|/g')
    escaped_name=$(printf '%s' "$record_name" | sed 's/|/\\|/g')
    escaped_type=$(printf '%s' "$decision_type" | sed 's/|/\\|/g')
    escaped_status=$(printf '%s' "$status" | sed 's/|/\\|/g')
    escaped_revision=$(printf '%s' "$current_revision" | sed 's/|/\\|/g')
    escaped_summary=$(printf '%s' "$summary" | sed 's/|/\\|/g')
    printf '| [%s](%s) | %s | %s | %s | %s |\n' \
      "$escaped_title" "$escaped_name" "$escaped_type" "$escaped_status" "$escaped_revision" "$escaped_summary"
  done < "$sorted_rows"
} > "$generated"

if [ "$mode" = check ]; then
  [ -f "$INDEX_FILE" ] || die "index.md is missing"
  cmp -s "$generated" "$INDEX_FILE" || die "index.md is stale; run without --check to regenerate"
else
  mv "$generated" "$INDEX_FILE"
fi
