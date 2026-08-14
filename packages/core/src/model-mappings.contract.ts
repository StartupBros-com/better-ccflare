import type { parseCustomEndpointData } from "./index";

type IsExact<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
			? true
			: false
		: false;
type Expect<T extends true> = T;

export type ParseCustomEndpointDataContract = Expect<
	IsExact<
		ReturnType<typeof parseCustomEndpointData>,
		{
			endpoint?: string;
			modelMappings?: Record<string, string>;
		} | null
	>
>;
