import type { VercelRequest, VercelResponse } from "@vercel/node";

export type JsonRecord = Record<string, unknown>;

export function sendJson(res: VercelResponse, status: number, body: JsonRecord): void {
	res.status(status).setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}

export function getHeader(req: VercelRequest, name: string): string | null {
	const value = req.headers[name.toLowerCase()];
	if (!value) return null;
	if (Array.isArray(value)) return value[0] ?? null;
	return value;
}

export async function readJson(req: VercelRequest): Promise<unknown> {
	// Vercel often parses req.body already
	if (req.body != null) {
		if (typeof req.body === "string") {
			if (req.body.trim().length === 0) return null;
			return JSON.parse(req.body);
		}
		return req.body;
	}

	// Fallback: read stream
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
	}

	if (raw.trim().length === 0) return null;
	return JSON.parse(raw);
}
