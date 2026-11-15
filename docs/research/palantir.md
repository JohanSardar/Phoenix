# Palantir: Ontology Snapshots, Scenarios, AIP Evals, AIP Evolve

Researched 2026-11-15 from Palantir's DevCon 7 page, the "Own Your Evals" talk description (2026-11-06), the AIP Evals and AIP Evolve docs, the Ontology Scenarios API docs, Palantir's "Evals as the Substrate for Sovereign AI" paper, and a Palantir engineer's community guide on writing evals. I could not get a transcript of the talk, so the details below come from the docs and the paper, not the talk itself.

## The pieces
- **Ontology Snapshot**: captures the exact state of the world when an agent runs, so a production run can become a test case that stays valid after the live data changes. "Freeze any real-world moment, replay it."
- **Ontology Scenario**: a sandboxed data fork of the ontology. Reads and writes go to the fork, and a write is visible to later reads in the same run (copy-on-write, kept as a delta). It can be rebased onto newer data or merged back. Used to "stage a what-if", meaning events that haven't happened yet.
- **AIP Evals**: an evaluation suite = test cases (inputs + optional expected output) + target function + evaluation functions. Test cases can be backed by real objects, for example past decisions with a known right answer. Each case is run several times to see variance, and results are compared against earlier versions.
- **AIP Evolve**: you set a target, a goal (migrate model, cut cost or latency, raise eval score, or custom), a validation strategy (which test cases, how compared) and limits (which kinds of change, how many iterations). Agents inspect, write test cases, make changes and evaluate against the baseline. The output is a proposal with evidence, reviewed by a person and merged through a branch. It never auto-deploys.

## How Palantir defines "the right thing"
1. **From the operator's correction.** The workflow records the context, what the agent proposed, how the operator promoted, edited or rejected it and why, and what happened next. A correction is triaged as a one-off exception (kept as context), a system gap (change the system), or a reusable decision (turned into an eval case that keeps "the conditions and properties of the validated decision").
2. **Evaluators, kept to pass/fail where possible:**
   - Built-in deterministic checks: exact match, regex, keyword, string length, numeric range, exact object match, and checks on the ontology edits an action proposed.
   - Custom code evaluators (functions).
   - An LLM judge, for open-ended output only, given few-shot pass and fail examples and made to quote its evidence. The judge is treated as code that needs its own tests.
3. **Prefer deterministic logic.** Their own write-ups say to use deterministic tools wherever possible and reserve the model for judgment, and Evolve has replaced model calls with code.

## Mapping to phoenix
| Palantir | Phoenix |
|---|---|
| Ontology Snapshot | Captured state behind a moment (recorded at our boundary, since we don't own the data) |
| Ontology Scenario | Staged world for use case 2, plus the write overlay during replay |
| Operator correction -> eval case | Source of a moment's success check |
| Built-in + custom + LLM-judge evaluators | Deterministic checks + custom code checks + plain-language intent |
| Evolve proposal -> branch review | Patch or PR of the allowed harness files; phoenix never deploys |
| Run several times, compare to baseline | Majority-of-samples rule against a same-model baseline |
