import { describe, it, expect } from "vitest";
import { isConstraintError, domainErrorFor, DomainConstraintError } from "./constraint-errors";

describe("isConstraintError", () => {
  it("matches by code", () => {
    expect(isConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
    expect(isConstraintError({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" })).toBe(true);
    expect(isConstraintError({ code: "SQLITE_CONSTRAINT" })).toBe(true);
  });

  it("matches by message text", () => {
    expect(isConstraintError({ message: "SQLITE_CONSTRAINT: UNIQUE constraint failed: x.y" })).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isConstraintError({ code: "SQLITE_BUSY" })).toBe(false);
    expect(isConstraintError(null)).toBe(false);
    expect(isConstraintError(new Error("not a db error"))).toBe(false);
  });
});

describe("domainErrorFor", () => {
  it("translates UNIQUE violation with target", () => {
    const e = new Error("UNIQUE constraint failed: threads.agent_id");
    (e as Error & { code: string }).code = "SQLITE_CONSTRAINT_UNIQUE";
    const out = domainErrorFor(e);
    expect(out).toBeInstanceOf(DomainConstraintError);
    expect((out as DomainConstraintError).code).toBe("unique_violation");
    expect((out as DomainConstraintError).target).toBe("threads.agent_id");
    expect((out as DomainConstraintError).message).toMatch(/already exists/i);
  });

  it("translates FOREIGN KEY violation", () => {
    const e = new Error("FOREIGN KEY constraint failed");
    (e as Error & { code: string }).code = "SQLITE_CONSTRAINT_FOREIGNKEY";
    const out = domainErrorFor(e);
    expect(out).toBeInstanceOf(DomainConstraintError);
    expect((out as DomainConstraintError).code).toBe("foreign_key_violation");
    expect((out as DomainConstraintError).message).toMatch(/Referenced row/i);
  });

  it("passes through non-constraint errors unchanged", () => {
    const e = new Error("something else");
    expect(domainErrorFor(e)).toBe(e);
  });

  it("passes through CHECK/NOT NULL constraint errors unchanged", () => {
    const e = new Error("CHECK constraint failed: foo");
    (e as Error & { code: string }).code = "SQLITE_CONSTRAINT_CHECK";
    // Translation only covers UNIQUE + FK; CHECK passes through.
    expect(domainErrorFor(e)).toBe(e);
  });
});
