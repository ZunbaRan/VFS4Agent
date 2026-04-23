# Archived documentation

These documents predate the FUSE refactor (commit `12dad14`). They describe
the **just-bash simulator** architecture (v1.2 / v2.0 / pre-FUSE handoff) and
are kept for historical reference only. **Do not follow their instructions
for new work** — the current architecture is FUSE-based and documented in:

- [`docs/FUSE_REFACTOR_PLAN.md`](../FUSE_REFACTOR_PLAN.md) — authoritative design doc
- [`docs/arch-diagram.html`](../arch-diagram.html) — 6-layer architecture
- [`docs/flow-diagram.html`](../flow-diagram.html) — command-execution flow
- [`examples/README.md`](../../examples/README.md) — Agent-framework adapter matrix

## Files in this folder

| File | Originally at | Replaced by |
|---|---|---|
| `IMPLEMENTATION_PLAN.v1.2.md` | repo root (as `.v1.2.bak.md`) | `docs/FUSE_REFACTOR_PLAN.md` |
| `IMPLEMENTATION_PLAN.v2.0.md` | repo root | `docs/FUSE_REFACTOR_PLAN.md` |
| `DEVELOPER_HANDOFF.pre-fuse.md` | repo root | `docs/FUSE_REFACTOR_PLAN.md` + `examples/README.md` |
