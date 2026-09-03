import type { InferResultType } from "@nomploy/server/types/with";

export type LibsqlNested = InferResultType<
	"libsql",
	{
		mounts: true;
		environment: { with: { project: true } };
	}
>;
