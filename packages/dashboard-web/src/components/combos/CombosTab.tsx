import type { ComboFamilyAssignment } from "@better-ccflare/types";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
	useCombos,
	useDeleteCombo,
	useEffectiveRouting,
	useFamilies,
	useUpdateCombo,
} from "../../hooks/queries";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { ComboCard, type ComboFamilyRoutingCardState } from "./ComboCard";
import { ComboDialog } from "./ComboDialog";
import { FamilyActivationSection } from "./FamilyActivationSection";
import {
	type FamilyRoutingProjection,
	projectFamilyRoutings,
} from "./family-routing";

/**
 * Join assignment configuration to the coherent effective-routing snapshots.
 * A snapshot owns effective counts; an assignment without one remains visible
 * but deliberately has no client-inferred membership count.
 */
export function buildComboFamilyRoutingStates(
	comboId: string,
	assignments: readonly ComboFamilyAssignment[],
	projections: readonly FamilyRoutingProjection[],
): ComboFamilyRoutingCardState[] {
	const projectionByFamily = new Map(
		projections.map((projection) => [projection.family, projection]),
	);
	const statesByFamily = new Map<
		ComboFamilyAssignment["family"],
		ComboFamilyRoutingCardState
	>();

	for (const assignment of assignments) {
		if (assignment.combo_id !== comboId) continue;
		const projection = projectionByFamily.get(assignment.family) ?? null;
		if (projection && projection.assignment.combo_id !== comboId) continue;
		statesByFamily.set(assignment.family, {
			assignment: projection?.assignment ?? assignment,
			routing: projection,
		});
	}

	// A coherent routing snapshot may be newer than the separately cached family
	// list. Preserve every family the server currently assigns to this combo.
	for (const projection of projections) {
		if (projection.assignment.combo_id !== comboId) continue;
		statesByFamily.set(projection.family, {
			assignment: projection.assignment,
			routing: projection,
		});
	}

	return [...statesByFamily.values()];
}

export function CombosTab() {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [editDialogComboId, setEditDialogComboId] = useState<string | null>(
		null,
	);
	const combosQuery = useCombos();
	const familiesQuery = useFamilies();
	const effectiveRoutingQuery = useEffectiveRouting();
	const deleteCombo = useDeleteCombo();
	const updateCombo = useUpdateCombo();
	const combos = combosQuery.data?.combos ?? [];
	const families = familiesQuery.data?.families ?? [];
	const effectiveData = effectiveRoutingQuery.data;
	const effectiveViews = effectiveData
		? Array.isArray(effectiveData)
			? effectiveData
			: [effectiveData]
		: [];
	const routingProjections = projectFamilyRoutings(effectiveViews);

	return (
		<div className="space-y-6">
			<FamilyActivationSection />

			<Separator />

			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-semibold">Combos</h2>
					<Button onClick={() => setIsCreateDialogOpen(true)}>
						<Plus className="mr-2 h-4 w-4" />
						Create Combo
					</Button>
				</div>

				{combosQuery.isLoading && (
					<p className="text-sm text-muted-foreground">Loading combos...</p>
				)}

				{combosQuery.isError && (
					<p className="text-sm text-destructive">Failed to load combos.</p>
				)}

				{!combosQuery.isLoading &&
					!combosQuery.isError &&
					combos.length === 0 && (
						<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-8 py-12 text-center">
							<p className="text-sm text-muted-foreground">
								No combos yet. Create one to define a fallback chain.
							</p>
							<Button size="sm" onClick={() => setIsCreateDialogOpen(true)}>
								<Plus className="mr-2 h-4 w-4" />
								Create Combo
							</Button>
						</div>
					)}

				{combos.length > 0 && (
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{combos.map((combo) => (
							<ComboCard
								key={combo.id}
								combo={combo}
								slotCount={combo.slot_count}
								familyRoutings={buildComboFamilyRoutingStates(
									combo.id,
									families,
									routingProjections,
								)}
								onEdit={() => setEditDialogComboId(combo.id)}
								onDelete={() => deleteCombo.mutate(combo.id)}
								onToggleEnabled={(enabled) =>
									updateCombo.mutate({ id: combo.id, enabled })
								}
							/>
						))}
					</div>
				)}
			</div>

			<ComboDialog
				isOpen={isCreateDialogOpen}
				onClose={() => setIsCreateDialogOpen(false)}
			/>

			<ComboDialog
				isOpen={!!editDialogComboId}
				comboId={editDialogComboId}
				onClose={() => setEditDialogComboId(null)}
			/>
		</div>
	);
}
