import { execAsync, execAsyncRemote } from "../process/execAsync";

type NomadAlloc = {
	ID: string;
	ClientStatus: string;
	DesiredStatus?: string;
	NodeName?: string;
	TaskGroup?: string;
};

const pickRunning = (allocs: NomadAlloc[]): string | undefined =>
	allocs.find((a) => a.ClientStatus === "running")?.ID;

/**
 * All allocations of a Nomad job (job id = appName), newest not guaranteed,
 * queried on the server the job runs on (or the control plane). Empty on any
 * error or when the job doesn't exist.
 */
export const getJobAllocations = async (
	appName: string,
	serverId?: string | null,
): Promise<NomadAlloc[]> => {
	try {
		if (serverId) {
			const { stdout } = await execAsyncRemote(
				serverId,
				`curl -s http://127.0.0.1:4646/v1/job/${appName}/allocations`,
			);
			return JSON.parse(stdout) as NomadAlloc[];
		}
		const addr = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
		const res = await fetch(
			`${addr}/v1/job/${encodeURIComponent(appName)}/allocations`,
		);
		if (!res.ok) return [];
		return (await res.json()) as NomadAlloc[];
	} catch {
		return [];
	}
};

/**
 * The id of a Nomad job's (job id = appName) currently running allocation, or
 * undefined if none. Used to find the alloc's docker container (labelled with
 * the alloc id) for logs/exec/backups/schedules now that services run on Nomad,
 * not Swarm.
 */
export const getRunningAllocId = async (
	appName: string,
	serverId?: string | null,
): Promise<string | undefined> => {
	return pickRunning(await getJobAllocations(appName, serverId));
};

// Superset of the two legacy container-listing shapes so both callers'
// consumers keep working: getContainersByAppNameMatch reads `status`, while
// getServiceContainersByAppName reads `currentState`/`node`/`error`.
export interface NomadContainerInfo {
	containerId: string;
	name: string;
	state: string;
	status: string;
	currentState: string;
	node: string;
	error: string;
}

const ALLOC_ID_LABEL = "com.hashicorp.nomad.alloc_id";

/**
 * The docker containers backing a Nomad job's allocations. Nomad names an
 * allocation's container `<task-group>-<allocId>` and labels it with the alloc
 * id, so we list the app's allocations, then match them to the containers by
 * that label (one Nomad query + one `docker ps`). Returns [] when the app isn't
 * a Nomad job — callers fall back to their legacy lookup for that case.
 *
 * This is the Nomad replacement for the Swarm `docker service ps` / name-grep
 * container listings used by the app logs UI.
 */
export const getNomadJobContainers = async (
	appName: string,
	serverId?: string | null,
): Promise<NomadContainerInfo[]> => {
	const allocs = await getJobAllocations(appName, serverId);
	if (allocs.length === 0) return [];

	const format = `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Label "${ALLOC_ID_LABEL}"}}`;
	const command = `docker ps -a --filter "label=${ALLOC_ID_LABEL}" --format '${format}'`;
	let stdout = "";
	try {
		const res = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		stdout = res.stdout;
	} catch {
		return [];
	}

	const byAlloc = new Map<
		string,
		{ id: string; name: string; state: string; status: string }
	>();
	for (const line of stdout.trim().split("\n").filter(Boolean)) {
		const [id = "", name = "", state = "", status = "", allocId = ""] =
			line.split("\t");
		if (allocId) byAlloc.set(allocId, { id, name, state, status });
	}

	return allocs
		.map((a): NomadContainerInfo => {
			const c = byAlloc.get(a.ID);
			const status = c?.status || a.ClientStatus || "";
			return {
				containerId: c?.id || "",
				name: c?.name || `${a.TaskGroup || appName}-${a.ID.slice(0, 8)}`,
				state: (c?.state || a.ClientStatus || "").toLowerCase(),
				status,
				currentState: status,
				node: a.NodeName || "",
				error: "",
			};
		})
		.filter((c) => c.containerId);
};
