import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { accessSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import { createSkillCgroup, probeSkillCgroup, resolveSkillCgroupRoot } from "./process-owner-cgroup";

vi.mock("node:fs", () => ({
  constants: { W_OK: 2, R_OK: 4 },
  accessSync: vi.fn(), lstatSync: vi.fn(), mkdirSync: vi.fn(), readFileSync: vi.fn(),
  realpathSync: vi.fn(), rmdirSync: vi.fn(), statfsSync: vi.fn(), writeFileSync: vi.fn(),
}));

const root = join(process.cwd(), "delegated-cgroup-fixture");
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("JARELA_SKILL_CGROUP_ROOT", root);
  vi.mocked(realpathSync).mockImplementation((path) => String(path));
  vi.mocked(lstatSync).mockReturnValue({ dev: 1n, ino: 2n, isDirectory: () => true, isSymbolicLink: () => false } as never);
  vi.mocked(statfsSync).mockReturnValue({ type: 0x63677270 } as never);
  vi.mocked(readFileSync).mockReturnValue("populated 0\nfrozen 0\n");
});
afterEach(() => vi.unstubAllEnvs());

describe("delegated cgroup-v2 ownership control", () => {
  it("probes only a newly created empty child and removes it without killing the configured root", () => {
    expect(probeSkillCgroup()).toBe(true);
    const child = String(vi.mocked(mkdirSync).mock.calls[0][0]);
    expect(child.startsWith(join(root, "jarela-skill-"))).toBe(true);
    expect(rmdirSync).toHaveBeenCalledWith(child);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("fails closed for missing delegation permissions and removes its empty probe", () => {
    vi.mocked(accessSync).mockImplementation(() => { throw Object.assign(new Error(), { code: "EACCES" }); });
    expect(probeSkillCgroup()).toBe(false);
    expect(rmdirSync).toHaveBeenCalledOnce();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses symlink/noncanonical or non-cgroup filesystem roots", () => {
    vi.mocked(realpathSync).mockReturnValue(join(root, "different"));
    expect(probeSkillCgroup()).toBe(false);
    expect(mkdirSync).not.toHaveBeenCalled();
    vi.mocked(realpathSync).mockReturnValue(root);
    vi.mocked(statfsSync).mockReturnValue({ type: 123 } as never);
    expect(() => resolveSkillCgroupRoot()).toThrow(/canonical writable delegated/);
  });

  it("writes kill only to its owned child and treats populated1/missing events as unverified", () => {
    const group = createSkillCgroup();
    group.kill();
    expect(writeFileSync).toHaveBeenCalledWith(join(group.directory, "cgroup.kill"), "1");
    vi.mocked(readFileSync).mockReturnValue("populated 1\n");
    expect(group.populated()).toBe(true);
    vi.mocked(readFileSync).mockReturnValue("populated 0\n");
    expect(group.populated()).toBe(false);
    vi.mocked(readFileSync).mockReturnValue("unknown\n");
    expect(() => group.populated()).toThrow(/Unverifiable/);
  });

  it("never kills a replaced cgroup identity", () => {
    const group = createSkillCgroup();
    vi.mocked(lstatSync).mockReturnValue({ dev: 1n, ino: 3n, isDirectory: () => true, isSymbolicLink: () => false } as never);
    expect(() => group.kill()).toThrow(/identity changed/);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
