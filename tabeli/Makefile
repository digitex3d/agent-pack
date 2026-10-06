CC      ?= cc
CFLAGS  ?= -O2 -Wall -Wextra -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE
LDFLAGS ?= -pie -Wl,-z,relro,-z,now

tabeli: tabeli.c
	@command -v $(firstword $(CC)) >/dev/null 2>&1 || { echo "tabeli: no C compiler found ($(firstword $(CC))) — install gcc or clang (Debian/Ubuntu: apt install build-essential) and build again" >&2; exit 1; }
	$(CC) $(CFLAGS) tabeli.c -o tabeli $(LDFLAGS)
	strip tabeli

test: tabeli
	./test.sh

# the skill ships a copy of the engine and its source: keep them in sync
sync-skill: tabeli
	cp tabeli.c skill/tabeli/src/tabeli.c
	cp tabeli skill/tabeli/bin/tabeli-x86_64
	cmp -s tabeli.c skill/tabeli/src/tabeli.c && echo "skill in sync"

clean:
	rm -f tabeli

.PHONY: test clean sync-skill
