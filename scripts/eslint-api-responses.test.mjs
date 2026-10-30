import { describe, expect, it } from "vitest";
import { Linter } from "eslint";
import apiResponses from "./eslint-api-responses.mjs";

function lint(code) {
  return new Linter().verify(code, [{
    plugins: { "jarela-api": apiResponses },
    rules: { "jarela-api/shared-errors": "error" },
  }]);
}

describe("shared API error rule", () => {
  it.each([
    'import { NextResponse } from "next/server"; NextResponse.json({error: "bad"}, {status: 400});',
    'import { NextResponse as Reply } from "next/server"; Reply.json({error}, {status});',
    'Response.json({error: "bad", code: "bad_json"}, {status: 400});',
    'Response["json"]({["error"]: "slow"}, {status: 429, headers: {"Retry-After": "1"}});',
    'Response.json({error: "missing explicit failure status"});',
    'Response.json({error: "bad"}, responseOptions);',
  ])("rejects inline error responses: %s", (code) => {
    expect(lint(code)).toEqual([expect.objectContaining({ ruleId: "jarela-api/shared-errors" })]);
  });

  it.each([
    'import { NextResponse } from "next/server"; NextResponse.json({ok: true});',
    'import { NextResponse } from "next/server"; NextResponse.json({status: flow.status, error: flow.error});',
    'Response.json({ok: false, error: "probe failed"}, {status: 200});',
    'errorResponse("bad", 400);',
    'errorJson({error: "bad", code: "bad_json"}, {status: 400});',
    'noStoreJson({error: "locked"});',
  ])("preserves helper, success, and domain-result responses: %s", (code) => {
    expect(lint(code)).toEqual([]);
  });
});
