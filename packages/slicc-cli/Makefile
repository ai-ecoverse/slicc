







BINARY    := slicc
PKG       := .
BIN_DIR   := bin
DIST_DIR  := dist
VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS   := -s -w -X main.version=$(VERSION)

COVER_MIN ?= 58


PLATFORMS := darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64

.PHONY: build test test-json check fmt vet lint tidy-check cover dist clean

build:
	go build -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BINARY) $(PKG)

test:
	go test ./...




test-json:
	go test -count=1 -json ./... > test-report.json || true

vet:
	go vet ./...

lint:
	golangci-lint run

fmt:
	gofmt -w .




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




cover:
	go test -race -coverpkg=./... -coverprofile=cover.out ./...
	@total=$$(go tool cover -func=cover.out | awk '/^total:/ {print $$3}' | tr -d '%'); \
	echo "total coverage: $$total% (floor $(COVER_MIN)%)"; \
	awk -v t="$$total" -v m="$(COVER_MIN)" 'BEGIN { if (t+0 < m+0) { printf "FAIL: coverage %.1f%% is below the %d%% floor\n", t, m; exit 1 } }'



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
