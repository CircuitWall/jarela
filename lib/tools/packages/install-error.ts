/**
 * HTTP mapping for install failures.
 *
 * A user typo is a 404 with a suggestion, not a 500 with npm's stderr —
 * approving `@huggingface/transformer` used to surface
 * `500 {"error":"npm install ... exited 1: npm error code E404 ..."}`.
 */
import { PackageInstallError } from "./package-install";
import type { InstallFailureCode } from "./package-registry";

const STATUS_BY_CODE: Record<InstallFailureCode, number> = {
  not_found: 404,
  forbidden: 403,
  peer_conflict: 409,
  network: 503,
  unknown: 500,
};

export interface InstallFailureBody {
  error: string;
  code: InstallFailureCode;
  spec: string;
  suggestion: string | null;
}

export interface InstallFailureDescription {
  status: number;
  body: InstallFailureBody;
}

/** Describe a typed install failure, or null for anything else. */
export function describeInstallError(err: unknown): InstallFailureDescription | null {
  if (!(err instanceof PackageInstallError)) return null;
  return {
    status: STATUS_BY_CODE[err.code],
    body: { error: err.message, code: err.code, spec: err.spec, suggestion: err.suggestion },
  };
}
