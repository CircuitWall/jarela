import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  auditAdrRot,
  auditDependencies,
  auditDoctrineDrift,
  auditMilestones,
  classifyStatus,
  extractAdrPathReferences,
  isLikelyRepoPath,
  main,
  parseAdrSource,
  rankItems,
} from "./cadence-audit.mjs";

const roots = [];
const NOW = new Date("2026-11-28T00:00:00.000Z");

function fixtureRepo(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "jarela-cadence-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

function capture() {
  return {
    out: { text: "", write(chunk) { this.text += chunk; } },
    err: { text: "", write(chunk) { this.text += chunk; } },
  };
}

const AUDIT_FIXTURE = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    "left-pad": {
      name: "left-pad",
      severity: "high",
      via: [{ title: "Prototype pollution" }],
      range: "<1.3.0",
      fixAvailable: true,
    },
    "bad-lib": {
      name: "bad-lib",
      severity: "critical",
      via: [{ title: "Remote code execution" }],
      range: "*",
      fixAvailable: { isSemVerMajor: true },
    },
    meh: {
      name: "meh",
      severity: "moderate",
      via: [],
      range: "*",
      fixAvailable: false,
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 1 } },
});

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("ADR parsing", () => {
  it("reads frontmatter and body statuses plus dates", () => {
    const frontmatter = parseAdrSource(
      "---\nstatus: superseded by [ADR-0021](0021-replacement.md)\ndate: 2026-05-22\n---\n\n# Old\n",
      "0019-old.md",
    );
    expect(frontmatter.status).toBe("superseded");
    expect(frontmatter.supersederId).toBe("0021");
    expect(frontmatter.date.toISOString()).toBe("2026-05-22T00:00:00.000Z");

    const body = parseAdrSource("# New\n\nStatus: **Accepted**\n\nDate: 2026-01-02\n", "0100-new.md");
    expect(body.status).toBe("accepted");
    expect(classifyStatus("Implementation; pending")).toBe("proposed");
  });

  it("extracts repository paths from links and inline code, not prose or fences", () => {
    const references = extractAdrPathReferences([
      "See `lib/tools/legacy.ts` and `lib/tools/`.",
      "[missing](lib/moved.ts) and [external](https://example.com/x.ts).",
      "Use `npm audit` and `agent_id` and `max_tokens`.",
      "```sql",
      "SELECT * FROM lib/not/a/path.ts;",
      "```",
    ].join("\n"));
    expect(references).toEqual(["lib/moved.ts", "lib/tools/", "lib/tools/legacy.ts"]);
    expect(isLikelyRepoPath("docs/adr/0019-old.md")).toBe(true);
    expect(isLikelyRepoPath("node_modules/pkg/index.js")).toBe(false);
  });
});

describe("ADR rot", () => {
  it("flags missing paths on accepted and superseded ADRs only", () => {
    const repo = fixtureRepo({
      "lib/present.ts": "export {};\n",
      "docs/adr/0001-accepted.md": "---\nstatus: accepted\ndate: 2026-01-01\n---\n\nSee `lib/present.ts` and `lib/missing.ts`.\n",
      "docs/adr/0002-proposed.md": "---\nstatus: proposed\ndate: 2026-01-01\n---\n\nSee `lib/also-missing.ts`.\n",
      "docs/adr/0003-superseded.md": "---\nstatus: superseded by [ADR-0004](0004-new.md)\ndate: 2026-01-01\n---\n\nSee `lib/old.ts`.\n",
      "docs/adr/0004-new.md": "---\nstatus: accepted\ndate: 2026-02-01\n---\n\n* Supersedes: [ADR-0003](0003-superseded.md).\n",
    });
    const { items } = auditAdrRot({ repoRoot: repo, now: NOW, adrAgeDays: 30 });
    const ranked = rankItems(items);
    expect(ranked.map((item) => item.id)).toEqual(["adr-rot:0001", "adr-rot:0003"]);
    expect(ranked[0].detail).toContain("lib/missing.ts");
    expect(ranked[0].detail).not.toContain("lib/present.ts");
    expect(ranked.every((item) => item.severity === "P1")).toBe(true);
  });

  it("reports an accepted ADR that a newer ADR supersedes by id", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-old.md": "---\nstatus: accepted\ndate: 2026-01-01\n---\n\nNo paths.\n",
      "docs/adr/0002-new.md": "---\nstatus: accepted\ndate: 2026-02-01\n---\n\n* Supersedes: [ADR-0001](0001-old.md).\n",
    });
    const { items } = auditAdrRot({ repoRoot: repo, now: NOW, adrAgeDays: 30 });
    expect(items.map((item) => item.id)).toContain("adr-rot:0001:status");
  });

  it("ignores a proposed ADR that claims supersession", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-old.md": "---\nstatus: accepted\ndate: 2026-01-01\n---\n\nNo paths.\n",
      "docs/adr/0002-new.md": "---\nstatus: proposed\ndate: 2026-02-01\n---\n\n* Supersedes: [ADR-0001](0001-old.md).\n",
    });
    const { items } = auditAdrRot({ repoRoot: repo, now: NOW, adrAgeDays: 30 });
    expect(items.map((item) => item.id)).not.toContain("adr-rot:0001:status");
  });

  it("reports a supersession pointer to a missing ADR", () => {
    const repo = fixtureRepo({
      "docs/adr/0001-old.md": "---\nstatus: superseded by ADR-0099\ndate: 2026-01-01\n---\n",
    });
    const { items } = auditAdrRot({ repoRoot: repo, now: NOW, adrAgeDays: 30 });
    expect(items.map((item) => item.id)).toContain("adr-rot:0001:superseder");
  });

  it("skips without throwing when docs/adr is missing", () => {
    const repo = fixtureRepo({ "README.md": "# fixture\n" });
    expect(auditAdrRot({ repoRoot: repo, now: NOW, adrAgeDays: 30 })).toEqual({
      items: [],
      skipped: [{ id: "adr-rot", reason: "docs/adr is missing; ADR rot was not ranked" }],
    });
  });
});

describe("doctrine drift", () => {
  it("ranks idle modules and includes the last commit date", () => {
    const repo = fixtureRepo({ "lib/db/Agent.md": "# db\n", "components/Agent.md": "# components\n" });
    const commits = new Map([
      ["lib/db", { ok: true, epoch: Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000) }],
      ["components", { ok: true, epoch: Math.floor(Date.parse("2026-11-01T00:00:00.000Z") / 1000) }],
    ]);
    const { items } = auditDoctrineDrift({
      repoRoot: repo,
      now: NOW,
      idleDays: 90,
      lastCommit: (_root, scope) => commits.get(scope) ?? { ok: true, epoch: null },
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("doctrine-drift:lib/db");
    expect(items[0].detail).toContain("2026-01-01");
    expect(items[0].severity).toBe("P1");
  });

  it("records one skip when git history is unavailable", () => {
    const repo = fixtureRepo({ "lib/db/Agent.md": "# db\n" });
    const { items, skipped } = auditDoctrineDrift({
      repoRoot: repo,
      now: NOW,
      idleDays: 90,
      lastCommit: () => ({ ok: false, reason: "not a git repository" }),
    });
    expect(items).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].id).toBe("doctrine-drift");
  });
});

describe("dependency staleness", () => {
  it("skips the npm registry unless --audit is requested", () => {
    const result = auditDependencies({
      repoRoot: "unused",
      audit: false,
      runAudit: () => {
        throw new Error("must not run");
      },
    });
    expect(result.items).toEqual([]);
    expect(result.skipped[0].id).toBe("dependency-staleness");
  });

  it("folds high and critical advisories into the ranked list", () => {
    const { items, skipped } = auditDependencies({
      repoRoot: "unused",
      audit: true,
      runAudit: () => ({ status: 1, stdout: AUDIT_FIXTURE, stderr: "" }),
    });
    expect(skipped).toEqual([]);
    const ranked = rankItems(items);
    expect(ranked.map((item) => item.id)).toEqual([
      "dependency-staleness:bad-lib",
      "dependency-staleness:left-pad",
    ]);
    expect(ranked[0]).toMatchObject({ severity: "P0", autoFixable: false });
    expect(ranked[1]).toMatchObject({ severity: "P1", autoFixable: true });
  });

  it("records a skip when npm audit fails", () => {
    const { items, skipped } = auditDependencies({
      repoRoot: "unused",
      audit: true,
      runAudit: () => ({ status: 2, stdout: "", stderr: "network down", error: null }),
    });
    expect(items).toEqual([]);
    expect(skipped[0].reason).toContain("network down");
  });
});

describe("milestone slippage", () => {
  it("emits one manual-review entry naming the human milestone source", () => {
    const repo = fixtureRepo({ "docs/POST_3_DIRECTION.md": "# Direction\n" });
    const { items } = auditMilestones({ repoRoot: repo });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("milestone-slippage:needs_manual_review");
    expect(items[0].detail).toContain("POST_3_DIRECTION.md");
  });

  it("names machine-readable data instead of inventing a parser", () => {
    const repo = fixtureRepo({
      "docs/POST_3_DIRECTION.md": "# Direction\n",
      "docs/roadmap.json": "{}\n",
    });
    const { items } = auditMilestones({ repoRoot: repo });
    expect(items[0].detail).toContain("docs/roadmap.json");
  });
});

describe("CLI", () => {
  it("prints the stable JSON envelope and gates only on P0 under --check", () => {
    const repo = fixtureRepo({ "docs/POST_3_DIRECTION.md": "# Direction\n" });
    const dirty = capture();
    const dirtyCode = main(["--format", "json", "--audit", "--check"], {
      repoRoot: repo,
      now: NOW,
      deps: {
        lastCommit: () => ({ ok: true, epoch: null }),
        runAudit: () => ({ status: 1, stdout: AUDIT_FIXTURE, stderr: "" }),
      },
      stdout: dirty.out,
      stderr: dirty.err,
    });
    expect(dirtyCode).toBe(1);
    const parsed = JSON.parse(dirty.out.text);
    expect(Object.keys(parsed)).toEqual(["generatedAt", "items", "skipped"]);
    expect(parsed.items[0]).toMatchObject({ id: "dependency-staleness:bad-lib", severity: "P0" });
    for (const item of parsed.items) {
      expect(Object.keys(item)).toEqual([
        "id", "class", "severity", "title", "detail", "owner", "action", "autoFixable",
      ]);
    }

    const clean = capture();
    const cleanCode = main(["--format", "json", "--audit", "--check"], {
      repoRoot: repo,
      now: NOW,
      deps: {
        lastCommit: () => ({ ok: true, epoch: null }),
        runAudit: () => ({ status: 0, stdout: JSON.stringify({ vulnerabilities: {} }), stderr: "" }),
      },
      stdout: clean.out,
      stderr: clean.err,
    });
    expect(cleanCode).toBe(0);
    expect(JSON.parse(clean.out.text).items.some((item) => item.severity === "P0")).toBe(false);
  });

  it("writes the durable report and leaves it untouched when only the timestamp changes", () => {
    const repo = fixtureRepo({ "docs/POST_3_DIRECTION.md": "# Direction\n" });
    const deps = {
      lastCommit: () => ({ ok: true, epoch: null }),
      runAudit: () => ({ status: 0, stdout: JSON.stringify({ vulnerabilities: {} }), stderr: "" }),
    };
    const first = capture();
    expect(main(["--report", "docs/CADENCE_REPORT.md"], {
      repoRoot: repo,
      now: NOW,
      deps,
      stdout: first.out,
      stderr: first.err,
    })).toBe(0);
    const reportPath = path.join(repo, "docs", "CADENCE_REPORT.md");
    const report = readFileSync(reportPath, "utf8");
    expect(report).toContain("Generated: 2026-11-28T00:00:00.000Z");
    expect(report).toContain("## No change recorded");

    const second = capture();
    expect(main(["--report", "docs/CADENCE_REPORT.md"], {
      repoRoot: repo,
      now: new Date("2026-12-05T00:00:00.000Z"),
      deps,
      stdout: second.out,
      stderr: second.err,
    })).toBe(0);
    expect(readFileSync(reportPath, "utf8")).toBe(report);
    expect(second.err.text).toContain("report unchanged");
  });

  it("rejects report paths outside the repository and unknown arguments", () => {
    const repo = fixtureRepo({});
    const outside = capture();
    expect(main(["--report", "../outside.md"], {
      repoRoot: repo,
      now: NOW,
      stdout: outside.out,
      stderr: outside.err,
    })).toBe(2);

    const unknown = capture();
    expect(main(["--nope"], {
      repoRoot: repo,
      now: NOW,
      stdout: unknown.out,
      stderr: unknown.err,
    })).toBe(2);
  });
});
