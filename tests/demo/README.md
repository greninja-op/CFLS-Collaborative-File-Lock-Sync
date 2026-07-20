# Single-laptop demo

You do **not** need multiple machines to see this system work. "Teammates" are
just separate `CoordinationAgent` instances — running several on one laptop,
all pointed at `127.0.0.1`, is exactly like running them on separate laptops.

## Narrated demo (headless)

Boots one real `CoordinationHost` + three agents (Alice, Bob, Carol) over the
real WSS transport and prints what each teammate sees at every step:

```bash
pnpm demo
```

(equivalent to `pnpm -r build && pnpm --filter @cfls/demo demo`)

It walks through:

1. **Presence** — Alice edits a file; Bob and Carol are notified in real time
   (including an _indirect_ reverse-dependency signal from the dependency graph).
2. **Direct conflict** — Bob's agent tries the file Alice locked and is told
   Alice holds it (deterministic winner by Event_Revision), so it backs off.
3. **Declared intent** — Carol announces the files she will modify and the new
   file she will create _before_ writing code; everyone's agent sees the plan.
4. **Indirect dependency risk** — two different files that are linked in the
   dependency graph surface a coordination signal.
5. **Release** — the lock clears and the file is safe again.

## Watching it in VS Code (optional)

The same thing works interactively:

1. Start a host (see `docs/deployment.md`) at a `wss://127.0.0.1:<port>` URL.
2. Launch two or three `CoordinationAgent` instances, each with its **own**
   device identity, cache dir, Local_API port, and (optionally) workspace
   folder, all pointed at that host.
3. Open a matching VS Code window per agent and edit shared files — presence,
   locks, declared intents, and warnings appear across the windows.

## The most complete check

The simulation suite exercises all eight end-to-end scenarios (presence,
direct + indirect conflict, lock acquire/release, stale-lock expiry, reconnect
sync, unauthorized-device rejection) against a real host and five real agents:

```bash
pnpm --filter @cfls/simulation test
```
