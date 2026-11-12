import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "node:test";
import { addMonitorUnlessMatching, normalizeMonitorUrl } from "./uptime-kuma-url";

test("monitor URL matching adopts scheme, www, and path variants", () => {
	assert.equal(normalizeMonitorUrl("https://www.foo.com/health"), "foo.com");
	assert.equal(normalizeMonitorUrl("http://foo.com"), "foo.com");
});

test("sync adoption skips creating a duplicate for a matching manual monitor", async () => {
	const existingUrls = new Set([
		normalizeMonitorUrl("https://www.foo.com/health"),
	]);
	const addMonitor = mock.fn(async () => 42);

	const id = await addMonitorUnlessMatching(
		existingUrls,
		"https://foo.com",
		addMonitor,
	);

	assert.equal(id, undefined);
	assert.equal(addMonitor.mock.callCount(), 0);
});
