import type { InferResultType } from "@nomploy/server/types/with";

export type RedisNested = InferResultType<
	"redis",
	{ mounts: true; environment: { with: { project: true } } }
>;
