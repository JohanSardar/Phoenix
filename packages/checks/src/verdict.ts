import { validate, type LedgerEntry, type ReplayPlan, type ReplayResult, type SuccessCheck, type TraceEvent } from "@phoenix/formats";
import { canonicalJson } from "@phoenix/wire";
import type { CheckEvidence } from "./evidence.ts";
import type { ExpectationResult } from "./evaluate.ts";

export type SampleVerdict = Pick<ReplayResult["samples"][number], "status" | "discounted">;
export function sampleVerdict(input: {
  expectations: readonly ExpectationResult[];
  evidence: CheckEvidence;
  intentRequired?: boolean;
  intent?: { met: boolean; reason: string };
  diverged?: boolean;
}): SampleVerdict {
  if (input.evidence.error) return { status: "unassessed", discounted: false };
  if (input.diverged || input.evidence.trace.some(e => e.kind === "divergence")) return { status: input.expectations.some(e => e.outcome === "fail" && e.irreversible) ? "fail" : "unassessed", discounted: false };
  if (input.expectations.some(e => e.outcome === "error")) return { status: "unassessed", discounted: false };
  if (input.expectations.some(e => e.outcome === "fail" && !e.tainted)) return { status: "fail", discounted: false };
  if (input.intentRequired && !input.intent) return { status: "unassessed", discounted: false };
  if (input.expectations.some(e => e.outcome !== "pass")) return { status: "unassessed", discounted: false };
  if (input.intentRequired && !input.intent!.met) return { status: input.evidence.firstSynthesized === undefined ? "fail" : "unassessed", discounted: false };
  return { status: "pass", discounted: input.expectations.some(e => e.tainted) || !!input.intentRequired && input.evidence.firstSynthesized !== undefined };
}

export interface MomentVerdict {
  verdict: ReplayResult["verdict"];
  meets_check?: boolean;
  discount: ReplayResult["discount"];
  counts: { pass: number; fail: number; unassessed: number };
  scheduled: number;
  needsTiebreak: boolean;
}

export function momentVerdict(samples: readonly (SampleVerdict & { sample: number; tiebreak: boolean })[], rule: SuccessCheck["samples"] = { base: 2, tiebreak: 1 }): MomentVerdict {
  if (!Number.isInteger(rule.base) || rule.base < 1 || !Number.isInteger(rule.tiebreak) || rule.tiebreak < 0) throw new Error("Invalid sample rule");
  if (new Set(samples.map(s => s.sample)).size !== samples.length) throw new Error("Duplicate sample id");
  const base = samples.filter(s => !s.tiebreak);
  if (base.length > rule.base || samples.filter(s => s.tiebreak).length > rule.tiebreak) throw new Error("Too many samples for check");
  const disagree = base.length === rule.base && base.every(s => s.status !== "unassessed") && base.some(s => s.status === "pass") && base.some(s => s.status === "fail");
  const needsTiebreak = rule.tiebreak > 0 && (disagree || samples.some(s => s.tiebreak));
  const scheduled = rule.base + (needsTiebreak ? rule.tiebreak : 0);
  const counts = { pass: samples.filter(s => s.status === "pass").length, fail: samples.filter(s => s.status === "fail").length, unassessed: samples.filter(s => s.status === "unassessed").length + scheduled - samples.length };
  const incomplete = base.length < rule.base || counts.unassessed > 0;
  const fails = counts.fail * 2 >= scheduled;
  return { verdict: incomplete ? "incomplete" : fails ? "fails" : "meets-check", ...(!incomplete ? { meets_check: !fails } : {}), discount: { discounted: !incomplete && !fails && samples.some(s => s.status === "pass" && s.discounted) }, counts, scheduled, needsTiebreak };
}

export function countsTowardPass(verdict: Pick<MomentVerdict, "verdict" | "discount">): boolean {
  return verdict.verdict === "meets-check" && (!verdict.discount.discounted || verdict.discount.confirmed !== undefined);
}

export function compareBaseline(candidate: MomentVerdict, baseline: MomentVerdict): { improved?: boolean; target_pass: boolean; baseline_did_not_reproduce: boolean } {
  const complete = candidate.verdict !== "incomplete" && baseline.verdict !== "incomplete";
  const improved = complete ? candidate.counts.pass / candidate.scheduled > baseline.counts.pass / baseline.scheduled : undefined;
  return { ...(improved !== undefined ? { improved } : {}), target_pass: countsTowardPass(candidate) && improved === true, baseline_did_not_reproduce: baseline.verdict === "meets-check" };
}

export interface DiscountedReplay {
  moment: string;
  revision: string;
  resultHash: string;
  plan: ReplayPlan;
  result: ReplayResult;
  trace: readonly TraceEvent[];
}

export type Confirmation = { how: "pass-accepted"; entry: LedgerEntry } | {
  how: "stateful-fake" | "fresh-recording";
  replay: DiscountedReplay;
};

export function confirmDiscount(original: DiscountedReplay, confirmation: Confirmation): ReplayResult["discount"] {
  if (!original.result.discount.discounted || original.result.verdict !== "meets-check") throw new Error("No discounted pass to confirm");
  for (const [format, value] of [["result", original.result], ["plan", original.plan]] as const) {
    const valid = validate(format, value);
    if (!valid.ok) throw new Error(valid.errors.join("; "));
  }
  if (confirmation.how === "pass-accepted") {
    const entry = validate("ledger", confirmation.entry);
    if (!entry.ok) throw new Error(entry.errors.join("; "));
    if (entry.value.how !== "pass-accepted" || entry.value.moment !== original.moment || entry.value.revision !== original.revision || entry.value.result_hash !== original.resultHash) throw new Error("Pass acceptance does not identify this result");
  } else {
    const other = confirmation.replay;
    for (const [format, value] of [["result", other.result], ["plan", other.plan]] as const) {
      const valid = validate(format, value);
      if (!valid.ok) throw new Error(valid.errors.join("; "));
    }
    if (other.moment !== original.moment || other.plan.candidate_tree !== original.plan.candidate_tree || other.plan.check !== original.plan.check || canonicalJson(other.plan.model) !== canonicalJson(original.plan.model) || canonicalJson(other.plan.start) !== canonicalJson(original.plan.start) || !countsTowardPass(other.result) || other.result.discount.discounted) throw new Error("Confirmation needs the same candidate, check, model and start, passing without a discount");
    if (confirmation.how === "fresh-recording" && other.revision === original.revision) throw new Error("Fresh recording confirmation needs a new locked revision");
    const connectors = new Set(original.trace.filter(e => e.kind === "result" && e.provenance === "synthesized").map(e => e.connector));
    for (const connector of connectors) {
      const answers = other.trace.filter(e => e.kind === "result" && e.connector === connector);
      if (!answers.length || answers.some(e => confirmation.how === "stateful-fake" ? e.resolver !== "emulator" : e.provenance !== "recorded" && e.provenance !== "real")) throw new Error(`Confirmation did not replace synthesized answers on ${connector}`);
    }
  }
  return { discounted: true, confirmed: confirmation.how };
}
