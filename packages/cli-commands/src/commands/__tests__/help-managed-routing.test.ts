import { describe, expect, it } from "bun:test";
import { getHelpText } from "../help";

describe("legacy CLI managed-routing help", () => {
	it("identifies the product and documents the compatible command", () => {
		const help = getHelpText();
		expect(help).toContain("wstack Router");
		expect(help).toContain("Usage: wstack-router <command> [options]");
		expect(help).toContain("better-ccflare remains a supported alias");
		expect(help).toContain("wstack-router add myaccount");
		expect(help).not.toContain("  better-ccflare ");
	});
	it("matches the shipped command syntax and never advertises a credential flag", () => {
		const help = getHelpText();

		expect(help).toContain("routing list");
		expect(help).toContain("routing detail <account-id>");
		expect(help).toContain("routing preview <family>");
		expect(help).toContain(
			"routing apply <family> --preview-id <id> --proposal-id <id> --managed-model <model> --yes",
		);
		expect(help).toContain("routing manual <family> --yes");
		expect(help).toContain("--api-url <loopback-url>");
		expect(help).not.toContain("--admin-api-key");
	});
});
