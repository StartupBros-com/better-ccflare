import { useState } from "react";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface PublicValueDialogProps {
	isOpen: boolean;
	accountName: string;
	/** Stored label, or "" when none. */
	initialLabel: string;
	onClose: () => void;
	onSave: (label: string) => void;
	isLoading?: boolean;
	/** Server error (e.g. the 400 message) shown under the input. */
	error?: string | null;
}

/**
 * Form body, split out so tests can render it without the Radix portal.
 * The server owns label validation; the client only rejects an empty label.
 */
export function PublicValueForm({
	accountName,
	initialLabel,
	onClose,
	onSave,
	isLoading = false,
	error = null,
}: Omit<PublicValueDialogProps, "isOpen">) {
	const [label, setLabel] = useState(initialLabel);
	const [localError, setLocalError] = useState("");

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = label.trim();
		if (!trimmed) {
			setLocalError("Public label cannot be empty");
			return;
		}
		setLocalError("");
		onSave(trimmed);
	};

	const shownError = localError || error;

	return (
		<form onSubmit={handleSubmit}>
			<DialogHeader>
				<DialogTitle>Public value label</DialogTitle>
				<DialogDescription>
					Choose the label for account "{accountName}" on the public value feed.
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-4 py-4">
				<div className="grid gap-2">
					<Label htmlFor="public-value-label">Public label</Label>
					<Input
						id="public-value-label"
						value={label}
						onChange={(e) => {
							setLabel(e.target.value);
							setLocalError("");
						}}
						placeholder="e.g. Claude Max #1"
						autoFocus
						disabled={isLoading}
					/>
					<p className="text-xs text-muted-foreground">
						This label is shown publicly on the House of Vibe site. It must not
						be the account name.
					</p>
					{shownError && (
						<p className="text-sm text-destructive" role="alert">
							{shownError}
						</p>
					)}
				</div>
			</div>
			<DialogFooter>
				<Button
					type="button"
					variant="outline"
					onClick={onClose}
					disabled={isLoading}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={isLoading}>
					{isLoading ? "Saving..." : "Save and publish"}
				</Button>
			</DialogFooter>
		</form>
	);
}

export function PublicValueDialog({
	isOpen,
	onClose,
	...formProps
}: PublicValueDialogProps) {
	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<PublicValueForm {...formProps} onClose={onClose} />
			</DialogContent>
		</Dialog>
	);
}
