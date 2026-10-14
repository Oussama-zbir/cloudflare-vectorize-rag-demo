import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ANSWER_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, MAX_TOP_K, type Env } from '../src/config';
import { SAMPLE_DOCUMENTS } from '../src/documents';

const STORED = [
	{
		id: 'kb-billing-refunds',
		score: 0.91,
		metadata: { title: 'Refund policy', source: 'help-center/billing/refunds', text: 'Annual plans...' },
	},
	{
		id: 'kb-billing-invoices',
		score: 0.74,
		metadata: { title: 'Invoices', source: 'help-center/billing/invoices', text: 'Invoices are...' },
	},
];

/** Mocked AI + Vectorize bindings. No network, no Cloudflare account needed. */
function mockEnv(matches = STORED) {
	// The first component encodes the input position, so tests can tell which embedding was used.
	const fakeVector = (_text: string, i: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, d) => (d === 0 ? i + 1 : 0.01));
	const run = vi.fn(async (model: string, inputs: { text?: string[] }) => {
		if (model === EMBEDDING_MODEL) {
			return { shape: [inputs.text!.length, EMBEDDING_DIMENSIONS], data: inputs.text!.map(fakeVector) };
		}
		if (model === ANSWER_MODEL) {
			return { response: 'Annual plans are fully refundable within 30 days [kb-billing-refunds].' };
		}
		throw new Error(`unexpected model ${model}`);
	});
	const query = vi.fn(async () => ({ matches, count: matches.length }));
	const upsert = vi.fn(async () => ({ mutationId: 'mutation-123' }));
	const env = { AI: { run }, VECTORIZE: { query, upsert } } as unknown as Env;
	return { env, run, query, upsert };
}

/** Call the Worker's fetch handler directly with the mocked bindings. */
function call(env: Env, path: string, init?: RequestInit): Promise<Response> {
	const request = new Request(`http://example.com${path}`, init) as Request<unknown, IncomingRequestCfProperties>;
	return worker.fetch(request, env);
}

const postJson = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(body),
});

describe('GET /health', () => {
	it('returns service status as JSON', async () => {
		const response = await call(mockEnv().env, '/health');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		expect(await response.json()).toEqual({ status: 'ok', service: 'cloudflare-vectorize-rag-demo' });
	});
});

describe('GET /search', () => {
	it.each([['/search'], ['/search?q='], ['/search?q=%20%20']])('rejects a missing or blank query: %s', async (path) => {
		const { env, run } = mockEnv();
		const response = await call(env, path);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: expect.stringContaining('"q"') });
		expect(run).not.toHaveBeenCalled();
	});

	it.each([['0'], ['-1'], ['2.5'], ['abc']])('rejects an invalid topK: %s', async (topK) => {
		const response = await call(mockEnv().env, `/search?q=refunds&topK=${topK}`);
		expect(response.status).toBe(400);
	});

	it('embeds the query, queries Vectorize and returns ranked matches', async () => {
		const { env, run, query } = mockEnv();
		const response = await call(env, '/search?q=Can%20I%20get%20a%20refund%3F&topK=2');

		expect(response.status).toBe(200);
		expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, expect.objectContaining({ text: ['Can I get a refund?'] }));
		expect(query).toHaveBeenCalledWith(expect.any(Array), { topK: 2, returnMetadata: 'all' });

		const body = await response.json<{ matches: unknown[] }>();
		expect(body.matches).toEqual([
			{ id: 'kb-billing-refunds', score: 0.91, title: 'Refund policy', source: 'help-center/billing/refunds', text: 'Annual plans...' },
			{ id: 'kb-billing-invoices', score: 0.74, title: 'Invoices', source: 'help-center/billing/invoices', text: 'Invoices are...' },
		]);
	});

	it('queries with data[0] using the same model and pooling as /seed, with no filter or namespace', async () => {
		const { env, run, query } = mockEnv();
		await call(env, '/seed', { method: 'POST' });
		await call(env, '/search?q=refunds');

		const [seedCall, searchCall] = run.mock.calls;
		expect(searchCall[0]).toBe(seedCall[0]);
		expect((searchCall[1] as { pooling?: string }).pooling).toBe((seedCall[1] as { pooling?: string }).pooling);

		const [vector, options] = query.mock.calls[0] as unknown as [number[], VectorizeQueryOptions];
		expect(Array.isArray(vector) && typeof vector[0]).toBe('number');
		expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
		expect(vector[0]).toBe(1);
		expect(options).toEqual({ topK: 3, returnMetadata: 'all' });
	});

	it('caps topK', async () => {
		const { env, query } = mockEnv();
		await call(env, '/search?q=refunds&topK=500');
		expect(query).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ topK: MAX_TOP_K }));
	});
});

describe('POST /ask', () => {
	it('retrieves context from Vectorize and grounds the generation on it', async () => {
		const { env, run, query } = mockEnv();
		const response = await call(env, '/ask', postJson({ question: 'What is the refund policy?', topK: 2 }));

		expect(response.status).toBe(200);
		expect(query).toHaveBeenCalledWith(expect.any(Array), { topK: 2, returnMetadata: 'all' });

		const [, generationInput] = run.mock.calls.find(([model]) => model === ANSWER_MODEL)!;
		const prompt = JSON.stringify(generationInput);
		expect(prompt).toContain('kb-billing-refunds');
		expect(prompt).toContain('Annual plans...');
		expect(prompt).toContain('What is the refund policy?');

		const body = await response.json<Record<string, unknown>>();
		expect(body.answer).toContain('[kb-billing-refunds]');
		expect(body.sources).toEqual([
			{ id: 'kb-billing-refunds', title: 'Refund policy', source: 'help-center/billing/refunds' },
			{ id: 'kb-billing-invoices', title: 'Invoices', source: 'help-center/billing/invoices' },
		]);
		expect(body.matches).toHaveLength(2);
	});

	it('does not call the LLM when retrieval finds nothing', async () => {
		const { env, run } = mockEnv([]);
		const response = await call(env, '/ask', postJson({ question: 'Anything?' }));
		expect(response.status).toBe(200);
		expect(run).toHaveBeenCalledTimes(1); // embedding only
		expect(await response.json()).toMatchObject({ sources: [], matches: [] });
	});

	it('rejects invalid JSON and a missing question', async () => {
		const { env } = mockEnv();
		expect((await call(env, '/ask', { method: 'POST', body: '{not json' })).status).toBe(400);
		expect((await call(env, '/ask', postJson({ topK: 3 }))).status).toBe(400);
	});
});

describe('POST /seed', () => {
	it('upserts every sample document with deterministic IDs and metadata', async () => {
		const { env, upsert } = mockEnv();
		const response = await call(env, '/seed', { method: 'POST' });

		expect(response.status).toBe(200);
		const [vectors] = upsert.mock.calls[0] as unknown as [VectorizeVector[]];
		expect(vectors.map((v) => v.id)).toEqual(SAMPLE_DOCUMENTS.map((d) => d.id));
		expect(vectors[0].values).toHaveLength(EMBEDDING_DIMENSIONS);
		expect(vectors[0].metadata).toEqual({
			title: SAMPLE_DOCUMENTS[0].title,
			source: SAMPLE_DOCUMENTS[0].source,
			text: SAMPLE_DOCUMENTS[0].text,
		});
		expect(await response.json()).toMatchObject({ upserted: SAMPLE_DOCUMENTS.length, mutationId: 'mutation-123' });
	});

	it('keeps each document within the 10 KiB Vectorize metadata limit', () => {
		for (const doc of SAMPLE_DOCUMENTS) {
			const bytes = new TextEncoder().encode(JSON.stringify({ title: doc.title, source: doc.source, text: doc.text })).length;
			expect(bytes).toBeLessThan(10 * 1024);
		}
		expect(new Set(SAMPLE_DOCUMENTS.map((d) => d.id)).size).toBe(SAMPLE_DOCUMENTS.length);
	});
});

describe('routing and errors', () => {
	it('returns 404 JSON for an unknown route', async () => {
		const response = await call(mockEnv().env, '/does-not-exist');
		expect(response.status).toBe(404);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		expect(await response.json()).toEqual({ error: 'Route not found: GET /does-not-exist' });
	});

	it('returns 405 with an Allow header for a wrong method', async () => {
		const response = await call(mockEnv().env, '/seed');
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('POST');
	});

	it('returns a generic 500 when a binding fails', async () => {
		const { env, query } = mockEnv();
		query.mockRejectedValueOnce(new Error('vectorize unavailable'));
		const response = await call(env, '/search?q=refunds');
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: 'Internal server error.' });
	});
});
