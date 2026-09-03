import type { InferResultType } from "@nomploy/server/types/with";

export type PostgresNested = InferResultType<
	"postgres",
	{ mounts: true; environment: { with: { project: true } } }
>;
