# slicc-cli — headless SLICC follower CLI (Go / pion)
#
# `make build`     local binary → bin/slicc
# `make test`      go test ./...
# `make check`     gofmt check + go vet + go test
# `make dist`      cross-compiled static binaries for mac/linux/windows × amd64/arm64

BINARY   := slicc
PKG      := .
BIN_DIR  := bin
DIST_DIR := dist
VERSION  ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS  := -s -w -X main.version=$(VERSION)

# GOOS/GOARCH pairs to cross-compile for `dist`.
PLATFORMS := darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64

.PHONY: build test check fmt vet dist clean

build:
	go build -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BINARY) $(PKG)

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

# CI gate: formatting must be clean, vet must pass, race-checked tests must pass.
check:
	@unformatted="$$(gofmt -l .)"; \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needs to run on:"; echo "$$unformatted"; exit 1; \
	fi
	go vet ./...
	go test -race ./...

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
