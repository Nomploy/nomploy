import { generatePanelNomadJob } from "@nomploy/server/utils/builders/nomad-panel";
import { describe, expect, it } from "vitest";

describe("generatePanelNomadJob — rollout", () => {
	it("zero-downtime (with domain): canary, routed only once promoted", () => {
		const job = generatePanelNomadJob(
			"ghcr.io/nomploy/nomploy:latest",
			{},
			"2026-10-02T00:00:00.000Z",
			"panel.example.com",
		);
		// Canary rollout for near-zero-downtime self-update.
		expect(job).toContain("canary           = 1");
		expect(job).toContain("auto_promote     = true");
		// The canary must NOT be Traefik-routed until promoted — otherwise old+new
		// both sit in the pool during the promotion window (stale/404 overlap).
		expect(job).toContain('canary_tags = ["traefik.enable=false"]');
		// The real tags still enable Traefik for the promoted/old alloc.
		expect(job).toContain("traefik.enable=true");
		// Old alloc drains gracefully after deregistration.
		expect(job).toContain('shutdown_delay = "10s"');
	});

	it("legacy (no domain): host-static fallback, no canary", () => {
		const job = generatePanelNomadJob(
			"ghcr.io/nomploy/nomploy:latest",
			{},
			"2026-10-02T00:00:00.000Z",
			undefined,
		);
		expect(job).not.toContain("canary           = 1");
		expect(job).not.toContain("canary_tags");
		expect(job).toContain('health_check     = "task_states"');
	});
});
