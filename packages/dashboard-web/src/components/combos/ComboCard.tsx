import type { Combo, ComboFamilyAssignment } from "@better-ccflare/types";
import { Edit, Trash2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Switch } from "../ui/switch";
import type { FamilyRoutingProjection } from "./family-routing";

export interface ComboFamilyRoutingCardState {
	assignment: ComboFamilyAssignment;
	/** Null means the authoritative effective-routing snapshot is unavailable. */
	routing: FamilyRoutingProjection | null;
}

interface ComboCardProps {
	combo: Combo;
	slotCount?: number;
	familyRoutings?: readonly ComboFamilyRoutingCardState[];
	onEdit: () => void;
	onDelete: () => void;
	onToggleEnabled: (enabled: boolean) => void;
}

function familyLabel(family: ComboFamilyAssignment["family"]): string {
	return family.charAt(0).toUpperCase() + family.slice(1);
}

export function ComboCard({
	combo,
	slotCount = 0,
	familyRoutings = [],
	onEdit,
	onDelete,
	onToggleEnabled,
}: ComboCardProps) {
	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0 flex-1">
						<CardTitle className="text-base leading-snug">
							{combo.name}
						</CardTitle>
						{combo.description && (
							<p className="mt-1 text-sm text-muted-foreground line-clamp-2">
								{combo.description}
							</p>
						)}
					</div>
					<Switch
						checked={combo.enabled}
						onCheckedChange={onToggleEnabled}
						aria-label={`${combo.name} enabled`}
					/>
				</div>
			</CardHeader>
			<CardContent className="pt-0">
				<div className="space-y-4">
					<div className="flex items-center justify-between gap-3">
						<span className="text-sm text-muted-foreground">
							{`${slotCount} persisted Manual ${slotCount === 1 ? "slot" : "slots"}`}
						</span>
						<div className="flex items-center gap-1">
							<Button
								variant="ghost"
								size="sm"
								onClick={onEdit}
								aria-label={`Edit ${combo.name}`}
							>
								<Edit className="h-4 w-4" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={onDelete}
								className="text-destructive hover:text-destructive"
								aria-label={`Delete ${combo.name}`}
							>
								<Trash2 className="h-4 w-4" />
							</Button>
						</div>
					</div>

					{familyRoutings.length > 0 && (
						<ul
							className="list-none space-y-2"
							aria-label={`${combo.name} assigned families`}
						>
							{familyRoutings.map(({ assignment, routing }) => {
								const displayFamily = familyLabel(assignment.family);
								const manualMemberCount = routing?.manualMembers.length;
								const managedMemberCount = routing?.managedMembers.length;
								const effectiveMemberCount =
									manualMemberCount !== undefined &&
									managedMemberCount !== undefined
										? manualMemberCount + managedMemberCount
										: null;
								const modeLabel =
									assignment.membership_mode === "managed"
										? "Managed mode"
										: "Manual mode";

								return (
									<li
										key={assignment.family}
										className="space-y-2 rounded-md border bg-muted/20 p-3"
										data-family={assignment.family}
										aria-label={`${displayFamily} family routing`}
									>
										<div className="flex flex-wrap items-center gap-2">
											<Badge variant="secondary" className="text-xs">
												{displayFamily}
											</Badge>
											<Badge
												variant={
													assignment.membership_mode === "managed"
														? "default"
														: "outline"
												}
												className="text-xs"
											>
												{modeLabel}
											</Badge>
											{!assignment.enabled && (
												<Badge variant="outline" className="text-xs">
													Inactive
												</Badge>
											)}
										</div>

										{assignment.membership_mode === "managed" && (
											<p className="break-all text-xs text-muted-foreground">
												{`Logical model: ${assignment.managed_model ?? "Not configured"}`}
											</p>
										)}

										{effectiveMemberCount === null ? (
											<p className="text-xs text-muted-foreground">
												Effective membership unavailable
											</p>
										) : (
											<fieldset
												className="space-y-1"
												aria-label={`${displayFamily} authoritative effective membership`}
											>
												<legend className="text-xs font-medium text-foreground">
													Authoritative effective membership
												</legend>
												<div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
													<span>{`Manual members: ${manualMemberCount}`}</span>
													<span>{`Managed members: ${managedMemberCount}`}</span>
													<span>{`Effective members: ${effectiveMemberCount}`}</span>
												</div>
											</fieldset>
										)}
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
