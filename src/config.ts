/**
 * Bindings this Worker relies on (declared in wrangler.jsonc).
 *
 * `wrangler types` generates `VECTORIZE: VectorizeIndex` (the legacy V1 class) because it cannot
 * know the index version. `rag-demo-index` is a V2 index, so the binding is typed as `Vectorize`.
 */
export interface Env {
	AI: Ai;
	VECTORIZE: Vectorize;
}

export const SERVICE_NAME = 'cloudflare-vectorize-rag-demo';

/** Embedding model. 768-dimensional output, matching the `rag-demo-index` configuration. */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const EMBEDDING_DIMENSIONS = 768;
/** Must be identical at seed and query time: `cls` and `mean` embeddings are not comparable. */
export const EMBEDDING_POOLING = 'cls';

/** Text-generation model used by /ask. Change this constant to swap models. */
export const ANSWER_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const ANSWER_MAX_TOKENS = 512;

export const DEFAULT_TOP_K = 3;
/** Vectorize allows topK <= 50 when returning metadata; a RAG prompt needs far fewer. */
export const MAX_TOP_K = 10;
export const MAX_QUERY_LENGTH = 1000;
