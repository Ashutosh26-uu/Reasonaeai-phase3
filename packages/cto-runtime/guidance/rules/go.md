---
name: go
description: "Go 1.27 conventions: idiom, error wrapping, context, HTTP, concurrency, testing, tooling."
always: false
globs: ["**/*.go", "**/go.mod", "**/go.sum"]
---

# Go
Target Go 1.27. Prefer the standard library; add a module only when the standard library genuinely cannot do the job.

## Language and idiom
- `gofmt` output is not negotiable; run `gofmt -l .` and `go vet ./...` before declaring work done.
- Use `any`, never `interface{}`. Use `min`/`max` rather than hand-written comparisons.
- `for i := range n` for a counting loop (`n` an integer); `for range` over a slice to discard the index.
- Use `slices` and `maps` for sorting, searching, cloning, and grouping. Do not write those helpers by hand.
- `errors.Join` to combine independent failures; `errors.Is`/`errors.As` to inspect them.
- `log/slog` for structured logging. Never `log.Fatal` or `os.Exit` outside `main`.
- `math/rand/v2`, not `math/rand`. Never `rand.Seed`. Nothing from `io/ioutil` — use `io`, `os`, and `os.ReadFile`/`WriteFile`.
- Return early and keep the happy path left-aligned. Make the zero value useful. Small interfaces, defined where they are consumed, and accept interfaces while returning concrete types.
- Never shadow `err` in a way that hides a prior failure; check each error before the next call, and wrap it with context using `%w`.
- No global mutable state. Pass dependencies explicitly through structs or parameters.
- Keep the package name one lowercase word; no `util`, `common`, `helpers`, or `base` packages.

## Errors
- Error strings are lowercase, have no trailing punctuation, and name the operation: `fmt.Errorf("load config %s: %w", path, err)`.
- Do not log and return the same error. Either log it at the boundary that owns the decision, or return it.
- Sentinel errors are exported variables; domain errors are typed structs with an `Error()` method so callers can use `errors.As`.
- Only ignore an error with `_` when the reason is stated in a comment.

## Context and I/O
- `ctx context.Context` is the first parameter of anything that does I/O, blocks, or is cancellable. Never store a context in a struct.
- Honor cancellation: pass `ctx` into queries and requests, and return `ctx.Err()` when it is done.
- Set explicit timeouts: `http.Server{ReadHeaderTimeout, ReadTimeout, WriteTimeout, IdleTimeout}` and a `Timeout` on `http.Client`. The zero-value client with no timeout is a defect.
- `defer resp.Body.Close()` after every successful `Do`; drain or discard the body when it is not read.
- Bound what you read from a stream: `io.LimitReader` for untrusted input, streaming rather than whole-payload buffering for large data.

## HTTP services
- With Go 1.22+ use the enhanced `net/http` `ServeMux`: `mux.HandleFunc("POST /api/items/{id}", h)` and `r.PathValue("id")`. A third-party router needs a stated reason.
- Validate and decode the body with a decoder that rejects unknown fields (`DisallowUnknownFields`), then validate the domain rules explicitly.
- Always set `Content-Type` and an explicit status code; encode errors through one shared helper so the shape is consistent.
- Middleware for cross-cutting concerns (logging, recovery, auth, request id); keep handlers about the domain.
- A client struct holds only configuration and dependencies (base URL, `*http.Client`, auth). Build a fresh `*http.Request` per call; never store request state on a shared client or reuse a consumed body.

## Concurrency
- Always know how a goroutine exits. Use `sync.WaitGroup` (or `wg.Go` on Go 1.25+) or a channel to join, and a context or a `done` channel to stop.
- Never leak a goroutine on an error path; ensure every started worker can return.
- Protect shared state with a mutex, or hand ownership to one goroutine and communicate over channels. Keep critical sections small.
- Bound concurrency explicitly — a semaphore or a worker pool. Unbounded goroutine-per-item spawns are a defect.
- Recover from panics at a boundary that owns the request (middleware, worker loop), and log with the stack.

## Structure
- `cmd/<binary>/main.go` for entry points; `internal/` for packages that are not a public API; `_test.go` files next to the code they test.
- One package per directory, one `package` declaration per file, using the directory's existing name.
- Keep `main` thin: parse flags and configuration, wire dependencies, start and gracefully shut down.

## Tests
- Table-driven tests with `t.Run` subtests; name them `TestSubject_Scenario`.
- Assert with `errors.Is`/`errors.As` and plain comparisons; add a dependency like `testify` only when it earns its place.
- Run with the race detector: `go test ./... -race`. Reuse a helper instead of duplicating setup.
- Benchmark with `testing.B` only for a measured performance decision, not by default.

## Tooling
- `go mod tidy` after a dependency change; keep `go.mod` pinned to the real module path and `go 1.27`.
- Never vendor unless the target environment requires it.
