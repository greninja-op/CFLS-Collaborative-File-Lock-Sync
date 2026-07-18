# Workspace test folders

Cross-cutting tests that are not owned by a single package live here. Tests that
target one package's logic are co-located with that package's source
(`<pkg>/src/**/*.test.ts`).

- `unit/` — cross-cutting, example-based unit tests and edge cases.
- `integration/` — real WSS handshake, SQLite store, agent↔host ingest/broadcast/
  sync, and MCP SDK tool round-trips.
- `simulation/` — the local multi-agent simulation harness (one host + N in-process
  agents) exercising the design's end-to-end scenarios.

## Property-based testing (PBT) convention

All property tests use [`fast-check`](https://fast-check.dev) through the shared
`@cfls/test-utils` harness. Every property test MUST:

1. Run at least **100 iterations** — use `assertProperty` / `pbtParameters` from
   `@cfls/test-utils`, which enforce `numRuns >= 100`.
2. Carry the standard tag produced by `propertyTag(n, text)`:
   `Feature: collaborative-file-lock-sync, Property N: <text>`.

```ts
import { assertProperty, fc, propertyTag } from "@cfls/test-utils";
import { test } from "vitest";

test(propertyTag(1, "Event_Revision monotonicity and total order"), () => {
  assertProperty(
    fc.property(fc.array(fc.integer()), (xs) => {
      // ... assert the property holds
    }),
  );
});
```
