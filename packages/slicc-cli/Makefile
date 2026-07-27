# slicc-cli — headless SLICC follower CLI (Go / pion)
#
# `make build`     local binary → bin/slicc
# `make test`      go test ./...
# `make check`     gofmt check + go mod tidy check + go vet + golangci-lint + race tests + coverage floor
# `make tidy-check` fail when go.mod/go.sum drift from the tree's imports
# `make dist`      cross-compiled static binaries for mac/linux/windows × amd64/arm64

BINARY    := slicc
PKG       := .
BIN_DIR   := bin
DIST_DIR  := dist
VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS   := -s -w -X main.version=$(VERSION)
# Total-statement coverage floor. The value lives in the repo-root
# coverage-thresholds.json (go.slicc-cli.statements) alongside every other
# language's floors, so the nightly coverage ratchet raises it automatically.
# Read with node when it is on PATH and with awk otherwise, so `make cover`
# gates identically for a Go developer with no Node toolchain. Override for a
# one-off run with `make cover COVER_MIN=60`.
THRESHOLDS := ../../coverage-thresholds.json
COVER_MIN_FILE := $(shell node -e 'process.stdout.write(String(require("$(THRESHOLDS)").go["slicc-cli"].statements))' 2>/dev/null \
	|| awk '/"go"/ { in_go = 1 } in_go && /"statements"/ { gsub(/[^0-9.]/, "", $$2); print $$2; exit }' $(THRESHOLDS) 2>/dev/null)
COVER_MIN ?= $(COVER_MIN_FILE)

# GOOS/GOARCH pairs to cross-compile for `dist`.
PLATFORMS := darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64

.PHONY: build test test-json check fmt vet lint tidy-check cover dist clean

build:
	go build -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BINARY) $(PKG)

test:
	go test ./...

# Machine-readable per-test timings for CI artifact upload. Kept separate from
# `test`/`cover` so their console output stays human-readable; the whole suite
# runs in well under 10s uninstrumented, so the extra pass is cheap.
test-json:
	go test -count=1 -json ./... > test-report.json || true

vet:
	go vet ./...

lint:
	golangci-lint run

fmt:
	gofmt -w .

# Unused/missing-dependency gate: fails when go.mod or go.sum drifts from the
# imports actually in the tree. `go mod tidy -diff` needs Go >= 1.23; older
# toolchains fall back to tidying a copy and diffing it back.
tidy-check:
	@if go help mod tidy 2>/dev/null | grep -q -- '-diff'; then \
		go mod tidy -diff || { echo "go.mod/go.sum are not tidy — run 'go mod tidy'"; exit 1; }; \
	else \
		cp go.mod go.mod.tidybak && cp go.sum go.sum.tidybak; \
		go mod tidy; \
		status=0; \
		diff -u go.mod.tidybak go.mod || status=1; \
		diff -u go.sum.tidybak go.sum || status=1; \
		mv go.mod.tidybak go.mod && mv go.sum.tidybak go.sum; \
		if [ $$status -ne 0 ]; then echo "go.mod/go.sum are not tidy — run 'go mod tidy'"; exit 1; fi; \
	fi

# Race-checked tests + total-coverage floor. -coverpkg=./... attributes coverage
# of code exercised across package boundaries (e.g. internal/tray via the
# main-package WebRTC integration test).
cover:
	@if [ -z "$(COVER_MIN)" ]; then \
		echo "FAIL: no Go coverage floor in $(THRESHOLDS) (go.slicc-cli.statements)"; exit 1; \
	fi
	go test -race -coverpkg=./... -coverprofile=cover.out ./...
	@total=$$(go tool cover -func=cover.out | awk '/^total:/ {print $$3}' | tr -d '%'); \
	echo "total coverage: $$total% (floor $(COVER_MIN)%)"; \
	awk -v t="$$total" -v m="$(COVER_MIN)" 'BEGIN { if (t+0 < m+0) { printf "FAIL: coverage %.1f%% is below the %d%% floor\n", t, m; exit 1 } }'

# CI gate: gofmt clean, tidy go.mod, go vet, golangci-lint (lint + complexity),
# race tests + coverage floor.
check:
	@unformatted="$$(gofmt -l .)"; \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needs to run on:"; echo "$$unformatted"; exit 1; \
	fi
	$(MAKE) tidy-check
	go vet ./...
	golangci-lint run
	$(MAKE) cover

dist:
	@mkdir -p $(DIST_DIR)
	@for platform in $(PLATFORMS); do \
		os=$${platform%/*}; arch=$${platform#*/}; \
		ext=""; [ "$$os" = "windows" ] && ext=".exe"; \
		out="$(DIST_DIR)/$(BINARY)-$$os-$$arch$$ext"; \
		echo "building $$out"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -ldflags "$(LDFLAGS)" -o "$$out" $(PKG) || exit 1; \
	done

clean:
	rm -rf $(BIN_DIR) $(DIST_DIR)
