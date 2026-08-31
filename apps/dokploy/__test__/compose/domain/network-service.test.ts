import { addNomployNetworkToService } from "@nomploy/server";
import { describe, expect, it } from "vitest";

describe("addNomployNetworkToService", () => {
	it("should add network to an empty array", () => {
		const result = addNomployNetworkToService([]);
		expect(result).toEqual(["nomploy-network", "default"]);
	});

	it("should not add duplicate network to an array", () => {
		const result = addNomployNetworkToService(["nomploy-network"]);
		expect(result).toEqual(["nomploy-network", "default"]);
	});

	it("should add network to an existing array with other networks", () => {
		const result = addNomployNetworkToService(["other-network"]);
		expect(result).toEqual(["other-network", "nomploy-network", "default"]);
	});

	it("should add network to an object if networks is an object", () => {
		const result = addNomployNetworkToService({ "other-network": {} });
		expect(result).toEqual({
			"other-network": {},
			"nomploy-network": {},
			default: {},
		});
	});

	it("should not duplicate default network when already present", () => {
		const result = addNomployNetworkToService(["default", "nomploy-network"]);
		expect(result).toEqual(["default", "nomploy-network"]);
	});
});
