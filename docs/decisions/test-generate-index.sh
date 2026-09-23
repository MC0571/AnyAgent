#!/usr/bin/env bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/anyagent-decision-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM

fail() {
  printf '%s\n' "test-generate-index.sh: $*" >&2
  exit 1
}

assert_contains() {
  grep -F "$2" "$1" >/dev/null || fail "expected '$2' in $1"
}

assert_same() {
  cmp -s "$1" "$2" || fail "files differ: $1 $2"
}

GENERATOR="$TEST_ROOT/generate-index.sh"
cp "$SCRIPT_DIR/generate-index.sh" "$GENERATOR"
chmod +x "$GENERATOR"

cat > "$TEST_ROOT/0001-workspace.md" <<'EOF'
# 决策记录 0001：工作区归属

* 状态： Accepted
* 类型： Product
* 决策简述：保留本地工作区 | 让 Agent 可更换
* 当前修订： 2026-09-22

## 当前决定
工作区属于产品层。

## 理由
工作资产可以连续使用。

## 不采用
不把工作区绑定到单一 Engine。

## 关联事实载体
[VISION.md](../../VISION.md)

## 修订记录

### 2026-09-22
初始决定。
EOF

(cd "$TEST_ROOT" && "$GENERATOR")
assert_contains "$TEST_ROOT/index.md" '# AnyAgent 决策索引'
assert_contains "$TEST_ROOT/index.md" '[0001：工作区归属](0001-workspace.md)'
assert_contains "$TEST_ROOT/index.md" '保留本地工作区 \| 让 Agent 可更换'
(cd "$TEST_ROOT" && "$GENERATOR" --check)

cp "$TEST_ROOT/index.md" "$TEST_ROOT/index.stable"
printf '\n' >> "$TEST_ROOT/index.md"
cp "$TEST_ROOT/index.md" "$TEST_ROOT/index.stale"
if (cd "$TEST_ROOT" && "$GENERATOR" --check); then
  fail "stale index was accepted"
fi
assert_same "$TEST_ROOT/index.stale" "$TEST_ROOT/index.md"
cp "$TEST_ROOT/index.stable" "$TEST_ROOT/index.md"

sed -e 's/0001/0002/g' -e 's/### 2026-09-22/### 2026-09-21/' "$TEST_ROOT/0001-workspace.md" > "$TEST_ROOT/0002-wrong-first-revision.md"
if (cd "$TEST_ROOT" && "$GENERATOR"); then
  fail "wrong first revision was accepted"
fi
assert_same "$TEST_ROOT/index.stable" "$TEST_ROOT/index.md"
rm "$TEST_ROOT/0002-wrong-first-revision.md"

sed 's/0001：工作区归属/0002/' "$TEST_ROOT/0001-workspace.md" > "$TEST_ROOT/0002-no-colon.md"
if (cd "$TEST_ROOT" && "$GENERATOR"); then
  fail "title without colon was accepted"
fi
assert_same "$TEST_ROOT/index.stable" "$TEST_ROOT/index.md"
rm "$TEST_ROOT/0002-no-colon.md"

sed 's/0001/0002/g' "$TEST_ROOT/0001-workspace.md" > "$TEST_ROOT/0002-one.md"
sed 's/0001/0002/g' "$TEST_ROOT/0001-workspace.md" > "$TEST_ROOT/0002-two.md"
if (cd "$TEST_ROOT" && "$GENERATOR"); then
  fail "duplicate decision number was accepted"
fi
assert_same "$TEST_ROOT/index.stable" "$TEST_ROOT/index.md"
rm "$TEST_ROOT/0002-one.md" "$TEST_ROOT/0002-two.md"

EMPTY_ROOT="$TEST_ROOT/empty"
mkdir "$EMPTY_ROOT"
cp "$GENERATOR" "$EMPTY_ROOT/generate-index.sh"
chmod +x "$EMPTY_ROOT/generate-index.sh"
(cd "$EMPTY_ROOT" && ./generate-index.sh)
assert_contains "$EMPTY_ROOT/index.md" '| 决策 | 类型 | 状态 | 当前修订 | 决策简述 |'
(cd "$EMPTY_ROOT" && ./generate-index.sh --check)

printf '%s\n' 'ok'
