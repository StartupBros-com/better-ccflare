import type { ProviderModelDefaultField } from "../../lib/provider-model-defaults-api";

/**
 * Pure copy-generation for `ProviderModelDefaultsDialog`'s per-field
 * placeholder/hint text, split out so it is unit-testable without rendering
 * the dialog (its `Dialog`/`DialogContent` portal renders nothing under
 * `renderToStaticMarkup`; see `codex-family-status.ts` for the same pattern).
 *
 * `field.factory` (`getProviderModelDefaultFactories()`) is already the
 * compiled map overlaid with provider-wide catalog-derived defaults — i.e.
 * exactly the value that applies when there is no saved override.
 * `field.effective` (`resolveProviderModelDefault(provider, family)`, no
 * accountId) only ever diverges from `field.factory` when a global override
 * is saved (`effective` becomes that override); with no override,
 * `effective === factory` always. So copy describing "what applies without
 * the override" must name `field.factory`, never `field.effective` — naming
 * `effective` on a customized field just echoes the override back at itself.
 *
 * A saved override here PINS that family for every account that has no
 * mapping of its own, AHEAD of that account's own catalog default — it does
 * not merely apply "after" the catalog. Copy must say so plainly, not read
 * as if an unmapped account's catalog always wins over a saved value here.
 */

/** What the field shows as a placeholder when no override is set. */
export function providerFieldPlaceholder(
	field: Pick<ProviderModelDefaultField, "effective" | "factory">,
): string {
	return `${field.effective || field.factory} (current default)`;
}

/** The `[11px]` hint line under the field, given whether it has a draft override. */
export function providerFieldHint(
	field: Pick<ProviderModelDefaultField, "effective" | "factory" | "override">,
	customized: boolean,
): string {
	if (customized) {
		return `Customized. Without this override: ${field.factory}.`;
	}
	if (field.override) {
		// The draft was reset to empty (handleReset) but Save has not run yet:
		// the server-reported override — and therefore `effective` — still
		// applies until Save.
		return `Saved override still applies: ${field.override}. Save to let accounts with no mapping of their own follow their catalog again, falling back to ${field.factory}.`;
	}
	return `Current default: ${field.factory}. Accounts with no mapping of their own follow their own catalog first; this is only the fallback.`;
}

/**
 * Title of the reset button next to a customized field. Clearing the draft
 * removes the saved override, letting every account with no mapping of its
 * own follow its own current catalog default again — falling back to the
 * factory value shown here only when that account has none.
 */
export function providerFieldResetTitle(
	field: Pick<ProviderModelDefaultField, "factory">,
): string {
	return `Clear override (falls back to ${field.factory} for accounts with no catalog of their own)`;
}
