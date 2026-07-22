import type { AccountRoutingOverview } from "@better-ccflare/types";
import { AlertCircle, Plus } from "lucide-react";
import { useState } from "react";
import { type Account, api } from "../api";
import {
	ACCOUNT_ROUTING_INVALIDATION,
	FULL_MANAGED_ROUTING_INVALIDATION,
	useAccountRoutingOverview,
	useAccounts,
	useForceResetRateLimit,
	useManagedRoutingInvalidation,
	usePauseAccount,
	useRefreshUsage,
	useRemoveAccount,
	useRenameAccount,
	useResumeAccount,
	useUpdateAccountAutoRefresh,
	useUpdateAccountBillingType,
	useUpdateAccountCustomEndpoint,
	useUpdateAccountModelMappings,
	useUpdateAccountPriority,
} from "../hooks/queries";
import { useApiError } from "../hooks/useApiError";
import {
	AccountAddForm,
	AccountCustomEndpointDialog,
	AccountList,
	AccountModelMappingsDialog,
	AccountPriorityDialog,
	AnthropicReauthDialog,
	CodexReauthDialog,
	DeleteConfirmationDialog,
	QwenReauthDialog,
	RenameAccountDialog,
} from "./accounts";
import type { AccountCreationIdentity } from "./accounts/AccountAddForm";
import {
	type AccountFamilyRoutingState,
	getAccountFamilyRoutingStates,
} from "./accounts/account-routing";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";

type AccountCreationClient = Pick<
	typeof api,
	| "completeAddAccount"
	| "addVertexAIAccount"
	| "addBedrockAccount"
	| "addZaiAccount"
	| "addMinimaxAccount"
	| "addNanoGPTAccount"
	| "addAlibabaCodingPlanAccount"
	| "addKiloAccount"
	| "addOpenRouterAccount"
	| "addAnthropicCompatibleAccount"
	| "addOpenAIAccount"
	| "addOllamaAccount"
	| "addOllamaCloudAccount"
>;

async function immutableAccountIdentity(
	operation: () => Promise<{ accountId: string }>,
	afterCreate: () => Promise<void>,
	onError?: (error: unknown) => void,
): Promise<AccountCreationIdentity> {
	let response: { accountId: string };
	try {
		response = await operation();
	} catch (error) {
		onError?.(error);
		throw error;
	}
	try {
		await afterCreate();
	} catch (error) {
		onError?.(error);
	}
	return { accountId: response.accountId };
}

export function createAccountCreationCallbacks(
	client: AccountCreationClient,
	afterCreate: () => Promise<void> = async () => undefined,
	onError?: (error: unknown) => void,
) {
	return {
		onCompleteAccount: (
			params: Parameters<typeof client.completeAddAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.completeAddAccount(params),
				afterCreate,
				onError,
			),
		onAddVertexAIAccount: (
			params: Parameters<typeof client.addVertexAIAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addVertexAIAccount(params),
				afterCreate,
				onError,
			),
		onAddBedrockAccount: (
			params: Parameters<typeof client.addBedrockAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addBedrockAccount(params),
				afterCreate,
				onError,
			),
		onAddZaiAccount: (params: Parameters<typeof client.addZaiAccount>[0]) =>
			immutableAccountIdentity(
				() => client.addZaiAccount(params),
				afterCreate,
				onError,
			),
		onAddMinimaxAccount: (
			params: Parameters<typeof client.addMinimaxAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addMinimaxAccount(params),
				afterCreate,
				onError,
			),
		onAddNanoGPTAccount: (
			params: Parameters<typeof client.addNanoGPTAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addNanoGPTAccount(params),
				afterCreate,
				onError,
			),
		onAddAlibabaCodingPlanAccount: (
			params: Parameters<typeof client.addAlibabaCodingPlanAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addAlibabaCodingPlanAccount(params),
				afterCreate,
				onError,
			),
		onAddKiloAccount: (params: Parameters<typeof client.addKiloAccount>[0]) =>
			immutableAccountIdentity(
				() => client.addKiloAccount(params),
				afterCreate,
				onError,
			),
		onAddOpenRouterAccount: (
			params: Parameters<typeof client.addOpenRouterAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addOpenRouterAccount(params),
				afterCreate,
				onError,
			),
		onAddAnthropicCompatibleAccount: (
			params: Parameters<typeof client.addAnthropicCompatibleAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addAnthropicCompatibleAccount(params),
				afterCreate,
				onError,
			),
		onAddOpenAIAccount: (
			params: Parameters<typeof client.addOpenAIAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addOpenAIAccount(params),
				afterCreate,
				onError,
			),
		onAddOllamaAccount: (
			params: Parameters<typeof client.addOllamaAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addOllamaAccount(params),
				afterCreate,
				onError,
			),
		onAddOllamaCloudAccount: (
			params: Parameters<typeof client.addOllamaCloudAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addOllamaCloudAccount(params),
				afterCreate,
				onError,
			),
	};
}

export function buildRoutingByAccountId(
	accountIds: readonly string[],
	overview: AccountRoutingOverview | undefined,
): Record<string, readonly AccountFamilyRoutingState[]> {
	const routingByAccountId: Record<
		string,
		readonly AccountFamilyRoutingState[]
	> = {};
	for (const accountId of accountIds) {
		routingByAccountId[accountId] = overview
			? getAccountFamilyRoutingStates(accountId, overview)
			: [];
	}
	return routingByAccountId;
}

export function AccountsTab() {
	const { formatError } = useApiError();
	const {
		data: accounts,
		isLoading: loading,
		error,
		refetch: loadAccounts,
	} = useAccounts();
	const { data: routingOverview } = useAccountRoutingOverview();
	const routingByAccountId = buildRoutingByAccountId(
		accounts?.map((account) => account.id) ?? [],
		routingOverview,
	);
	const invalidateManagedRouting = useManagedRoutingInvalidation();
	const removeAccount = useRemoveAccount();
	const pauseAccount = usePauseAccount();
	const resumeAccount = useResumeAccount();
	const forceResetRateLimit = useForceResetRateLimit();
	const refreshUsage = useRefreshUsage();
	const renameAccount = useRenameAccount();
	const updatePriority = useUpdateAccountPriority();
	const updateAutoRefresh = useUpdateAccountAutoRefresh();
	const updateBillingType = useUpdateAccountBillingType();
	const updateCustomEndpoint = useUpdateAccountCustomEndpoint();
	const updateModelMappings = useUpdateAccountModelMappings();

	const [adding, setAdding] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<{
		show: boolean;
		accountName: string;
		confirmInput: string;
	}>({
		show: false,
		accountName: "",
		confirmInput: "",
	});
	const [renameDialog, setRenameDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [priorityDialog, setPriorityDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [customEndpointDialog, setCustomEndpointDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [modelMappingsDialog, setModelMappingsDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [qwenReauthDialog, setQwenReauthDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [anthropicReauthDialog, setAnthropicReauthDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [codexReauthDialog, setCodexReauthDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [actionError, setActionError] = useState<string | null>(null);
	const accountCreationCallbacks = createAccountCreationCallbacks(
		api,
		() => invalidateManagedRouting(FULL_MANAGED_ROUTING_INVALIDATION),
		(err) => setActionError(formatError(err)),
	);

	const handleAddAccount = async (params: {
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
	}) => {
		try {
			const result = await api.initAddAccount(params);
			setActionError(null);
			return result;
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAddVertexAIAccount = async (params: {
		name: string;
		projectId: string;
		region: string;
		priority: number;
	}) => {
		return accountCreationCallbacks.onAddVertexAIAccount(params);
	};

	const handleAddBedrockAccount = async (params: {
		name: string;
		profile: string;
		region: string;
		priority: number;
		cross_region_mode?: "geographic" | "global" | "regional";
		customModel?: string;
	}) => {
		return accountCreationCallbacks.onAddBedrockAccount(params);
	};

	const handleCompleteAccount = async (params: {
		sessionId: string;
		code: string;
	}) => {
		return accountCreationCallbacks.onCompleteAccount(params);
	};

	const handleAddZaiAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddZaiAccount(params);
	};

	const handleAddOpenAIAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddOpenAIAccount(params);
	};

	const handleAddMinimaxAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
	}) => {
		return accountCreationCallbacks.onAddMinimaxAccount(params);
	};

	const handleAddNanoGPTAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddNanoGPTAccount(params);
	};

	const handleAddAlibabaCodingPlanAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddAlibabaCodingPlanAccount(params);
	};

	const handleAddKiloAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddKiloAccount(params);
	};

	const handleAddOpenRouterAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddOpenRouterAccount(params);
	};

	const handleAddAnthropicCompatibleAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddAnthropicCompatibleAccount(params);
	};

	const handleAddOllamaAccount = async (params: {
		name: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddOllamaAccount(params);
	};

	const handleAddOllamaCloudAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddOllamaCloudAccount(params);
	};

	const handleRemoveAccount = (name: string) => {
		setConfirmDelete({ show: true, accountName: name, confirmInput: "" });
	};

	const handleConfirmDelete = async () => {
		if (confirmDelete.confirmInput !== confirmDelete.accountName) {
			setActionError(
				"Account name does not match. Please type the exact account name.",
			);
			return;
		}

		try {
			await removeAccount.mutateAsync({
				name: confirmDelete.accountName,
				confirmInput: confirmDelete.confirmInput,
			});
			setConfirmDelete({ show: false, accountName: "", confirmInput: "" });
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleRename = (account: Account) => {
		setRenameDialog({ isOpen: true, account });
	};

	const handleConfirmRename = async (newName: string) => {
		if (!renameDialog.account) return;

		try {
			await renameAccount.mutateAsync({
				accountId: renameDialog.account.id,
				newName,
			});
			setRenameDialog({ isOpen: false, account: null });
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handlePauseToggle = async (account: Account) => {
		try {
			if (account.paused) {
				await resumeAccount.mutateAsync(account.id);
			} else {
				await pauseAccount.mutateAsync(account.id);
			}
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleForceResetRateLimit = async (account: Account) => {
		try {
			await forceResetRateLimit.mutateAsync(account.id);
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleRefreshUsage = async (account: Account) => {
		try {
			await refreshUsage.mutateAsync(account.id);
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handlePriorityChange = (account: Account) => {
		setPriorityDialog({ isOpen: true, account });
	};

	const handleUpdatePriority = async (accountId: string, priority: number) => {
		try {
			await updatePriority.mutateAsync({ accountId, priority });
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAutoFallbackToggle = async (account: Account) => {
		try {
			await api.updateAccountAutoFallback(
				account.id,
				!account.autoFallbackEnabled,
			);
			await loadAccounts();
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleAutoRefreshToggle = async (account: Account) => {
		try {
			await updateAutoRefresh.mutateAsync({
				accountId: account.id,
				enabled: !account.autoRefreshEnabled,
			});
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleBillingTypeToggle = async (account: Account) => {
		try {
			await updateBillingType.mutateAsync({
				accountId: account.id,
				billingType: account.billingType === "plan" ? "api" : "plan",
			});
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleAutoPauseOnOverageToggle = async (account: Account) => {
		try {
			await api.updateAccountAutoPauseOnOverage(
				account.id,
				!account.autoPauseOnOverageEnabled,
			);
			await loadAccounts();
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleCustomEndpointChange = (account: Account) => {
		setCustomEndpointDialog({ isOpen: true, account });
	};

	const handleModelMappingsChange = (account: Account) => {
		setModelMappingsDialog({ isOpen: true, account });
	};

	const handleReauth = (account: Account) => {
		setQwenReauthDialog({ isOpen: true, account });
	};

	const handleAnthropicReauth = (account: Account) => {
		setAnthropicReauthDialog({ isOpen: true, account });
	};

	const handleCodexReauth = (account: Account) => {
		setCodexReauthDialog({ isOpen: true, account });
	};

	const handleReauthSuccess = async (closeDialog: () => void) => {
		try {
			await invalidateManagedRouting(ACCOUNT_ROUTING_INVALIDATION);
			closeDialog();
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handlePeakHoursPauseToggle = async (account: Account) => {
		try {
			await api.updateAccountPeakHoursPause(
				account.id,
				!account.peakHoursPauseEnabled,
			);
			await loadAccounts();
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleUpdateCustomEndpoint = async (
		accountId: string,
		customEndpoint: string | null,
	) => {
		try {
			await updateCustomEndpoint.mutateAsync({ accountId, customEndpoint });
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleUpdateModelMappings = async (
		accountId: string,
		modelMappings: { [key: string]: string | string[] },
	) => {
		try {
			await updateModelMappings.mutateAsync({ accountId, modelMappings });
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	if (loading) {
		return (
			<Card>
				<CardContent className="pt-6">
					<p className="text-muted-foreground">Loading accounts...</p>
				</CardContent>
			</Card>
		);
	}

	const displayError = error ? formatError(error) : actionError;

	return (
		<div className="space-y-4">
			{displayError && (
				<Card className="border-destructive">
					<CardContent className="pt-6">
						<div className="flex items-center gap-2">
							<AlertCircle className="h-4 w-4 text-destructive" />
							<p className="text-destructive">{displayError}</p>
						</div>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<div>
							<CardTitle>Accounts</CardTitle>
							<CardDescription>Manage your Claude accounts</CardDescription>
						</div>
						{!adding && (
							<Button onClick={() => setAdding(true)} size="sm">
								<Plus className="mr-2 h-4 w-4" />
								Add Account
							</Button>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{adding && (
						<AccountAddForm
							onAddAccount={handleAddAccount}
							onCompleteAccount={handleCompleteAccount}
							onAddVertexAIAccount={handleAddVertexAIAccount}
							onAddBedrockAccount={handleAddBedrockAccount}
							onAddZaiAccount={handleAddZaiAccount}
							onAddMinimaxAccount={handleAddMinimaxAccount}
							onAddNanoGPTAccount={handleAddNanoGPTAccount}
							onAddAlibabaCodingPlanAccount={handleAddAlibabaCodingPlanAccount}
							onAddKiloAccount={handleAddKiloAccount}
							onAddOpenRouterAccount={handleAddOpenRouterAccount}
							onAddAnthropicCompatibleAccount={
								handleAddAnthropicCompatibleAccount
							}
							onAddOpenAIAccount={handleAddOpenAIAccount}
							onAddOllamaAccount={handleAddOllamaAccount}
							onAddOllamaCloudAccount={handleAddOllamaCloudAccount}
							onCancel={() => {
								setAdding(false);
								setActionError(null);
							}}
							onSuccess={() => {
								setAdding(false);
								setActionError(null);
							}}
							onRoutingChanged={() =>
								invalidateManagedRouting(FULL_MANAGED_ROUTING_INVALIDATION)
							}
							onError={setActionError}
						/>
					)}

					<AccountList
						accounts={accounts}
						routingByAccountId={routingByAccountId}
						onPauseToggle={handlePauseToggle}
						onForceResetRateLimit={handleForceResetRateLimit}
						onRefreshUsage={handleRefreshUsage}
						onRemove={handleRemoveAccount}
						onRename={handleRename}
						onPriorityChange={handlePriorityChange}
						onAutoFallbackToggle={handleAutoFallbackToggle}
						onAutoRefreshToggle={handleAutoRefreshToggle}
						onBillingTypeToggle={handleBillingTypeToggle}
						onAutoPauseOnOverageToggle={handleAutoPauseOnOverageToggle}
						onPeakHoursPauseToggle={handlePeakHoursPauseToggle}
						onCustomEndpointChange={handleCustomEndpointChange}
						onModelMappingsChange={handleModelMappingsChange}
						onReauth={handleReauth}
						onAnthropicReauth={handleAnthropicReauth}
						onCodexReauth={handleCodexReauth}
					/>
				</CardContent>
			</Card>

			{confirmDelete.show && (
				<DeleteConfirmationDialog
					accountName={confirmDelete.accountName}
					confirmInput={confirmDelete.confirmInput}
					onConfirmInputChange={(value) =>
						setConfirmDelete({
							...confirmDelete,
							confirmInput: value,
						})
					}
					onConfirm={handleConfirmDelete}
					onCancel={() => {
						setConfirmDelete({
							show: false,
							accountName: "",
							confirmInput: "",
						});
						setActionError(null);
					}}
				/>
			)}

			{renameDialog.isOpen && renameDialog.account && (
				<RenameAccountDialog
					isOpen={renameDialog.isOpen}
					currentName={renameDialog.account.name}
					onClose={() => setRenameDialog({ isOpen: false, account: null })}
					onRename={handleConfirmRename}
					isLoading={renameAccount.isPending}
				/>
			)}

			{priorityDialog.isOpen && priorityDialog.account && (
				<AccountPriorityDialog
					account={priorityDialog.account}
					isOpen={priorityDialog.isOpen}
					onOpenChange={(open) =>
						setPriorityDialog({
							isOpen: open,
							account: open ? priorityDialog.account : null,
						})
					}
					onUpdatePriority={handleUpdatePriority}
				/>
			)}

			{customEndpointDialog.isOpen && customEndpointDialog.account && (
				<AccountCustomEndpointDialog
					isOpen={customEndpointDialog.isOpen}
					account={customEndpointDialog.account}
					onOpenChange={(open) =>
						setCustomEndpointDialog({
							isOpen: open,
							account: open ? customEndpointDialog.account : null,
						})
					}
					onUpdateEndpoint={handleUpdateCustomEndpoint}
				/>
			)}
			{modelMappingsDialog.isOpen && modelMappingsDialog.account && (
				<AccountModelMappingsDialog
					isOpen={modelMappingsDialog.isOpen}
					account={modelMappingsDialog.account}
					onOpenChange={(open) =>
						setModelMappingsDialog({
							isOpen: open,
							account: open ? modelMappingsDialog.account : null,
						})
					}
					onUpdateModelMappings={handleUpdateModelMappings}
				/>
			)}
			<QwenReauthDialog
				isOpen={qwenReauthDialog.isOpen}
				account={qwenReauthDialog.account}
				onClose={() => setQwenReauthDialog({ isOpen: false, account: null })}
				onSuccess={() =>
					handleReauthSuccess(() =>
						setQwenReauthDialog({ isOpen: false, account: null }),
					)
				}
			/>
			<AnthropicReauthDialog
				isOpen={anthropicReauthDialog.isOpen}
				account={anthropicReauthDialog.account}
				onClose={() =>
					setAnthropicReauthDialog({ isOpen: false, account: null })
				}
				onSuccess={() =>
					handleReauthSuccess(() =>
						setAnthropicReauthDialog({ isOpen: false, account: null }),
					)
				}
			/>
			<CodexReauthDialog
				isOpen={codexReauthDialog.isOpen}
				account={codexReauthDialog.account}
				onClose={() => setCodexReauthDialog({ isOpen: false, account: null })}
				onSuccess={() =>
					handleReauthSuccess(() =>
						setCodexReauthDialog({ isOpen: false, account: null }),
					)
				}
			/>
		</div>
	);
}
