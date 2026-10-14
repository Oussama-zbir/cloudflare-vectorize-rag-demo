/** An error that maps directly to an HTTP status and a client-safe message. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
}

export function errorResponse(status: number, message: string): Response {
	return json({ error: message }, status);
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new HttpError(400, 'Request body must be valid JSON.');
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw new HttpError(400, 'Request body must be a JSON object.');
	}
	return body as Record<string, unknown>;
}
