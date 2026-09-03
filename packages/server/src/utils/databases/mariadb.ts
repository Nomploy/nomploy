import type { InferResultType } from "@nomploy/server/types/with";

export type MariadbNested = InferResultType<
	"mariadb",
	{ mounts: true; environment: { with: { project: true } } }
>;
