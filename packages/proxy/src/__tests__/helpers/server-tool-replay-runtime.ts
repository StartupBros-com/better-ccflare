import {
	createDurableServerToolReplayWriterAdmission,
	createServerToolReplayRuntime,
	type ServerToolReplayRuntimeState,
} from "../../server-tool-replay-runtime";

const TEST_REPLAY_KEY = Array.from({ length: 32 }, (_, index) => index + 1);

export type TestServerToolReplayIssuanceReservation = Readonly<{
	counterIdentity: string;
	reservationSize: number;
	firstIssuanceCount: number;
	lastIssuanceCount: number;
}>;

export type TestServerToolReplayRuntimeObserver = Readonly<{
	onReserveReplayIssuanceRange?: (
		reservation: TestServerToolReplayIssuanceReservation,
	) => void;
}>;

/** Build a factory runtime over the real durable range-to-lease adapter. */
export async function createReadyServerToolReplayRuntimeForTest(
	observer: TestServerToolReplayRuntimeObserver = {},
): Promise<
	Extract<ServerToolReplayRuntimeState, Readonly<{ status: "ready" }>>
> {
	let lastIssuanceCount = 0;
	const durableAdmission = createDurableServerToolReplayWriterAdmission({
		reserveReplayIssuanceRange: async (input) => {
			const firstIssuanceCount = lastIssuanceCount + 1;
			lastIssuanceCount += input.reservationSize;
			observer.onReserveReplayIssuanceRange?.(
				Object.freeze({
					counterIdentity: input.counterIdentity,
					reservationSize: input.reservationSize,
					firstIssuanceCount,
					lastIssuanceCount,
				}),
			);
			return Object.freeze({
				counterIdentity: input.counterIdentity,
				firstIssuanceCount,
				lastIssuanceCount,
			});
		},
	});
	if (durableAdmission.status !== "ready") {
		throw new Error("test durable replay admission was not ready");
	}
	const runtime = await createServerToolReplayRuntime(
		{
			status: "ready",
			activeKeyId: "test-active",
			keys: [
				{
					id: "test-active",
					status: "active",
					key: TEST_REPLAY_KEY,
				},
			],
		},
		{
			writerAdmission: durableAdmission.writerAdmission,
		},
	);
	if (runtime.status !== "ready") {
		throw new Error("test server-tool replay runtime was not ready");
	}
	return runtime;
}
