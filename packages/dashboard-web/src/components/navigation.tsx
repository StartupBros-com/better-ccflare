import {
	Activity,
	BarChart3,
	Bot,
	CircleDollarSign,
	FileText,
	GitBranch,
	History,
	Key,
	LayoutDashboard,
	Lightbulb,
	LogOut,
	Menu,
	RefreshCw,
	Settings,
	Shield,
	Users,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAlerts } from "../hooks/queries";
import { cn } from "../lib/utils";
import { version } from "../lib/version";
import { CopyButton } from "./CopyButton";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";

export interface UpdateStatusResponse {
	readonly currentVersion: string;
	readonly availability: "current" | "available" | "unavailable";
	readonly latestVersion: string | null;
	readonly action: {
		readonly kind: "command" | "url";
		readonly value: string;
	} | null;
	readonly reason: string;
}

interface UpdateStatusFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

type UpdateStatusFetcher = (
	input: string,
) => PromiseLike<UpdateStatusFetchResponse>;

export async function requestUpdateStatus(
	fetcher: UpdateStatusFetcher = fetch,
): Promise<UpdateStatusResponse> {
	const response = await fetcher("/api/version/check");
	if (!response.ok) throw new Error(`Update check failed: ${response.status}`);
	return (await response.json()) as UpdateStatusResponse;
}

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

interface UpdateCheckTimer {
	setInterval(callback: () => void, delay: number): unknown;
	clearInterval(handle: unknown): void;
}

export function scheduleUpdateChecks(
	checkForUpdates: () => void,
	timer: UpdateCheckTimer = globalThis,
): () => void {
	const interval = timer.setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
	return () => timer.clearInterval(interval);
}

export function UpdateStatusDetails({
	status,
	result,
}: {
	readonly status:
		| "idle"
		| "checking"
		| "available"
		| "current"
		| "unavailable"
		| "error";
	readonly result: UpdateStatusResponse | null;
}) {
	if (status === "available" && result?.latestVersion) {
		return (
			<div className="mt-2 space-y-1">
				<p className="text-xs text-muted-foreground text-left">
					{result.currentVersion} → {result.latestVersion}
				</p>
				{result.action?.kind === "command" && (
					<div className="flex items-center gap-1">
						<code className="text-xs bg-background px-1 py-0.5 rounded font-mono flex-1 truncate">
							{result.action.value}
						</code>
						<CopyButton
							value={result.action.value}
							size="sm"
							variant="ghost"
							className="h-6 w-6 p-0"
							title="Copy update command"
						/>
					</div>
				)}
				{result.action?.kind === "url" && (
					<a
						href={result.action.value}
						className="text-xs text-primary underline"
					>
						View release
					</a>
				)}
			</div>
		);
	}
	if (status === "current" && result) {
		return (
			<p className="mt-1 text-xs text-muted-foreground text-left">
				Version {result.currentVersion}
			</p>
		);
	}
	if (status === "unavailable" && result) {
		return (
			<p className="mt-1 text-xs text-muted-foreground text-left">
				{result.reason}
			</p>
		);
	}
	if (status === "error") {
		return (
			<p className="mt-1 text-xs text-destructive text-left">
				Update status could not be loaded.
			</p>
		);
	}
	return null;
}

interface NavItem {
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	path: string;
	badge?: string;
}

interface NavigationProps {
	onLogout?: () => void;
}

export function Navigation({ onLogout }: NavigationProps = {}) {
	const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
	const [updateStatus, setUpdateStatus] = useState<
		"idle" | "checking" | "available" | "current" | "unavailable" | "error"
	>("idle");
	const [updateResult, setUpdateResult] = useState<UpdateStatusResponse | null>(
		null,
	);
	const { data: alertData } = useAlerts();
	const unacknowledgedCount = alertData?.unacknowledgedCount ?? 0;
	const location = useLocation();
	const isMountedRef = useRef(true);

	// Build nav items with the current alert badge
	const navItems: NavItem[] = useMemo(() => {
		const baseItems: NavItem[] = [
			{ label: "Overview", icon: LayoutDashboard, path: "/" },
			{ label: "Analytics", icon: BarChart3, path: "/analytics" },
			{
				label: "Insights",
				icon: Lightbulb,
				path: "/insights",
				badge:
					unacknowledgedCount > 0 ? String(unacknowledgedCount) : undefined,
			},
			{ label: "Requests", icon: Activity, path: "/requests" },
			{ label: "Accounts", icon: Users, path: "/accounts" },
			{ label: "Usage History", icon: History, path: "/usage-history" },
			{
				label: "Window Value",
				icon: CircleDollarSign,
				path: "/window-value",
			},
		];

		baseItems.push({ label: "Combos", icon: Zap, path: "/combos" });

		// Add remaining items
		baseItems.push(
			{ label: "Agents", icon: Bot, path: "/agents" },
			{ label: "API Keys", icon: Key, path: "/api-keys" },
			{ label: "Logs", icon: FileText, path: "/logs" },
			{ label: "Settings", icon: Settings, path: "/settings" },
		);

		return baseItems;
	}, [unacknowledgedCount]);

	const checkForUpdates = useCallback(async () => {
		if (!isMountedRef.current) return;
		setUpdateStatus("checking");
		try {
			const result = await requestUpdateStatus();
			if (!isMountedRef.current) return;
			setUpdateResult(result);
			setUpdateStatus(result.availability);
		} catch {
			if (!isMountedRef.current) return;
			setUpdateResult(null);
			setUpdateStatus("error");
		}
	}, []);

	useEffect(() => {
		isMountedRef.current = true;
		checkForUpdates();
		const cancelUpdateChecks = scheduleUpdateChecks(checkForUpdates);
		return () => {
			isMountedRef.current = false;
			cancelUpdateChecks();
		};
	}, [checkForUpdates]);

	return (
		<>
			{/* Mobile header */}
			<div className="lg:hidden fixed top-0 left-0 right-0 z-50 h-16 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b px-4 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<Shield className="h-6 w-6 text-primary" />
					<span className="font-semibold text-lg">better-ccflare</span>
				</div>
				<div className="flex items-center gap-2">
					<ThemeToggle />
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
					>
						{isMobileMenuOpen ? (
							<X className="h-5 w-5" />
						) : (
							<Menu className="h-5 w-5" />
						)}
					</Button>
				</div>
			</div>

			{/* Mobile menu overlay */}
			{isMobileMenuOpen && (
				<button
					type="button"
					className="lg:hidden fixed inset-0 z-40 bg-background/80 backdrop-blur-sm cursor-default"
					onClick={() => setIsMobileMenuOpen(false)}
					aria-label="Close menu"
				/>
			)}

			{/* Sidebar */}
			<aside
				className={cn(
					"fixed left-0 top-0 z-40 h-screen w-64 bg-card border-r transition-transform duration-300 lg:translate-x-0",
					isMobileMenuOpen
						? "translate-x-0"
						: "-translate-x-full lg:translate-x-0",
				)}
			>
				<div className="flex h-full flex-col">
					{/* Logo */}
					<div className="p-6 pb-4">
						<div className="flex items-center gap-3">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
								<Shield className="h-6 w-6 text-primary" />
							</div>
							<div>
								<h1 className="font-semibold text-lg">better-ccflare</h1>
								<p className="text-xs text-muted-foreground">
									Powerful proxy for Claude Code
								</p>
							</div>
						</div>
					</div>

					<Separator />

					{/* Navigation */}
					<nav className="flex-1 space-y-1 p-4">
						{navItems.map((item) => {
							const Icon = item.icon;
							const isActive = location.pathname === item.path;
							return (
								<Link
									key={item.path}
									to={item.path}
									onClick={() => setIsMobileMenuOpen(false)}
								>
									<Button
										variant={isActive ? "secondary" : "ghost"}
										className={cn(
											"w-full justify-start gap-3 transition-all",
											isActive &&
												"bg-primary/10 text-primary hover:bg-primary/20",
										)}
									>
										<Icon className="h-4 w-4" />
										{item.label}
										{item.badge && (
											<span className="ml-auto rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium">
												{item.badge}
											</span>
										)}
									</Button>
								</Link>
							);
						})}
						{onLogout && (
							<Button
								variant="ghost"
								className="w-full justify-start gap-3 transition-all text-muted-foreground hover:text-destructive"
								onClick={() => {
									setIsMobileMenuOpen(false);
									onLogout();
								}}
							>
								<LogOut className="h-4 w-4" />
								Log Out
							</Button>
						)}
					</nav>

					<Separator />

					{/* Footer */}
					<div className="p-4 space-y-4">
						<div className="rounded-lg bg-muted/50 p-3">
							<div className="flex items-center gap-2 text-sm">
								<Zap className="h-4 w-4 text-primary" />
								<span className="font-medium">Status</span>
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								All systems operational
							</p>
						</div>

						{/* Update Check */}
						<div
							className={cn(
								"rounded-lg bg-muted/50 p-3",
								updateStatus === "checking" && "opacity-50",
							)}
						>
							<button
								type="button"
								onClick={checkForUpdates}
								disabled={updateStatus === "checking"}
								className="w-full transition-colors hover:bg-muted/50 -m-3 p-3 rounded-lg"
							>
								<div className="flex items-center gap-2 text-sm">
									<RefreshCw
										className={cn(
											"h-4 w-4",
											updateStatus === "checking" && "animate-spin",
											updateStatus === "available" && "text-green-500",
											updateStatus === "current" && "text-primary",
											updateStatus === "error" && "text-red-500",
										)}
									/>
									<span className="font-medium">
										{updateStatus === "idle" && "Check for Updates"}
										{updateStatus === "checking" && "Checking..."}
										{updateStatus === "available" && "Update Available"}
										{updateStatus === "current" && "Up to Date"}
										{updateStatus === "unavailable" && "Updates Unavailable"}
										{updateStatus === "error" && "Check Failed"}
									</span>
								</div>
							</button>
							<UpdateStatusDetails
								status={updateStatus}
								result={updateResult}
							/>
						</div>

						<div className="hidden lg:flex items-center justify-between">
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<GitBranch className="h-3 w-3" />
								<span>{version}</span>
							</div>
							<ThemeToggle />
						</div>
					</div>
				</div>
			</aside>
		</>
	);
}
