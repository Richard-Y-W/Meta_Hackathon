# LIFELINE Infra P03 Run 0 — Versioned contracts and adapter conformance

**Date:** November 1, 2026. **Task:** P03. **State:** active. Contracts, clock and adapter conformance are qualified; the live run through the adapter waits for the VM to be free of the P02 comparison.

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

## Open

- A live communications run driven through the adapter (observe, validate, execute, measure) in the VM.
