import { execAsyncRemote } from "../process/execAsync";

type NomadAlloc = { ID: string; ClientStatus: string };

const pickRunning = (allocs: NomadAlloc[]): string | undefined =>
	allocs.find((a) => a.ClientStatus === "running")?.ID;

/**
 * The id of a Nomad job's (job id = appName) currently running allocation, or
 * undefined if none. Queried on the server the job runs on (or the control
 * plane). Used to find the alloc's docker container (labelled with the alloc id)
 * for logs/exec/backups/schedules now that services run on Nomad, not Swarm.
 */
export const getRunningAllocId = async (
	appName: string,
	serverId?: string | null,
): Promise<string | undefined> => {
	if (serverId) {
		try {
			const { stdout } = await execAsyncRemote(
				serverId,
				`curl -s http://127.0.0.1:4646/v1/job/${appName}/allocations`,
			);
			return pickRunning(JSON.parse(stdout) as NomadAlloc[]);
		} catch {
			return undefined;
		}
	}
	const addr = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
	try {
		const res = await fetch(
			`${addr}/v1/job/${encodeURIComponent(appName)}/allocations`,
		);
		if (!res.ok) return undefined;
		return pickRunning((await res.json()) as NomadAlloc[]);
	} catch {
		return undefined;
	}
};
