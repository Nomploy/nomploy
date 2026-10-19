import {
	findApplicationById,
	findComposeById,
	updateCompose,
	wakeApplication,
} from "@nomploy/server";
import { db } from "@nomploy/server/db";
import { domains } from "@nomploy/server/db/schema";
import { getActivatorConfig } from "@nomploy/server/setup/activator";
import { eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";

/**
 * Internal wake endpoint called by the scale-to-zero activator. Given the Host of
 * a request that fell through to the activator (its service is sleeping), wake the
 * owning application/compose. Authenticated by the activator's shared secret —
 * never exposed to end users (the activator calls it server-to-server).
 */
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "POST")
		return res.status(405).json({ error: "POST only" });
	const cfg = getActivatorConfig();
	// Not enabled → behave as if the route doesn't exist.
	if (!cfg.enabled || cfg.secret === "")
		return res.status(404).json({ error: "activator disabled" });
	if (req.headers["x-activator-secret"] !== cfg.secret)
		return res.status(403).json({ error: "forbidden" });

	const host = String(req.body?.host ?? "")
		.toLowerCase()
		.trim();
	if (!host) return res.status(400).json({ error: "host required" });

	try {
		const domain = await db.query.domains.findFirst({
			where: eq(domains.host, host),
		});
		if (!domain) return res.status(404).json({ status: "notfound" });

		if (domain.applicationId) {
			const app = await findApplicationById(domain.applicationId);
			if (app.isSleeping) {
				await wakeApplication(app.applicationId);
				return res.json({ status: "woken" });
			}
			return res.json({ status: "awake" });
		}

		if (domain.composeId) {
			const compose = await findComposeById(domain.composeId);
			if (compose.isSleeping) {
				await updateCompose(compose.composeId, {
					isSleeping: false,
					sleepingSince: null,
				});
				const jobData: DeploymentJob = {
					composeId: compose.composeId,
					titleLog: "Wake (activator)",
					type: "redeploy",
					applicationType: "compose",
					descriptionLog: "",
					server: !!compose.serverId,
				};
				await myQueue.add(
					"deployments",
					{ ...jobData },
					{ removeOnComplete: true, removeOnFail: true },
				);
				return res.json({ status: "woken" });
			}
			return res.json({ status: "awake" });
		}

		return res.json({ status: "notfound" });
	} catch (error) {
		console.error("activator wake failed:", error);
		return res.status(500).json({ error: "wake failed" });
	}
}
