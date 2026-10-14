/**
 * Cloudflare RAG API: Workers AI embeddings + Vectorize semantic search + Workers AI generation.
 *
 *   GET  /health
 *   POST /seed                      embed the sample documents and upsert them into Vectorize
 *   GET  /search?q=<query>&topK=3   semantic search
 *   POST /ask {"question", "topK"}  retrieval-augmented answer with sources
 */
import { DEFAULT_TOP_K, MAX_QUERY_LENGTH, MAX_TOP_K, SERVICE_NAME, type Env } from './config';
import { SAMPLE_DOCUMENTS } from './documents';
import { errorResponse, HttpError, json, readJsonBody } from './http';
import { ask, search, seedDocuments } from './rag';

const ROUTES: Record<string, Record<string, (request: Request, env: Env) => Promise<Response>>> = {
	'/health': {
		GET: async () => json({ status: 'ok', service: SERVICE_NAME }),
	},
	'/seed': {
		POST: async (_request, env) => {
			const { mutationId, ids } = await seedDocuments(env, SAMPLE_DOCUMENTS);
			return json({
				upserted: ids.length,
				ids,
				mutationId,
				note: 'Vectorize applies mutations asynchronously; vectors are queryable after a few seconds.',
			});
		},
	},
	'/search': {
		GET: async (request, env) => {
			const params = new URL(request.url).searchParams;
			const query = parseQuery(params.get('q'), 'q');
			const topK = parseTopK(params.get('topK'));
			const matches = await search(env, query, topK);
			return json({ query, topK, matches });
		},
	},
	'/ask': {
		POST: async (request, env) => {
			const body = await readJsonBody(request);
			const question = parseQuery(body.question, 'question');
			const topK = parseTopK(body.topK);
			return json(await ask(env, question, topK));
		},
	},
};

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		const route = ROUTES[pathname];
		if (!route) {
			return errorResponse(404, `Route not found: ${request.method} ${pathname}`);
		}
		const handler = route[request.method];
		if (!handler) {
			const response = errorResponse(405, `Method ${request.method} not allowed on ${pathname}.`);
			response.headers.set('Allow', Object.keys(route).join(', '));
			return response;
		}

		try {
			return await handler(request, env);
		} catch (err) {
			if (err instanceof HttpError) {
				return errorResponse(err.status, err.message);
			}
			console.error(JSON.stringify({ message: 'unhandled error', path: pathname, error: String(err) }));
			return errorResponse(500, 'Internal server error.');
		}
	},
} satisfies ExportedHandler<Env>;

/** Validate a free-text query from the URL or JSON body. */
function parseQuery(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new HttpError(400, `"${field}" is required and must be a non-empty string.`);
	}
	const trimmed = value.trim();
	if (trimmed.length > MAX_QUERY_LENGTH) {
		throw new HttpError(400, `"${field}" must be at most ${MAX_QUERY_LENGTH} characters.`);
	}
	return trimmed;
}

/** Validate topK (query-string or JSON number). Missing -> default; above the cap -> capped. */
function parseTopK(value: unknown): number {
	if (value === undefined || value === null || value === '') {
		return DEFAULT_TOP_K;
	}
	const n = typeof value === 'string' ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
		throw new HttpError(400, '"topK" must be a positive integer.');
	}
	return Math.min(n, MAX_TOP_K);
}
