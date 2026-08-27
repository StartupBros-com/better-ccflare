export {
	ROUTING_ATTEMPT_REASONS,
	ROUTING_ATTEMPT_SCOPES,
	type RoutingAttemptReason,
	type RoutingAttemptScope,
} from "@better-ccflare/types";

import { ROUTING_ATTEMPT_REASONS } from "@better-ccflare/types";

export const ROUTING_ATTEMPT_REASON_SQL = ROUTING_ATTEMPT_REASONS.map(
	(reason) => `'${reason}'`,
).join(", ");
