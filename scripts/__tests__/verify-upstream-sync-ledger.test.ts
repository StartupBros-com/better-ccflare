import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalLedgerAnchor,
  generateSyncInventory,
  renderLedger,
  type RerereApplication,
  type SyncInventory,
  validateSyncInventory,
} from "../verify-upstream-sync-ledger";

const SHA_A = "1111111111111111111111111111111111111111";
const SHA_B = "2222222222222222222222222222222222222222";
const SHA_C = "3333333333333333333333333333333333333333";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix = "ccflare-upstream-sync-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function item(
  kind: "upstream-commit" | "conflict" | "shared-path" | "rerere",
  source: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  const sourceValue =
    kind === "upstream-commit"
      ? source.sha
      : kind === "rerere"
        ? `${source.path}:${source.preimageSha256}`
        : source.path;
  const id = `${kind === "upstream-commit" ? "commit" : kind}:${sourceValue}`;
  return {
    id,
    kind,
    source,
    ledgerAnchor: `#${canonicalLedgerAnchor(id, kind)}`,
    disposition: "pending",
    upstreamIntent: "pending",
    protectedForkBehavior: "pending",
    selectedResolution: "pending",
    evidence: {
      focusedPacket: { status: "pending", references: [] },
      acceptanceComplete: { status: "pending", references: [] },
      combinedDiff: { status: "pending", references: [] },
    },
    reviewer: { status: "pending", identity: null, notes: "pending" },
    dependencies: [],
    rationale: "pending",
    refreshedMainEvidence: [],
    ...overrides,
  };
}

function validInventory(): SyncInventory {
  const commit = item("upstream-commit", { sha: SHA_C });
  const conflict = item(
    "conflict",
    { path: "packages/example/src/conflict.ts", conflictClass: "content" },
    { id: "conflict:packages/example/src/conflict.ts" },
  );
  const shared = item("shared-path", {
    path: "packages/example/src/shared.ts",
  });
  return {
    schemaVersion: 1,
    phase: "pre-merge",
    baseline: {
      forkParent: SHA_A,
      requiredAncestors: [SHA_A],
      target: SHA_B,
      canonicalTag: "refs/tags/v3.5.66",
      peeledTag: SHA_B,
      mergeBase: "0000000000000000000000000000000000000000",
      rawCounts: { left: 1, right: 1 },
      cherryPickCounts: { left: 1, right: 1 },
      versions: {
        fork: { root: "1.0.0", cli: "1.0.0" },
        target: { root: "2.0.0", cli: "2.0.0" },
      },
    },
    derivation: {
      algorithmVersion: "upstream-sync-ledger/v1",
      upstreamCommitOrder:
        "git rev-list --topo-order --reverse <base>..<target>",
      pathSemantics:
        "git diff --name-only with rename detection; current repo-relative paths",
      conflictMechanism:
        "git merge-tree --write-tree with temporary alternate object directory",
    },
    expected: {
      upstreamCommits: [SHA_C],
      conflicts: [
        { path: "packages/example/src/conflict.ts", conflictClass: "content" },
      ],
      sharedPaths: ["packages/example/src/shared.ts"],
      qwenComparisonTrigger: { active: false, triggeringPaths: [] },
      rerereCapture: { state: "pre-merge-empty", applications: [] },
    },
    evidenceCatalog: {},
    items: [commit, conflict, shared],
  };
}

function validateFixture(inventory: SyncInventory): void {
  validateSyncInventory(inventory, renderLedger(inventory), {
    skipGitDerivation: true,
    observedRerereApplications:
      inventory.phase === "final"
        ? inventory.expected.rerereCapture.applications
        : undefined,
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function completeFinalInventory(): SyncInventory {
  const inventory = validInventory();
  inventory.phase = "final";
  inventory.expected.rerereCapture.state = "complete";
  inventory.evidenceCatalog = {
    focused: {
      type: "test",
      summary: "Focused packet passed",
      details: "bun test focused.test.ts exited 0",
    },
    acceptance: {
      type: "test",
      summary: "Acceptance packet passed",
      details: "acceptance command exited 0",
    },
    combined: {
      type: "combined-diff",
      summary: "Combined diff reviewed",
      details: "reviewed exact merge combined diff",
    },
  };
  for (const entry of inventory.items) {
    entry.disposition = "retained";
    entry.upstreamIntent = "Retain upstream behavior.";
    entry.protectedForkBehavior = "Preserve protected fork behavior.";
    entry.selectedResolution = "Reviewed retained resolution.";
    entry.evidence.focusedPacket = {
      status: "passed",
      references: ["focused"],
    };
    entry.evidence.acceptanceComplete = {
      status: "complete",
      references: ["acceptance"],
    };
    entry.evidence.combinedDiff =
      entry.kind === "upstream-commit"
        ? { status: "not-applicable", references: [] }
        : { status: "reviewed", references: ["combined"] };
    entry.reviewer = {
      status: "accepted",
      identity: "reviewer@example.invalid",
      notes: "Accepted after review.",
    };
    entry.rationale = "Retained after focused and acceptance review.";
  }
  return inventory;
}

describe("upstream sync inventory structural validation", () => {
  test("accepts an explicit empty pre-merge rerere capture", () => {
    expect(() => validateFixture(validInventory())).not.toThrow();
  });

  test("rejects unknown schema versions, phases, kinds, and dispositions", () => {
    for (const mutate of [
      (value: SyncInventory) => (value.schemaVersion = 2),
      (value: SyncInventory) =>
        (value.phase = "after-party" as SyncInventory["phase"]),
      (value: SyncInventory) =>
        (value.items[0].kind =
          "mystery" as SyncInventory["items"][number]["kind"]),
      (value: SyncInventory) =>
        (value.items[0].disposition =
          "maybe" as SyncInventory["items"][number]["disposition"]),
    ]) {
      const inventory = validInventory();
      mutate(inventory);
      expect(() => validateFixture(inventory)).toThrow();
    }
  });

  test("rejects abbreviated or malformed object ids", () => {
    for (const invalid of ["abc123", "G".repeat(40), "1".repeat(41)]) {
      const inventory = validInventory();
      inventory.baseline.target = invalid;
      expect(() => validateFixture(inventory)).toThrow(
        /40-character lowercase SHA/,
      );
    }
  });

  test("rejects unsafe or non-normalized paths", () => {
    for (const invalid of [
      "/absolute.ts",
      "../escape.ts",
      "dir/../escape.ts",
      "dir\\windows.ts",
      "dir//double.ts",
      "dir\nnewline.ts",
      "dir\0nul.ts",
    ]) {
      const inventory = validInventory();
      const conflict = inventory.items.find(
        (entry) => entry.kind === "conflict",
      );
      if (!conflict || conflict.kind !== "conflict") throw new Error("fixture");
      conflict.source.path = invalid;
      expect(() => validateFixture(inventory)).toThrow(
        /safe normalized repo-relative path/,
      );
    }
  });

  test("rejects duplicate canonical ids and duplicate normalized sources", () => {
    const duplicateId = validInventory();
    duplicateId.items.push(clone(duplicateId.items[0]));
    expect(() => validateFixture(duplicateId)).toThrow(
      /duplicate canonical id/,
    );

    const duplicateSource = validInventory();
    const copy = clone(duplicateSource.items[2]);
    copy.id = "shared-path:another-id.ts";
    duplicateSource.items.push(copy);
    expect(() => validateFixture(duplicateSource)).toThrow(
      /duplicate normalized source/,
    );
  });

  test("rejects a canonical id that does not derive from its source", () => {
    const inventory = validInventory();
    inventory.items[0].id = `commit:${SHA_A}`;
    expect(() => validateFixture(inventory)).toThrow(/canonical id/);
  });
});

describe("bidirectional expected-set validation", () => {
  test.each([
    ["upstream-commit", "missing upstream commit"],
    ["conflict", "missing conflict"],
    ["shared-path", "missing shared path"],
  ] as const)("rejects a missing %s item", (kind, message) => {
    const inventory = validInventory();
    inventory.items = inventory.items.filter((entry) => entry.kind !== kind);
    expect(() => validateFixture(inventory)).toThrow(message);
  });

  test("rejects a missing rerere item and final observed-capture mismatch", () => {
    const inventory = validInventory();
    const application: RerereApplication = {
      path: "packages/example/src/rerere.ts",
      preimageSha256: "a".repeat(64),
    };
    inventory.phase = "merge-in-progress";
    inventory.expected.rerereCapture = {
      state: "capturing",
      applications: [application],
    };
    expect(() => validateFixture(inventory)).toThrow("missing rerere");

    inventory.items.push(
      item("rerere", {
        path: application.path,
        preimageSha256: application.preimageSha256,
      }),
    );
    inventory.phase = "final";
    expect(() =>
      validateSyncInventory(inventory, renderLedger(inventory), {
        skipGitDerivation: true,
        observedRerereApplications: [],
      }),
    ).toThrow(/authoritative rerere capture/);
  });

  test("rejects conflict source or class drift from the exact record", () => {
    const inventory = validInventory();
    const conflict = inventory.items.find((entry) => entry.kind === "conflict");
    if (!conflict || conflict.kind !== "conflict") throw new Error("fixture");
    conflict.source.conflictClass = "add/add";
    expect(() => validateFixture(inventory)).toThrow(/conflict record drift/);
  });
});

describe("ledger linkage and machine/human parity", () => {
  test("renders a diff-clean ledger with exactly one trailing newline", () => {
    const ledger = renderLedger(validInventory());
    expect(ledger.endsWith("\n")).toBe(true);
    expect(ledger.endsWith("\n\n")).toBe(false);
  });

  test("rejects dangling and duplicate explicit anchors", () => {
    const inventory = validInventory();
    const ledger = renderLedger(inventory);
    const anchor = inventory.items[0].ledgerAnchor.slice(1);
    expect(() =>
      validateSyncInventory(
        inventory,
        ledger.replace(`<a id="${anchor}"></a>`, ""),
        { skipGitDerivation: true },
      ),
    ).toThrow(/exactly one matching explicit anchor/);
    expect(() =>
      validateSyncInventory(inventory, `${ledger}\n<a id="${anchor}"></a>\n`, {
        skipGitDerivation: true,
      }),
    ).toThrow(/duplicate ledger anchor/);
    expect(() =>
      validateSyncInventory(
        inventory,
        `${ledger}\n<a id="sync-dangling"></a>\n`,
        { skipGitDerivation: true },
      ),
    ).toThrow(/dangling ledger anchor/);
  });

  test.each([
    ["upstreamIntent", "upstream intent"],
    ["protectedForkBehavior", "protected fork behavior"],
    ["selectedResolution", "selected resolution"],
    ["disposition", "pending"],
    ["focused evidence", "focusedPacket"],
    ["acceptance evidence", "acceptanceComplete"],
    ["combined diff", "combinedDiff"],
    ["dependency", "dependencies"],
    ["rationale", "rationale"],
    ["reviewer", "reviewer"],
  ] as const)("rejects stale human-ledger %s", (_field, token) => {
    const inventory = validInventory();
    inventory.items[0].upstreamIntent = "upstream intent";
    inventory.items[0].protectedForkBehavior = "protected fork behavior";
    inventory.items[0].selectedResolution = "selected resolution";
    const ledger = renderLedger(inventory);
    expect(ledger).toContain(token);
    expect(() =>
      validateSyncInventory(
        inventory,
        ledger.replace(token, `stale-${token}`),
        {
          skipGitDerivation: true,
        },
      ),
    ).toThrow(/ledger review record diverges/);
  });
});

describe("disposition and evidence validation", () => {
  test("rejects a final item left pending", () => {
    const inventory = validInventory();
    inventory.phase = "final";
    inventory.expected.rerereCapture.state = "complete";
    expect(() => validateFixture(inventory)).toThrow(/final item.*pending/);
  });

  test("accepts a complete final fixture and rejects pending review-bearing fields", () => {
    expect(() => validateFixture(completeFinalInventory())).not.toThrow();

    for (const mutate of [
      (inventory: SyncInventory) => (inventory.items[0].rationale = "pending"),
      (inventory: SyncInventory) =>
        (inventory.items[0].reviewer.notes = "pending"),
      (inventory: SyncInventory) =>
        (inventory.items[0].evidence.combinedDiff.status = "pending"),
    ]) {
      const inventory = completeFinalInventory();
      mutate(inventory);
      expect(() => validateFixture(inventory)).toThrow(/final item.*pending/);
    }
  });

  test("rejects a final item whose reviewer rejected it", () => {
    const inventory = completeFinalInventory();
    inventory.items[0].reviewer.status = "rejected";
    expect(() => validateFixture(inventory)).toThrow(
      /requires an accepted reviewer disposition/,
    );
  });

  test("rejects premature acceptance-complete and missing dependency evidence", () => {
    const premature = validInventory();
    premature.items[0].evidence.acceptanceComplete.status = "complete";
    expect(() => validateFixture(premature)).toThrow(
      /premature acceptance-complete/,
    );

    const dependency = validInventory();
    dependency.items[0].dependencies = ["missing-evidence"];
    expect(() => validateFixture(dependency)).toThrow(
      /missing dependency evidence/,
    );
  });

  test("rejects intentional rejection without rationale", () => {
    const inventory = validInventory();
    inventory.items[0].disposition = "intentionally-rejected";
    inventory.items[0].rationale = "";
    expect(() => validateFixture(inventory)).toThrow(
      /requires non-empty rationale/,
    );
  });

  test("rejects already-superseded without refreshed-main evidence", () => {
    const inventory = validInventory();
    inventory.items[0].disposition = "already-superseded";
    expect(() => validateFixture(inventory)).toThrow(/refreshed-main evidence/);
  });

  test("rejects a catalog key whose evidence record is empty or untyped", () => {
    for (const record of [
      { type: "test", summary: "" },
      { type: "unknown", summary: "real detail" },
    ]) {
      const inventory = validInventory();
      inventory.evidenceCatalog.proof = record as never;
      inventory.items[0].evidence.focusedPacket.references = ["proof"];
      expect(() => validateFixture(inventory)).toThrow(
        /concrete typed non-empty evidence record/,
      );
    }
  });

  test("rejects concrete evidence records with the wrong semantic role", () => {
    const wrongCombinedDiff = completeFinalInventory();
    wrongCombinedDiff.evidenceCatalog.combined.type = "test";
    expect(() => validateFixture(wrongCombinedDiff)).toThrow(
      /combined-diff evidence.*type combined-diff/,
    );

    const wrongRefreshedMain = validInventory();
    wrongRefreshedMain.evidenceCatalog.wrongRole = {
      type: "combined-diff",
      summary: "Concrete but wrong role",
      details: "This is not refreshed-main evidence.",
    };
    wrongRefreshedMain.items[0].disposition = "already-superseded";
    wrongRefreshedMain.items[0].refreshedMainEvidence = ["wrongRole"];
    expect(() => validateFixture(wrongRefreshedMain)).toThrow(
      /refreshed-main evidence.*type refreshed-main/,
    );
  });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed:\n${result.stdout.toString()}\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

function write(repo: string, path: string, contents: string): void {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (parent) mkdirSync(join(repo, parent), { recursive: true });
  writeFileSync(join(repo, path), contents);
}

function commitAll(repo: string, message: string): string {
  git(repo, "add", "--all");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function createMergeFixture(): {
  repo: string;
  base: string;
  fork: string;
  target: string;
  tag: string;
} {
  const repo = tempDir("ccflare-upstream-sync-git-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Upstream Sync Test");
  git(repo, "config", "user.email", "sync-test@example.invalid");
  write(repo, "package.json", '{"version":"1.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"1.0.0"}\n');
  write(repo, "content.txt", "base\n");
  write(repo, "modify-delete.txt", "base\n");
  write(repo, "shared.txt", "first\nmiddle\nlast\n");
  write(
    repo,
    "packages/providers/src/providers/qwen/provider.ts",
    "first\nmiddle\nlast\n",
  );
  const base = commitAll(repo, "base");
  git(repo, "branch", "upstream");

  write(repo, "content.txt", "fork\n");
  write(repo, "modify-delete.txt", "fork modified\n");
  write(repo, "add-add.txt", "fork\n");
  write(repo, "shared.txt", "fork-first\nmiddle\nlast\n");
  write(
    repo,
    "packages/providers/src/providers/qwen/provider.ts",
    "fork-first\nmiddle\nlast\n",
  );
  const fork = commitAll(repo, "fork changes");

  git(repo, "checkout", "upstream");
  write(repo, "package.json", '{"version":"2.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"2.0.0"}\n');
  write(repo, "content.txt", "upstream\n");
  rmSync(join(repo, "modify-delete.txt"));
  write(repo, "add-add.txt", "upstream\n");
  write(repo, "shared.txt", "first\nmiddle\nupstream-last\n");
  write(
    repo,
    "packages/providers/src/providers/qwen/provider.ts",
    "first\nmiddle\nupstream-last\n",
  );
  const target = commitAll(repo, "upstream changes");
  git(repo, "tag", "-a", "v-test", "-m", "annotated target", target);
  git(repo, "checkout", "main");
  return { repo, base, fork, target, tag: "refs/tags/v-test" };
}

describe("hermetic derivation and CLI", () => {
  test("generate then check derives stable graph/conflict/shared sets without mutating Git state", () => {
    const fixture = createMergeFixture();
    const outputDir = tempDir("ccflare-upstream-sync-output-");
    const inventoryPath = join(outputDir, "inventory.json");
    const ledgerPath = join(outputDir, "ledger.md");
    const before = {
      head: git(fixture.repo, "rev-parse", "HEAD"),
      index: git(fixture.repo, "write-tree"),
      status: git(fixture.repo, "status", "--porcelain=v1"),
    };

    const script = join(
      import.meta.dir,
      "..",
      "verify-upstream-sync-ledger.ts",
    );
    const generateCli = Bun.spawnSync(
      [
        "bun",
        script,
        "generate",
        "--repo",
        fixture.repo,
        "--fork-parent",
        fixture.fork,
        "--required-ancestor",
        fixture.base,
        "--target",
        fixture.target,
        "--tag",
        fixture.tag,
        "--inventory",
        inventoryPath,
        "--ledger",
        ledgerPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(generateCli.exitCode, generateCli.stderr.toString()).toBe(0);
    expect(generateCli.stdout.toString()).toContain("generated");
    const inventory = JSON.parse(
      readFileSync(inventoryPath, "utf8"),
    ) as SyncInventory;
    validateSyncInventory(inventory, readFileSync(ledgerPath, "utf8"), {
      repo: fixture.repo,
    });

    expect(inventory.baseline.peeledTag).toBe(fixture.target);
    expect(inventory.baseline.requiredAncestors).toEqual([fixture.base]);
    expect(inventory.baseline.rawCounts).toEqual({ left: 1, right: 1 });
    expect(inventory.baseline.cherryPickCounts).toEqual({ left: 1, right: 1 });
    expect(inventory.expected.upstreamCommits).toEqual([fixture.target]);
    expect(inventory.expected.conflicts).toEqual([
      { path: "add-add.txt", conflictClass: "add/add" },
      { path: "content.txt", conflictClass: "content" },
      { path: "modify-delete.txt", conflictClass: "modify/delete" },
    ]);
    expect(inventory.expected.sharedPaths).toEqual([
      "packages/providers/src/providers/qwen/provider.ts",
      "shared.txt",
    ]);
    expect(inventory.expected.qwenComparisonTrigger).toEqual({
      active: true,
      triggeringPaths: ["packages/providers/src/providers/qwen/provider.ts"],
    });
    expect(inventory.expected.rerereCapture).toEqual({
      state: "pre-merge-empty",
      applications: [],
    });
    expect(inventory.items.map((entry) => entry.id)).toEqual(
      [...inventory.items.map((entry) => entry.id)].sort(),
    );

    const cli = Bun.spawnSync(
      [
        "bun",
        script,
        "check",
        "--repo",
        fixture.repo,
        "--inventory",
        inventoryPath,
        "--ledger",
        ledgerPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(cli.exitCode, cli.stderr.toString()).toBe(0);
    expect(cli.stdout.toString()).toContain("validated");

    expect({
      head: git(fixture.repo, "rev-parse", "HEAD"),
      index: git(fixture.repo, "write-tree"),
      status: git(fixture.repo, "status", "--porcelain=v1"),
    }).toEqual(before);
  }, 30_000);

  test("check rejects required-ancestor failure and Qwen trigger drift", () => {
    const fixture = createMergeFixture();
    const inventory = generateSyncInventory({
      repo: fixture.repo,
      forkParent: fixture.fork,
      requiredAncestors: [fixture.base],
      target: fixture.target,
      canonicalTag: fixture.tag,
    });

    const ancestorFailure = clone(inventory);
    ancestorFailure.baseline.requiredAncestors = [fixture.target];
    expect(() =>
      validateSyncInventory(ancestorFailure, renderLedger(ancestorFailure), {
        repo: fixture.repo,
      }),
    ).toThrow(/required ancestor/);

    const triggerDrift = clone(inventory);
    triggerDrift.expected.qwenComparisonTrigger = {
      active: false,
      triggeringPaths: [],
    };
    expect(() =>
      validateSyncInventory(triggerDrift, renderLedger(triggerDrift), {
        repo: fixture.repo,
      }),
    ).toThrow(/Qwen comparison trigger/);
  }, 30_000);
});
