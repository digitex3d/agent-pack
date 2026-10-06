#!/bin/bash
# tabeli smoke-test suite: builds nothing, expects ./tabeli to exist (make first).
set -u
REPO=$(pwd)
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
cp tabeli "$DIR/seed"
cd "$DIR"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { # check <desc> <expected-substring> <actual>
  case "$3" in *"$2"*) ok ;; *) fail "$1 — expected '$2' in: $3" ;; esac
}
check_rc() { # check_rc <desc> <expected-rc> <actual-rc>
  [ "$2" = "$3" ] && ok || fail "$1 — expected rc=$2 got rc=$3"
}

# --- seed & init ---
out=$(./seed); check "seed help" "creates self-contained tables" "$out"
out=$(./seed a x=1 2>&1); rc=$?
check_rc "seed refuses verbs" 2 $rc
out=$(./seed init t.tbl)
check "init message" "created t.tbl" "$out"
[ -x t.tbl ] && ok || fail "table is executable"
out=$(./seed init t.tbl 2>&1); rc=$?
check_rc "init refuses overwrite" 2 $rc

# --- help ---
out=$(./t.tbl); check "table help" "data lives inside this file" "$out"

# --- a: echo, ids, timestamps ---
out=$(./t.tbl a title='fix lock' status=open prio=2)
check "a echo id" "id=1 title='fix lock' status=open prio=2" "$out"
check "a echo created_at" "created_at=" "$out"
out=$(./t.tbl a title=second status=open prio=1 by=agent-a)
check "a by= becomes created_by" "created_by=agent-a" "$out"
out=$(./t.tbl a title=third status=done prio=5)
check "a third id" "id=3" "$out"

# --- reserved keys teach ---
out=$(./t.tbl a id=9 x=1 2>&1); rc=$?
check_rc "a rejects id=" 2 $rc
check "id error teaches" "assigned by the engine" "$out"
out=$(./t.tbl a created_at=2020-01-01 x=1 2>&1); rc=$?
check_rc "a rejects created_at" 2 $rc
check "ts error teaches" "engine-owned" "$out"

# --- q: filters, ops, limit, count, ts hiding ---
out=$(./t.tbl q status=open)
check "q eq matches 2" "# 2 records" "$out"
case "$out" in *created_at*) fail "q hides ts by default" ;; *) ok ;; esac
out=$(./t.tbl q status=open ts)
check "q ts flag shows ts" "created_at=" "$out"
out=$(./t.tbl q status!=open)
check "q neq" "id=3" "$out"
out=$(./t.tbl q prio\>1)
check "q gt matches 2" "# 2 records" "$out"
out=$(./t.tbl q prio\>=2)
check "q ge matches 2" "# 2 records" "$out"
out=$(./t.tbl q title~lock)
check "q contains" "id=1" "$out"
out=$(./t.tbl q status=open prio\>1)
check "q AND" "# 1 record" "$out"
out=$(./t.tbl q limit=1)
check "q limit truncation notice" "showing 1 of 3" "$out"
out=$(./t.tbl q count)
check "q count mode" "# 3 records" "$out"
out=$(./t.tbl q status=missing)
check "q empty explicit" "# 0 records match" "$out"
out=$(./t.tbl q staus 2>&1); rc=$?
check_rc "bad filter rc" 2 $rc
check "bad filter teaches" "filters look like" "$out"

# --- quoting round-trip (quotes, $(), spaces) ---
./t.tbl a "title=has 'quote' and \$(rm -rf /) inside" >/dev/null
out=$(./t.tbl g 4)
check "quote round-trip" "'\\''" "$out"
check "dollar preserved inside single quotes" '$(rm -rf /)' "$out"
out=$(./t.tbl q title~quote)
check "q finds quoted value" "id=4" "$out"

# --- g ---
out=$(./t.tbl g 2)
check "g by id" "title=second" "$out"
out=$(./t.tbl g 99 2>&1); rc=$?
check_rc "g never-existed rc" 1 $rc
check "g never-existed teaches" "never existed" "$out"

# --- s: update, CAS ---
out=$(./t.tbl s 1 status=done by=agent-b)
check "s echo" "status=done" "$out"
check "s sets updated_at" "updated_at=" "$out"
check "s sets updated_by" "updated_by=agent-b" "$out"
out=$(./t.tbl s 1 status=open if status=missingval 2>&1); rc=$?
check_rc "CAS fail rc" 4 $rc
check "CAS teaches stale view" "stale" "$out"
out=$(./t.tbl s 1 prio=9 if status=done)
check "CAS success applies" "prio=9" "$out"
out=$(./t.tbl s 1 2>&1); rc=$?
check_rc "s without assignments" 2 $rc

# --- d: delete, ids never reused ---
out=$(./t.tbl d 2)
check "d echoes record" "title=second" "$out"
out=$(./t.tbl g 2 2>&1); rc=$?
check_rc "deleted g rc" 1 $rc
check "deleted teaches no-reuse" "never reused" "$out"
out=$(./t.tbl a title=fifth status=open)
check "ids monotonic after delete" "id=5" "$out"

# --- i ---
out=$(./t.tbl i)
check "i counts" "4 records" "$out"
check "i last id" "last id=5" "$out"
check "i fields histogram" "title(4)" "$out"

# --- next: atomic take (fresh queue so state is known) ---
./seed init queue.tbl >/dev/null
./queue.tbl a job=one status=open >/dev/null
./queue.tbl a job=two status=open >/dev/null
out=$(./queue.tbl next status=open set status=claimed claimed_by=w1 by=w1)
check "next takes lowest match" "id=1" "$out"
check "next applies set" "status=claimed" "$out"
out=$(./queue.tbl next status=open set status=claimed claimed_by=w2)
check "next second take differs" "id=2" "$out"
out=$(./queue.tbl next status=open set status=claimed 2>&1); rc=$?
check_rc "next empty queue rc" 1 $rc
check "next empty queue message" "queue empty" "$out"
out=$(./queue.tbl next status=claimed 2>&1); rc=$?
check_rc "next without set" 2 $rc

# --- cursor / diff ---
sleep 1 # step past the second of the writes above: diff counts same-second updates
cur=$(./t.tbl cursor | head -1 | sed 's/# cursor=//')
out=$(./t.tbl diff "$cur")
check "diff no changes" "no changes since cursor" "$out"
sleep 1
./t.tbl a title=after status=open >/dev/null
./t.tbl s 3 prio=7 >/dev/null
./t.tbl d 4 >/dev/null
out=$(./t.tbl diff "$cur")
check "diff new record listed" "title=after" "$out"
check "diff summary" "1 new, 1 modified, 1 deleted" "$out"
out=$(./t.tbl diff nonsense 2>&1); rc=$?
check_rc "diff bad cursor rc" 2 $rc

# --- no-ts table ---
./seed init n.tbl no-ts >/dev/null
out=$(./n.tbl a x=1 by=me)
case "$out" in *created_at*|*created_by*) fail "no-ts writes no timestamps" ;; *) ok ;; esac
out=$(./n.tbl a created_at=x 2>&1); rc=$?
check_rc "no-ts still reserves ts keys" 2 $rc
out=$(./n.tbl i)
check "i shows no-ts" "no-ts" "$out"

# --- corruption detection ---
cp t.tbl c.tbl
sz=$(stat -c%s c.tbl)
printf 'X' | dd of=c.tbl bs=1 seek=$((sz - 2)) conv=notrunc 2>/dev/null
out=$(./c.tbl q 2>&1); rc=$?
check_rc "corrupt table rc" 5 $rc
check "corrupt table teaches" "crc mismatch" "$out"

# --- concurrent writers under lock (10 parallel appends, no losses) ---
./seed init p.tbl >/dev/null
for i in $(seq 1 10); do ./p.tbl a n=$i >/dev/null & done
wait
out=$(./p.tbl q count)
check "10 parallel appends all land" "# 10 records" "$out"
out=$(./p.tbl i)
check "parallel last id" "last id=10" "$out"

# --- lossless values: byte-identical round-trip through g <id> json ---
# (needs python3 to decode the JSON and write the exact bytes back out)
./seed init j.tbl >/dev/null
jval() { # jval <table> <id> <field>  -> the decoded value's exact bytes
  "./$1" g "$2" json | python3 -c 'import sys,json
sys.stdout.buffer.write(json.loads(sys.stdin.buffer.read())[sys.argv[1]].encode())' "$3"
}
rt() { # rt <desc> <value>
  printf '%s' "$2" > want.bin
  local id
  id=$(./j.tbl a v="$2" | sed -n '1s/^id=\([0-9]*\) .*/\1/p')
  jval j.tbl "$id" v > got.bin
  cmp -s want.bin got.bin && ok || fail "round-trip $1 — got: $(cat -A got.bin)"
}
rt "real newline" $'a\nb'
rt "literal backslash-n" 'a\nb'
rt "lone backslash at end" 'end\'
rt "double backslash" 'x\\y'
rt "single quotes" "it's 'quoted'"
rt "equals signs" 'a=b==c'
rt "CR" $'line\r\nnext\r'
rt "tab" $'a\tb'
rt "nested json text" '{"a":[1,"x\ny"]}'
rt "utf-8" 'è perché — 🙂'
code=$(cat <<'EOF'
function greet(name) {
  // a "quoted" comment with a \ backslash
  const re = /\d+\.\d+/g;
  console.log("hello\n" + name + '\t!');
  return `${name}\\done`;
}
EOF
)
rt "multi-line code" "$code"
out=$(./j.tbl g 1 json)
check "json id is a number" '{"id":1,' "$out"
check "json escapes newline" '"v":"a\nb"' "$out"
out=$(./j.tbl g 2)
check "human view escapes backslash" "v='a\\\\nb'" "$out"
out=$(./j.tbl g 1 bogus 2>&1); rc=$?
check_rc "g unknown option rc" 2 $rc

# --- filters on decoded values ---
out=$(./j.tbl q v=$'a\nb' count)
check "eq real newline matches only it" "# 1 record" "$out"
out=$(./j.tbl q v='a\nb' json)
check "eq literal backslash-n matches only it" '[
{"id":2,' "$out"
out=$(./j.tbl q v~$'\n' count)
check "contains real newline (not literal \\n)" "# 3 records" "$out"
out=$(./j.tbl q v~'\' count)
check "contains backslash" "# 5 records" "$out"
out=$(./j.tbl s 2 n=1 if v='a\nb')
check "if on literal backslash-n" "n=1" "$out"
out=$(./j.tbl s 1 n=1 if v='a\nb' 2>&1); rc=$?
check_rc "if literal does not match real newline" 4 $rc
out=$(./j.tbl next v=$'a\nb' set w=$'p\\q\nr')
check "next filter + set with escapes" "w='p\\\\q\\nr'" "$out"
printf 'p\\q\nr' > want.bin; jval j.tbl 1 w > got.bin
cmp -s want.bin got.bin && ok || fail "next set value round-trip"

# --- json shapes for q ---
out=$(./j.tbl q v=nope json)
check "q json empty array" "[]" "$out"
out=$(./j.tbl q count json)
check "q count json" '{"count":11}' "$out"
out=$(./j.tbl q limit=2 json 2>/dev/null | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))')
check "q json respects limit" "2" "$out"
out=$(./j.tbl q limit=2 json 2>&1 >/dev/null)
check "q json truncation notice on stderr" "showing 2 of 11" "$out"
out=$(./j.tbl q json | python3 -c 'import sys,json; r=json.load(sys.stdin)[0]; print("created_at" in r)')
check "q json hides ts by default" "False" "$out"
out=$(./j.tbl q ts json | python3 -c 'import sys,json; r=json.load(sys.stdin)[0]; print("created_at" in r)')
check "q json ts shows ts" "True" "$out"

# --- old tables: format v1 data (backslashes unescaped) is read leniently ---
# craft = seed engine + v1 header + records exactly as the v1 engine wrote them
craft() { # craft <out> <format-version> <data>
  python3 - "$1" "$2" "$3" <<'EOF'
import sys, struct, zlib
out, ver, data = sys.argv[1], int(sys.argv[2]), sys.argv[3].encode()
eng = open("seed", "rb").read()
n = data.count(b"\n")
hdr = struct.pack("<8sHHIQQI", b"TABELI01", ver, 0, n, len(data), n, zlib.crc32(data))
open(out, "wb").write(eng + hdr.ljust(64, b"\0") + data)
EOF
  chmod +x "$1"
}
craft old.tbl 1 "id=1 path='C:\\path' code='a\\nb' two='x\\\\y' end='a\\' created_at=2026-07-01T00:00:00Z
"
printf 'C:\\path' > want.bin; jval old.tbl 1 path > got.bin
cmp -s want.bin got.bin && ok || fail "v1 unknown escape kept as itself"
printf 'a\nb' > want.bin; jval old.tbl 1 code > got.bin
cmp -s want.bin got.bin && ok || fail "v1 \\n still means newline"
printf 'x\\\\y' > want.bin; jval old.tbl 1 two > got.bin
cmp -s want.bin got.bin && ok || fail "v1 double backslash stays two"
printf 'a\\' > want.bin; jval old.tbl 1 end > got.bin
cmp -s want.bin got.bin && ok || fail "v1 trailing backslash"
out=$(./old.tbl q path~'C:\p' count)
check "v1 filter on backslash value" "# 1 record" "$out"
./old.tbl s 1 n=1 >/dev/null
ver=$(python3 -c 'import struct; print(struct.unpack_from("<H", open("old.tbl","rb").read(), '"$(stat -c%s seed)"' + 8)[0])')
check "first write upgrades data to v2" "2" "$ver"
printf 'C:\\path' > want.bin; jval old.tbl 1 path > got.bin
cmp -s want.bin got.bin && ok || fail "v1 value survives the upgrade write"
craft hand.tbl 2 "id=1 x='C:\\p\\' created_at=2026-07-01T00:00:00Z
"
printf 'C:\\p\\' > want.bin; jval hand.tbl 1 x > got.bin
cmp -s want.bin got.bin && ok || fail "v2 unknown escape decodes leniently"
craft future.tbl 3 ""
out=$(./future.tbl q 2>&1); rc=$?
check_rc "unknown future format refused" 5 $rc

# --- upgrade: a genuine v1 table (the last v1 engine, vendored as a fixture) onto v2 ---
if ${CC:-cc} -O2 "$REPO/test-fixtures/tabeli-v1.c" -o v1seed 2>/dev/null; then
  ./v1seed init v1.tbl >/dev/null
  ./v1.tbl a title=$'line1\nline2' q="it's" eq='a=b==c' u='è 🙂' by=agent >/dev/null
  ./v1.tbl a title=plain status=open >/dev/null
  ./v1.tbl a title=gone >/dev/null
  ./v1.tbl a path='C:\path' >/dev/null
  ./v1.tbl s 2 status=done by=agent-b >/dev/null
  ./v1.tbl d 3 >/dev/null
  ./v1seed init v1n.tbl no-ts >/dev/null
  ./v1n.tbl a x=1 >/dev/null
  chmod 0750 v1.tbl
  before=$(./v1.tbl g 2)
  sleep 1 # diff counts same-second updates as modified: step past the writes above
  cur=$(./v1.tbl cursor | head -1 | sed 's/# cursor=//')
  curn=$(./v1n.tbl cursor | head -1 | sed 's/# cursor=//')
  out=$(./v1.tbl q json 2>&1); rc=$?
  check_rc "v1 table rejects json (the reason for upgrade)" 2 $rc
  out=$(./seed upgrade v1.tbl); rc=$?
  check_rc "upgrade rc" 0 $rc
  check "upgrade reports" "format v1 -> v2, 3 records, last id=4" "$out"
  out=$(./v1.tbl | head -1)
  check "upgraded table speaks v2" "# tabeli v2" "$out"
  check "upgrade keeps file mode" "750" "$(stat -c%a v1.tbl)"
  check "plain record identical after upgrade (ts, by, fields)" "$before" "$(./v1.tbl g 2)"
  printf 'line1\nline2' > want.bin; jval v1.tbl 1 title > got.bin
  cmp -s want.bin got.bin && ok || fail "upgrade: newline value round-trip"
  printf "it's" > want.bin; jval v1.tbl 1 q > got.bin
  cmp -s want.bin got.bin && ok || fail "upgrade: quote value round-trip"
  printf 'a=b==c' > want.bin; jval v1.tbl 1 eq > got.bin
  cmp -s want.bin got.bin && ok || fail "upgrade: equals value round-trip"
  printf 'è 🙂' > want.bin; jval v1.tbl 1 u > got.bin
  cmp -s want.bin got.bin && ok || fail "upgrade: utf-8 value round-trip"
  printf 'C:\\path' > want.bin; jval v1.tbl 4 path > got.bin
  cmp -s want.bin got.bin && ok || fail "upgrade: v1 backslash stays literal"
  out=$(./v1.tbl q status=done json)
  check "upgraded table answers q json" '"title":"plain"' "$out"
  out=$(./v1.tbl diff "$cur")
  check "pre-upgrade cursor still valid" "0 new, 0 modified, 0 deleted" "$out"
  out=$(./v1.tbl a title=after status=open)
  check "ids continue after upgrade" "id=5" "$out"
  out=$(./v1.tbl next status=open set status=claimed by=w)
  check "next works after upgrade" "status=claimed" "$out"
  check "deleted id still never reused" "was deleted" "$(./v1.tbl g 3 2>&1)"
  cp v1.tbl snap.tbl
  out=$(./seed upgrade v1.tbl); rc=$?
  check_rc "upgrade twice rc" 0 $rc
  check "upgrade twice is a no-op" "already format v2" "$out"
  cmp -s v1.tbl snap.tbl && ok || fail "no-op upgrade leaves the file untouched"
  out=$(./v1.tbl upgrade v1n.tbl)
  check "a v2 table can upgrade another" "format v1 -> v2" "$out"
  check "no-ts kept" "no-ts" "$(./v1n.tbl i)"
  check "no-ts cursor: no changes" "no changes since cursor" "$(./v1n.tbl diff "$curn")"
  case "$(./v1n.tbl a x=2)" in *created_at*) fail "no-ts upgraded table writes no timestamps" ;; *) ok ;; esac
else
  fail "the v1 fixture engine (test-fixtures/tabeli-v1.c) does not build"
fi

# --- upgrade refuses what is not an older table, and touches nothing ---
printf 'just text\n' > notes.txt; cp notes.txt notes.bak
out=$(./seed upgrade notes.txt 2>&1); rc=$?
check_rc "upgrade text file rc" 5 $rc
check "upgrade text file teaches" "not a tabeli file" "$out"
cmp -s notes.txt notes.bak && ok || fail "text file untouched"
[ ! -e .notes.txt.lock ] && ok || fail "no lockfile left next to a non-table"
cp "$(type -P true)" prog; cp prog prog.bak
out=$(./seed upgrade prog 2>&1); rc=$?
check_rc "upgrade other program rc" 2 $rc
check "upgrade other program teaches" "holds no tabeli data" "$out"
cmp -s prog prog.bak && ok || fail "other program untouched"
out=$(./seed upgrade missing.tbl 2>&1); rc=$?
check_rc "upgrade missing file rc" 2 $rc
out=$(./seed upgrade 2>&1); rc=$?
check_rc "upgrade without target rc" 2 $rc
cp future.tbl future.bak
out=$(./seed upgrade future.tbl 2>&1); rc=$?
check_rc "upgrade unknown future format rc" 5 $rc
cmp -s future.tbl future.bak && ok || fail "future table untouched"

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]
