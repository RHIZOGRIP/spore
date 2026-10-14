# Build rules for the image tools. Tabs, not spaces, start every recipe line.

PREFIX ?= /usr/local
CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c11
LDLIBS = -lm -lpng -lz

SRC = src/main.c src/scale.c src/crop.c src/rotate.c src/palette.c src/io.c
OBJ = $(SRC:.c=.o)
BIN = imgtool

.PHONY: all clean install uninstall test check dist

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(LDFLAGS) -o $@ $^ $(LDLIBS)

%.o: %.c src/imgtool.h
	$(CC) $(CFLAGS) -c -o $@ $<

src/io.o: src/io.c src/imgtool.h src/png_compat.h
	$(CC) $(CFLAGS) -DHAVE_PNG=1 -c -o $@ $<

test: $(BIN)
	@for t in tests/*.sh; do \
		echo "running $$t"; \
		sh "$$t" ./$(BIN) || exit 1; \
	done
	@echo "all tests passed"

check: test
	@if command -v valgrind >/dev/null 2>&1; then \
		valgrind --error-exitcode=1 --leak-check=full ./$(BIN) --selftest; \
	else \
		echo "valgrind not found, skipping memory check"; \
	fi

install: $(BIN)
	install -d "$(DESTDIR)$(PREFIX)/bin"
	install -m 755 $(BIN) "$(DESTDIR)$(PREFIX)/bin/$(BIN)"
	install -d "$(DESTDIR)$(PREFIX)/share/man/man1"
	install -m 644 doc/imgtool.1 "$(DESTDIR)$(PREFIX)/share/man/man1/imgtool.1"

uninstall:
	rm -f "$(DESTDIR)$(PREFIX)/bin/$(BIN)"
	rm -f "$(DESTDIR)$(PREFIX)/share/man/man1/imgtool.1"

dist: clean
	mkdir -p dist/imgtool
	cp -R src doc tests Makefile README dist/imgtool/
	tar -C dist -czf dist/imgtool.tar.gz imgtool
	rm -rf dist/imgtool

clean:
	rm -f $(OBJ) $(BIN)
	rm -rf dist

# Per-file overrides, for compilers that warn about the generated tables.
src/palette.o: CFLAGS += -Wno-overlength-strings
src/rotate.o: CFLAGS += -ffast-math

print-%:
	@echo '$*=$($*)'
