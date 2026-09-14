






COVER_MIN ?= 80

.PHONY: test check fmt vet lint tidy-check cover

test:
	go test ./...

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
		cp go.mod go.mod.tidybak; \
		[ -f go.sum ] && cp go.sum go.sum.tidybak || true; \
		go mod tidy; \
		status=0; \
		diff -u go.mod.tidybak go.mod || status=1; \
		mv go.mod.tidybak go.mod; \
		if [ -f go.sum.tidybak ]; then diff -u go.sum.tidybak go.sum || status=1; mv go.sum.tidybak go.sum; fi; \
		if [ $$status -ne 0 ]; then echo "go.mod/go.sum are not tidy — run 'go mod tidy'"; exit 1; fi; \
	fi


cover:
	go test -race -coverprofile=cover.out ./...
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
