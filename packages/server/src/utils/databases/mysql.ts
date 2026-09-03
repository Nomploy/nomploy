import type { InferResultType } from "@nomploy/server/types/with";

export type MysqlNested = InferResultType<
	"mysql",
	{ mounts: true; environment: { with: { project: true } } }
>;
