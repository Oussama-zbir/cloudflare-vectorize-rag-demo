import { ANSWER_MAX_TOKENS, ANSWER_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_POOLING, type Env } from './config';
import type { KnowledgeDocument } from './documents';
import { HttpError } from './http';

export interface SearchMatch {
	id: string;
	score: number;
	title: string;
	source: string;
	text: string;
}

export interface AskResult {
	answer: string;
	sources: { id: string; title: string; source: string }[];
	matches: SearchMatch[];
}

/** Embed one or more texts with Workers AI. Returns one 768-dim vector per input, in order. */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
	const result = await env.AI.run(EMBEDDING_MODEL, { text: texts, pooling: EMBEDDING_POOLING });
	const vectors = 'data' in result ? result.data : undefined;
	if (!vectors || vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
		throw new HttpError(502, 'Embedding model returned an unexpected response.');
	}
	return vectors;
}

/**
 * Embed every document and upsert it into Vectorize.
 *
 * `upsert` (not `insert`) plus deterministic document IDs makes seeding idempotent: running it twice
 * replaces the same vectors. Title, source and full text are stored as vector metadata so a query
 * can return everything needed for a RAG prompt without a second datastore.
 */
export async function seedDocuments(env: Env, documents: KnowledgeDocument[]): Promise<{ mutationId: string; ids: string[] }> {
	const vectors = await embed(
		env,
		documents.map((doc) => `${doc.title}\n\n${doc.text}`),
	);

	const records: VectorizeVector[] = documents.map((doc, i) => ({
		id: doc.id,
		values: vectors[i],
		metadata: { title: doc.title, source: doc.source, text: doc.text },
	}));

	// Vectorize V2 mutations are asynchronous: vectors become queryable a few seconds after this returns.
	const mutation = await env.VECTORIZE.upsert(records);
	return { mutationId: mutation.mutationId, ids: records.map((r) => r.id) };
}

/** Embed the query and run a cosine-similarity search against the index. */
export async function search(env: Env, query: string, topK: number): Promise<SearchMatch[]> {
	const [queryVector] = await embed(env, [query]);

	const result = await env.VECTORIZE.query(queryVector, {
		topK,
		returnMetadata: 'all',
	});

	return result.matches.map((match) => ({
		id: match.id,
		score: match.score,
		title: metadataString(match.metadata, 'title'),
		source: metadataString(match.metadata, 'source'),
		text: metadataString(match.metadata, 'text'),
	}));
}

const SYSTEM_PROMPT = [
	'You are a support assistant answering questions about the Acme Cloud product.',
	'Answer ONLY from the numbered context documents provided by the user message.',
	'Cite the documents you used with their id in square brackets, e.g. [kb-billing-refunds].',
	'If the context does not contain the answer, say that you do not know. Do not use outside knowledge.',
	'Keep the answer under 120 words.',
].join(' ');

export function buildContext(matches: SearchMatch[]): string {
	return matches.map((m, i) => `[${i + 1}] id: ${m.id}\ntitle: ${m.title}\nsource: ${m.source}\n${m.text}`).join('\n\n');
}

/** Retrieval-augmented answer: embed -> Vectorize search -> grounded prompt -> Workers AI generation. */
export async function ask(env: Env, question: string, topK: number): Promise<AskResult> {
	const matches = await search(env, question, topK);

	if (matches.length === 0) {
		return {
			answer: 'No documents were found in the index. Run POST /seed first (indexing takes a few seconds), then retry.',
			sources: [],
			matches: [],
		};
	}

	const output = await env.AI.run(ANSWER_MODEL, {
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: `Context documents:\n\n${buildContext(matches)}\n\nQuestion: ${question}` },
		],
		max_tokens: ANSWER_MAX_TOKENS,
		temperature: 0.2,
	});

	const answer = typeof output === 'string' ? output : 'response' in output ? output.response : undefined;
	if (typeof answer !== 'string' || answer.trim() === '') {
		throw new HttpError(502, 'Text-generation model returned an empty response.');
	}

	return {
		answer: answer.trim(),
		sources: matches.map(({ id, title, source }) => ({ id, title, source })),
		matches,
	};
}

function metadataString(metadata: Record<string, VectorizeVectorMetadata> | undefined, key: string): string {
	const value = metadata?.[key];
	return typeof value === 'string' ? value : '';
}
