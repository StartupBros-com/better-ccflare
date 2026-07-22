import type {
	ComboRoutingPreviewResult,
	DeviceSetupJobView,
	DeviceSetupProvider,
} from "@better-ccflare/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeviceSetupInitRequest } from "../../api";
import { useDeviceSetupJob } from "../../hooks/queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { AccountRoutingPreviewPanel } from "./AccountRoutingPreviewPanel";
import {
	type AccountRoutingOutcome,
	type AccountRoutingSelection,
	type AccountSetupMode,
	buildAccountSetupRoutingDraft,
	defaultRoutingSelections,
	reconcileAccountRoutingSelections,
	routingPreviewsFromPayload,
} from "./account-routing";
import {
	type AccountCreationIdentity,
	type AccountSetupCreationKind,
	type AccountSetupEvent,
	accountSetupCanCancel,
	accountSetupCanCreate,
	createDeviceSetupAttemptKeyStore,
	createInitialAccountSetupState,
	finalizeAccountSetup,
	reduceAccountSetupState,
} from "./account-setup-state";

export type { AccountCreationIdentity } from "./account-setup-state";

export interface AccountModelMappingFields {
	fableModel: string;
	opusModel: string;
	sonnetModel: string;
	haikuModel: string;
}

/** Build only the provider model mappings; account credentials never enter it. */
export function buildAccountModelMappings(
	fields: AccountModelMappingFields,
): Record<string, string> {
	const mappings: Record<string, string> = {};
	if (fields.fableModel) mappings.fable = fields.fableModel;
	if (fields.opusModel) mappings.opus = fields.opusModel;
	if (fields.sonnetModel) mappings.sonnet = fields.sonnetModel;
	if (fields.haikuModel) mappings.haiku = fields.haikuModel;
	return mappings;
}

/** Copy the exact durable setup command; secrets and draft-only fields stay local. */
export function buildDeviceSetupInitCommand(
	input: DeviceSetupInitRequest,
): DeviceSetupInitRequest {
	return {
		name: input.name,
		priority: input.priority,
		idempotencyKey: input.idempotencyKey,
		reviewed: input.reviewed.map(({ family, proposalId }) => ({
			family,
			proposalId,
		})),
	};
}

interface AccountAddFormProps {
	onAddAccount: (params: {
		name: string;
		mode:
			| "claude-oauth"
			| "console"
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
			| "codex"
			| "qwen"
			| "ollama";
		priority: number;
		customEndpoint?: string;
	}) => Promise<{ authUrl: string; sessionId: string }>;
	onCompleteAccount: (params: {
		sessionId: string;
		code: string;
	}) => Promise<AccountCreationIdentity>;
	onAddZaiAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<AccountCreationIdentity>;
	onAddMinimaxAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
	}) => Promise<AccountCreationIdentity>;
	onAddAnthropicCompatibleAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<AccountCreationIdentity>;
	onAddNanoGPTAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<AccountCreationIdentity>;
	onAddOpenAIAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<AccountCreationIdentity>;
	onAddVertexAIAccount: (params: {
		name: string;
		projectId: string;
		region: string;
		priority: number;
	}) => Promise<AccountCreationIdentity>;
	onAddBedrockAccount: (params: {
		name: string;
		profile: string;
		region: string;
		priority: number;
		cross_region_mode?: "geographic" | "global" | "regional";
		customModel?: string;
	}) => Promise<AccountCreationIdentity>;
	onAddAlibabaCodingPlanAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => Promise<AccountCreationIdentity>;
	onAddKiloAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => Promise<AccountCreationIdentity>;
	onAddOpenRouterAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => Promise<AccountCreationIdentity>;
	onAddOllamaAccount: (params: {
		name: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<AccountCreationIdentity>;
	onAddOllamaCloudAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => Promise<AccountCreationIdentity>;
	onCancel: () => void;
	onSuccess: (identity: AccountCreationIdentity) => void;
	onRoutingChanged: (
		identity: AccountCreationIdentity,
		outcomes: readonly AccountRoutingOutcome[],
	) => void | Promise<void>;
	onError: (error: string) => void;
}

export function AccountAddForm({
	onAddAccount,
	onCompleteAccount,
	onAddZaiAccount,
	onAddMinimaxAccount,
	onAddAnthropicCompatibleAccount,
	onAddNanoGPTAccount,
	onAddOpenAIAccount,
	onAddVertexAIAccount,
	onAddBedrockAccount,
	onAddAlibabaCodingPlanAccount,
	onAddKiloAccount,
	onAddOpenRouterAccount,
	onAddOllamaAccount,
	onAddOllamaCloudAccount,
	onCancel,
	onSuccess,
	onRoutingChanged,
	onError,
}: AccountAddFormProps) {
	const [authStep, setAuthStep] = useState<"form" | "code">("form");
	const [authCode, setAuthCode] = useState("");
	const [sessionId, setSessionId] = useState("");
	const [newAccount, setNewAccount] = useState({
		name: "",
		mode: "claude-oauth" as
			| "claude-oauth"
			| "console"
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
			| "codex"
			| "qwen"
			| "ollama"
			| "ollama-cloud",
		priority: 0,
		apiKey: "",
		customEndpoint: "",
		projectId: "",
		region: "global",
		profile: "",
		awsRegion: "",
		crossRegionMode: "geographic" as "geographic" | "global" | "regional",
		customBedrockModel: "",
		fableModel: "",
		opusModel: "",
		sonnetModel: "",
		haikuModel: "",
	});
	const currentRoutingDraft = buildAccountSetupRoutingDraft({
		mode: newAccount.mode as AccountSetupMode,
		priority: newAccount.priority,
		modelMappings: buildAccountModelMappings(newAccount),
	});
	const currentRoutingDraftKey = JSON.stringify(currentRoutingDraft);
	const [routingPreviews, setRoutingPreviews] = useState<
		ComboRoutingPreviewResult[]
	>([]);
	const [routingSelections, setRoutingSelections] = useState<
		AccountRoutingSelection[]
	>([]);
	const [routingLoading, setRoutingLoading] = useState(false);
	const [accountSetupState, setAccountSetupState] = useState(
		createInitialAccountSetupState,
	);
	const accountSetupStateRef = useRef(accountSetupState);
	const transitionAccountSetup = useCallback((event: AccountSetupEvent) => {
		const previous = accountSetupStateRef.current;
		const next = reduceAccountSetupState(previous, event);
		if (next !== previous) {
			accountSetupStateRef.current = next;
			setAccountSetupState(next);
		}
		return { previous, next };
	}, []);
	const {
		stage: routingStage,
		outcomes: routingOutcomes,
		previewDraftKey: routingPreviewDraftKey,
		reviewed: routingReviewed,
		error: routingError,
		createdAccountId,
	} = accountSetupState;
	const createdIdentity = createdAccountId
		? { accountId: createdAccountId }
		: null;

	// Qwen device flow state
	const [qwenStep, setQwenStep] = useState<
		"idle" | "pending" | "complete" | "error"
	>("idle");
	const [qwenAuthUrl, setQwenAuthUrl] = useState("");
	const [qwenUserCode, setQwenUserCode] = useState("");
	const [qwenError, setQwenError] = useState("");

	// Codex device flow state
	const [codexStep, setCodexStep] = useState<
		"idle" | "pending" | "complete" | "error"
	>("idle");
	const [codexVerificationUrl, setCodexVerificationUrl] = useState("");
	const [codexUserCode, setCodexUserCode] = useState("");
	const [codexError, setCodexError] = useState("");
	const deviceSetupAttemptKeysRef = useRef(createDeviceSetupAttemptKeyStore());
	const [activeDeviceSetup, setActiveDeviceSetup] = useState<{
		provider: DeviceSetupProvider;
		jobId: string;
		initialJob: DeviceSetupJobView;
	} | null>(null);
	const deviceSetupQuery = useDeviceSetupJob(activeDeviceSetup?.jobId ?? null);
	const observedDeviceJob =
		deviceSetupQuery.data ?? activeDeviceSetup?.initialJob ?? null;

	const [awsProfiles, setAwsProfiles] = useState<
		Array<{ name: string; region: string | null }>
	>([]);
	const [loadingProfiles, setLoadingProfiles] = useState(false);

	// Any routing-relevant edit invalidates the reviewed server snapshot. Secret,
	// endpoint, and mutable-name edits are intentionally absent from the key.
	useEffect(() => {
		if (routingPreviewDraftKey === currentRoutingDraftKey) return;
		const { previous, next } = transitionAccountSetup({
			type: "draft-changed",
			draftKey: currentRoutingDraftKey,
		});
		if (next === previous) return;
		deviceSetupAttemptKeysRef.current.reset();
		setRoutingPreviews([]);
		setRoutingSelections([]);
	}, [currentRoutingDraftKey, routingPreviewDraftKey, transitionAccountSetup]);

	useEffect(() => {
		if (
			!activeDeviceSetup ||
			!observedDeviceJob ||
			observedDeviceJob.id !== activeDeviceSetup.jobId
		) {
			return;
		}
		transitionAccountSetup({
			type: "device-job-updated",
			job: observedDeviceJob,
		});
		const terminalSuccess =
			observedDeviceJob.status === "complete" ||
			observedDeviceJob.status === "complete_with_actions";
		const terminalRetry =
			observedDeviceJob.status === "authorization_error" ||
			observedDeviceJob.status === "expired";
		if (activeDeviceSetup.provider === "qwen") {
			if (terminalSuccess) setQwenStep("complete");
			if (terminalRetry) {
				setQwenStep("error");
				setQwenError(
					observedDeviceJob.errorMessage ?? "Authorization must be restarted",
				);
			}
		} else {
			if (terminalSuccess) setCodexStep("complete");
			if (terminalRetry) {
				setCodexStep("error");
				setCodexError(
					observedDeviceJob.errorMessage ?? "Authorization must be restarted",
				);
			}
		}
		if (terminalRetry) {
			deviceSetupAttemptKeysRef.current.reset(activeDeviceSetup.provider);
			setActiveDeviceSetup(null);
		}
	}, [activeDeviceSetup, observedDeviceJob, transitionAccountSetup]);

	// Load AWS profiles when bedrock mode is selected
	useEffect(() => {
		if (newAccount.mode === "bedrock") {
			setLoadingProfiles(true);
			api
				.getAwsProfiles()
				.then((profiles) => {
					setAwsProfiles(profiles);
				})
				.catch((error) => {
					console.error("Failed to load AWS profiles:", error);
					setAwsProfiles([]);
				})
				.finally(() => {
					setLoadingProfiles(false);
				});
		}
	}, [newAccount.mode]);

	const validateCustomEndpoint = (endpoint: string): boolean => {
		if (!endpoint) return true; // Empty is fine (use default)
		try {
			new URL(endpoint);
			return true;
		} catch {
			return false;
		}
	};

	const accountDetailsError = (): string | null => {
		if (!newAccount.name) return "Account name is required";
		if (
			newAccount.customEndpoint &&
			!validateCustomEndpoint(newAccount.customEndpoint)
		) {
			return "Custom endpoint must be a valid URL (e.g., https://api.anthropic.com)";
		}
		if (newAccount.mode === "vertex-ai" && !newAccount.projectId) {
			return "Google Cloud Project ID is required for Vertex AI accounts";
		}
		if (newAccount.mode === "bedrock") {
			if (!newAccount.profile)
				return "AWS profile is required for Bedrock accounts";
			if (!newAccount.awsRegion) {
				return "Region not found for selected profile. Configure ~/.aws/config";
			}
		}
		if (!newAccount.apiKey) {
			const apiKeyErrors: Partial<Record<AccountSetupMode, string>> = {
				zai: "API key is required for z.ai accounts",
				minimax: "API key is required for Minimax accounts",
				nanogpt: "API key is required for NanoGPT accounts",
				"anthropic-compatible":
					"API key is required for Anthropic-compatible accounts",
				"openai-compatible":
					"API key is required for OpenAI-compatible accounts",
				kilo: "API key is required for Kilo Gateway accounts",
				openrouter: "API key is required for OpenRouter accounts",
				"alibaba-coding-plan":
					"API key is required for Alibaba Coding Plan accounts",
				"ollama-cloud": "API key is required for Ollama Cloud",
			};
			const message = apiKeyErrors[newAccount.mode];
			if (message) return message;
		}
		if (newAccount.mode === "openai-compatible" && !newAccount.customEndpoint) {
			return "Endpoint URL is required for OpenAI-compatible accounts";
		}
		return null;
	};

	const validateAccountDetails = (): boolean => {
		const message = accountDetailsError();
		if (!message) return true;
		onError(message);
		return false;
	};

	const stopQwenPolling = () => {
		setActiveDeviceSetup((current) =>
			current?.provider === "qwen" ? null : current,
		);
	};

	const stopCodexPolling = () => {
		setActiveDeviceSetup((current) =>
			current?.provider === "codex" ? null : current,
		);
	};

	const enterCreationTransition = (kind: AccountSetupCreationKind) => {
		const { previous, next } = transitionAccountSetup({
			type: "creation-started",
			kind,
		});
		return next !== previous;
	};

	const enterFinalizing = () => {
		const { previous, next } = transitionAccountSetup({
			type: "finalization-started",
		});
		return next !== previous;
	};

	const handleRoutingPreview = async () => {
		if (!validateAccountDetails()) return;

		setRoutingLoading(true);
		transitionAccountSetup({ type: "error-changed", error: null });
		try {
			const draft = currentRoutingDraft;
			const payload = await api.previewRouting({ draft });
			const previews = routingPreviewsFromPayload(payload);
			setRoutingPreviews(previews);
			setRoutingSelections(defaultRoutingSelections(previews));
			transitionAccountSetup({
				type: "preview-loaded",
				draftKey: currentRoutingDraftKey,
			});
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Unable to preview account routing";
			transitionAccountSetup({ type: "error-changed", error: message });
			onError(message);
		} finally {
			setRoutingLoading(false);
		}
	};

	const requireCurrentRoutingReview = (): boolean => {
		if (
			!accountSetupCanCreate(
				accountSetupStateRef.current,
				currentRoutingDraftKey,
			)
		) {
			const message = "Review routing before creating this account";
			transitionAccountSetup({ type: "error-changed", error: message });
			onError(message);
			return false;
		}
		transitionAccountSetup({ type: "error-changed", error: null });
		return true;
	};

	const completeCreatedAccount = async (
		result: {
			accountId?: unknown;
		},
		missingIdentityMessage?: string,
	): Promise<void> => {
		enterFinalizing();
		const finalization = await finalizeAccountSetup({
			result,
			selections: routingSelections,
			missingIdentityMessage,
			onIdentity: (identity) => {
				transitionAccountSetup({
					type: "identity-created",
					accountId: identity.accountId,
				});
			},
			reconcile: (identity, selections) =>
				reconcileAccountRoutingSelections({
					accountId: identity.accountId,
					selections,
					client: api,
				}),
			notify: onRoutingChanged,
		});
		transitionAccountSetup({
			type: "finalization-completed",
			result: finalization,
		});
		for (const message of finalization.reportedErrors) onError(message);
	};

	const handleStartQwenAuth = async () => {
		if (!requireCurrentRoutingReview()) return;
		if (!validateAccountDetails()) return;
		if (!enterCreationTransition("device-flow")) return;
		setQwenStep("pending");
		setQwenError("");
		try {
			const idempotencyKey = deviceSetupAttemptKeysRef.current.get("qwen");
			const reviewed = routingSelections;
			const result = await api.initQwenDeviceFlow(
				buildDeviceSetupInitCommand({
					name: newAccount.name,
					priority: newAccount.priority,
					idempotencyKey,
					reviewed,
				}),
			);
			setActiveDeviceSetup({
				provider: "qwen",
				jobId: result.job.id,
				initialJob: result.job,
			});
			if (result.authorization) {
				setQwenAuthUrl(result.authorization.verificationUrl);
				setQwenUserCode(result.authorization.userCode);
				if (typeof window !== "undefined") {
					window.open(result.authorization.verificationUrl, "_blank");
				}
			}
		} catch (err) {
			setQwenStep("error");
			const error =
				err instanceof Error ? err.message : "Failed to start authentication";
			setQwenError(error);
			transitionAccountSetup({
				type: "creation-failed",
				error,
				retryStage: "review",
			});
		}
	};

	const handleStartCodexAuth = async () => {
		if (!requireCurrentRoutingReview()) return;
		if (!validateAccountDetails()) return;
		if (!enterCreationTransition("device-flow")) return;
		setCodexStep("pending");
		setCodexError("");
		try {
			const idempotencyKey = deviceSetupAttemptKeysRef.current.get("codex");
			const reviewed = routingSelections;
			const result = await api.initCodexDeviceFlow(
				buildDeviceSetupInitCommand({
					name: newAccount.name,
					priority: newAccount.priority,
					idempotencyKey,
					reviewed,
				}),
			);
			setActiveDeviceSetup({
				provider: "codex",
				jobId: result.job.id,
				initialJob: result.job,
			});
			if (result.authorization) {
				setCodexVerificationUrl(result.authorization.verificationUrl);
				setCodexUserCode(result.authorization.userCode);
				if (typeof window !== "undefined") {
					window.open(result.authorization.verificationUrl, "_blank");
				}
			}
		} catch (err) {
			setCodexStep("error");
			const error =
				err instanceof Error ? err.message : "Failed to start authentication";
			setCodexError(error);
			transitionAccountSetup({
				type: "creation-failed",
				error,
				retryStage: "review",
			});
		}
	};

	const handleAddAccount = async () => {
		if (!requireCurrentRoutingReview()) return;
		if (!validateAccountDetails()) return;
		const authorizationCodeFlow =
			newAccount.mode === "claude-oauth" || newAccount.mode === "console";
		if (
			!enterCreationTransition(
				authorizationCodeFlow ? "authorization-code" : "direct",
			)
		) {
			return;
		}

		const accountParams = {
			name: newAccount.name,
			mode: newAccount.mode as
				| "claude-oauth"
				| "console"
				| "zai"
				| "minimax"
				| "anthropic-compatible"
				| "openai-compatible"
				| "bedrock"
				| "kilo"
				| "openrouter"
				| "alibaba-coding-plan",
			priority: newAccount.priority,
			...(newAccount.customEndpoint && {
				customEndpoint: newAccount.customEndpoint.trim(),
			}),
		};

		if (newAccount.mode === "vertex-ai") {
			if (!newAccount.projectId) {
				onError("Google Cloud Project ID is required for Vertex AI accounts");
				return;
			}
			// For Vertex AI accounts, we don't need OAuth flow
			const identity = await onAddVertexAIAccount({
				name: newAccount.name,
				projectId: newAccount.projectId.trim(),
				region: newAccount.region || "global",
				priority: newAccount.priority,
			});
			// Reset form and signal success
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "bedrock") {
			if (!newAccount.profile) {
				onError("AWS profile is required for Bedrock accounts");
				return;
			}
			if (!newAccount.awsRegion) {
				onError(
					"Region not found for selected profile. Configure ~/.aws/config",
				);
				return;
			}
			// For Bedrock accounts, we don't need OAuth flow
			const identity = await onAddBedrockAccount({
				name: newAccount.name,
				profile: newAccount.profile,
				region: newAccount.awsRegion,
				priority: newAccount.priority,
				cross_region_mode: newAccount.crossRegionMode,
				customModel: newAccount.customBedrockModel || undefined,
			});
			// Reset form and signal success
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "zai") {
			if (!newAccount.apiKey) {
				onError("API key is required for z.ai accounts");
				return;
			}
			// Build model mappings from form fields
			const zaiModelMappings = buildAccountModelMappings(newAccount);
			// For z.ai accounts, we don't need OAuth flow
			const identity = await onAddZaiAccount({
				...accountParams,
				apiKey: newAccount.apiKey,
				...(newAccount.customEndpoint && {
					customEndpoint: newAccount.customEndpoint.trim(),
				}),
				...(Object.keys(zaiModelMappings).length > 0 && {
					modelMappings: zaiModelMappings,
				}),
			});
			// Reset form and signal success
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "minimax") {
			if (!newAccount.apiKey) {
				onError("API key is required for Minimax accounts");
				return;
			}
			// For Minimax accounts, we don't need OAuth flow and use default tier
			const identity = await onAddMinimaxAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
			});
			// Reset form and signal success
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "nanogpt") {
			if (!newAccount.apiKey) {
				onError("API key is required for NanoGPT accounts");
				return;
			}
			// Build model mappings from form fields
			const modelMappings = buildAccountModelMappings(newAccount);
			// For NanoGPT accounts, we don't need OAuth flow
			const identity = await onAddNanoGPTAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint || undefined,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			// Reset form and signal success
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "kilo") {
			if (!newAccount.apiKey) {
				onError("API key is required for Kilo Gateway accounts");
				return;
			}
			const kiloModelMappings = buildAccountModelMappings(newAccount);
			const identity = await onAddKiloAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				modelMappings:
					Object.keys(kiloModelMappings).length > 0
						? kiloModelMappings
						: undefined,
			});
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "alibaba-coding-plan") {
			if (!newAccount.apiKey) {
				onError("API key is required for Alibaba Coding Plan accounts");
				return;
			}
			const modelMappings = buildAccountModelMappings(newAccount);
			const identity = await onAddAlibabaCodingPlanAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "openrouter") {
			if (!newAccount.apiKey) {
				onError("API key is required for OpenRouter accounts");
				return;
			}
			const modelMappings = buildAccountModelMappings(newAccount);
			const identity = await onAddOpenRouterAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "anthropic-compatible") {
			if (!newAccount.apiKey) {
				onError("API key is required for Anthropic-compatible accounts");
				return;
			}
			// Build model mappings object
			const modelMappings = buildAccountModelMappings(newAccount);

			// For Anthropic-compatible accounts, we don't need OAuth flow and use default tier
			const identity = await onAddAnthropicCompatibleAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint || undefined,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			// Reset form and signal success
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "openai-compatible") {
			if (!newAccount.apiKey) {
				onError("API key is required for OpenAI-compatible accounts");
				return;
			}
			if (!newAccount.customEndpoint) {
				onError("Endpoint URL is required for OpenAI-compatible accounts");
				return;
			}

			// Build model mappings object
			const modelMappings = buildAccountModelMappings(newAccount);

			// For OpenAI-compatible accounts, we don't need OAuth flow
			const identity = await onAddOpenAIAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint.trim(),
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});

			// Reset form and signal success
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "ollama") {
			const modelMappings = buildAccountModelMappings(newAccount);

			const identity = await onAddOllamaAccount({
				name: newAccount.name,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint || undefined,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			await completeCreatedAccount(identity);
			return;
		}

		if (newAccount.mode === "ollama-cloud") {
			if (!newAccount.apiKey) {
				onError("API key is required for Ollama Cloud");
				return;
			}
			const modelMappings = buildAccountModelMappings(newAccount);

			const identity = await onAddOllamaCloudAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			await completeCreatedAccount(identity);
			return;
		}

		// Step 1: Initialize OAuth flow for Max/Console accounts
		const { authUrl, sessionId } = await onAddAccount(accountParams);
		setSessionId(sessionId);

		// Open auth URL in new tab
		if (typeof window !== "undefined") {
			window.open(authUrl, "_blank");
		}

		// Move to code entry step
		setAuthStep("code");
	};

	const handleCodeSubmit = async () => {
		const trimmedCode = authCode.trim();
		if (!trimmedCode) {
			onError("Authorization code is required");
			return;
		}
		// Step 2: Complete OAuth flow
		if (!enterFinalizing()) return;
		const identity = await onCompleteAccount({
			sessionId,
			code: trimmedCode,
		});
		await completeCreatedAccount(identity);
		setAuthStep("form");
		setAuthCode("");
		setSessionId("");
	};

	const handleCreationError = (
		error: unknown,
		options: {
			retryStage?: "review" | "creating";
			ambiguousCommit?: boolean;
		} = {},
	) => {
		const { next } = transitionAccountSetup({
			type: "creation-failed",
			error,
			retryStage: options.retryStage,
			ambiguousCommit: options.ambiguousCommit,
		});
		if (next.error) onError(next.error);
	};

	const handleBackToDetails = () => {
		transitionAccountSetup({ type: "back-to-details" });
		deviceSetupAttemptKeysRef.current.reset();
	};

	const handleDone = () => {
		const accountId = accountSetupStateRef.current.createdAccountId;
		const { previous, next } = transitionAccountSetup({ type: "done" });
		if (next === previous || !accountId) return;
		const identity = { accountId };
		stopQwenPolling();
		stopCodexPolling();
		deviceSetupAttemptKeysRef.current.reset();
		setQwenStep("idle");
		setCodexStep("idle");
		setAuthStep("form");
		setAuthCode("");
		setSessionId("");
		setRoutingPreviews([]);
		setRoutingSelections([]);
		setNewAccount({
			name: "",
			mode: "claude-oauth",
			priority: 0,
			apiKey: "",
			customEndpoint: "",
			projectId: "",
			region: "global",
			profile: "",
			awsRegion: "",
			crossRegionMode: "geographic",
			customBedrockModel: "",
			fableModel: "",
			opusModel: "",
			sonnetModel: "",
			haikuModel: "",
		});
		onSuccess(identity);
	};

	const handleCancel = () => {
		const { previous, next } = transitionAccountSetup({ type: "cancelled" });
		if (next === previous) return;
		stopQwenPolling();
		setQwenStep("idle");
		setQwenAuthUrl("");
		setQwenUserCode("");
		setQwenError("");
		stopCodexPolling();
		deviceSetupAttemptKeysRef.current.reset();
		setCodexStep("idle");
		setCodexVerificationUrl("");
		setCodexUserCode("");
		setCodexError("");
		setAuthStep("form");
		setAuthCode("");
		setSessionId("");
		setRoutingPreviews([]);
		setRoutingSelections([]);
		setNewAccount({
			name: "",
			mode: "claude-oauth",
			priority: 0,
			apiKey: "",
			customEndpoint: "",
			projectId: "",
			region: "global",
			profile: "",
			awsRegion: "",
			crossRegionMode: "geographic",
			customBedrockModel: "",
			fableModel: "",
			opusModel: "",
			sonnetModel: "",
			haikuModel: "",
		});
		onCancel();
	};

	return (
		<div className="space-y-4 mb-6 p-4 border rounded-lg">
			<h4 className="font-medium">
				{routingStage === "finalizing"
					? "Finalizing account setup"
					: routingStage === "outcome"
						? "Account routing outcome"
						: authStep === "form"
							? "Add New Account"
							: "Enter Authorization Code"}
			</h4>
			{authStep === "form" &&
				routingStage !== "finalizing" &&
				routingStage !== "outcome" && (
					<>
						<div className="space-y-2">
							<Label htmlFor="name">Account Name</Label>
							<Input
								id="name"
								value={newAccount.name}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									setNewAccount({
										...newAccount,
										name: (e.target as HTMLInputElement).value,
									})
								}
								placeholder="e.g., work-account or user@example.com"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="mode">Mode</Label>
							<Select
								value={newAccount.mode}
								onValueChange={(
									value:
										| "claude-oauth"
										| "console"
										| "zai"
										| "minimax"
										| "anthropic-compatible"
										| "openai-compatible"
										| "bedrock"
										| "kilo"
										| "openrouter"
										| "codex"
										| "qwen"
										| "ollama"
										| "ollama-cloud",
								) => setNewAccount({ ...newAccount, mode: value })}
							>
								<SelectTrigger id="mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="claude-oauth">
										Claude CLI OAuth (Recommended)
									</SelectItem>
									<SelectItem value="console">Claude API</SelectItem>
									<SelectItem value="codex">Codex (OpenAI OAuth)</SelectItem>
									<SelectItem value="qwen">
										Qwen (Alibaba Cloud OAuth)
									</SelectItem>
									<SelectItem value="vertex-ai">
										Vertex AI (Google Cloud)
									</SelectItem>
									<SelectItem value="bedrock">AWS Bedrock</SelectItem>
									<SelectItem value="zai">z.ai (API Key)</SelectItem>
									<SelectItem value="minimax">Minimax (API Key)</SelectItem>
									<SelectItem value="nanogpt">NanoGPT (API Key)</SelectItem>
									<SelectItem value="anthropic-compatible">
										Anthropic-Compatible (API Key)
									</SelectItem>
									<SelectItem value="openai-compatible">
										OpenAI-Compatible (API Key)
									</SelectItem>
									<SelectItem value="kilo">Kilo Gateway (API Key)</SelectItem>
									<SelectItem value="openrouter">
										OpenRouter (API Key)
									</SelectItem>
									<SelectItem value="alibaba-coding-plan">
										Alibaba Coding Plan International (API Key)
									</SelectItem>
									<SelectItem value="ollama">
										Ollama (v0.14.0+, local)
									</SelectItem>
									<SelectItem value="ollama-cloud">
										Ollama Cloud (ollama.com)
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{newAccount.mode === "codex" && (
							<div className="space-y-3">
								{codexStep === "idle" && (
									<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg">
										<p className="text-sm text-blue-900 dark:text-blue-100 font-medium mb-1">
											Device Code Authentication
										</p>
										<p className="text-xs text-blue-800 dark:text-blue-200">
											Click the button below to start Codex authentication. A
											browser tab will open for you to authorize.
										</p>
									</div>
								)}
								{codexStep === "pending" && (
									<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg space-y-2">
										<p className="text-sm text-blue-900 dark:text-blue-100 font-medium">
											Waiting for authorization...
										</p>
										<p className="text-xs text-blue-800 dark:text-blue-200">
											Enter this code in the browser tab:
										</p>
										<p className="text-xs text-blue-800 dark:text-blue-200">
											This setup continues on the server if you navigate away.
										</p>
										<div className="flex items-center gap-2">
											<code className="text-lg font-mono font-bold tracking-widest bg-blue-100 dark:bg-blue-900 text-blue-900 dark:text-blue-100 px-3 py-1 rounded">
												{codexUserCode}
											</code>
											<a
												href={codexVerificationUrl}
												target="_blank"
												rel="noreferrer"
												className="text-xs text-blue-700 dark:text-blue-300 underline"
											>
												Open browser
											</a>
										</div>
									</div>
								)}
								{codexStep === "complete" && (
									<div className="bg-green-50 dark:bg-green-950 p-3 rounded-lg">
										<p className="text-sm text-green-900 dark:text-green-100 font-medium">
											Authorization successful! Account added.
										</p>
									</div>
								)}
								{codexStep === "error" && (
									<div className="bg-red-50 dark:bg-red-950 p-3 rounded-lg space-y-2">
										<p className="text-sm text-red-900 dark:text-red-100 font-medium">
											Authentication failed
										</p>
										<p className="text-xs text-red-800 dark:text-red-200">
											{codexError}
										</p>
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												setCodexStep("idle");
												setCodexError("");
											}}
										>
											Try again
										</Button>
									</div>
								)}
							</div>
						)}
						{newAccount.mode === "qwen" && (
							<div className="space-y-3">
								{qwenStep === "idle" && (
									<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg">
										<p className="text-sm text-blue-900 dark:text-blue-100 font-medium mb-1">
											Device Code Authentication
										</p>
										<p className="text-xs text-blue-800 dark:text-blue-200">
											Click the button below to start Qwen authentication. A
											browser tab will open for you to authorize.
										</p>
									</div>
								)}
								{qwenStep === "pending" && (
									<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg space-y-2">
										<p className="text-sm text-blue-900 dark:text-blue-100 font-medium">
											Waiting for authorization...
										</p>
										<p className="text-xs text-blue-800 dark:text-blue-200">
											Enter this code in the browser tab:
										</p>
										<p className="text-xs text-blue-800 dark:text-blue-200">
											This setup continues on the server if you navigate away.
										</p>
										<div className="flex items-center gap-2">
											<code className="text-lg font-mono font-bold tracking-widest bg-blue-100 dark:bg-blue-900 text-blue-900 dark:text-blue-100 px-3 py-1 rounded">
												{qwenUserCode}
											</code>
											<a
												href={qwenAuthUrl}
												target="_blank"
												rel="noreferrer"
												className="text-xs text-blue-700 dark:text-blue-300 underline"
											>
												Open browser
											</a>
										</div>
									</div>
								)}
								{qwenStep === "complete" && (
									<div className="bg-green-50 dark:bg-green-950 p-3 rounded-lg">
										<p className="text-sm text-green-900 dark:text-green-100 font-medium">
											Authorization successful! Account added.
										</p>
									</div>
								)}
								{qwenStep === "error" && (
									<div className="bg-red-50 dark:bg-red-950 p-3 rounded-lg space-y-2">
										<p className="text-sm text-red-900 dark:text-red-100 font-medium">
											Authentication failed
										</p>
										<p className="text-xs text-red-800 dark:text-red-200">
											{qwenError}
										</p>
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												setQwenStep("idle");
												setQwenError("");
											}}
										>
											Try again
										</Button>
									</div>
								)}
							</div>
						)}
						{newAccount.mode === "vertex-ai" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="projectId">Google Cloud Project ID</Label>
									<Input
										id="projectId"
										value={newAccount.projectId}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												projectId: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="your-project-id"
									/>
									<p className="text-xs text-muted-foreground">
										Your Google Cloud project ID where Vertex AI is enabled
									</p>
								</div>
								<div className="space-y-2">
									<Label htmlFor="region">Region</Label>
									<Select
										value={newAccount.region}
										onValueChange={(value: string) =>
											setNewAccount({ ...newAccount, region: value })
										}
									>
										<SelectTrigger id="region">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="global">
												Global (Recommended)
											</SelectItem>
											<SelectItem value="us-east5">us-east5</SelectItem>
											<SelectItem value="us-central1">us-central1</SelectItem>
											<SelectItem value="europe-west1">europe-west1</SelectItem>
											<SelectItem value="europe-west4">europe-west4</SelectItem>
											<SelectItem value="asia-southeast1">
												asia-southeast1
											</SelectItem>
										</SelectContent>
									</Select>
									<p className="text-xs text-muted-foreground">
										Global for best availability, regional for data residency
									</p>
								</div>
								<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg">
									<p className="text-sm text-blue-900 dark:text-blue-100 font-medium mb-1">
										Authentication Required
									</p>
									<p className="text-xs text-blue-800 dark:text-blue-200">
										Vertex AI uses Google Cloud credentials. Ensure you've run:{" "}
										<code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">
											gcloud auth application-default login
										</code>
									</p>
								</div>
							</>
						)}
						{newAccount.mode === "bedrock" && (
							<>
								{awsProfiles.length === 0 && !loadingProfiles && (
									<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg">
										<p className="text-sm text-blue-900 dark:text-blue-100 font-medium mb-1">
											No AWS profiles found
										</p>
										<p className="text-xs text-blue-800 dark:text-blue-200">
											Run{" "}
											<code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">
												aws configure
											</code>{" "}
											to set up profiles.
										</p>
									</div>
								)}
								{awsProfiles.length > 0 && (
									<>
										<div className="space-y-2">
											<Label htmlFor="awsProfile">AWS Profile</Label>
											<Select
												value={newAccount.profile}
												onValueChange={(value: string) => {
													const selectedProfile = awsProfiles.find(
														(p) => p.name === value,
													);
													setNewAccount({
														...newAccount,
														profile: value,
														awsRegion: selectedProfile?.region || "",
													});
												}}
											>
												<SelectTrigger id="awsProfile">
													<SelectValue placeholder="Select AWS profile" />
												</SelectTrigger>
												<SelectContent>
													{awsProfiles.map((profile) => (
														<SelectItem key={profile.name} value={profile.name}>
															{profile.name}
															{profile.region && ` (${profile.region})`}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<p className="text-xs text-muted-foreground">
												Your AWS profile from ~/.aws/credentials
											</p>
										</div>
										<div className="space-y-2">
											<Label htmlFor="awsRegion">Region (Auto-detected)</Label>
											<Input
												id="awsRegion"
												value={newAccount.awsRegion}
												disabled
												placeholder="Select profile to detect region"
											/>
											<p className="text-xs text-muted-foreground">
												Region from ~/.aws/config for selected profile
											</p>
											{newAccount.profile &&
												!newAccount.awsRegion &&
												!loadingProfiles && (
													<p className="text-xs text-yellow-600 dark:text-yellow-400">
														No default region found for this profile. Configure
														region in ~/.aws/config
													</p>
												)}
										</div>
										<div className="space-y-2">
											<Label htmlFor="crossRegionMode">Cross-Region Mode</Label>
											<Select
												value={newAccount.crossRegionMode}
												onValueChange={(
													value: "geographic" | "global" | "regional",
												) =>
													setNewAccount({
														...newAccount,
														crossRegionMode: value,
													})
												}
											>
												<SelectTrigger id="crossRegionMode">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="geographic">
														Geographic (default - routes within your region's
														geography)
													</SelectItem>
													<SelectItem value="global">
														Global (routes globally, ~10% cost savings, premium
														models only)
													</SelectItem>
													<SelectItem value="regional">
														Regional (single region, no failover)
													</SelectItem>
												</SelectContent>
											</Select>
											<p className="text-xs text-muted-foreground">
												Controls how Bedrock routes requests for cross-region
												inference
											</p>
										</div>
										<div className="space-y-2">
											<Label htmlFor="customBedrockModel">
												Custom Model ID (Optional)
											</Label>
											<Input
												id="customBedrockModel"
												value={newAccount.customBedrockModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														customBedrockModel: (e.target as HTMLInputElement)
															.value,
													})
												}
												placeholder="e.g., anthropic.claude-opus-4-6-v1:0"
											/>
											<p className="text-xs text-muted-foreground">
												Specify a Bedrock model ID to bypass automatic model
												detection. Leave empty to use fuzzy matching.
											</p>
										</div>
										<div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg">
											<p className="text-sm text-blue-900 dark:text-blue-100 font-medium mb-1">
												Authentication Required
											</p>
											<p className="text-xs text-blue-800 dark:text-blue-200">
												Bedrock uses AWS credentials from the selected profile.
												Ensure your credentials are configured.
											</p>
										</div>
									</>
								)}
							</>
						)}
						{newAccount.mode === "zai" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="apiKey">z.ai API Key</Label>
									<Input
										id="apiKey"
										type="password"
										value={newAccount.apiKey}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												apiKey: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="Enter your z.ai API key"
									/>
								</div>
								<div className="space-y-2">
									<Label className="text-sm font-medium">
										Model Mappings (Optional)
									</Label>
									<p className="text-xs text-muted-foreground">
										Map Anthropic model names to z.ai-specific models. Leave
										empty to use Claude models directly.
									</p>
									<div className="space-y-2 pl-4">
										<div>
											<Label htmlFor="zaiFableModel" className="text-sm">
												Fable Model
											</Label>
											<Input
												id="zaiFableModel"
												value={newAccount.fableModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														fableModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g. glm-4.5-flash"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="opusModel" className="text-sm">
												Opus Model
											</Label>
											<Input
												id="opusModel"
												value={newAccount.opusModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														opusModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g. glm-4.5-flash"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="sonnetModel" className="text-sm">
												Sonnet Model
											</Label>
											<Input
												id="sonnetModel"
												value={newAccount.sonnetModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														sonnetModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g. glm-4.5-flash"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="haikuModel" className="text-sm">
												Haiku Model
											</Label>
											<Input
												id="haikuModel"
												value={newAccount.haikuModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														haikuModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g. glm-4.5-air"
												className="mt-1"
											/>
										</div>
									</div>
								</div>
							</>
						)}
						{newAccount.mode === "minimax" && (
							<div className="space-y-2">
								<Label htmlFor="apiKey">Minimax API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your Minimax API key"
								/>
							</div>
						)}
						{newAccount.mode === "nanogpt" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="apiKey">NanoGPT API Key</Label>
									<Input
										id="apiKey"
										type="password"
										value={newAccount.apiKey}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												apiKey: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="Enter your NanoGPT API key"
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="customEndpoint">
										Custom Endpoint (Optional)
									</Label>
									<Input
										id="customEndpoint"
										type="url"
										value={newAccount.customEndpoint}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												customEndpoint: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="https://nano-gpt.com/api (default)"
									/>
								</div>
								<div className="space-y-2">
									<Label className="text-sm font-medium">
										Model Mappings (Optional)
									</Label>
									<p className="text-xs text-muted-foreground">
										Map Anthropic model names to NanoGPT-specific models. Leave
										empty to use defaults.
									</p>
									<div className="space-y-2 pl-4">
										<div>
											<Label htmlFor="nanogptFableModel" className="text-sm">
												Fable Model
											</Label>
											<Input
												id="nanogptFableModel"
												value={newAccount.fableModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														fableModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="nanogpt-ultra (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="opusModel" className="text-sm">
												Opus Model
											</Label>
											<Input
												id="opusModel"
												value={newAccount.opusModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														opusModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="nanogpt-ultra (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="sonnetModel" className="text-sm">
												Sonnet Model
											</Label>
											<Input
												id="sonnetModel"
												value={newAccount.sonnetModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														sonnetModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="nanogpt-pro (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="haikuModel" className="text-sm">
												Haiku Model
											</Label>
											<Input
												id="haikuModel"
												value={newAccount.haikuModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														haikuModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="nanogpt-lite (default)"
												className="mt-1"
											/>
										</div>
									</div>
								</div>
							</>
						)}
						{newAccount.mode === "kilo" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="apiKey">Kilo API Key</Label>
									<Input
										id="apiKey"
										type="password"
										value={newAccount.apiKey}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												apiKey: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="Enter your Kilo API key"
									/>
									<p className="text-xs text-muted-foreground">
										Endpoint: https://api.kilo.ai/api/gateway
									</p>
								</div>
								<div className="space-y-2">
									<Label className="text-sm font-medium">
										Model Mappings (Optional)
									</Label>
									<p className="text-xs text-muted-foreground">
										Map Anthropic model names to Kilo-specific models. Leave
										empty to use defaults.
									</p>
									<div className="space-y-2 pl-4">
										<div>
											<Label htmlFor="kiloFableModel" className="text-sm">
												Fable Model
											</Label>
											<Input
												id="kiloFableModel"
												value={newAccount.fableModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														fableModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., anthropic/claude-fable (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="kiloOpusModel" className="text-sm">
												Opus Model
											</Label>
											<Input
												id="kiloOpusModel"
												value={newAccount.opusModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														opusModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., anthropic/claude-opus-4-6 (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="kiloSonnetModel" className="text-sm">
												Sonnet Model
											</Label>
											<Input
												id="kiloSonnetModel"
												value={newAccount.sonnetModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														sonnetModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., anthropic/claude-sonnet-4-6 (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="kiloHaikuModel" className="text-sm">
												Haiku Model
											</Label>
											<Input
												id="kiloHaikuModel"
												value={newAccount.haikuModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														haikuModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., anthropic/claude-haiku-4-5 (default)"
												className="mt-1"
											/>
										</div>
									</div>
								</div>
							</>
						)}
						{newAccount.mode === "openrouter" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="apiKey">OpenRouter API Key</Label>
									<Input
										id="apiKey"
										type="password"
										value={newAccount.apiKey}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												apiKey: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="Enter your OpenRouter API key"
									/>
									<p className="text-xs text-muted-foreground">
										Endpoint: https://openrouter.ai/api/v1
									</p>
								</div>
								<div className="space-y-2">
									<Label className="text-sm font-medium">
										Model Mappings (Optional)
									</Label>
									<p className="text-xs text-muted-foreground">
										Map Anthropic model names to OpenRouter-specific models.
										Leave empty to pass model names through unchanged.
									</p>
									<div className="space-y-2 pl-4">
										<div>
											<Label htmlFor="openRouterFableModel" className="text-sm">
												Fable Model
											</Label>
											<Input
												id="openRouterFableModel"
												value={newAccount.fableModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														fableModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., anthropic/claude-fable"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="opusModel" className="text-sm">
												Opus Model
											</Label>
											<Input
												id="opusModel"
												value={newAccount.opusModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														opusModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., anthropic/claude-opus-4-5"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="sonnetModel" className="text-sm">
												Sonnet Model
											</Label>
											<Input
												id="sonnetModel"
												value={newAccount.sonnetModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														sonnetModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., anthropic/claude-sonnet-4-5"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="haikuModel" className="text-sm">
												Haiku Model
											</Label>
											<Input
												id="haikuModel"
												value={newAccount.haikuModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														haikuModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., anthropic/claude-haiku-4-5"
												className="mt-1"
											/>
										</div>
									</div>
								</div>
							</>
						)}
						{newAccount.mode === "alibaba-coding-plan" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="apiKey">Alibaba Coding Plan API Key</Label>
									<Input
										id="apiKey"
										type="password"
										value={newAccount.apiKey}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												apiKey: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="Enter your Alibaba Coding Plan API key"
									/>
									<p className="text-xs text-muted-foreground">
										Endpoint: https://bailian-singapore-cs.alibabacloud.com
									</p>
								</div>
								<div className="space-y-2">
									<Label className="text-sm font-medium">
										Model Mappings (Optional)
									</Label>
									<p className="text-xs text-muted-foreground">
										Map Anthropic model names to Alibaba-specific models. Leave
										empty to use defaults.
									</p>
									<div className="space-y-2 pl-4">
										<div>
											<Label htmlFor="alibabaFableModel" className="text-sm">
												Fable Model
											</Label>
											<Input
												id="alibabaFableModel"
												value={newAccount.fableModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														fableModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., qwen-max (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="alibabaOpusModel" className="text-sm">
												Opus Model
											</Label>
											<Input
												id="alibabaOpusModel"
												value={newAccount.opusModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														opusModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., qwen-max (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="alibabaSonnetModel" className="text-sm">
												Sonnet Model
											</Label>
											<Input
												id="alibabaSonnetModel"
												value={newAccount.sonnetModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														sonnetModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., qwen-plus (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="alibabaHaikuModel" className="text-sm">
												Haiku Model
											</Label>
											<Input
												id="alibabaHaikuModel"
												value={newAccount.haikuModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														haikuModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="e.g., qwen-turbo (default)"
												className="mt-1"
											/>
										</div>
									</div>
								</div>
							</>
						)}
						{newAccount.mode === "anthropic-compatible" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="apiKey">Anthropic-Compatible API Key</Label>
									<Input
										id="apiKey"
										type="password"
										value={newAccount.apiKey}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												apiKey: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="Enter your Anthropic-Compatible API key"
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="customEndpoint">
										Custom Endpoint URL (Optional)
									</Label>
									<Input
										id="customEndpoint"
										type="url"
										value={newAccount.customEndpoint}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												customEndpoint: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="https://api.anthropic-compatible.com"
									/>
								</div>
								<div className="space-y-2">
									<Label>Model Mappings (Optional)</Label>
									<p className="text-xs text-muted-foreground mb-2">
										Map Anthropic model names to provider-specific models. Leave
										empty to use defaults.
									</p>
									<div className="space-y-2 pl-4">
										<div>
											<Label
												htmlFor="anthropicCompatibleFableModel"
												className="text-sm"
											>
												Fable Model
											</Label>
											<Input
												id="anthropicCompatibleFableModel"
												value={newAccount.fableModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														fableModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="claude-fable (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="opusModel" className="text-sm">
												Opus Model
											</Label>
											<Input
												id="opusModel"
												value={newAccount.opusModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														opusModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="claude-3-opus-20240229 (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="sonnetModel" className="text-sm">
												Sonnet Model
											</Label>
											<Input
												id="sonnetModel"
												value={newAccount.sonnetModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														sonnetModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="claude-3-sonnet-20240229 (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="haikuModel" className="text-sm">
												Haiku Model
											</Label>
											<Input
												id="haikuModel"
												value={newAccount.haikuModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														haikuModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="claude-3-haiku-20240307 (default)"
												className="mt-1"
											/>
										</div>
									</div>
								</div>
							</>
						)}
						{newAccount.mode === "openai-compatible" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="apiKey">API Key</Label>
									<Input
										id="apiKey"
										type="password"
										value={newAccount.apiKey}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												apiKey: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="Enter your API key"
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="endpoint">Endpoint URL</Label>
									<Input
										id="endpoint"
										value={newAccount.customEndpoint}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												customEndpoint: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="https://api.openrouter.ai/api/v1"
									/>
									<p className="text-xs text-muted-foreground">
										Enter the base URL for the OpenAI-compatible API
									</p>
								</div>
								<div className="space-y-2">
									<Label>Model Mappings (Optional)</Label>
									<p className="text-xs text-muted-foreground mb-2">
										Map Anthropic model names to provider-specific models. Leave
										empty to use defaults.
									</p>
									<div className="space-y-2 pl-4">
										<div>
											<Label htmlFor="opusModel" className="text-sm">
												Opus Model
											</Label>
											<Input
												id="opusModel"
												value={newAccount.opusModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														opusModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="openai/gpt-5 (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="openAiFableModel" className="text-sm">
												Fable Model
											</Label>
											<Input
												id="openAiFableModel"
												value={newAccount.fableModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														fableModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="openai/gpt-5 (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="sonnetModel" className="text-sm">
												Sonnet Model
											</Label>
											<Input
												id="sonnetModel"
												value={newAccount.sonnetModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														sonnetModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="openai/gpt-5 (default)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="haikuModel" className="text-sm">
												Haiku Model
											</Label>
											<Input
												id="haikuModel"
												value={newAccount.haikuModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														haikuModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="openai/gpt-5-mini (default)"
												className="mt-1"
											/>
										</div>
									</div>
								</div>
							</>
						)}
						{newAccount.mode === "ollama" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="customEndpoint">
										Ollama Endpoint URL (Optional)
									</Label>
									<Input
										id="customEndpoint"
										type="url"
										value={newAccount.customEndpoint}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												customEndpoint: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="http://localhost:11434"
									/>
									<p className="text-xs text-muted-foreground">
										Leave empty to use default http://localhost:11434. Requires
										Ollama v0.14.0+.
									</p>
								</div>
								<div className="space-y-2">
									<Label>Model Mappings (Optional)</Label>
									<p className="text-xs text-muted-foreground mb-2">
										Map Anthropic model names to Ollama model names (e.g.
										qwen3-coder, llama3.3).
									</p>
									<div className="space-y-2 pl-4">
										<div>
											<Label htmlFor="opusModel" className="text-sm">
												Opus Model
											</Label>
											<Input
												id="opusModel"
												value={newAccount.opusModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														opusModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="qwen3-coder (example)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="ollamaFableModel" className="text-sm">
												Fable Model
											</Label>
											<Input
												id="ollamaFableModel"
												value={newAccount.fableModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														fableModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="qwen3-coder (example)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="sonnetModel" className="text-sm">
												Sonnet Model
											</Label>
											<Input
												id="sonnetModel"
												value={newAccount.sonnetModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														sonnetModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="qwen3-coder (example)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="haikuModel" className="text-sm">
												Haiku Model
											</Label>
											<Input
												id="haikuModel"
												value={newAccount.haikuModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														haikuModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="llama3.3 (example)"
												className="mt-1"
											/>
										</div>
									</div>
								</div>
							</>
						)}
						{newAccount.mode === "ollama-cloud" && (
							<>
								<div className="space-y-2">
									<Label htmlFor="apiKey">Ollama Cloud API Key</Label>
									<Input
										id="apiKey"
										type="password"
										value={newAccount.apiKey}
										onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
											setNewAccount({
												...newAccount,
												apiKey: (e.target as HTMLInputElement).value,
											})
										}
										placeholder="Enter your Ollama Cloud API key"
									/>
								</div>
								<div className="space-y-2">
									<Label>Model Mappings (Optional)</Label>
									<p className="text-xs text-muted-foreground mb-2">
										Map Anthropic model names to Ollama model names (e.g.
										qwen3-coder, llama3.3).
									</p>
									<div className="space-y-2 pl-4">
										<div>
											<Label htmlFor="opusModel" className="text-sm">
												Opus Model
											</Label>
											<Input
												id="opusModel"
												value={newAccount.opusModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														opusModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="qwen3-coder (example)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label
												htmlFor="ollamaCloudFableModel"
												className="text-sm"
											>
												Fable Model
											</Label>
											<Input
												id="ollamaCloudFableModel"
												value={newAccount.fableModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														fableModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="qwen3-coder (example)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="sonnetModel" className="text-sm">
												Sonnet Model
											</Label>
											<Input
												id="sonnetModel"
												value={newAccount.sonnetModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														sonnetModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="qwen3-coder (example)"
												className="mt-1"
											/>
										</div>
										<div>
											<Label htmlFor="haikuModel" className="text-sm">
												Haiku Model
											</Label>
											<Input
												id="haikuModel"
												value={newAccount.haikuModel}
												onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
													setNewAccount({
														...newAccount,
														haikuModel: (e.target as HTMLInputElement).value,
													})
												}
												placeholder="llama3.3 (example)"
												className="mt-1"
											/>
										</div>
									</div>
								</div>
							</>
						)}
						{(newAccount.mode === "claude-oauth" ||
							newAccount.mode === "console") && (
							<div className="space-y-2">
								<Label htmlFor="customEndpoint">
									Custom Endpoint URL (Optional)
								</Label>
								<Input
									id="customEndpoint"
									type="url"
									value={newAccount.customEndpoint}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											customEndpoint: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="https://api.anthropic.com"
								/>
								<p className="text-xs text-muted-foreground">
									Leave empty to use default Anthropic endpoint. Must be a valid
									URL.
								</p>
							</div>
						)}
						<div className="space-y-2">
							<Label htmlFor="priority">Priority</Label>
							<Select
								value={String(newAccount.priority)}
								onValueChange={(value: string) =>
									setNewAccount({
										...newAccount,
										priority: parseInt(value, 10),
									})
								}
							>
								<SelectTrigger id="priority">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="0">0 (Highest)</SelectItem>
									<SelectItem value="25">25 (High)</SelectItem>
									<SelectItem value="50">50 (Medium)</SelectItem>
									<SelectItem value="75">75 (Low)</SelectItem>
									<SelectItem value="100">100 (Lowest)</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</>
				)}
			{routingStage !== "details" && (
				<AccountRoutingPreviewPanel
					previews={routingPreviews}
					selections={routingSelections}
					onSelectionChange={
						routingStage === "review"
							? (selections) => {
									setRoutingSelections(selections);
									transitionAccountSetup({
										type: "review-consent-changed",
										reviewed: false,
									});
								}
							: undefined
					}
					outcomes={routingOutcomes}
					isLoading={routingLoading}
					error={routingError}
				/>
			)}

			{routingStage === "review" && (
				<label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
					<input
						type="checkbox"
						checked={routingReviewed}
						onChange={(event) =>
							transitionAccountSetup({
								type: "review-consent-changed",
								reviewed: event.currentTarget.checked,
							})
						}
					/>
					<span>I reviewed these routing changes</span>
				</label>
			)}

			{routingStage === "details" ? (
				<div className="flex gap-2">
					<Button
						onClick={() => void handleRoutingPreview()}
						disabled={routingLoading}
					>
						{routingLoading ? "Reviewing routing…" : "Review routing"}
					</Button>
					<Button variant="outline" onClick={handleCancel}>
						Cancel
					</Button>
				</div>
			) : routingStage === "review" ? (
				<div className="flex gap-2">
					<Button variant="outline" onClick={handleBackToDetails}>
						Back
					</Button>
					{newAccount.mode === "qwen" ? (
						<Button
							onClick={() => void handleStartQwenAuth()}
							disabled={
								!routingReviewed ||
								routingPreviewDraftKey !== currentRoutingDraftKey
							}
						>
							Start Qwen Authentication
						</Button>
					) : newAccount.mode === "codex" ? (
						<Button
							onClick={() => void handleStartCodexAuth()}
							disabled={
								!routingReviewed ||
								routingPreviewDraftKey !== currentRoutingDraftKey
							}
						>
							Start Codex Authentication
						</Button>
					) : (
						<Button
							onClick={() => {
								const authorizationCodeFlow =
									newAccount.mode === "claude-oauth" ||
									newAccount.mode === "console";
								void handleAddAccount().catch((error) => {
									handleCreationError(error, {
										ambiguousCommit: !authorizationCodeFlow,
									});
								});
							}}
							disabled={
								!routingReviewed ||
								routingPreviewDraftKey !== currentRoutingDraftKey
							}
						>
							Create account
						</Button>
					)}
					<Button variant="outline" onClick={handleCancel}>
						Cancel
					</Button>
				</div>
			) : routingStage === "finalizing" ? (
				<div className="space-y-1" role="status" aria-live="polite">
					<p className="text-sm font-medium">Finalizing account setup…</p>
					<p className="text-xs text-muted-foreground">
						Reconciliation continues on the server. You can navigate away or
						close this form safely.
					</p>
				</div>
			) : routingStage === "outcome" ? (
				<div className="space-y-2">
					{createdIdentity ? (
						<Button onClick={handleDone}>Done</Button>
					) : (
						<p className="text-sm text-destructive">
							Account identity is unavailable. Routing was not changed. Keep
							this outcome open while you resolve the action-required result.
						</p>
					)}
				</div>
			) : authStep === "code" ? (
				<>
					<div className="space-y-2">
						<p className="text-sm text-muted-foreground">
							A new browser tab has opened for authentication. After
							authorizing, copy the code and paste it below.
						</p>
						<Label htmlFor="code">Authorization Code</Label>
						<Input
							id="code"
							value={authCode}
							onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
								setAuthCode(event.currentTarget.value)
							}
							placeholder="Paste authorization code here"
						/>
					</div>
					<div className="flex gap-2">
						<Button
							onClick={() => {
								void handleCodeSubmit().catch((error) => {
									handleCreationError(error, {
										retryStage: "creating",
										ambiguousCommit: true,
									});
								});
							}}
						>
							{routingError
								? "Retry completion after checking accounts"
								: "Complete Setup"}
						</Button>
						<Button variant="outline" onClick={handleCancel}>
							Cancel
						</Button>
					</div>
				</>
			) : accountSetupCanCancel(accountSetupState) ? (
				<div className="flex items-center gap-3">
					<p className="text-sm text-muted-foreground">
						Authorization is in progress. You can still cancel before it
						completes.
					</p>
					<Button variant="outline" onClick={handleCancel}>
						Cancel
					</Button>
				</div>
			) : (
				<div className="space-y-1" role="status" aria-live="polite">
					<p className="text-sm font-medium">Authorization is in progress…</p>
					<p className="text-xs text-muted-foreground">
						Keep this form open. The server is completing device authorization
						and will reconcile the created account automatically.
					</p>
				</div>
			)}
		</div>
	);
}
