import { expect, test } from "bun:test";
import {
	isRouterRepository,
	ROUTER_REPOSITORIES,
	ROUTER_REPOSITORY_ID,
	type RouterRepository,
	routerRepositoryOrigins,
	validateRouterRepository,
} from "./router-repository";

test("Router authority is exactly two same-owner names and one numeric ID", () => {
	expect(ROUTER_REPOSITORIES).toEqual([
		"StartupBros/wstack-router",
		"StartupBros/hov-router",
	]);
	expect(ROUTER_REPOSITORY_ID).toBe(1278801682);
	for (const full_name of ROUTER_REPOSITORIES) {
		const metadata: RouterRepository = {
			id: 1278801682,
			full_name,
			name:
				full_name === "StartupBros/wstack-router"
					? "wstack-router"
					: "hov-router",
			owner: { login: "StartupBros" },
		};
		expect(isRouterRepository(full_name)).toBe(true);
		expect(validateRouterRepository(metadata)).toEqual(metadata);
		for (const patch of [
			{ id: undefined },
			{ id: 1 },
			{ id: "1278801682" },
			{ id: NaN },
			{ owner: undefined },
			{ owner: { login: "startupbros" } },
			{ name: "unrelated" },
			{ name: [metadata.name] },
			{ full_name: `other/${metadata.name}` },
			{ full_name: `${full_name}-extra` },
			{ full_name: `${full_name}/extra` },
			{ full_name: `prefix-${full_name}` },
			{ full_name: ` ${full_name}` },
			{ full_name: `${full_name}\n` },
		])
			expect(() =>
				validateRouterRepository({ ...metadata, ...patch }),
			).toThrow();
	}
	for (const metadata of [undefined, null, "StartupBros/hov-router", {}, []])
		expect(() => validateRouterRepository(metadata)).toThrow();
});

test("offline origin forms are literal and never require remote ID discovery", () => {
	for (const name of ROUTER_REPOSITORIES) {
		expect(routerRepositoryOrigins(name)).toEqual([
			`https://github.com/${name}`,
			`https://github.com/${name}.git`,
			`git@github.com:${name}.git`,
			`ssh://git@github.com/${name}.git`,
		]);
	}
	for (const name of [
		"StartupBros/hov-router-extra",
		"StartupBros/hov-router/extra",
		"startupbros/hov-router",
		"StartupBros-com/hov-router",
		"StartupBros/wstack-router.git",
		"other/hov-router",
	]) {
		expect(isRouterRepository(name)).toBe(false);
		expect(() => routerRepositoryOrigins(name)).toThrow();
	}
});
