# LIFELINE Contracts Run 0

**Run ID:** `contracts-run-0`. **Date:** October 31, 2026. **Task:** 2, typed contracts and evidence identities.

**Result:** Qualified at the contract-test level. No network or model is involved.

| Item | Value |
| --- | --- |
| Starting commit | `45163a5` |
| Files | `src/lifeline/identity.mjs`, `src/lifeline/contracts.mjs`, `test/lifeline/contracts.test.mjs`, `fixtures/lifeline/policy-v1.json` |
| Policy identity | `f7baa4fa7e3c82e2d226d1e923b7b55d0f6e170c1ef70abe2f24f4a96498dd25` (canonical SHA-256 of `policy-v1.json`, pinned in the test) |
| Runtime | Host Node v24.14.1 |

## RED and GREEN

Stubs returning empty identities and `unimplemented` produced 38 behavioral failures. The implementation then passed 37; the remaining failure was the deliberate `pending-review` policy pin. Review found that `in` accepted inherited property names (`constructor`) as registered endpoints. A regression case failed RED, and own-property checks fixed it.

```text
node --test test/lifeline/contracts.test.mjs   → 39 pass, 0 fail
npm test                                       → 67 pass, 0 fail
```

## Covered behavior

- `canonicalRecord`: round trip, key-order independence, array-order sensitivity, rejection of NaN, Infinity, `undefined`, functions, BigInt, Date, Map, Symbol and sparse arrays, and a changed identity for each authority field.
- `validateProposal`: valid admission without mutating deep-frozen inputs; 30 malformed or unauthorized cases with stable `code`/`detail` pairs; exact run, policy and configuration bindings; future revisions and observations; the 10-second lifetime and 2-second admission-sample age taken from the policy; bundle and incident probe-byte budgets.

The originating observation may be older than 2 seconds by design; staleness applies to the fresh admission sample, as the design specifies.

## Remaining limits

- `JSON.parse` keeps the last of duplicate keys in raw model text. The provider parser in Task 9 must detect duplicates before this validator sees an object.
- Preconditions are checked for form and registered references only. Evaluating them against the newest observation, charging rejected attempts and transition checks belong to Task 5.
- The policy is a development fixture. Freeze it with measured provider timing before evaluation.

**Next:** Task 3, receipt-based scoring.
