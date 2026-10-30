import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statfsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const CGROUP2_MAGIC = 0x63677270;
const unavailable = "Linux checked skills require a canonical writable delegated cgroup-v2 root with cgroup.kill, cgroup.procs and cgroup.events";
const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

export function resolveSkillCgroupRoot(): string {
  const configured = process.env.JARELA_SKILL_CGROUP_ROOT;
  if (configured !== undefined) return canonical(configured);
  const self = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((line) => line.startsWith("0::"))?.slice(3);
  if (!self || !isAbsolute(self)) throw new Error(unavailable);
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const [before, after] = line.split(" - ");
    if (!after?.startsWith("cgroup2 ")) continue;
    const fields = before.split(" ");
    const mountRoot = unescapeMount(fields[3]);
    const mountPoint = unescapeMount(fields[4]);
    const local = relative(mountRoot, self);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) continue;
    try { return canonical(join(mountPoint, local)); } catch { /* Try another cgroup2 mount. */ }
  }
  throw new Error(unavailable);
}

function canonical(path: string): string {
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync(path) !== path
    || !lstatSync(path).isDirectory() || statfsSync(path).type !== CGROUP2_MAGIC) throw new Error(unavailable);
  return path;
}

export interface SkillCgroup {
  readonly directory: string;
  kill(): void;
  populated(): boolean;
  remove(): void;
}

/** Never writes to a caller's existing cgroup.kill: only a newly owned child. */
export function createSkillCgroup(root = resolveSkillCgroupRoot()): SkillCgroup {
  canonical(root);
  const directory = join(root, `jarela-skill-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const identity = lstatSync(directory, { bigint: true });
  const assertIdentity = () => {
    const now = lstatSync(directory, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== identity.dev || now.ino !== identity.ino) {
      throw new Error("Owned skill cgroup identity changed");
    }
  };
  try {
    accessSync(join(directory, "cgroup.kill"), constants.W_OK);
    accessSync(join(directory, "cgroup.procs"), constants.W_OK);
    accessSync(join(directory, "cgroup.events"), constants.R_OK);
  } catch {
    rmdirSync(directory);
    throw new Error(unavailable);
  }
  return {
    directory,
    kill() { assertIdentity(); writeFileSync(join(directory, "cgroup.kill"), "1"); },
    populated() {
      assertIdentity();
      const event = readFileSync(join(directory, "cgroup.events"), "utf8").match(/^populated ([01])$/m);
      if (!event) throw new Error("Unverifiable owned skill cgroup state");
      return event[1] === "1";
    },
    remove() { assertIdentity(); rmdirSync(directory); },
  };
}

export function probeSkillCgroup(): boolean {
  try {
    const group = createSkillCgroup();
    const empty = !group.populated();
    group.remove();
    return empty;
  } catch { return false; }
}
