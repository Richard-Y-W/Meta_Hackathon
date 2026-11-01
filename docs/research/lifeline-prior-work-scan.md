# LIFELINE Prior-Work Scan for the Pilot Comparators

**Date:** November 1, 2026, while the frozen pilot was running. **Scope:** a current scan required by Task 11 before comparator claims are made. The fuller reproduction study is Task 16. The comparators were frozen before this scan (protocol revision 1, `90bc5b6`), so this scan cannot have shaped them; it does constrain what the results may claim.

## Closest work and what it already covers

| Work | What it does | Consequence for LIFELINE |
| --- | --- | --- |
| [007](https://www.usenix.org/conference/nsdi18) (retransmission-triggered traceroute and tomography; summarized in [this gray-failure overview](https://ronvo.substack.com/p/synthetic-monitoring-and-gray-failures)) | Starts probing when end hosts see retransmissions, then votes across probes to localize faulty links | The adaptive baseline's rule (persistent degradation with no capacity explanation → probe an alternative, move if clean) is a simplified relative of this. Localizing a silent lossy link by probing is established practice, not an AI contribution |
| [NetBouncer](https://naizhengtan.github.io/doc/papers/netbouncer19tan.pdf) (NSDI 2019) | Path-pinned IP-in-IP probes from end hosts localize hard and gray failures within a minute in production | Path-pinned probes (D11) follow this idea; a NetBouncer-style tomography baseline is a closer conventional comparator than the pilot's adaptive rule |
| Pingmesh (SIGCOMM 2015, via the same overview) | All-pairs continuous probing; notes that probe load can worsen a degraded path | Supports charging probe bytes to every controller's budget |
| [NIKA network arena](https://arxiv.org/pdf/2512.16381), [FaulT-Bench](https://arxiv.org/html/2608.27021v1), [SADE](https://arxiv.org/abs/2605.04530) | Benchmarks and methods for LLM network-troubleshooting agents; SADE encodes a classical troubleshooting procedure as policy | LLM-based network diagnosis is an active area. LIFELINE differs in closing the loop on real packets under a guarded action contract and comparing against a strong conventional controller under matched budgets; it does not claim LLM diagnosis is new |
| [TN-AutoRCA](https://arxiv.org/pdf/2507.18190), [GALA](https://arxiv.org/abs/2608.08968) | Alarm- and graph-augmented LLM root-cause analysis in telecom networks and microservices | Diagnosis accuracy alone is covered; LIFELINE's measured outcome is service delivery |
| Schema, SWAN, B4 (already in the evaluation protocol) | Persistent environment models with verification; priority-aware traffic engineering | Unchanged from the protocol's novelty boundaries |

## What the pilot may and may not claim

- A tie or loss against the adaptive baseline on the gray-failure case is expected: the baseline already implements a 007-style reaction.
- A gain on gray-failure cases would still not establish an advance over tomography methods. That needs a NetBouncer- or 007-style baseline (Task 16).
- The pilot can support C2 (real model participation with measured consequences) and a preliminary C4 difference against this repository's adaptive controller only.
