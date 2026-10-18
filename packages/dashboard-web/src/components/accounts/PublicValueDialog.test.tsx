import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "../ui/dialog";
import { PublicValueForm } from "./PublicValueDialog";

function render(props: Partial<Parameters<typeof PublicValueForm>[0]> = {}) {
	return renderToStaticMarkup(
		<Dialog open>
			<PublicValueForm
				accountName="my-account"
				initialLabel=""
				onClose={() => {}}
				onSave={() => {}}
				{...props}
			/>
		</Dialog>,
	);
}

describe("PublicValueForm", () => {
	it("explains the label is public and must not be the account name", () => {
		const html = render();
		expect(html).toContain("shown publicly on the House of Vibe site");
		expect(html).toContain("must not");
		expect(html).toContain("be the account name");
	});

	it("prefills the stored label and leaves it empty when none", () => {
		expect(render({ initialLabel: "Max #1" })).toContain('value="Max #1"');
		expect(render()).toContain('value=""');
	});

	it("surfaces the server error message", () => {
		const html = render({ error: "label must not contain the account name" });
		expect(html).toContain("label must not contain the account name");
		expect(html).toContain('role="alert"');
		expect(render()).not.toContain('role="alert"');
	});
});
