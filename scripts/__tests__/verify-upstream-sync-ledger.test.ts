import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  type InventoryItem,
  type RerereApplication,
  type SyncInventory,
  validateSyncInventory,
} from "../verify-upstream-sync-ledger";

const SHA_A = "1111111111111111111111111111111111111111";
const SHA_B = "2222222222222222222222222222222222222222";
const SHA_C = "3333333333333333333333333333333333333333";
const EXCLUDED_PATH = "packages/proxy/src/inline-worker.ts";
const CANONICAL_EXCLUSIONS = [
  "packages/database/src/inline-incremental-vacuum-worker.ts",
  "packages/database/src/inline-integrity-check-worker.ts",
  "packages/database/src/inline-vacuum-worker.ts",
  EXCLUDED_PATH,
];
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
): InventoryItem {
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

function asLegacySchema(
  inventory: SyncInventory,
  schemaVersion: 1 | 2,
): SyncInventory {
  inventory.schemaVersion = schemaVersion;
  delete inventory.trackingIssue;
  inventory.derivation = {
    algorithmVersion: `upstream-sync-ledger/v${schemaVersion}`,
    upstreamCommitOrder:
      "git rev-list --topo-order --reverse <merge-base>..<target>",
    pathSemantics:
      "git diff --name-status -z --find-renames; rename destinations and current repo-relative paths",
    conflictMechanism:
      "git merge-tree --write-tree --name-only with a temporary alternate object directory under OS tmpdir",
  };
  if (schemaVersion === 1) {
    delete inventory.baseline.tagObject;
    delete inventory.baseline.integrationCommit;
  }
  return inventory;
}

function completeInventory(inventory: SyncInventory): SyncInventory {
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

function completeFinalInventory(): SyncInventory {
  return completeInventory(validInventory());
}

describe("upstream sync inventory structural validation", () => {
  test("accepts an explicit empty pre-merge rerere capture", () => {
    expect(() => validateFixture(validInventory())).not.toThrow();
  });

  test("renders the release from the canonical tag", () => {
    const inventory = validInventory();
    inventory.baseline.canonicalTag = "refs/tags/v3.5.67";

    expect(renderLedger(inventory)).toStartWith(
      "# Issue #260 — v3.5.67 Resolution Ledger",
    );
  });

  test("rejects unknown schema versions, phases, kinds, and dispositions", () => {
    for (const mutate of [
      (value: SyncInventory) => (value.schemaVersion = 3),
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

  test("schema v2 final inventories require a recorded integration commit", () => {
    const inventory = completeFinalInventory();
    inventory.schemaVersion = 2;
    inventory.derivation.algorithmVersion = "upstream-sync-ledger/v2";
    Object.assign(inventory.baseline, {
      tagObject: SHA_C,
      integrationCommit: null,
    });

    expect(() => validateFixture(inventory)).toThrow(
      /final schema-v2 inventory requires baseline.integrationCommit/,
    );

    delete (inventory.baseline as unknown as Record<string, unknown>)
      .integrationCommit;
    expect(() => validateFixture(inventory)).toThrow(
      /final schema-v2 inventory requires baseline.integrationCommit/,
    );
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
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
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
  tagObject: string;
} {
  const repo = tempDir("ccflare-upstream-sync-git-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Upstream Sync Test");
  git(repo, "config", "user.email", "sync-test@example.invalid");
  write(repo, "package.json", '{"version":"1.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"1.0.0"}\n');
  write(repo, "content.txt", "base\n");
  write(repo, "modify-delete.txt", "base\n");
  write(repo, "rename-source.txt", "rename me\n");
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
  const tag = "refs/tags/v-test";
  const tagObject = git(repo, "rev-parse", tag);
  git(repo, "checkout", "main");
  return { repo, base, fork, target, tag, tagObject };
}

function createTopologyFixture(): {
  repo: string;
  base: string;
  fork: string;
  target: string;
  tag: string;
  tagObject: string;
  integrationCommit: string;
} {
  const repo = tempDir("ccflare-upstream-sync-topology-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Upstream Sync Test");
  git(repo, "config", "user.email", "sync-test@example.invalid");
  write(repo, "package.json", '{"version":"1.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"1.0.0"}\n');
  write(repo, "base.txt", "base\n");
  const base = commitAll(repo, "base");
  git(repo, "branch", "upstream");

  write(repo, "fork.txt", "fork\n");
  const fork = commitAll(repo, "fork changes");

  git(repo, "checkout", "upstream");
  write(repo, "package.json", '{"version":"2.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"2.0.0"}\n');
  write(repo, "upstream.txt", "upstream\n");
  const target = commitAll(repo, "upstream changes");
  git(repo, "tag", "-a", "v-topology", "-m", "annotated target", target);
  const tag = "refs/tags/v-topology";
  const tagObject = git(repo, "rev-parse", tag);

  git(repo, "checkout", "main");
  git(repo, "merge", "--no-ff", "upstream", "-m", "integrate upstream");
  const integrationCommit = git(repo, "rev-parse", "HEAD");
  return { repo, base, fork, target, tag, tagObject, integrationCommit };
}

function commitWithParents(
  repo: string,
  treeCommit: string,
  parents: string[],
  message = "alternate integration topology",
): string {
  const tree = git(repo, "rev-parse", `${treeCommit}^{tree}`);
  return git(
    repo,
    "commit-tree",
    tree,
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m",
    message,
  );
}

function treeEntry(repo: string, commit: string, path: string): string | null {
  const entry = git(repo, "ls-tree", commit, "--", path);
  return entry === "" ? null : entry;
}

function removeLooseObject(repo: string, objectId: string): void {
  const objects = git(repo, "rev-parse", "--git-path", "objects");
  rmSync(join(repo, objects, objectId.slice(0, 2), objectId.slice(2)));
}

function createProjectionFixture(): ReturnType<typeof createMergeFixture> & {
  excludedObjects: string[];
} {
  const fixture = createMergeFixture();
  git(fixture.repo, "checkout", "main");
  write(fixture.repo, EXCLUDED_PATH, "fork-only opaque contents\n");
  const fork = commitAll(fixture.repo, "add excluded fork artifact");

  git(fixture.repo, "checkout", "upstream");
  write(fixture.repo, EXCLUDED_PATH, "upstream-only opaque contents\n");
  git(fixture.repo, "mv", "rename-source.txt", "rename-target.txt");
  write(fixture.repo, "shape/file.txt", "directory side\n");
  const target = commitAll(fixture.repo, "rename and add directory shape");
  git(fixture.repo, "tag", "-f", "-a", "v-test", "-m", "annotated target", target);

  git(fixture.repo, "checkout", "main");
  git(fixture.repo, "mv", "rename-source.txt", "fork-rename-target.txt");
  write(fixture.repo, "shape", "file side\n");
  const projectedFork = commitAll(fixture.repo, "fork rename and file shape");

  const excludedObjects = [fork, target]
    .map((commit) => treeEntry(fixture.repo, commit, EXCLUDED_PATH))
    .filter((entry): entry is string => entry !== null)
    .map((entry) => entry.split(/\s+/)[2]);
  return {
    ...fixture,
    fork: projectedFork,
    target,
    tagObject: git(fixture.repo, "rev-parse", fixture.tag),
    excludedObjects,
  };
}

function createProjectedCherryPickFixture(): ReturnType<
  typeof createMergeFixture
> & {
  upstreamCommits: string[];
  intermediateExcludedObjects: string[];
} {
  const repo = tempDir("ccflare-upstream-sync-cherry-pick-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Upstream Sync Test");
  git(repo, "config", "user.email", "sync-test@example.invalid");
  write(repo, "package.json", '{"version":"1.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"1.0.0"}\n');
  write(repo, "equivalent.txt", "base\n");
  const root = commitAll(repo, "root boundary");
  git(repo, "branch", "boundary-topic", root);

  write(repo, "boundary-main.txt", "main boundary\n");
  commitAll(repo, "main boundary change");
  git(repo, "checkout", "boundary-topic");
  write(repo, "boundary-topic.txt", "topic boundary\n");
  commitAll(repo, "topic boundary change");
  git(repo, "checkout", "main");
  git(repo, "merge", "--no-ff", "boundary-topic", "-m", "merge boundary history");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", "upstream");

  write(repo, "equivalent.txt", "same allowed patch\n");
  write(repo, EXCLUDED_PATH, "fork-only intermediate excluded edit\n");
  const forkEquivalent = commitAll(repo, "fork equivalent allowed patch");
  write(repo, "fork-only.txt", "fork only\n");
  rmSync(join(repo, EXCLUDED_PATH));
  commitAll(repo, "fork follow-up");
  git(repo, "branch", "fork-topic", forkEquivalent);
  git(repo, "checkout", "fork-topic");
  write(repo, "fork-topic.txt", "fork topic\n");
  commitAll(repo, "fork topic change");
  git(repo, "checkout", "main");
  git(repo, "merge", "--no-ff", "fork-topic", "-m", "merge fork topic");
  const fork = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "upstream");
  write(repo, "equivalent.txt", "same allowed patch\n");
  write(repo, EXCLUDED_PATH, "upstream-only intermediate excluded edit\n");
  const upstreamEquivalent = commitAll(repo, "upstream equivalent allowed patch");
  write(repo, "package.json", '{"version":"2.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"2.0.0"}\n');
  write(repo, "upstream-only.txt", "upstream only\n");
  rmSync(join(repo, EXCLUDED_PATH));
  const target = commitAll(repo, "upstream follow-up");
  git(repo, "tag", "-a", "v-cherry-pick", "-m", "annotated target", target);
  const tag = "refs/tags/v-cherry-pick";
  const tagObject = git(repo, "rev-parse", tag);

  const intermediateExcludedObjects = [forkEquivalent, upstreamEquivalent].map(
    (commit) => {
      const entry = treeEntry(repo, commit, EXCLUDED_PATH);
      if (entry === null) throw new Error("fixture excluded entry");
      return entry.split(/\s+/)[2];
    },
  );
  git(repo, "checkout", "main");
  return {
    repo,
    base,
    fork,
    target,
    tag,
    tagObject,
    upstreamCommits: [upstreamEquivalent, target],
    intermediateExcludedObjects,
  };
}

function createLargeProjectedPatchFixture(): ReturnType<
  typeof createMergeFixture
> {
  const fixture = createMergeFixture();
  git(fixture.repo, "checkout", "upstream");
  write(
    fixture.repo,
    "large-permitted-patch.txt",
    "permitted textual patch payload\n".repeat(50_000),
  );
  const target = commitAll(fixture.repo, "add large permitted textual patch");
  git(fixture.repo, "tag", "-f", "-a", "v-test", "-m", "annotated target", target);
  git(fixture.repo, "checkout", "main");
  return {
    ...fixture,
    target,
    tagObject: git(fixture.repo, "rev-parse", fixture.tag),
  };
}

function createPrefixConflictFixture(): ReturnType<typeof createMergeFixture> {
  const repo = tempDir("ccflare-upstream-sync-prefix-conflict-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Upstream Sync Test");
  git(repo, "config", "user.email", "sync-test@example.invalid");
  write(repo, "package.json", '{"version":"1.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"1.0.0"}\n');
  write(repo, "one.txt", "base\n");
  write(repo, "one.txt.extra", "base\n");
  const base = commitAll(repo, "base");
  git(repo, "branch", "upstream");

  write(repo, "one.txt", "fork content\n");
  write(repo, "one.txt.extra", "fork modified\n");
  const fork = commitAll(repo, "fork conflicts");

  git(repo, "checkout", "upstream");
  write(repo, "package.json", '{"version":"2.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"2.0.0"}\n');
  write(repo, "one.txt", "upstream content\n");
  rmSync(join(repo, "one.txt.extra"));
  const target = commitAll(repo, "upstream conflicts");
  git(repo, "tag", "-a", "v-prefix-conflict", "-m", "annotated target", target);
  const tag = "refs/tags/v-prefix-conflict";
  const tagObject = git(repo, "rev-parse", tag);
  git(repo, "checkout", "main");
  return { repo, base, fork, target, tag, tagObject };
}

type ExcludedMutation = "addition" | "removal" | "rename" | "mode" | "object";

function createExcludedTopologyFixture(mutation?: ExcludedMutation): ReturnType<
  typeof createTopologyFixture
> {
  const repo = tempDir("ccflare-upstream-sync-excluded-topology-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Upstream Sync Test");
  git(repo, "config", "user.email", "sync-test@example.invalid");
  write(repo, "package.json", '{"version":"1.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"1.0.0"}\n');
  if (mutation !== "addition") write(repo, EXCLUDED_PATH, "fork artifact\n");
  write(repo, "base.txt", "base\n");
  const base = commitAll(repo, "base");
  git(repo, "branch", "upstream");

  write(repo, "fork.txt", "fork\n");
  const fork = commitAll(repo, "fork changes");

  git(repo, "checkout", "upstream");
  write(repo, "package.json", '{"version":"2.0.0"}\n');
  write(repo, "apps/cli/package.json", '{"version":"2.0.0"}\n');
  write(repo, "upstream.txt", "upstream\n");
  switch (mutation) {
    case "addition":
      write(repo, EXCLUDED_PATH, "upstream addition\n");
      break;
    case "removal":
      rmSync(join(repo, EXCLUDED_PATH));
      break;
    case "rename":
      git(repo, "mv", EXCLUDED_PATH, `${EXCLUDED_PATH}.renamed`);
      break;
    case "mode":
      chmodSync(join(repo, EXCLUDED_PATH), 0o755);
      break;
    case "object":
      write(repo, EXCLUDED_PATH, "upstream replacement\n");
      break;
  }
  const target = commitAll(repo, "upstream changes");
  git(repo, "tag", "-a", "v-topology", "-m", "annotated target", target);
  const tag = "refs/tags/v-topology";
  const tagObject = git(repo, "rev-parse", tag);

  git(repo, "checkout", "main");
  git(repo, "merge", "--no-ff", "upstream", "-m", "integrate upstream");
  const integrationCommit = git(repo, "rev-parse", "HEAD");
  return { repo, base, fork, target, tag, tagObject, integrationCommit };
}

function finalTopologyInventory(
  fixture: ReturnType<typeof createTopologyFixture>,
  schemaVersion: 2 | 3 = 3,
): SyncInventory {
  const inventory = generateSyncInventory({
    repo: fixture.repo,
    forkParent: fixture.fork,
    requiredAncestors: [fixture.base],
    target: fixture.target,
    canonicalTag: fixture.tag,
  });
  Object.assign(inventory.baseline, {
    integrationCommit: fixture.integrationCommit,
  });
  if (schemaVersion === 2) asLegacySchema(inventory, 2);
  return completeInventory(inventory);
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
    const generateCli = spawnSync(
      process.execPath,
      [
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
      { encoding: "utf8" },
    );
    expect(generateCli.status, generateCli.stderr).toBe(0);
    expect(generateCli.stdout).toContain("generated");
    const inventory = JSON.parse(
      readFileSync(inventoryPath, "utf8"),
    ) as SyncInventory;
    validateSyncInventory(inventory, readFileSync(ledgerPath, "utf8"), {
      repo: fixture.repo,
    });

    expect(inventory.schemaVersion).toBe(3);
    expect(inventory.trackingIssue).toBe(338);
    expect(inventory.derivation.algorithmVersion).toBe(
      "upstream-sync-ledger/v3",
    );
    expect(inventory.derivation.exclusions).toEqual(CANONICAL_EXCLUSIONS);
    expect(
      (inventory.baseline as unknown as Record<string, unknown>).tagObject,
    ).toBe(fixture.tagObject);
    expect(
      (inventory.baseline as unknown as Record<string, unknown>)
        .integrationCommit,
    ).toBeNull();
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

    const cli = spawnSync(
      process.execPath,
      [
        script,
        "check",
        "--repo",
        fixture.repo,
        "--inventory",
        inventoryPath,
        "--ledger",
        ledgerPath,
      ],
      { encoding: "utf8" },
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toContain("validated");

    expect({
      head: git(fixture.repo, "rev-parse", "HEAD"),
      index: git(fixture.repo, "write-tree"),
      status: git(fixture.repo, "status", "--porcelain=v1"),
    }).toEqual(before);
  }, 30_000);

  test("reports child-process capture failures without embedding stdout payloads", () => {
    const repo = tempDir("ccflare-upstream-sync-git-failure-");
    const bin = tempDir("ccflare-upstream-sync-git-wrapper-");
    const gitWrapper = join(bin, "git");
    writeFileSync(
      gitWrapper,
      `#!/bin/sh
printf 'synthetic actionable git failure\\n' >&2
i=0
while [ "$i" -lt 50000 ]; do
  printf 'SYNTHETIC_STDOUT_PAYLOAD\\n'
  i=$((i + 1))
done
exit 23
`,
    );
    chmodSync(gitWrapper, 0o755);
    const originalPath = process.env.PATH;
    let message = "";
    try {
      process.env.PATH = `${bin}:${originalPath ?? ""}`;
      try {
        generateSyncInventory({
          repo,
          forkParent: SHA_A,
          requiredAncestors: [SHA_A],
          target: SHA_B,
          canonicalTag: "refs/tags/v-synthetic-failure",
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    expect(message).toContain("ENOBUFS");
    expect(message).toContain("synthetic actionable git failure");
    expect(message).toContain("stdout omitted");
    expect(message).not.toContain("SYNTHETIC_STDOUT_PAYLOAD");
    expect(message.length).toBeLessThan(10_000);
  });

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

  test("schema v2 and v3 reject lightweight tags while schema v1 retains its old tag contract", () => {
    const fixture = createMergeFixture();
    const lightweightTag = "refs/tags/v-lightweight";
    git(fixture.repo, "tag", "v-lightweight", fixture.target);

    expect(() =>
      generateSyncInventory({
        repo: fixture.repo,
        forkParent: fixture.fork,
        requiredAncestors: [fixture.base],
        target: fixture.target,
        canonicalTag: lightweightTag,
      }),
    ).toThrow(/annotated tag/);

    const generated = generateSyncInventory({
      repo: fixture.repo,
      forkParent: fixture.fork,
      requiredAncestors: [fixture.base],
      target: fixture.target,
      canonicalTag: fixture.tag,
    });
    const v2 = asLegacySchema(clone(generated), 2);
    v2.baseline.canonicalTag = lightweightTag;
    v2.baseline.tagObject = fixture.target;
    expect(() =>
      validateSyncInventory(v2, renderLedger(v2), { repo: fixture.repo }),
    ).toThrow(/annotated tag/);

    const v1 = asLegacySchema(generated, 1);
    v1.baseline.canonicalTag = lightweightTag;
    expect(() =>
      validateSyncInventory(v1, renderLedger(v1), { repo: fixture.repo }),
    ).not.toThrow();
  }, 30_000);

  test("schema v2 and v3 reject a recorded tag object that differs from the canonical ref", () => {
    const fixture = createMergeFixture();
    expect(() =>
      generateSyncInventory({
        repo: fixture.repo,
        forkParent: fixture.fork,
        requiredAncestors: [fixture.base],
        target: fixture.fork,
        canonicalTag: fixture.tag,
      }),
    ).toThrow(/canonical tag peels.*not recorded target/);

    const generated = generateSyncInventory({
      repo: fixture.repo,
      forkParent: fixture.fork,
      requiredAncestors: [fixture.base],
      target: fixture.target,
      canonicalTag: fixture.tag,
    });

    for (const schemaVersion of [2, 3] as const) {
      const inventory = clone(generated);
      if (schemaVersion === 2) asLegacySchema(inventory, 2);
      Object.assign(inventory.baseline, { tagObject: fixture.target });
      expect(() =>
        validateSyncInventory(inventory, renderLedger(inventory), {
          repo: fixture.repo,
        }),
      ).toThrow(/recorded tag object/);
    }
  }, 30_000);

  test("schema v2 and v3 final validation accept the real ordered two-parent integration merge", () => {
    const fixture = createTopologyFixture();
    for (const schemaVersion of [2, 3] as const) {
      const inventory = finalTopologyInventory(fixture, schemaVersion);
      expect(() =>
        validateSyncInventory(inventory, renderLedger(inventory), {
          repo: fixture.repo,
          observedRerereApplications: [],
        }),
      ).not.toThrow();
    }
  }, 30_000);

  test("schema v2 and v3 final validation ignore parent-prefixed commit message lines", () => {
    const fixture = createTopologyFixture();
    const integrationCommit = commitWithParents(
      fixture.repo,
      fixture.integrationCommit,
      [fixture.fork, fixture.target],
      `integrate upstream\n\nparent ${fixture.base}`,
    );
    for (const schemaVersion of [2, 3] as const) {
      const inventory = finalTopologyInventory(fixture, schemaVersion);
      Object.assign(inventory.baseline, { integrationCommit });
      expect(() =>
        validateSyncInventory(inventory, renderLedger(inventory), {
          repo: fixture.repo,
          observedRerereApplications: [],
          reviewedRef: integrationCommit,
        }),
      ).not.toThrow();
    }
  }, 30_000);

  test("schema v2 and v3 final validation reject a detached valid integration merge", () => {
    const fixture = createTopologyFixture();
    const integrationCommit = commitWithParents(
      fixture.repo,
      fixture.integrationCommit,
      [fixture.fork, fixture.target],
    );
    git(fixture.repo, "branch", "detached-integration", integrationCommit);
    for (const schemaVersion of [2, 3] as const) {
      const inventory = finalTopologyInventory(fixture, schemaVersion);
      Object.assign(inventory.baseline, { integrationCommit });
      expect(() =>
        validateSyncInventory(inventory, renderLedger(inventory), {
          repo: fixture.repo,
          observedRerereApplications: [],
        }),
      ).toThrow(/not an ancestor of reviewed ref HEAD/);
    }
  }, 30_000);

  test("schema v2 and v3 final validation accept a reviewed descendant after follow-up commits", () => {
    const fixture = createTopologyFixture();
    write(fixture.repo, "follow-up.txt", "follow-up\n");
    commitAll(fixture.repo, "follow-up");

    for (const schemaVersion of [2, 3] as const) {
      const inventory = finalTopologyInventory(fixture, schemaVersion);
      expect(() =>
        validateSyncInventory(inventory, renderLedger(inventory), {
          repo: fixture.repo,
          observedRerereApplications: [],
        }),
      ).not.toThrow();
    }
  }, 30_000);

  test.each([
    ["one-parent commit", (fixture: ReturnType<typeof createTopologyFixture>) => fixture.fork],
    [
      "reversed parents",
      (fixture: ReturnType<typeof createTopologyFixture>) =>
        commitWithParents(fixture.repo, fixture.target, [
          fixture.target,
          fixture.fork,
        ]),
    ],
    [
      "extra parent",
      (fixture: ReturnType<typeof createTopologyFixture>) =>
        commitWithParents(fixture.repo, fixture.target, [
          fixture.fork,
          fixture.target,
          fixture.base,
        ]),
    ],
    [
      "wrong first parent",
      (fixture: ReturnType<typeof createTopologyFixture>) =>
        commitWithParents(fixture.repo, fixture.target, [
          fixture.base,
          fixture.target,
        ]),
    ],
    [
      "wrong target parent",
      (fixture: ReturnType<typeof createTopologyFixture>) =>
        commitWithParents(fixture.repo, fixture.target, [
          fixture.fork,
          fixture.base,
        ]),
    ],
  ])("schema v2 and v3 final validation reject %s", (_label, integrationCommit) => {
    const fixture = createTopologyFixture();
    const invalidCommit = integrationCommit(fixture);
    for (const schemaVersion of [2, 3] as const) {
      const inventory = finalTopologyInventory(fixture, schemaVersion);
      Object.assign(inventory.baseline, { integrationCommit: invalidCommit });
      expect(() =>
        validateSyncInventory(inventory, renderLedger(inventory), {
          repo: fixture.repo,
          observedRerereApplications: [],
        }),
      ).toThrow(/exact ordered parents.*forkParent.*target/);
    }
  }, 30_000);
});

describe("schema v3 exclusion-safe projection", () => {
  test("computes projected patch IDs for permitted textual patches larger than one MiB", () => {
    const fixture = createLargeProjectedPatchFixture();
    let inventory: SyncInventory | undefined;
    let failureSummary:
      | { messageLength: number; reportsCaptureLimit: boolean }
      | undefined;

    try {
      inventory = generateSyncInventory({
        repo: fixture.repo,
        forkParent: fixture.fork,
        requiredAncestors: [fixture.base],
        target: fixture.target,
        canonicalTag: fixture.tag,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failureSummary = {
        messageLength: message.length,
        reportsCaptureLimit: /ENOBUFS|maxBuffer/.test(message),
      };
    }

    expect(failureSummary).toBeUndefined();
    expect(inventory?.baseline.rawCounts).toEqual({ left: 1, right: 2 });
    expect(inventory?.baseline.cherryPickCounts).toEqual({ left: 1, right: 2 });
  }, 30_000);

  test("counts projected patch equivalence across multi-commit sides, an in-range merge, and merged boundary history", () => {
    const fixture = createProjectedCherryPickFixture();
    const inventory = generateSyncInventory({
      repo: fixture.repo,
      forkParent: fixture.fork,
      requiredAncestors: [fixture.base],
      target: fixture.target,
      canonicalTag: fixture.tag,
    });

    expect(inventory.baseline.rawCounts).toEqual({ left: 4, right: 2 });
    expect(inventory.baseline.cherryPickCounts).toEqual({ left: 3, right: 1 });
    expect(inventory.expected.upstreamCommits).toEqual(fixture.upstreamCommits);
  }, 30_000);

  test("counts projected patch equivalence without excluded blobs from intermediate history", () => {
    const fixture = createProjectedCherryPickFixture();
    expect(treeEntry(fixture.repo, fixture.fork, EXCLUDED_PATH)).toBeNull();
    expect(treeEntry(fixture.repo, fixture.target, EXCLUDED_PATH)).toBeNull();
    for (const objectId of fixture.intermediateExcludedObjects) {
      removeLooseObject(fixture.repo, objectId);
    }

    const inventory = generateSyncInventory({
      repo: fixture.repo,
      forkParent: fixture.fork,
      requiredAncestors: [fixture.base],
      target: fixture.target,
      canonicalTag: fixture.tag,
    });

    expect(inventory.baseline.rawCounts).toEqual({ left: 4, right: 2 });
    expect(inventory.baseline.cherryPickCounts).toEqual({ left: 3, right: 1 });
    expect(inventory.expected.upstreamCommits).toEqual(fixture.upstreamCommits);
  }, 30_000);

  test("attributes prefix-related conflict paths to their exact classes", () => {
    const fixture = createPrefixConflictFixture();
    const inventory = generateSyncInventory({
      repo: fixture.repo,
      forkParent: fixture.fork,
      requiredAncestors: [fixture.base],
      target: fixture.target,
      canonicalTag: fixture.tag,
    });

    expect(inventory.expected.conflicts).toEqual([
      { path: "one.txt", conflictClass: "content" },
      { path: "one.txt.extra", conflictClass: "modify/delete" },
    ]);
  }, 30_000);

  test("derives conflicts from projected trees without reading excluded blobs", () => {
    const fixture = createProjectionFixture();
    for (const objectId of fixture.excludedObjects) {
      removeLooseObject(fixture.repo, objectId);
    }

    const inventory = generateSyncInventory({
      repo: fixture.repo,
      forkParent: fixture.fork,
      requiredAncestors: [fixture.base],
      target: fixture.target,
      canonicalTag: fixture.tag,
      trackingIssue: 338,
    });
    const proof = inventory.derivation as unknown as {
      exclusions: string[];
      exclusionsSha256: string;
      originalTrees: Record<string, string>;
      projectedTrees: Record<string, string>;
      retainedEntriesSha256: Record<string, string>;
    };

    expect(inventory.schemaVersion).toBe(3);
    expect(inventory.trackingIssue).toBe(338);
    expect(proof.exclusions).toEqual(CANONICAL_EXCLUSIONS);
    expect(proof.exclusionsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(proof.originalTrees).sort()).toEqual([
      "base",
      "fork",
      "target",
    ]);
    expect(Object.keys(proof.projectedTrees).sort()).toEqual([
      "base",
      "fork",
      "target",
    ]);
    expect(Object.values(proof.retainedEntriesSha256)).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(JSON.stringify(inventory.expected)).not.toContain(EXCLUDED_PATH);
    expect(inventory.expected.conflicts).toContainEqual({
      path: "content.txt",
      conflictClass: "content",
    });
    expect(
      inventory.expected.conflicts.some((entry) =>
        entry.path.startsWith("shape"),
      ),
    ).toBe(true);
    expect(
      inventory.expected.conflicts.some((entry) =>
        entry.path.includes("rename-target"),
      ),
    ).toBe(true);
    expect(renderLedger(inventory)).toStartWith(
      "# Issue #338 — v-test Resolution Ledger",
    );
    expect(() =>
      validateSyncInventory(inventory, renderLedger(inventory), {
        repo: fixture.repo,
      }),
    ).not.toThrow();
  }, 30_000);

  test("rejects changed exclusion policy and tampered immutable projection proofs", () => {
    const fixture = createMergeFixture();
    const inventory = generateSyncInventory({
      repo: fixture.repo,
      forkParent: fixture.fork,
      requiredAncestors: [fixture.base],
      target: fixture.target,
      canonicalTag: fixture.tag,
      trackingIssue: 338,
    });

    for (const mutate of [
      (value: SyncInventory) => {
        const derivation = value.derivation as unknown as {
          exclusions: string[];
        };
        derivation.exclusions = derivation.exclusions.slice(1);
      },
      (value: SyncInventory) => {
        const derivation = value.derivation as unknown as {
          exclusions: string[];
        };
        derivation.exclusions = ["../unsafe"];
      },
      (value: SyncInventory) => {
        const derivation = value.derivation as unknown as {
          projectedTrees: { fork: string };
        };
        derivation.projectedTrees.fork = SHA_A;
      },
      (value: SyncInventory) => {
        const derivation = value.derivation as unknown as {
          retainedEntriesSha256: { target: string };
        };
        derivation.retainedEntriesSha256.target = "0".repeat(64);
      },
    ]) {
      const tampered = clone(inventory);
      mutate(tampered);
      expect(() =>
        validateSyncInventory(tampered, renderLedger(tampered), {
          repo: fixture.repo,
        }),
      ).toThrow(/exclusion|projection|derivation contract|Git evidence/);
    }
  }, 30_000);

  test.each([
    "addition",
    "removal",
    "rename",
    "mode",
    "object",
  ] as const)(
    "rejects an excluded-entry %s in the integration tree",
    (mutation) => {
      const fixture = createExcludedTopologyFixture(mutation);
      const inventory = finalTopologyInventory(fixture);

      expect(() =>
        validateSyncInventory(inventory, renderLedger(inventory), {
          repo: fixture.repo,
          observedRerereApplications: [],
        }),
      ).toThrow(/excluded entry parity.*integration commit/);
    },
    30_000,
  );

  test("checks excluded-entry parity again at the reviewed descendant", () => {
    const fixture = createExcludedTopologyFixture();
    const inventory = finalTopologyInventory(fixture);

    expect(() =>
      validateSyncInventory(inventory, renderLedger(inventory), {
        repo: fixture.repo,
        observedRerereApplications: [],
      }),
    ).not.toThrow();

    write(fixture.repo, EXCLUDED_PATH, "post-integration replacement\n");
    commitAll(fixture.repo, "change excluded entry after integration");
    expect(() =>
      validateSyncInventory(inventory, renderLedger(inventory), {
        repo: fixture.repo,
        observedRerereApplications: [],
      }),
    ).toThrow(/excluded entry parity.*reviewed ref/);
  }, 30_000);
});
