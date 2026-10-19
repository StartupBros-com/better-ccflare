import {
	valueWindowAggregates as valueCoreAggregates,
	type WindowTokenAggregate,
} from "@better-ccflare/core";
import {
	type ModelRouteProfile,
	parseModelRouteProfiles,
} from "@better-ccflare/proxy";

/** Keep observed model keys in the ledger, resolving configured route aliases
 * only for pricing. Unknown physical models retain the unpriced-token signal. */
export function valueWindowAggregates(
	aggregates: readonly WindowTokenAggregate[],
	atMs: number,
	profiles: readonly ModelRouteProfile[] = parseModelRouteProfiles(),
) {
	return valueCoreAggregates(aggregates, atMs, (model) => {
		if (!model.startsWith("claude-bccf-route-")) return model;
		const bare = model.replace(/\[1m\]$/, "");
		const profile = profiles.find(
			(p) => p.publicModelId === bare || p.discoveryModelId === model,
		);
		// Catalog roles can select a different physical model for each account.
		// Current config cannot reconstruct that historical selection safely.
		return profile && profile.physicalModelPolicy !== "catalog-role"
			? (profile.expectedPhysicalModel ?? model)
			: model;
	});
}
