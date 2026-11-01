# LIFELINE Infra P03 Run 0 — Versioned contracts and adapter conformance

**Date:** November 1, 2026. **Task:** P03. **State:** qualified. Contracts, clock and adapter conformance are qualified; the live run through the adapter waits for the VM to be free of the P02 comparison.

| Item | Value |
| --- | --- |
| Code | `6c21e4f` |
| Files | `src/lifeline/kernel/{contracts,clock,services}.mjs`, `src/lifeline/domains/communications.mjs`, `fixtures/lifeline/infra/contract-v1.json`, `test/lifeline/infra/{contracts,clock,adapter-conformance}.test.mjs` |

## RED → GREEN

```text
contracts.test.mjs          RED 8/9 on a permissive stub → GREEN 10/10 (service registry case RED → GREEN)
clock.test.mjs              RED 4/4 → GREEN 4/4
adapter-conformance.test.mjs RED 8/8 → GREEN 8/8
npm test                    291 pass at commit
```

## What is qualified

- **Envelopes (`infra-contract-v1`):** schema version, run, domain, sequence and integer-microsecond `tickUs` on every record, with per-kind exact fields for observation, service, capability, forecast, plan, action, receipt and measurement records. Rejected: unknown fields, unsupported versions, unknown kinds, NaN or Infinity, negative or fractional times, received-before-observed.
- **Units:** a pinned registry gives each metric exactly one canonical unit. A water flow given in W is `unit_mismatch`; a convertible but non-canonical unit (L/s) is `unit_not_canonical` inside the kernel, and `admitQuantity` converts it explicitly at adapter admission (12 L/s → 0.012 m3/s; 2.5 kW → 2500 W).
- **Missing data:** `null` with a reason. A missing-quality value of 0 is `missing_as_zero`; null without a reason is refused.
- **Actions** must name a known capability with exactly its parameters. **Plans** must match their run (including every cited observation), the current configuration revision per domain, and be unexpired.
- **Clock:** integer microseconds on a monotonic source; regressions are refused; acceleration charges waiting to simulated time (a 15 s call at 60× = 900 s).
- **Communications adapter:** wraps V1 contract validation, the guarded executor and the receipt scorer. Observations become canonical envelopes, with unreported counters `null`/`counter_unreported`. Duplicate action IDs return the prior receipt without a second effect. A closed adapter refuses work and a fresh one is unaffected. `checkpoint`, `restore` and `advance` report `unsupported_operation` (real-time packets cannot fork or step).
- **Measurement through the adapter** on the retained ledgered run `recovery-run-0` reproduces the original receipt scorer exactly, and its measurement envelopes validate.

## Live adapter-driven run (closes P03)

`node scripts/lifeline-adapter-run.mjs --scenario fixtures/lifeline/development/cascade.json --duration-ms 90000 --tag lfp3` in the `lifeline` guest, after a passing guest storage preflight. Evidence: `artifacts/lifeline/guest/p03-run-0/adapter-run/`.

- The orchestrator built the scenario and injected the hidden faults (r0-r3 down at 20 s, r1-r2 to 3 Mbit/s at 65 s). Control used only `adapter.observe()` envelopes and `adapter.execute()` action envelopes.
- 4,464 observation envelopes, all valid. One `comms.set_route` action (dispatch-clinic → r0-r1-r2-r3) passed envelope validation and V1 contract validation, executed through the guarded executor, and returned a `success` (confirmed) receipt.
- `adapter.measure()` on the bundle gave results identical to the original receipt scorer on the same raw sender/receiver records. Its 3 measurement envelopes validate.
- On-time delivery was 75.7% of 16,800 messages. This rule only reroutes around reported-down links and does not react to the capacity fault. The run qualifies the interface; it does not evaluate a controller.

**State:** P03 qualified.
