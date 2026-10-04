import {
	createNomadToken,
	deleteNomadToken,
	listNomadTokens,
} from "@nomploy/server/services/nomad-acl";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";

export const nomadTokenRouter = createTRPCRouter({
	list: withPermission("server", "create").query(() => listNomadTokens()),

	create: withPermission("server", "create")
		.input(
			z.object({
				name: z
					.string()
					.trim()
					.min(1)
					.max(64)
					.regex(/^[a-zA-Z0-9._-]+$/, "Use letters, numbers, . _ - only"),
				scope: z.enum(["read", "deploy"]),
			}),
		)
		.mutation(({ input }) => createNomadToken(input.name, input.scope)),

	delete: withPermission("server", "delete")
		.input(z.object({ accessorId: z.string() }))
		.mutation(({ input }) => deleteNomadToken(input.accessorId)),
});
