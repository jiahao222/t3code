import * as Context from "effect/Context";

export const AntigravityUsageRefreshConfirmed = Context.Reference<boolean>(
  "t3/provider/AntigravityUsageRefreshConfirmed",
  { defaultValue: () => false },
);
