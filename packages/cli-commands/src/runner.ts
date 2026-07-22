import { parseArgs } from "node:util";
import { Config } from "@better-ccflare/config";
import { shutdown } from "@better-ccflare/core";
import { container, SERVICE_KEYS } from "@better-ccflare/core-di";
import type { ComboFamily } from "@better-ccflare/types";
import type { CreatedAccountIdentity } from "./commands/account";
import { getHelpText } from "./commands/help";
import {
	createManagedAccountRoutingReviewedSelection,
	formatManagedRoutingReport,
	type ManagedRoutingPreviewReport,
	type ManagedRoutingReport,
	runManagedAccountRoutingApply,
	runManagedAccountRoutingPreview,
	runManagedRoutingApply,
	runManagedRoutingDetail,
	runManagedRoutingList,
	runManagedRoutingManualRollback,
	runManagedRoutingPreview,
} from "./commands/managed-routing";
import {
	createManagedRoutingClient,
	type ManagedRoutingClientEnvironment,
	type ManagedRoutingControlPlane,
} from "./commands/managed-routing-client";
import type { PromptAdapter } from "./prompts/adapter";
import { stdPromptAdapter } from "./prompts/std-adapter";

const MANAGED_ROUTING_FAMILIES = new Set<ComboFamily>([
	"fable",
	"opus",
	"sonnet",
	"haiku",
]);

interface ManagedRoutingCliBaseCommand {
	apiUrl?: string;
	json: boolean;
}

export type ManagedRoutingCliCommand =
	| (ManagedRoutingCliBaseCommand & { action: "list" })
	| (ManagedRoutingCliBaseCommand & {
			action: "detail";
			accountId: string;
	  })
	| (ManagedRoutingCliBaseCommand & {
			action: "preview";
			family: ComboFamily;
			managedModel?: string;
	  })
	| (ManagedRoutingCliBaseCommand & {
			action: "apply";
			family: ComboFamily;
			previewId?: string;
			proposalId?: string;
			managedModel?: string;
			confirmed?: true;
	  })
	| (ManagedRoutingCliBaseCommand & {
			action: "manual";
			family: ComboFamily;
			confirmed?: true;
	  });

export class ManagedRoutingCliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManagedRoutingCliUsageError";
	}
}

export interface ParseManagedRoutingCliOptions {
	interactive?: boolean;
}

function requiredOptionValue(
	args: string[],
	index: number,
	flag: string,
): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new ManagedRoutingCliUsageError(`${flag} requires a value.`);
	}
	return value;
}

function parseFamily(value: string | undefined): ComboFamily {
	if (!value || !MANAGED_ROUTING_FAMILIES.has(value as ComboFamily)) {
		throw new ManagedRoutingCliUsageError(
			"Routing family must be one of: fable, opus, sonnet, haiku.",
		);
	}
	return value as ComboFamily;
}

/**
 * Strict parser shared by the packaged flag CLI and the legacy command runner.
 * It returns null for non-routing commands and rejects every unknown routing
 * token so mutation flags cannot be silently ignored.
 */
export function parseManagedRoutingCliCommand(
	args: string[],
	options: ParseManagedRoutingCliOptions = {},
): ManagedRoutingCliCommand | null {
	if (args[0] !== "routing") return null;

	const actionValue = args[1];
	if (
		!new Set(["list", "detail", "preview", "apply", "manual"]).has(actionValue)
	) {
		throw new ManagedRoutingCliUsageError(
			"Routing action must be one of: list, detail, preview, apply, manual.",
		);
	}
	const action = actionValue as ManagedRoutingCliCommand["action"];

	const subject = args[2];
	if (!subject && action !== "list") {
		throw new ManagedRoutingCliUsageError(
			`${action} requires ${action === "detail" ? "an account ID" : "a family"}.`,
		);
	}
	if (action !== "list" && subject?.startsWith("--")) {
		throw new ManagedRoutingCliUsageError(
			`${action} requires ${action === "detail" ? "an account ID" : "a family"}.`,
		);
	}

	let apiUrl: string | undefined;
	let managedModel: string | undefined;
	let previewId: string | undefined;
	let proposalId: string | undefined;
	let confirmed: true | undefined;
	let json = false;
	const optionStart = action === "list" ? 2 : 3;
	const seenOptions = new Set<string>();
	for (let index = optionStart; index < args.length; index++) {
		const flag = args[index];
		if (seenOptions.has(flag)) {
			throw new ManagedRoutingCliUsageError(
				`Routing option may be supplied only once: ${flag}`,
			);
		}
		seenOptions.add(flag);
		switch (flag) {
			case "--api-url":
				apiUrl = requiredOptionValue(args, index, flag);
				index += 1;
				break;
			case "--managed-model":
				managedModel = requiredOptionValue(args, index, flag);
				index += 1;
				break;
			case "--preview-id":
				previewId = requiredOptionValue(args, index, flag);
				index += 1;
				break;
			case "--proposal-id":
				proposalId = requiredOptionValue(args, index, flag);
				index += 1;
				break;
			case "--yes":
				confirmed = true;
				break;
			case "--json":
				json = true;
				break;
			default:
				throw new ManagedRoutingCliUsageError(
					`Unknown routing option: ${flag}`,
				);
		}
	}

	const common = { ...(apiUrl ? { apiUrl } : {}), json };
	if (action === "list") {
		if (managedModel || previewId || proposalId || confirmed) {
			throw new ManagedRoutingCliUsageError(
				"routing list accepts only --api-url and --json.",
			);
		}
		return { action, ...common };
	}
	if (action === "detail") {
		if (managedModel || previewId || proposalId || confirmed) {
			throw new ManagedRoutingCliUsageError(
				"routing detail accepts only --api-url and --json.",
			);
		}
		return { action, accountId: subject, ...common };
	}

	const family = parseFamily(subject);
	if (action === "preview") {
		if (previewId || proposalId || confirmed) {
			throw new ManagedRoutingCliUsageError(
				"routing preview accepts only --managed-model, --api-url, and --json.",
			);
		}
		return {
			action,
			family,
			...(managedModel ? { managedModel } : {}),
			...common,
		};
	}
	if (action === "manual") {
		if (managedModel || previewId || proposalId) {
			throw new ManagedRoutingCliUsageError(
				"routing manual accepts only --yes, --api-url, and --json.",
			);
		}
		if ((!options.interactive || json) && !confirmed) {
			throw new ManagedRoutingCliUsageError(
				"Unattended manual rollback requires --yes.",
			);
		}
		return { action, family, ...(confirmed ? { confirmed } : {}), ...common };
	}

	const hasTupleIdentifier = Boolean(previewId || proposalId);
	const hasCompleteTuple = Boolean(previewId && proposalId && managedModel);
	if (hasTupleIdentifier && !hasCompleteTuple) {
		throw new ManagedRoutingCliUsageError(
			"Routing apply requires the complete --preview-id, --proposal-id, and --managed-model tuple.",
		);
	}
	if ((!options.interactive || json) && (!hasCompleteTuple || !confirmed)) {
		throw new ManagedRoutingCliUsageError(
			"Unattended routing apply requires --preview-id, --proposal-id, --managed-model, and --yes.",
		);
	}
	if (options.interactive && !json && hasCompleteTuple && !confirmed) {
		throw new ManagedRoutingCliUsageError(
			"A complete reviewed preview/proposal/model tuple requires --yes; omit the tuple to run the interactive review flow.",
		);
	}
	if (confirmed && !hasCompleteTuple) {
		throw new ManagedRoutingCliUsageError(
			"--yes requires a complete reviewed preview/proposal/model tuple.",
		);
	}
	return {
		action,
		family,
		...(previewId ? { previewId } : {}),
		...(proposalId ? { proposalId } : {}),
		...(managedModel ? { managedModel } : {}),
		...(confirmed ? { confirmed } : {}),
		...common,
	};
}

export interface ExecuteManagedRoutingCliOptions {
	client?: ManagedRoutingControlPlane;
	interactive?: boolean;
	prompt?: PromptAdapter;
	onReviewOutput?: (output: string) => void | Promise<void>;
}

export interface ManagedRoutingCliExecutionResult {
	exitCode: 0 | 2;
	output: string;
}

export async function executeManagedRoutingCliCommand(
	command: ManagedRoutingCliCommand,
	options: ExecuteManagedRoutingCliOptions = {},
): Promise<ManagedRoutingCliExecutionResult> {
	let client = options.client;
	if (!client) {
		try {
			client = createManagedRoutingClient({
				...(command.apiUrl ? { baseUrl: command.apiUrl } : {}),
			});
		} catch (error) {
			throw new ManagedRoutingCliUsageError(
				error instanceof Error
					? error.message
					: "Managed-routing API configuration is invalid.",
			);
		}
	}

	const interactive = options.interactive ?? false;
	const prompt = options.prompt ?? (interactive ? stdPromptAdapter : undefined);
	const format = command.json ? "json" : "text";
	let report: ManagedRoutingReport;
	switch (command.action) {
		case "list":
			report = await runManagedRoutingList(client);
			break;
		case "detail":
			report = await runManagedRoutingDetail(client, command.accountId);
			break;
		case "preview":
			report = await runManagedRoutingPreview(client, {
				family: command.family,
				...(command.managedModel ? { managedModel: command.managedModel } : {}),
			});
			break;
		case "apply":
			report = await runManagedRoutingApply(client, {
				family: command.family,
				...(command.previewId ? { previewId: command.previewId } : {}),
				...(command.proposalId ? { proposalId: command.proposalId } : {}),
				...(command.managedModel ? { managedModel: command.managedModel } : {}),
				...(command.confirmed ? { confirmed: command.confirmed } : {}),
				nonInteractive: !interactive,
				json: command.json,
				...(prompt ? { prompt } : {}),
				review: async (preview: ManagedRoutingPreviewReport) => {
					const rendered = formatManagedRoutingReport(preview, format);
					if (options.onReviewOutput) {
						await options.onReviewOutput(rendered);
					} else {
						console.log(rendered);
					}
				},
			});
			break;
		case "manual":
			report = await runManagedRoutingManualRollback(client, {
				family: command.family,
				...(command.confirmed ? { confirmed: command.confirmed } : {}),
				nonInteractive: !interactive,
				json: command.json,
				...(prompt ? { prompt } : {}),
			});
			break;
	}

	const output = formatManagedRoutingReport(report, format);
	return {
		exitCode: "status" in report && report.status === "declined" ? 2 : 0,
		output,
	};
}

export interface PostCreateManagedRoutingIo {
	stdout(message: string): void;
	stderr(message: string): void;
}

export interface PostCreateManagedRoutingOptions {
	identity: CreatedAccountIdentity;
	interactive: boolean;
	json: boolean;
	apiUrl?: string;
	client?: ManagedRoutingControlPlane;
	prompt?: PromptAdapter;
	io?: PostCreateManagedRoutingIo;
}

function postCreateRoutingGuidance(
	identity: CreatedAccountIdentity,
	apiUrl?: string,
): string[] {
	const apiUrlSuffix = apiUrl ? ` --api-url ${apiUrl}` : "";
	return [
		`Inspect this persisted account: better-ccflare routing detail ${identity.id}${apiUrlSuffix}`,
		`Review a family before applying: better-ccflare routing preview <family>${apiUrlSuffix}`,
	];
}

/**
 * Bridge a newly persisted immutable account identity into the live routing
 * control plane. Automated text callers receive authoritative exact-ID detail
 * plus guidance without any preview or write. Interactive callers explicitly
 * select proposals from a complete preview before the orchestrator freshly
 * re-previews, revalidates, confirms, and applies each family.
 */
export async function handlePostCreateManagedRouting(
	options: PostCreateManagedRoutingOptions,
): Promise<0 | 1 | 2> {
	const io = options.io ?? {
		stdout: (message: string) => console.log(message),
		stderr: (message: string) => console.error(message),
	};
	if (!options.json) {
		io.stdout(
			`Created account ${options.identity.name} with immutable ID ${options.identity.id}.`,
		);
	}

	let client = options.client;
	let guidanceApiUrl: string | undefined;
	if (options.apiUrl) {
		try {
			const configuredClient = createManagedRoutingClient({
				baseUrl: options.apiUrl,
			});
			client ??= configuredClient;
			guidanceApiUrl = new URL(options.apiUrl).origin;
		} catch (error) {
			io.stderr(
				error instanceof Error
					? error.message
					: "Managed-routing API configuration is invalid.",
			);
			return 2;
		}
	}
	const guidance = postCreateRoutingGuidance(options.identity, guidanceApiUrl);

	if (options.json) {
		io.stdout(
			JSON.stringify(
				{
					kind: "account-created",
					account: {
						id: options.identity.id,
						name: options.identity.name,
						provider: options.identity.provider,
					},
					routing: { status: "not-applied", guidance },
				},
				null,
				2,
			),
		);
		return 0;
	}
	if (!options.interactive) {
		try {
			client ??= createManagedRoutingClient({
				...(options.apiUrl ? { baseUrl: options.apiUrl } : {}),
			});
			const detail = await runManagedRoutingDetail(client, options.identity.id);
			io.stdout(formatManagedRoutingReport(detail, "text"));
		} catch {
			io.stderr(
				"Post-create effective routing report is incomplete: the account was persisted, but its authoritative live routing state could not be read.",
			);
			for (const line of guidance) io.stdout(line);
			return 1;
		}
		for (const line of guidance) io.stdout(line);
		return 0;
	}

	if (!client) {
		try {
			client = createManagedRoutingClient({
				...(options.apiUrl ? { baseUrl: options.apiUrl } : {}),
			});
		} catch (error) {
			io.stderr(
				error instanceof Error
					? error.message
					: "Managed-routing API configuration is invalid.",
			);
			for (const line of guidance) io.stdout(line);
			return 2;
		}
	}
	const prompt = options.prompt;
	if (!prompt) {
		io.stderr(
			"Interactive post-create routing review requires a prompt adapter.",
		);
		for (const line of guidance) io.stdout(line);
		return 2;
	}

	try {
		const preview = await runManagedAccountRoutingPreview(client, {
			accountId: options.identity.id,
		});
		io.stdout(formatManagedRoutingReport(preview, "text"));

		const selections = [];
		for (const familyPreview of preview.previews) {
			if (familyPreview.proposals.length === 0) continue;
			const skip = `__skip_${familyPreview.family}__`;
			const selected = await prompt.select(
				`Select a reviewed ${familyPreview.family} proposal, or skip this family`,
				[
					...familyPreview.proposals.map((proposal) => ({
						label: `${proposal.provider} ${proposal.route_class} model=${proposal.managed_model} tier=${proposal.tier_source} reason=${proposal.reason}`,
						value: proposal.proposal_id,
					})),
					{ label: `Skip ${familyPreview.family}`, value: skip },
				],
			);
			if (selected === skip) continue;
			const proposal = familyPreview.proposals.find(
				(candidate) => candidate.proposal_id === selected,
			);
			if (!proposal) {
				throw new Error(
					"The selected proposal was not present in the reviewed live preview.",
				);
			}
			selections.push(
				createManagedAccountRoutingReviewedSelection(
					familyPreview,
					proposal.proposal_id,
				),
			);
		}

		if (selections.length === 0) {
			io.stdout("No routing proposal selected; no routing write was sent.");
			for (const line of guidance) io.stdout(line);
			return 0;
		}

		const applied = await runManagedAccountRoutingApply(client, {
			accountId: options.identity.id,
			selections,
			prompt,
			review: async (current) => {
				io.stdout(formatManagedRoutingReport(current, "text"));
			},
		});
		io.stdout(formatManagedRoutingReport(applied, "text"));
		if (applied.status === "applied") return 0;
		if (applied.status === "declined") return 2;
		return 1;
	} catch (error) {
		io.stderr(
			`Managed-routing review failed closed: ${
				error instanceof Error
					? error.message
					: "The live control plane is unavailable."
			}`,
		);
		for (const line of guidance) io.stdout(line);
		return 1;
	}
}

export function parseLegacyCliArguments(args: string[]) {
	return parseArgs({
		args,
		strict: false,
		options: {
			"api-url": { type: "string" },
			mode: { type: "string" },
			priority: { type: "string" },
			modelMappings: { type: "string" },
			force: { type: "boolean" },
		},
	});
}

export function preflightPostCreateManagedRouting(options: {
	interactive: boolean;
	apiUrl?: string;
	env?: ManagedRoutingClientEnvironment;
}): void {
	if (!options.interactive && !options.apiUrl) return;
	createManagedRoutingClient({
		...(options.apiUrl ? { baseUrl: options.apiUrl } : {}),
		...(options.env ? { env: options.env } : {}),
	});
}

/**
 * Main CLI runner
 */
export async function runCli(argv: string[]): Promise<void> {
	const cliArgs = argv.slice(2);
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	let routingCommand: ManagedRoutingCliCommand | null;
	try {
		routingCommand = parseManagedRoutingCliCommand(cliArgs, { interactive });
	} catch (error) {
		console.error(
			`Error: ${error instanceof Error ? error.message : "Invalid routing arguments."}`,
		);
		process.exit(2);
	}

	if (routingCommand) {
		try {
			const result = await executeManagedRoutingCliCommand(routingCommand, {
				interactive,
				onReviewOutput: (output) => console.log(output),
			});
			console.log(result.output);
			process.exit(result.exitCode);
		} catch (error) {
			console.error(
				`Error: ${error instanceof Error ? error.message : "Managed-routing operation failed."}`,
			);
			process.exit(error instanceof ManagedRoutingCliUsageError ? 2 : 1);
		}
	}
	const [accountCommands, analyzeCommands, statsCommands, tokenCommands] =
		await Promise.all([
			import("./commands/account"),
			import("./commands/analyze"),
			import("./commands/stats"),
			import("./commands/token-health"),
		]);
	const {
		addAccount,
		getAccountsList,
		pauseAccount,
		removeAccountWithConfirmation,
		resumeAccount,
		setAccountPriority,
	} = accountCommands;
	const { analyzePerformance } = analyzeCommands;
	const { clearRequestHistory, resetAllStats } = statsCommands;
	const { checkReauthNeeded, checkTokenHealth } = tokenCommands;

	// Initialize DI container and services
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	const config = container.resolve<Config>(SERVICE_KEYS.Config);
	const { DatabaseFactory } = await import("@better-ccflare/database");
	DatabaseFactory.initialize();
	const dbOps = DatabaseFactory.getInstance();
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	try {
		// Parse command line arguments
		const { positionals, values } = parseLegacyCliArguments(cliArgs);

		const command = positionals[0];

		switch (command) {
			case "add": {
				const name = positionals[1];
				if (!name) {
					console.error("Error: Account name is required");
					console.log(
						"Usage: ccflare-cli add <name> [--mode <claude-oauth|console|codex|qwen|xai|zai|minimax|anthropic-compatible|openai-compatible|nanogpt|kilo|openrouter|ollama|ollama-cloud>] [--priority <number>] [--modelMappings <JSON>] [--api-url <loopback-url>]",
					);
					process.exit(1);
				}
				const apiUrl = values["api-url"];
				try {
					preflightPostCreateManagedRouting({
						interactive,
						...(typeof apiUrl === "string" ? { apiUrl } : {}),
					});
				} catch (error) {
					console.error(
						`Error: ${error instanceof Error ? error.message : "Managed-routing API configuration is invalid."}`,
					);
					process.exit(2);
				}

				// Parse options
				let mode = values.mode as
					| "claude-oauth"
					| "console"
					| "codex"
					| "qwen"
					| "xai"
					| "zai"
					| "minimax"
					| "anthropic-compatible"
					| "openai-compatible"
					| "nanogpt"
					| "vertex-ai"
					| "bedrock"
					| "kilo"
					| "openrouter"
					| "alibaba-coding-plan"
					| "ollama"
					| "ollama-cloud"
					| "max"
					| undefined;

				// Handle deprecated "max" mode with warning
				if (mode === "max") {
					console.warn(
						'⚠️  Mode "max" is deprecated. Please use "claude-oauth" instead.',
					);
					mode = "claude-oauth";
				}
				const priorityValue = values.priority
					? parseInt(values.priority as string, 10)
					: undefined;
				const priority =
					typeof priorityValue === "number" && !Number.isNaN(priorityValue)
						? priorityValue
						: undefined;
				const modelMappingsValue = values.modelMappings as string | undefined;
				let modelMappings: Record<string, string> | undefined;
				if (modelMappingsValue) {
					try {
						modelMappings = JSON.parse(modelMappingsValue);
					} catch (error) {
						console.error(
							`Error parsing model mappings: ${error instanceof Error ? error.message : String(error)}`,
						);
						process.exit(1);
					}
				}

				const createdAccount = await addAccount(dbOps, config, {
					name,
					mode,
					priority,
					modelMappings,
				});
				const postCreateExit = await handlePostCreateManagedRouting({
					identity: createdAccount,
					interactive,
					json: false,
					...(typeof apiUrl === "string" ? { apiUrl } : {}),
					prompt: stdPromptAdapter,
				});
				if (postCreateExit !== 0) process.exit(postCreateExit);
				break;
			}

			case "list": {
				const accounts = await getAccountsList(dbOps);

				if (accounts.length === 0) {
					console.log("No accounts found");
				} else {
					console.log(`\nAccounts (${accounts.length}):`);
					console.log("─".repeat(100));

					// Header
					console.log(
						"Name".padEnd(20) +
							"Type".padEnd(10) +
							"Priority".padEnd(9) +
							"Requests".padEnd(12) +
							"Token".padEnd(10) +
							"Status".padEnd(20) +
							"Session",
					);
					console.log("─".repeat(94));

					// Rows
					for (const account of accounts) {
						console.log(
							account.name.padEnd(20) +
								account.provider.padEnd(10) +
								account.priority.toString().padEnd(9) +
								`${account.requestCount}/${account.totalRequests}`.padEnd(12) +
								account.tokenStatus.padEnd(10) +
								account.rateLimitStatus.padEnd(20) +
								account.sessionInfo,
						);
					}
				}
				break;
			}

			case "remove": {
				const name = positionals[1];
				if (!name) {
					console.error("Error: Account name is required");
					console.log("Usage: ccflare-cli remove <name> [--force]");
					process.exit(1);
				}

				const result = await removeAccountWithConfirmation(
					dbOps,
					name,
					values.force === true,
				);
				console.log(result.message);
				if (!result.success) {
					process.exit(1);
				}
				break;
			}

			case "reset-stats": {
				await resetAllStats(dbOps);
				console.log("Account statistics reset successfully");
				break;
			}

			case "clear-history": {
				const result = await clearRequestHistory(dbOps, config);
				console.log(
					`Cleared ${result.removedPayloads} payloads and ${result.removedRequests} request records`,
				);
				break;
			}

			case "pause": {
				const name = positionals[1];
				if (!name) {
					console.error("Error: Account name is required");
					console.log("Usage: ccflare-cli pause <name>");
					process.exit(1);
				}

				const result = await pauseAccount(dbOps, name);
				console.log(result.message);
				if (!result.success) {
					process.exit(1);
				}
				break;
			}

			case "resume": {
				const name = positionals[1];
				if (!name) {
					console.error("Error: Account name is required");
					console.log("Usage: ccflare-cli resume <name>");
					process.exit(1);
				}

				const result = await resumeAccount(dbOps, name);
				console.log(result.message);
				if (!result.success) {
					process.exit(1);
				}
				break;
			}

			case "set-priority": {
				const name = positionals[1];
				const priorityValue = positionals[2];

				if (!name) {
					console.error("Error: Account name is required");
					console.log("Usage: ccflare-cli set-priority <name> <priority>");
					process.exit(1);
				}

				if (priorityValue === undefined) {
					console.error("Error: Priority value is required");
					console.log("Usage: ccflare-cli set-priority <name> <priority>");
					process.exit(1);
				}

				const priority = parseInt(priorityValue, 10);
				if (Number.isNaN(priority)) {
					console.error("Error: Priority must be a number");
					process.exit(1);
				}

				const result = await setAccountPriority(dbOps, name, priority);
				console.log(result.message);
				if (!result.success) {
					process.exit(1);
				}
				break;
			}

			case "analyze": {
				await analyzePerformance(dbOps);
				break;
			}

			case "token-health": {
				await checkTokenHealth(dbOps);
				break;
			}

			case "reauth-needed": {
				await checkReauthNeeded(dbOps);
				break;
			}

			default: {
				console.log(getHelpText());
				if (command && command !== "help") {
					console.error(`\nError: Unknown command '${command}'`);
					process.exit(1);
				}
				break;
			}
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	} finally {
		// Always shutdown resources
		await shutdown();
	}
}
