import { addNomployNetworkToRoot } from "@nomploy/server";
import { describe, expect, it } from "vitest";

describe("addNomployNetworkToRoot", () => {
	it("should create network object if networks is undefined", () => {
		const result = addNomployNetworkToRoot(undefined);
		expect(result).toEqual({ "nomploy-network": { external: true } });
	});

	it("should add network to an empty object", () => {
		const result = addNomployNetworkToRoot({});
		expect(result).toEqual({ "nomploy-network": { external: true } });
	});

	it("should not modify existing network configuration", () => {
		const existing = { "nomploy-network": { external: false } };
		const result = addNomployNetworkToRoot(existing);
		expect(result).toEqual({ "nomploy-network": { external: true } });
	});

	it("should add network alongside existing networks", () => {
		const existing = { "other-network": { external: true } };
		const result = addNomployNetworkToRoot(existing);
		expect(result).toEqual({
			"other-network": { external: true },
			"nomploy-network": { external: true },
		});
	});
});
