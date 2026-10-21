/** Display identity only. Operational namespaces and distribution authority are separate. */
export const PRODUCT_NAME = "HoV Router";
export const COMMAND_NAME = "hov-router";
export const LEGACY_COMMAND_NAME = "better-ccflare";
export const COMMAND_NAMES = [
	COMMAND_NAME,
	"wstack-router",
	LEGACY_COMMAND_NAME,
] as const;
