export const normalizeMonitorUrl = (url: string): string => {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
		return `${hostname}${parsed.port ? `:${parsed.port}` : ""}`;
	} catch {
		return url
			.toLowerCase()
			.replace(/^[a-z][a-z\d+.-]*:\/\//, "")
			.replace(/^www\./, "")
			.split(/[/?#]/, 1)[0];
	}
};

export const addMonitorUnlessMatching = async <T>(
	existingUrls: Set<string>,
	url: string,
	add: () => Promise<T>,
): Promise<T | undefined> => {
	if (existingUrls.has(normalizeMonitorUrl(url))) return undefined;
	return add();
};
