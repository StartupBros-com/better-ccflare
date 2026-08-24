// These ceilings bound translator work while remaining far below the 32 MiB
// request-body admission limit. Input and tool definitions are both compact
// request elements, so matching limits avoid an arbitrary tighter tool cap.
export const MAX_RESPONSES_INPUT_ITEMS = 100_000;
export const MAX_RESPONSES_TOOLS = 100_000;
