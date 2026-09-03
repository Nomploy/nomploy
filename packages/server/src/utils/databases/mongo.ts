import type { InferResultType } from "@nomploy/server/types/with";

export type MongoNested = InferResultType<
	"mongo",
	{ mounts: true; environment: { with: { project: true } } }
>;
