export type ValidationKind =
  | "claim_without_tool"
  | "citation_unregistered_tool"
  | "citation_uncalled_tool"
  | "summary_without_action";

export interface ValidationOk {
  ok: true;
}

export interface ValidationFail {
  ok: false;
  kind: ValidationKind;
  reason: string;
  evidence: string;
}

export type ValidationResult = ValidationOk | ValidationFail;

export interface Citation {
  tool: string;
  raw: string;
}

export interface Claim {
  verb: string;
  raw: string;
}
