import { eq } from "drizzle-orm";
import { db } from "../db";
import { networkPolicies, projects } from "../db/schema";
import { NOMPLOY_PROJECT_TAG } from "../utils/builders/nomad";

/**
 * Phase B segmentation — Consul Connect intentions engine (pure computation).
 *
 * Isolated projects' services join the Connect mesh and are tagged
 * `${NOMPLOY_PROJECT_TAG}<projectId>` in Consul. From the live catalog we know
 * which mesh service belongs to which project; combined with the network_policy
 * allow-rules (source project → target project) we compute, for every mesh
 * service in an isolated project, the set of source services allowed to reach it.
 * A wildcard deny makes everything else default-deny.
 *
 * The router turns each DesiredIntention into a Consul `service-intentions`
 * config entry (marked managed-by=nomploy so it can prune stale ones), and
 * re-runs this on deploy and whenever isolation/policies change.
 */

export const INTENTION_MANAGED_BY = "nomploy";

export interface MeshService {
	/** Consul service name (the destination/source identity for intentions). */
	name: string;
	/** Project the service belongs to (from its Consul tag). */
	projectId: string;
}

export interface PolicyEdge {
	/** Project allowed to initiate traffic. */
	source: string;
	/** Isolated project accepting the traffic. */
	target: string;
}

export interface DesiredIntention {
	/** Destination mesh service name. */
	destination: string;
	/** Source service names allowed to reach it (a "*" deny is appended). */
	allowedSources: string[];
}

/** Extract the project id a Consul service is tagged with, or null if none. */
export const projectFromTags = (tags: string[]): string | null => {
	for (const t of tags) {
		if (t.startsWith(NOMPLOY_PROJECT_TAG)) {
			return t.slice(NOMPLOY_PROJECT_TAG.length) || null;
		}
	}
	return null;
};

/** Build the list of mesh services from a Consul catalog listing (name → tags). */
export const meshServicesFromCatalog = (
	catalog: Record<string, string[]>,
): MeshService[] => {
	const services: MeshService[] = [];
	for (const [name, tags] of Object.entries(catalog)) {
		const projectId = projectFromTags(tags || []);
		if (projectId) services.push({ name, projectId });
	}
	return services;
};

/**
 * For every mesh service in an isolated project, the source services allowed to
 * reach it: services in the same project plus services in any project with an
 * allow-rule to it. Services in non-isolated projects get no intention (they are
 * not in the mesh, so they stay reachable as before).
 */
export const computeIntentions = (
	services: MeshService[],
	isolatedProjectIds: Iterable<string>,
	policyEdges: PolicyEdge[],
): DesiredIntention[] => {
	const isolated = new Set(isolatedProjectIds);
	const allowedSourceProjects = (target: string): Set<string> => {
		const set = new Set<string>([target]);
		for (const e of policyEdges) if (e.target === target) set.add(e.source);
		return set;
	};

	const intentions: DesiredIntention[] = [];
	for (const dest of services) {
		if (!isolated.has(dest.projectId)) continue;
		const allowProjects = allowedSourceProjects(dest.projectId);
		const allowedSources = Array.from(
			new Set(
				services
					.filter((s) => allowProjects.has(s.projectId))
					.map((s) => s.name),
			),
		).sort();
		intentions.push({ destination: dest.name, allowedSources });
	}
	return intentions;
};

/** The Consul `service-intentions` config entry body for one desired intention. */
export const intentionConfigEntry = (intention: DesiredIntention) => ({
	Kind: "service-intentions",
	Name: intention.destination,
	Meta: { "managed-by": INTENTION_MANAGED_BY },
	Sources: [
		...intention.allowedSources.map((name) => ({
			Name: name,
			Action: "allow" as const,
		})),
		// Everything not explicitly allowed is denied.
		{ Name: "*", Action: "deny" as const },
	],
});

// ── Live reconcile against the control-plane Consul ─────────────────────────
// The panel runs on the hub (host networking) so the cluster-wide Consul is at
// 127.0.0.1:8500. Config entries (intentions) are cluster-global, so a single
// write applies everywhere.
const CONSUL_ADDRESS = process.env.CONSUL_ADDRESS || "http://127.0.0.1:8500";
const CONSUL_TOKEN = process.env.CONSUL_TOKEN || "";

const consulFetch = (path: string, init?: RequestInit) => {
	const headers: Record<string, string> = {};
	if (CONSUL_TOKEN) headers["X-Consul-Token"] = CONSUL_TOKEN;
	return fetch(`${CONSUL_ADDRESS.replace(/\/$/, "")}/v1${path}`, {
		...init,
		headers,
	});
};

/**
 * Reconcile the cluster's service-intentions to the current isolated projects +
 * network_policy allow-rules for an org. Idempotent + fail-closed (a global "*"
 * deny catches un-synced mesh services). Only prunes nomploy-managed entries.
 * Safe to call after every deploy and on every policy/isolation change.
 */
export const syncIntentionsForOrg = async (
	organizationId: string,
): Promise<{ applied: number; pruned: number }> => {
	const catalogRes = await consulFetch("/catalog/services");
	if (!catalogRes.ok) return { applied: 0, pruned: 0 };
	const catalog = (await catalogRes.json()) as Record<string, string[]>;
	const meshServices = meshServicesFromCatalog(catalog);

	const orgProjects = await db.query.projects.findMany({
		where: eq(projects.organizationId, organizationId),
		columns: { projectId: true, isolated: true },
	});
	const isolated = orgProjects
		.filter((p) => p.isolated)
		.map((p) => p.projectId);
	const policies = await db.query.networkPolicies.findMany({
		where: eq(networkPolicies.organizationId, organizationId),
		columns: { sourceProjectId: true, targetProjectId: true },
	});
	const edges = policies.map((p) => ({
		source: p.sourceProjectId,
		target: p.targetProjectId,
	}));

	const desired = computeIntentions(meshServices, isolated, edges);
	// The full set of managed config-entry names we want to exist. When the org
	// has any isolated project we also install a global fail-closed "*" deny so a
	// mesh service without a specific intention is denied (a specific destination
	// Name overrides "*"); when nothing is isolated we want none (so the prune
	// step removes the global deny too and the mesh goes fully open again).
	const active = isolated.length > 0;
	const desiredEntries = active
		? [
				{
					Kind: "service-intentions",
					Name: "*",
					Meta: { "managed-by": INTENTION_MANAGED_BY },
					Sources: [{ Name: "*", Action: "deny" }],
				},
				...desired.map(intentionConfigEntry),
			]
		: [];
	const desiredNames = new Set(desiredEntries.map((e) => e.Name));

	let applied = 0;
	for (const entry of desiredEntries) {
		const res = await consulFetch("/config", {
			method: "PUT",
			body: JSON.stringify(entry),
		});
		if (res.ok) applied++;
	}

	let pruned = 0;
	try {
		const listRes = await consulFetch("/config/service-intentions");
		if (listRes.ok) {
			const existing = (await listRes.json()) as {
				Name: string;
				Meta?: Record<string, string>;
			}[];
			for (const entry of existing) {
				if (entry.Meta?.["managed-by"] !== INTENTION_MANAGED_BY) continue;
				if (desiredNames.has(entry.Name)) continue;
				const res = await consulFetch(
					`/config/service-intentions/${encodeURIComponent(entry.Name)}`,
					{ method: "DELETE" },
				);
				if (res.ok) pruned++;
			}
		}
	} catch {}

	return { applied, pruned };
};
