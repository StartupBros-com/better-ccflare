/** Release authority only. Import directly; the core runtime barrel does not need it. */
export const ROUTER_REPOSITORY_ID = 1278801682;
export const ROUTER_OWNER = "StartupBros";
export const ROUTER_REPOSITORIES = [
	"StartupBros/wstack-router",
	"StartupBros/hov-router",
] as const;
export type RouterRepositoryName = (typeof ROUTER_REPOSITORIES)[number];

export function isRouterRepository(
	name: unknown,
): name is RouterRepositoryName {
	return ROUTER_REPOSITORIES.some((repository) => repository === name);
}

/** Offline builds prove an exact origin and tagged source, not remote repository ID. */
export function routerRepositoryOrigins(name: string): readonly string[] {
	if (!isRouterRepository(name)) throw new Error("Wrong Router repository");
	return [
		`https://github.com/${name}`,
		`https://github.com/${name}.git`,
		`git@github.com:${name}.git`,
		`ssh://git@github.com/${name}.git`,
	];
}

export interface RouterRepository {
	id: typeof ROUTER_REPOSITORY_ID;
	full_name: RouterRepositoryName;
	name: "wstack-router" | "hov-router";
	owner: { login: typeof ROUTER_OWNER };
}

/** API/event metadata must prove the stable numeric ID and all exact name fields. */
export function validateRouterRepository(metadata: unknown): RouterRepository {
	const repository = metadata as Partial<RouterRepository> | null | undefined;
	if (
		repository?.id !== ROUTER_REPOSITORY_ID ||
		!isRouterRepository(repository.full_name) ||
		repository.owner?.login !== ROUTER_OWNER ||
		typeof repository.name !== "string" ||
		`${repository.owner.login}/${repository.name}` !== repository.full_name
	)
		throw new Error("Wrong Router repository identity (owner/name/numeric ID)");
	return repository as RouterRepository;
}
