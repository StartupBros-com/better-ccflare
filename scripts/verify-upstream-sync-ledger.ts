#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const ALGORITHM_VERSION = "upstream-sync-ledger/v1";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const KINDS = ["upstream-commit", "conflict", "shared-path", "rerere"] as const;
const DISPOSITIONS = [
  "pending",
  "retained",
  "semantically-remapped",
  "intentionally-rejected",
  "already-superseded",
] as const;
const PHASES = ["pre-merge", "merge-in-progress", "final"] as const;
const EVIDENCE_TYPES = [
  "command",
  "test",
  "combined-diff",
  "reviewer",
  "refreshed-main",
  "capture",
  "document",
] as const;

type Kind = (typeof KINDS)[number];
type Disposition = (typeof DISPOSITIONS)[number];
type Phase = (typeof PHASES)[number];

export interface RerereApplication {
  path: string;
  preimageSha256: string;
}

interface EvidenceStatus {
  status: "pending" | "passed" | "failed" | "not-applicable";
  references: string[];
}

interface AcceptanceStatus {
  status: "pending" | "complete" | "failed";
  references: string[];
}

interface CombinedDiffStatus {
  status: "pending" | "reviewed" | "failed" | "not-applicable";
  references: string[];
}

export interface InventoryItem {
  id: string;
  kind: Kind;
  source: {
    sha?: string;
    path?: string;
    conflictClass?: string;
    preimageSha256?: string;
  };
  ledgerAnchor: string;
  disposition: Disposition;
  upstreamIntent: string;
  protectedForkBehavior: string;
  selectedResolution: string;
  evidence: {
    focusedPacket: EvidenceStatus;
    acceptanceComplete: AcceptanceStatus;
    combinedDiff: CombinedDiffStatus;
  };
  reviewer: {
    status: "pending" | "accepted" | "rejected";
    identity: string | null;
    notes: string;
  };
  dependencies: string[];
  rationale: string;
  refreshedMainEvidence: string[];
}

export interface EvidenceRecord {
  type: (typeof EVIDENCE_TYPES)[number];
  summary: string;
  details: string;
}

export interface SyncInventory {
  schemaVersion: number;
  phase: Phase;
  baseline: {
    forkParent: string;
    requiredAncestors: string[];
    target: string;
    canonicalTag: string;
    peeledTag: string;
    mergeBase: string;
    rawCounts: { left: number; right: number };
    cherryPickCounts: { left: number; right: number };
    versions: {
      fork: { root: string; cli: string };
      target: { root: string; cli: string };
    };
  };
  derivation: {
    algorithmVersion: string;
    upstreamCommitOrder: string;
    pathSemantics: string;
    conflictMechanism: string;
  };
  expected: {
    upstreamCommits: string[];
    conflicts: Array<{ path: string; conflictClass: string }>;
    sharedPaths: string[];
    qwenComparisonTrigger: {
      active: boolean;
      triggeringPaths: string[];
    };
    rerereCapture: {
      state: "pre-merge-empty" | "capturing" | "complete";
      applications: RerereApplication[];
    };
  };
  evidenceCatalog: Record<string, EvidenceRecord>;
  items: InventoryItem[];
}

export interface GenerateOptions {
  repo: string;
  forkParent: string;
  requiredAncestors: string[];
  target: string;
  canonicalTag: string;
}

export interface ValidationOptions {
  repo?: string;
  skipGitDerivation?: boolean;
  observedRerereApplications?: RerereApplication[];
}

function fail(message: string): never {
  throw new Error(message);
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") fail(`${label} must be a string`);
}

function assertNonEmpty(
  value: unknown,
  label: string,
): asserts value is string {
  assertString(value, label);
  if (value.trim() === "") fail(`${label} must be non-empty`);
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail(`${label} must be a full 40-character lowercase SHA`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a 64-character lowercase SHA-256`);
  }
}

function assertSafePath(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("//") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    normalize(value).replaceAll("\\", "/") !== value
  ) {
    fail(`${label} must be a safe normalized repo-relative path`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    fail(`${label} must be an array of strings`);
  }
}

function git(
  repo: string,
  args: string[],
  options: { allowConflictExit?: boolean; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0 && !(options.allowConflictExit && exitCode === 1)) {
    fail(
      `git ${args.join(" ")} failed (${exitCode}): ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    );
  }
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode,
  };
}

function gitText(repo: string, args: string[]): string {
  return git(repo, args).stdout.trim();
}

function resolveCommit(repo: string, value: string, label: string): string {
  const resolved = gitText(repo, [
    "rev-parse",
    "--verify",
    `${value}^{commit}`,
  ]);
  assertSha(resolved, label);
  return resolved;
}

function parseCounts(
  value: string,
  label: string,
): { left: number; right: number } {
  const parts = value.trim().split(/\s+/).map(Number);
  if (
    parts.length !== 2 ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    fail(`${label} did not return two non-negative integer counts`);
  }
  return { left: parts[0], right: parts[1] };
}

function packageVersion(repo: string, commit: string, path: string): string {
  const raw = gitText(repo, ["show", `${commit}:${path}`]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${path} at ${commit} is not valid JSON`);
  }
  assertRecord(parsed, `${path} package`);
  assertNonEmpty(parsed.version, `${path} version`);
  return parsed.version;
}

function changedPaths(repo: string, base: string, parent: string): string[] {
  const output = git(repo, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    `${base}..${parent}`,
  ]).stdout;
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const paths = new Set<string>();
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) fail("git diff returned an empty path status");
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      assertSafePath(oldPath, "renamed source path");
      assertSafePath(newPath, "renamed destination path");
      paths.add(newPath);
    } else {
      const path = fields[index++];
      assertSafePath(path, "side-changed path");
      paths.add(path);
    }
  }
  return [...paths].sort();
}

function sourceObjectDirectory(repo: string): string {
  const path = gitText(repo, ["rev-parse", "--git-path", "objects"]);
  return isAbsolute(path) ? path : resolve(repo, path);
}

function deriveConflicts(
  repo: string,
  forkParent: string,
  target: string,
): Array<{ path: string; conflictClass: string }> {
  const alternateObjects = mkdtempSync(join(tmpdir(), "ccflare-sync-objects-"));
  try {
    const result = git(
      repo,
      ["merge-tree", "--write-tree", "--name-only", forkParent, target],
      {
        allowConflictExit: true,
        env: {
          GIT_OBJECT_DIRECTORY: alternateObjects,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjectDirectory(repo),
        },
      },
    );
    const sections = result.stdout.split(/\n\n/);
    const summary = sections.shift()?.split("\n") ?? [];
    const tree = summary.shift()?.trim();
    assertSha(tree, "merge-tree result tree");
    const conflictPaths = summary.filter(Boolean);
    for (const path of conflictPaths) assertSafePath(path, "conflict path");
    if (result.exitCode === 0 && conflictPaths.length > 0) {
      fail("merge-tree returned conflict paths with a successful exit");
    }
    if (result.exitCode === 1 && conflictPaths.length === 0) {
      fail("merge-tree reported conflicts without exact conflict paths");
    }

    const classByPath = new Map<string, string>();
    const orderedPaths = [...conflictPaths].sort(
      (left, right) => right.length - left.length || left.localeCompare(right),
    );
    for (const line of sections.join("\n\n").split("\n")) {
      const match = line.match(/^CONFLICT \(([^)]+)\): (.+)$/);
      if (!match) continue;
      const path = orderedPaths.find((candidate) =>
        match[2].includes(candidate),
      );
      if (!path) fail(`could not link merge-tree conflict message: ${line}`);
      if (classByPath.has(path)) fail(`duplicate conflict message for ${path}`);
      const conflictClass = match[1].trim();
      if (conflictClass === "") fail(`empty conflict class for ${path}`);
      classByPath.set(path, conflictClass);
    }
    const conflicts = conflictPaths.map((path) => {
      const conflictClass = classByPath.get(path);
      if (!conflictClass) fail(`missing explicit conflict class for ${path}`);
      return { path, conflictClass };
    });
    return conflicts.sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    rmSync(alternateObjects, { recursive: true, force: true });
  }
}

function deriveGitState(
  options: GenerateOptions,
): Omit<SyncInventory, "items" | "evidenceCatalog"> {
  const repo = realpathSync(options.repo);
  const forkParent = resolveCommit(repo, options.forkParent, "fork parent");
  const requiredAncestors = options.requiredAncestors
    .map((ancestor) => resolveCommit(repo, ancestor, "required ancestor"))
    .sort();
  if (requiredAncestors.length === 0) {
    fail("at least one required fork-parent ancestor must be recorded");
  }
  if (new Set(requiredAncestors).size !== requiredAncestors.length) {
    fail("duplicate required fork-parent ancestor");
  }
  for (const ancestor of requiredAncestors) {
    const relationship = git(
      repo,
      ["merge-base", "--is-ancestor", ancestor, forkParent],
      { allowConflictExit: true },
    );
    if (relationship.exitCode !== 0) {
      fail(`required ancestor ${ancestor} is not an ancestor of ${forkParent}`);
    }
  }
  const target = resolveCommit(repo, options.target, "target");
  const peeledTag = gitText(repo, [
    "rev-parse",
    "--verify",
    `${options.canonicalTag}^{}`,
  ]);
  assertSha(peeledTag, "peeled canonical tag");
  if (peeledTag !== target) {
    fail(`canonical tag peels to ${peeledTag}, not recorded target ${target}`);
  }
  const mergeBase = gitText(repo, ["merge-base", forkParent, target]);
  assertSha(mergeBase, "merge base");
  const upstreamCommits = gitText(repo, [
    "rev-list",
    "--topo-order",
    "--reverse",
    `${mergeBase}..${target}`,
  ])
    .split("\n")
    .filter(Boolean);
  for (const commit of upstreamCommits)
    assertSha(commit, "upstream-only commit");
  const conflicts = deriveConflicts(repo, forkParent, target);
  const conflictPaths = new Set(conflicts.map((entry) => entry.path));
  const leftPaths = changedPaths(repo, mergeBase, forkParent);
  const rightPaths = changedPaths(repo, mergeBase, target);
  const rightSet = new Set(rightPaths);
  const sharedPaths = leftPaths
    .filter((path) => rightSet.has(path) && !conflictPaths.has(path))
    .sort();
  const qwenComparisonTrigger = deriveQwenComparisonTrigger(
    conflicts,
    sharedPaths,
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    phase: "pre-merge",
    baseline: {
      forkParent,
      requiredAncestors,
      target,
      canonicalTag: options.canonicalTag,
      peeledTag,
      mergeBase,
      rawCounts: parseCounts(
        gitText(repo, [
          "rev-list",
          "--left-right",
          "--count",
          `${forkParent}...${target}`,
        ]),
        "raw rev-list",
      ),
      cherryPickCounts: parseCounts(
        gitText(repo, [
          "rev-list",
          "--left-right",
          "--count",
          "--cherry-pick",
          `${forkParent}...${target}`,
        ]),
        "cherry-pick rev-list",
      ),
      versions: {
        fork: {
          root: packageVersion(repo, forkParent, "package.json"),
          cli: packageVersion(repo, forkParent, "apps/cli/package.json"),
        },
        target: {
          root: packageVersion(repo, target, "package.json"),
          cli: packageVersion(repo, target, "apps/cli/package.json"),
        },
      },
    },
    derivation: {
      algorithmVersion: ALGORITHM_VERSION,
      upstreamCommitOrder:
        "git rev-list --topo-order --reverse <merge-base>..<target>",
      pathSemantics:
        "git diff --name-status -z --find-renames; rename destinations and current repo-relative paths",
      conflictMechanism:
        "git merge-tree --write-tree --name-only with a temporary alternate object directory under OS tmpdir",
    },
    expected: {
      upstreamCommits,
      conflicts,
      sharedPaths,
      qwenComparisonTrigger,
      rerereCapture: { state: "pre-merge-empty", applications: [] },
    },
  };
}

function deriveQwenComparisonTrigger(
  conflicts: Array<{ path: string }>,
  sharedPaths: string[],
): { active: boolean; triggeringPaths: string[] } {
  const triggeringPaths = [
    ...conflicts.map((entry) => entry.path),
    ...sharedPaths,
  ]
    .filter(
      (path) =>
        path === "packages/providers/src/providers/qwen.ts" ||
        path.startsWith("packages/providers/src/providers/qwen/"),
    )
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .sort();
  return { active: triggeringPaths.length > 0, triggeringPaths };
}

function canonicalId(kind: Kind, source: InventoryItem["source"]): string {
  switch (kind) {
    case "upstream-commit":
      assertSha(source.sha, "upstream commit source SHA");
      return `commit:${source.sha}`;
    case "conflict":
      assertSafePath(source.path, "conflict source path");
      return `conflict:${source.path}`;
    case "shared-path":
      assertSafePath(source.path, "shared source path");
      return `shared-path:${source.path}`;
    case "rerere":
      assertSafePath(source.path, "rerere source path");
      assertSha256(source.preimageSha256, "rerere preimage SHA-256");
      return `rerere:${source.path}:${source.preimageSha256}`;
  }
}

export function canonicalLedgerAnchor(id: string, kind: Kind): string {
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 24);
  const prefix = kind === "upstream-commit" ? "commit" : kind;
  return `sync-${prefix}-${digest}`;
}

function pendingItem(
  kind: Kind,
  source: InventoryItem["source"],
): InventoryItem {
  const id = canonicalId(kind, source);
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
  };
}

export function generateSyncInventory(options: GenerateOptions): SyncInventory {
  const derived = deriveGitState(options);
  const items: InventoryItem[] = [
    ...derived.expected.upstreamCommits.map((sha) =>
      pendingItem("upstream-commit", { sha }),
    ),
    ...derived.expected.conflicts.map(({ path, conflictClass }) =>
      pendingItem("conflict", { path, conflictClass }),
    ),
    ...derived.expected.sharedPaths.map((path) =>
      pendingItem("shared-path", { path }),
    ),
  ].sort((left, right) => left.id.localeCompare(right.id));
  return { ...derived, evidenceCatalog: {}, items };
}

function reviewRecord(item: InventoryItem): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    disposition: item.disposition,
    upstreamIntent: item.upstreamIntent,
    protectedForkBehavior: item.protectedForkBehavior,
    selectedResolution: item.selectedResolution,
    evidence: item.evidence,
    reviewer: item.reviewer,
    dependencies: item.dependencies,
    rationale: item.rationale,
    refreshedMainEvidence: item.refreshedMainEvidence,
  };
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlUnescape(value: string): string {
  return value
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function renderLedger(inventory: SyncInventory): string {
  const release = inventory.baseline.canonicalTag.split("/").at(-1);
  if (!release) fail("canonical tag must identify a release");
  const lines = [
    `# Issue #260 — ${release} Resolution Ledger`,
    "",
    "> Generated review skeleton. Edit the machine inventory first, then regenerate this ledger explicitly.",
    "> `check` never rewrites either file.",
    "",
    `- Schema version: \`${inventory.schemaVersion}\``,
    `- Phase: \`${inventory.phase}\``,
    `- Fork parent: \`${inventory.baseline.forkParent}\``,
    `- Required fork-parent ancestors: \`${stableJson(inventory.baseline.requiredAncestors)}\``,
    `- Target: \`${inventory.baseline.target}\``,
    `- Canonical tag: \`${inventory.baseline.canonicalTag}\``,
    `- Merge base: \`${inventory.baseline.mergeBase}\``,
    `- Qwen comparison trigger: \`${stableJson(inventory.expected.qwenComparisonTrigger)}\``,
    "",
  ];
  for (const item of inventory.items) {
    lines.push(
      `<a id="${item.ledgerAnchor.slice(1)}"></a>`,
      `## \`${item.id}\``,
      "",
      `Kind: \`${item.kind}\``,
      "",
      `<pre data-upstream-sync-item="v1">${htmlEscape(stableJson(reviewRecord(item)))}</pre>`,
      "",
    );
  }
  while (lines.at(-1) === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

function validateEvidenceCatalog(inventory: SyncInventory): void {
  assertRecord(inventory.evidenceCatalog, "evidenceCatalog");
  for (const [key, record] of Object.entries(inventory.evidenceCatalog)) {
    if (key.trim() === "") fail("evidence catalog key must be non-empty");
    if (
      record === null ||
      typeof record !== "object" ||
      !EVIDENCE_TYPES.includes(record.type as never) ||
      typeof record.summary !== "string" ||
      record.summary.trim() === "" ||
      typeof record.details !== "string" ||
      record.details.trim() === ""
    ) {
      fail(
        `evidenceCatalog.${key} must contain a concrete typed non-empty evidence record`,
      );
    }
  }
}

function validateReferences(
  inventory: SyncInventory,
  references: unknown,
  label: string,
  requiredType?: EvidenceRecord["type"],
): string[] {
  assertStringArray(references, label);
  for (const reference of references) {
    if (!(reference in inventory.evidenceCatalog)) {
      fail(`${label} contains dangling evidence reference ${reference}`);
    }
    if (
      requiredType !== undefined &&
      inventory.evidenceCatalog[reference].type !== requiredType
    ) {
      fail(`${label} reference ${reference} must have type ${requiredType}`);
    }
  }
  if (new Set(references).size !== references.length) {
    fail(`${label} contains duplicate evidence references`);
  }
  return references;
}

function validateItem(inventory: SyncInventory, item: InventoryItem): void {
  assertRecord(item, "inventory item");
  if (!KINDS.includes(item.kind as never))
    fail(`unknown item kind: ${String(item.kind)}`);
  assertRecord(item.source, `${item.id || "item"}.source`);
  const expectedId = canonicalId(item.kind, item.source);
  if (item.id !== expectedId)
    fail(`${item.id} does not match its canonical id ${expectedId}`);
  const expectedAnchor = `#${canonicalLedgerAnchor(item.id, item.kind)}`;
  if (item.ledgerAnchor !== expectedAnchor) {
    fail(`${item.id} ledgerAnchor must be the deterministic canonical anchor`);
  }
  if (!DISPOSITIONS.includes(item.disposition as never)) {
    fail(`unknown disposition on ${item.id}: ${String(item.disposition)}`);
  }
  for (const [field, value] of [
    ["upstreamIntent", item.upstreamIntent],
    ["protectedForkBehavior", item.protectedForkBehavior],
    ["selectedResolution", item.selectedResolution],
    ["rationale", item.rationale],
  ] as const) {
    assertString(value, `${item.id}.${field}`);
  }
  if (item.kind === "conflict") {
    assertNonEmpty(
      item.source.conflictClass,
      `${item.id}.source.conflictClass`,
    );
  }
  assertRecord(item.evidence, `${item.id}.evidence`);
  assertRecord(
    item.evidence.focusedPacket,
    `${item.id}.evidence.focusedPacket`,
  );
  assertRecord(
    item.evidence.acceptanceComplete,
    `${item.id}.evidence.acceptanceComplete`,
  );
  assertRecord(item.evidence.combinedDiff, `${item.id}.evidence.combinedDiff`);
  if (
    !["pending", "passed", "failed", "not-applicable"].includes(
      item.evidence.focusedPacket.status,
    )
  ) {
    fail(`${item.id} has unknown focused packet status`);
  }
  if (
    !["pending", "complete", "failed"].includes(
      item.evidence.acceptanceComplete.status,
    )
  ) {
    fail(`${item.id} has unknown acceptance-complete status`);
  }
  if (
    !["pending", "reviewed", "failed", "not-applicable"].includes(
      item.evidence.combinedDiff.status,
    )
  ) {
    fail(`${item.id} has unknown combined-diff status`);
  }
  const focused = validateReferences(
    inventory,
    item.evidence.focusedPacket.references,
    `${item.id} focused evidence`,
  );
  const acceptance = validateReferences(
    inventory,
    item.evidence.acceptanceComplete.references,
    `${item.id} acceptance evidence`,
  );
  const combined = validateReferences(
    inventory,
    item.evidence.combinedDiff.references,
    `${item.id} combined-diff evidence`,
    "combined-diff",
  );
  assertStringArray(item.dependencies, `${item.id}.dependencies`);
  for (const dependency of item.dependencies) {
    if (!(dependency in inventory.evidenceCatalog)) {
      fail(`${item.id} has missing dependency evidence ${dependency}`);
    }
  }
  validateReferences(
    inventory,
    item.refreshedMainEvidence,
    `${item.id} refreshed-main evidence`,
    "refreshed-main",
  );
  assertRecord(item.reviewer, `${item.id}.reviewer`);
  if (!["pending", "accepted", "rejected"].includes(item.reviewer.status)) {
    fail(`${item.id} has unknown reviewer status`);
  }
  if (item.reviewer.identity !== null)
    assertNonEmpty(item.reviewer.identity, `${item.id}.reviewer.identity`);
  assertString(item.reviewer.notes, `${item.id}.reviewer.notes`);

  if (item.evidence.acceptanceComplete.status === "complete") {
    if (
      item.evidence.focusedPacket.status !== "passed" ||
      focused.length === 0 ||
      acceptance.length === 0 ||
      item.dependencies.some((dependency) => !acceptance.includes(dependency))
    ) {
      fail(`${item.id} has premature acceptance-complete evidence`);
    }
  }
  if (
    item.disposition === "intentionally-rejected" &&
    item.rationale.trim() === ""
  ) {
    fail(`${item.id} intentional rejection requires non-empty rationale`);
  }
  if (
    item.disposition === "already-superseded" &&
    item.refreshedMainEvidence.length === 0
  ) {
    fail(`${item.id} already-superseded requires refreshed-main evidence`);
  }

  if (inventory.phase === "final") {
    if (item.disposition === "pending")
      fail(`final item ${item.id} is pending`);
    for (const [field, value] of [
      ["upstreamIntent", item.upstreamIntent],
      ["protectedForkBehavior", item.protectedForkBehavior],
      ["selectedResolution", item.selectedResolution],
    ] as const) {
      if (value.trim() === "" || value === "pending") {
        fail(`final item ${item.id} has pending ${field}`);
      }
    }
    if (item.rationale.trim() === "" || item.rationale === "pending") {
      fail(`final item ${item.id} has pending rationale`);
    }
    if (
      item.evidence.focusedPacket.status !== "passed" ||
      focused.length === 0
    ) {
      fail(`final item ${item.id} lacks passing focused evidence`);
    }
    if (
      item.evidence.acceptanceComplete.status !== "complete" ||
      acceptance.length === 0
    ) {
      fail(`final item ${item.id} lacks acceptance-complete evidence`);
    }
    if (
      item.kind === "upstream-commit" &&
      item.evidence.combinedDiff.status !== "not-applicable"
    ) {
      fail(`final item ${item.id} has pending combined-diff review`);
    }
    if (
      item.kind !== "upstream-commit" &&
      (item.evidence.combinedDiff.status !== "reviewed" ||
        combined.length === 0)
    ) {
      fail(`final item ${item.id} lacks combined-diff review evidence`);
    }
    if (item.reviewer.status !== "accepted" || !item.reviewer.identity) {
      fail(`final item ${item.id} requires an accepted reviewer disposition`);
    }
    if (
      item.reviewer.notes.trim() === "" ||
      item.reviewer.notes === "pending"
    ) {
      fail(`final item ${item.id} has pending reviewer notes`);
    }
  }
}

function itemSourceKey(item: InventoryItem): string {
  return canonicalId(item.kind, item.source);
}

function compareExpectedItems(inventory: SyncInventory): void {
  const commitItems = inventory.items.filter(
    (item) => item.kind === "upstream-commit",
  );
  const conflictItems = inventory.items.filter(
    (item) => item.kind === "conflict",
  );
  const sharedItems = inventory.items.filter(
    (item) => item.kind === "shared-path",
  );
  const rerereItems = inventory.items.filter((item) => item.kind === "rerere");

  const commitSources = new Set(commitItems.map((item) => item.source.sha));
  for (const sha of inventory.expected.upstreamCommits) {
    if (!commitSources.has(sha)) fail(`missing upstream commit item ${sha}`);
  }
  if (commitItems.length !== inventory.expected.upstreamCommits.length) {
    fail("upstream commit item set contains an unexpected or duplicate item");
  }

  const expectedConflict = new Map(
    inventory.expected.conflicts.map((entry) => [
      entry.path,
      entry.conflictClass,
    ]),
  );
  for (const [path, conflictClass] of expectedConflict) {
    const found = conflictItems.find((item) => item.source.path === path);
    if (!found) fail(`missing conflict item ${path}`);
    if (found.source.conflictClass !== conflictClass) {
      fail(`conflict record drift for ${path}: expected ${conflictClass}`);
    }
  }
  if (conflictItems.length !== expectedConflict.size) {
    fail("conflict item set contains an unexpected or duplicate item");
  }

  const sharedSources = new Set(sharedItems.map((item) => item.source.path));
  for (const path of inventory.expected.sharedPaths) {
    if (!sharedSources.has(path)) fail(`missing shared path item ${path}`);
  }
  if (sharedItems.length !== inventory.expected.sharedPaths.length) {
    fail("shared path item set contains an unexpected or duplicate item");
  }

  const rerereSources = new Set(
    rerereItems.map(
      (item) => `${item.source.path}:${item.source.preimageSha256}`,
    ),
  );
  for (const application of inventory.expected.rerereCapture.applications) {
    const key = `${application.path}:${application.preimageSha256}`;
    if (!rerereSources.has(key)) fail(`missing rerere item ${key}`);
  }
  if (
    rerereItems.length !== inventory.expected.rerereCapture.applications.length
  ) {
    fail("rerere item set contains an unexpected or duplicate item");
  }
}

function validateExpected(inventory: SyncInventory): void {
  assertRecord(inventory.expected, "expected");
  if (!Array.isArray(inventory.expected.upstreamCommits)) {
    fail("expected.upstreamCommits must be an array");
  }
  for (const sha of inventory.expected.upstreamCommits)
    assertSha(sha, "expected upstream commit");
  if (
    new Set(inventory.expected.upstreamCommits).size !==
    inventory.expected.upstreamCommits.length
  ) {
    fail("duplicate expected upstream commit");
  }
  if (!Array.isArray(inventory.expected.conflicts))
    fail("expected.conflicts must be an array");
  const conflictPaths = new Set<string>();
  for (const conflict of inventory.expected.conflicts) {
    assertRecord(conflict, "expected conflict");
    assertSafePath(conflict.path, "expected conflict path");
    assertNonEmpty(conflict.conflictClass, "expected conflict class");
    if (conflictPaths.has(conflict.path))
      fail(`duplicate normalized conflict path ${conflict.path}`);
    conflictPaths.add(conflict.path);
  }
  assertStringArray(inventory.expected.sharedPaths, "expected.sharedPaths");
  const sharedPaths = new Set<string>();
  for (const path of inventory.expected.sharedPaths) {
    assertSafePath(path, "expected shared path");
    if (sharedPaths.has(path)) fail(`duplicate normalized shared path ${path}`);
    if (conflictPaths.has(path))
      fail(`${path} cannot be both conflict and clean shared path`);
    sharedPaths.add(path);
  }
  assertRecord(
    inventory.expected.qwenComparisonTrigger,
    "expected.qwenComparisonTrigger",
  );
  if (typeof inventory.expected.qwenComparisonTrigger.active !== "boolean") {
    fail("Qwen comparison trigger active flag must be boolean");
  }
  assertStringArray(
    inventory.expected.qwenComparisonTrigger.triggeringPaths,
    "expected.qwenComparisonTrigger.triggeringPaths",
  );
  for (const path of inventory.expected.qwenComparisonTrigger.triggeringPaths) {
    assertSafePath(path, "Qwen comparison trigger path");
  }
  const derivedQwenTrigger = deriveQwenComparisonTrigger(
    inventory.expected.conflicts,
    inventory.expected.sharedPaths,
  );
  if (!sameJson(inventory.expected.qwenComparisonTrigger, derivedQwenTrigger)) {
    fail("Qwen comparison trigger diverges from conflict/shared-path evidence");
  }
  assertRecord(inventory.expected.rerereCapture, "expected.rerereCapture");
  if (
    !["pre-merge-empty", "capturing", "complete"].includes(
      inventory.expected.rerereCapture.state,
    )
  ) {
    fail("unknown rerere capture state");
  }
  if (!Array.isArray(inventory.expected.rerereCapture.applications)) {
    fail("rerere applications must be an array");
  }
  const rerereSources = new Set<string>();
  for (const application of inventory.expected.rerereCapture.applications) {
    assertRecord(application, "rerere application");
    assertSafePath(application.path, "rerere application path");
    assertSha256(
      application.preimageSha256,
      "rerere application preimage SHA-256",
    );
    const key = `${application.path}:${application.preimageSha256}`;
    if (rerereSources.has(key)) fail(`duplicate rerere source ${key}`);
    rerereSources.add(key);
  }
  if (
    inventory.phase === "pre-merge" &&
    (inventory.expected.rerereCapture.state !== "pre-merge-empty" ||
      inventory.expected.rerereCapture.applications.length !== 0)
  ) {
    fail("pre-merge inventory requires the legal explicit empty rerere state");
  }
}

function validateLedger(inventory: SyncInventory, ledger: string): void {
  for (const expectedHeader of [
    `- Required fork-parent ancestors: \`${stableJson(inventory.baseline.requiredAncestors)}\``,
    `- Qwen comparison trigger: \`${stableJson(inventory.expected.qwenComparisonTrigger)}\``,
  ]) {
    if (ledger.split(expectedHeader).length !== 2) {
      fail(`ledger header diverges from machine inventory: ${expectedHeader}`);
    }
  }
  const anchorMatches = [...ledger.matchAll(/<a id="([^"]+)"><\/a>/g)].map(
    (match) => match[1],
  );
  const anchorCounts = new Map<string, number>();
  for (const anchor of anchorMatches)
    anchorCounts.set(anchor, (anchorCounts.get(anchor) ?? 0) + 1);
  for (const [anchor, count] of anchorCounts) {
    if (count > 1) fail(`duplicate ledger anchor #${anchor}`);
  }
  const expectedAnchors = new Set(
    inventory.items.map((item) => item.ledgerAnchor.slice(1)),
  );
  for (const anchor of expectedAnchors) {
    if (anchorCounts.get(anchor) !== 1) {
      fail(`item requires exactly one matching explicit anchor #${anchor}`);
    }
  }
  for (const anchor of anchorCounts.keys()) {
    if (!expectedAnchors.has(anchor)) fail(`dangling ledger anchor #${anchor}`);
  }

  const records = [
    ...ledger.matchAll(/<pre data-upstream-sync-item="v1">([\s\S]*?)<\/pre>/g),
  ];
  if (records.length !== inventory.items.length) {
    fail("ledger must contain exactly one review record per inventory item");
  }
  const byId = new Map<string, string>();
  for (const match of records) {
    const encoded = htmlUnescape(match[1]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      fail("ledger contains a malformed deterministic review record");
    }
    assertRecord(parsed, "ledger review record");
    assertString(parsed.id, "ledger review record id");
    if (byId.has(parsed.id))
      fail(`duplicate ledger review record for ${parsed.id}`);
    byId.set(parsed.id, encoded);
  }
  for (const item of inventory.items) {
    const actual = byId.get(item.id);
    if (actual !== stableJson(reviewRecord(item))) {
      fail(
        `ledger review record diverges from machine inventory for ${item.id}`,
      );
    }
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function validateGitDerivation(inventory: SyncInventory, repo: string): void {
  const regenerated = deriveGitState({
    repo,
    forkParent: inventory.baseline.forkParent,
    requiredAncestors: inventory.baseline.requiredAncestors,
    target: inventory.baseline.target,
    canonicalTag: inventory.baseline.canonicalTag,
  });
  for (const field of [
    "forkParent",
    "requiredAncestors",
    "target",
    "canonicalTag",
    "peeledTag",
    "mergeBase",
    "rawCounts",
    "cherryPickCounts",
    "versions",
  ] as const) {
    if (!sameJson(inventory.baseline[field], regenerated.baseline[field])) {
      fail(`recorded baseline.${field} diverges from regenerated Git evidence`);
    }
  }
  if (!sameJson(inventory.derivation, regenerated.derivation)) {
    fail("recorded derivation contract diverges from the algorithm version");
  }
  for (const field of [
    "upstreamCommits",
    "conflicts",
    "sharedPaths",
    "qwenComparisonTrigger",
  ] as const) {
    if (!sameJson(inventory.expected[field], regenerated.expected[field])) {
      fail(`recorded expected.${field} diverges from regenerated Git evidence`);
    }
  }
}

function validateBaseline(inventory: SyncInventory): void {
  assertRecord(inventory.baseline, "baseline");
  for (const field of [
    "forkParent",
    "target",
    "peeledTag",
    "mergeBase",
  ] as const) {
    assertSha(inventory.baseline[field], `baseline.${field}`);
  }
  assertStringArray(
    inventory.baseline.requiredAncestors,
    "baseline.requiredAncestors",
  );
  if (inventory.baseline.requiredAncestors.length === 0) {
    fail(
      "baseline.requiredAncestors must contain at least one required ancestor",
    );
  }
  const requiredAncestors = new Set<string>();
  for (const ancestor of inventory.baseline.requiredAncestors) {
    assertSha(ancestor, "baseline required ancestor");
    if (requiredAncestors.has(ancestor)) {
      fail(`duplicate required fork-parent ancestor ${ancestor}`);
    }
    requiredAncestors.add(ancestor);
  }
  if (
    !sameJson(
      inventory.baseline.requiredAncestors,
      [...inventory.baseline.requiredAncestors].sort(),
    )
  ) {
    fail("baseline.requiredAncestors must be deterministically sorted");
  }
  assertNonEmpty(inventory.baseline.canonicalTag, "baseline.canonicalTag");
  if (
    !inventory.baseline.canonicalTag.startsWith("refs/tags/") ||
    /[\0\n\r ]/.test(inventory.baseline.canonicalTag)
  ) {
    fail("baseline.canonicalTag must be an explicit safe refs/tags ref");
  }
  for (const [label, counts] of [
    ["rawCounts", inventory.baseline.rawCounts],
    ["cherryPickCounts", inventory.baseline.cherryPickCounts],
  ] as const) {
    assertRecord(counts, `baseline.${label}`);
    if (
      !Number.isSafeInteger(counts.left) ||
      counts.left < 0 ||
      !Number.isSafeInteger(counts.right) ||
      counts.right < 0
    ) {
      fail(`baseline.${label} must contain non-negative integers`);
    }
  }
  assertRecord(inventory.baseline.versions, "baseline.versions");
  for (const side of ["fork", "target"] as const) {
    assertRecord(
      inventory.baseline.versions[side],
      `baseline.versions.${side}`,
    );
    assertNonEmpty(
      inventory.baseline.versions[side].root,
      `baseline.versions.${side}.root`,
    );
    assertNonEmpty(
      inventory.baseline.versions[side].cli,
      `baseline.versions.${side}.cli`,
    );
  }
  assertRecord(inventory.derivation, "derivation");
  for (const field of [
    "algorithmVersion",
    "upstreamCommitOrder",
    "pathSemantics",
    "conflictMechanism",
  ] as const) {
    assertNonEmpty(inventory.derivation[field], `derivation.${field}`);
  }
  if (inventory.derivation.algorithmVersion !== ALGORITHM_VERSION) {
    fail(
      `unknown derivation algorithm version ${inventory.derivation.algorithmVersion}`,
    );
  }
}

function normalizedApplications(applications: RerereApplication[]): string[] {
  return applications
    .map((entry) => {
      assertSafePath(entry.path, "observed rerere path");
      assertSha256(entry.preimageSha256, "observed rerere preimage SHA-256");
      return `${entry.path}:${entry.preimageSha256}`;
    })
    .sort();
}

export function validateSyncInventory(
  inventory: SyncInventory,
  ledger: string,
  options: ValidationOptions = {},
): void {
  assertRecord(inventory, "inventory");
  if (inventory.schemaVersion !== SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!PHASES.includes(inventory.phase as never))
    fail(`unknown phase: ${String(inventory.phase)}`);
  validateBaseline(inventory);
  validateExpected(inventory);
  validateEvidenceCatalog(inventory);
  if (!Array.isArray(inventory.items)) fail("items must be an array");
  if (inventory.phase === "final") {
    if (!options.observedRerereApplications) {
      fail("final validation requires an authoritative rerere capture");
    }
    if (
      !sameJson(
        normalizedApplications(inventory.expected.rerereCapture.applications),
        normalizedApplications(options.observedRerereApplications),
      )
    ) {
      fail(
        "final inventory does not exactly match the authoritative rerere capture",
      );
    }
    if (inventory.expected.rerereCapture.state !== "complete") {
      fail(
        "final validation requires a complete authoritative rerere capture state",
      );
    }
  }
  const ids = new Set<string>();
  const sources = new Set<string>();
  const anchors = new Set<string>();
  for (const item of inventory.items) {
    if (ids.has(item.id)) fail(`duplicate canonical id ${item.id}`);
    ids.add(item.id);
  }
  for (const item of inventory.items) {
    if (!KINDS.includes(item.kind as never)) continue;
    const source = itemSourceKey(item);
    if (sources.has(source)) fail(`duplicate normalized source ${source}`);
    sources.add(source);
  }
  for (const item of inventory.items) {
    validateItem(inventory, item);
    if (anchors.has(item.ledgerAnchor))
      fail(`duplicate inventory ledger anchor ${item.ledgerAnchor}`);
    anchors.add(item.ledgerAnchor);
  }
  compareExpectedItems(inventory);
  validateLedger(inventory, ledger);
  if (!options.skipGitDerivation) {
    validateGitDerivation(inventory, options.repo ?? process.cwd());
  }
}

function parseArgs(args: string[]): {
  command: string;
  values: Map<string, string>;
} {
  const command = args[0] ?? "";
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid CLI argument near ${key ?? "<end>"}`);
    }
    if (values.has(key)) fail(`duplicate CLI argument ${key}`);
    values.set(key, value);
  }
  return { command, values };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) fail(`missing required ${key}`);
  return value;
}

function assertAllowedArgs(
  values: Map<string, string>,
  allowed: string[],
): void {
  for (const key of values.keys()) {
    if (!allowed.includes(key)) fail(`unknown CLI argument ${key}`);
  }
}

function loadRerereCapture(path: string): RerereApplication[] {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(value)) fail("rerere capture file must contain an array");
  return value as RerereApplication[];
}

export function runCli(args = process.argv.slice(2)): void {
  const { command, values } = parseArgs(args);
  if (command === "generate") {
    assertAllowedArgs(values, [
      "--repo",
      "--fork-parent",
      "--required-ancestor",
      "--target",
      "--tag",
      "--inventory",
      "--ledger",
    ]);
    const inventoryPath = resolve(required(values, "--inventory"));
    const ledgerPath = resolve(required(values, "--ledger"));
    const inventory = generateSyncInventory({
      repo: resolve(values.get("--repo") ?? process.cwd()),
      forkParent: required(values, "--fork-parent"),
      requiredAncestors: [required(values, "--required-ancestor")],
      target: required(values, "--target"),
      canonicalTag: required(values, "--tag"),
    });
    writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
    writeFileSync(ledgerPath, renderLedger(inventory));
    process.stdout.write(
      `generated ${inventory.items.length} items in ${relative(process.cwd(), inventoryPath)} and ${relative(process.cwd(), ledgerPath)}\n`,
    );
    return;
  }
  if (command === "check") {
    assertAllowedArgs(values, [
      "--repo",
      "--inventory",
      "--ledger",
      "--rerere-capture",
    ]);
    const inventoryPath = resolve(required(values, "--inventory"));
    const ledgerPath = resolve(required(values, "--ledger"));
    const inventory = JSON.parse(
      readFileSync(inventoryPath, "utf8"),
    ) as SyncInventory;
    const capturePath = values.get("--rerere-capture");
    validateSyncInventory(inventory, readFileSync(ledgerPath, "utf8"), {
      repo: resolve(values.get("--repo") ?? process.cwd()),
      observedRerereApplications: capturePath
        ? loadRerereCapture(capturePath)
        : undefined,
    });
    process.stdout.write(
      `validated ${inventory.items.length} inventory items\n`,
    );
    return;
  }
  fail(
    "usage: verify-upstream-sync-ledger.ts <generate|check> --inventory <path> --ledger <path> [options]",
  );
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
