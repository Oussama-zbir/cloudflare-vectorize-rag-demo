# Cloudflare Vectorize RAG Demo

A small retrieval-augmented generation (RAG) API that runs entirely on Cloudflare: **Workers** for the HTTP API, **Workers AI** for embeddings and answer generation, and **Vectorize** as the vector database. It seeds a sample knowledge base, runs cosine-similarity search over it, and answers questions using only the retrieved documents, with source citations. The Vectorize code (index setup, deterministic upserts, metadata design, `query` options) is kept in one short file, [`src/rag.ts`](src/rag.ts), so it can be reviewed quickly.

The full flow (seed, search, ask) has been run end to end against real Workers AI and Vectorize bindings. The example responses below come from those runs, with long `text` fields shortened. This is a compact demo, not a production service; see [Limitations](#limitations).

## What it demonstrates

- Creating and binding a Vectorize index (768 dimensions, cosine) to a Worker
- Generating embeddings with Workers AI (`@cf/baai/bge-base-en-v1.5`) and upserting them in batch
- Idempotent seeding: deterministic vector IDs + `upsert`, so re-seeding replaces vectors instead of duplicating them
- Storing document fields as Vectorize metadata and reading them back with `returnMetadata: "all"`
- A grounded RAG prompt with citations, and a no-LLM path when retrieval returns nothing
- Input validation, capped `topK`, and JSON errors (400 / 404 / 405 / 500 / 502)
- Unit tests with mocked AI and Vectorize bindings (no Cloudflare account needed to run them)

## Architecture

```
POST /seed    sample docs ─► Workers AI embed (bge-base, 768d) ─► VECTORIZE.upsert
                                         id = doc id, metadata = { title, source, text }

GET  /search  q ─► Workers AI embed ─► VECTORIZE.query(topK, cosine) ─► ranked matches

POST /ask     question ─► embed ─► VECTORIZE.query ─► grounded context prompt
                       ─► Workers AI generation (llama-3.3-70b) ─► { answer, sources, matches }
```

| File                                       | Responsibility                                                     |
| ------------------------------------------ | ------------------------------------------------------------------ |
| [`src/index.ts`](src/index.ts)             | Routing, request validation, error mapping                         |
| [`src/rag.ts`](src/rag.ts)                 | Embedding, Vectorize upsert/query, prompt construction, generation |
| [`src/config.ts`](src/config.ts)           | `Env` bindings type, model names, `topK` limits                    |
| [`src/documents.ts`](src/documents.ts)     | 8 sample help-center articles for a fictional SaaS product         |
| [`test/index.spec.ts`](test/index.spec.ts) | Endpoint tests with mocked bindings                                |

No framework, no external vector database, no API keys. The Worker talks to Cloudflare services only through bindings.

## Cloudflare services used

| Service    | Binding     | Purpose                                                                                           |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------- |
| Workers    | n/a         | HTTP API                                                                                          |
| Workers AI | `AI`        | Embeddings (`@cf/baai/bge-base-en-v1.5`), generation (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| Vectorize  | `VECTORIZE` | Vector storage and cosine similarity search (`rag-demo-index`)                                    |

To change the generation model, edit `ANSWER_MODEL` in `src/config.ts`.

## Vectorize configuration

The index is created once, outside the Worker:

```bash
npx wrangler vectorize create rag-demo-index --dimensions=768 --metric=cosine
```

- **Dimensions 768** match the output of `bge-base-en-v1.5`. The Worker rejects any embedding of a different size before it reaches the index.
- **Cosine** is the standard metric for BGE sentence embeddings; scores are in `[-1, 1]`, higher is more similar.
- **Pooling:** embeddings use `cls` pooling at both seed and query time. `cls` and `mean` vectors are not comparable, so the setting is a single constant.
- **Vector IDs** are stable document IDs (`kb-billing-refunds`, ...). `upsert` with the same ID overwrites, so `POST /seed` is safe to run repeatedly.
- **Metadata:** each vector stores `{ title, source, text }`. Vectorize allows 10 KiB of metadata per vector; every sample document is under 1 KiB (a test enforces the limit). Keeping the text in metadata means one `query` call returns everything the prompt needs, with no second datastore. For real documents that exceed the limit, the usual alternative is to chunk them, or to store only an ID in metadata and fetch the text from D1, KV or R2.

`wrangler.jsonc`:

```jsonc
"ai": { "binding": "AI", "remote": true },
"vectorize": [{ "binding": "VECTORIZE", "index_name": "rag-demo-index", "remote": true }]
```

`remote: true` is set because Vectorize has no local simulator: `wrangler dev` runs the Worker locally but proxies AI and Vectorize calls to your Cloudflare account.

## Local setup

Requirements: Node.js 20+, a Cloudflare account, and the `rag-demo-index` index created as above.

```bash
npm install
npx wrangler login
npm run check        # prettier --check, tsc (src + tests), vitest
npm run dev          # http://localhost:8787
```

The tests mock both bindings and do not need a Cloudflare login.

## Seed the index

```bash
curl -X POST http://localhost:8787/seed
```

```json
{
	"upserted": 8,
	"ids": [
		"kb-billing-refunds",
		"kb-billing-invoices",
		"kb-security-sso",
		"kb-security-data-retention",
		"kb-api-rate-limits",
		"kb-api-webhooks",
		"kb-account-roles",
		"kb-support-sla"
	],
	"mutationId": "ea2a79e6-3694-4f33-b93d-4dc1bc564626",
	"note": "Vectorize applies mutations asynchronously; vectors are queryable after a few seconds."
}
```

Vectorize processes writes asynchronously. Until the mutation is applied, `/search` returns `"matches": []` with no error (in testing, a search 18 s after the first seed was still empty). Before querying, check that `processedUpToMutation` in `npx wrangler vectorize info rag-demo-index` equals the returned `mutationId`.

## Search

```bash
curl "http://localhost:8787/search?q=how%20long%20do%20refunds%20take&topK=3"
```

Live response:

```json
{
	"query": "how long do refunds take",
	"topK": 3,
	"matches": [
		{
			"id": "kb-billing-refunds",
			"score": 0.7393826,
			"title": "Refund policy",
			"source": "help-center/billing/refunds",
			"text": "Annual plans can be refunded in full within 30 days of purchase. ..."
		},
		{
			"id": "kb-support-sla",
			"score": 0.6127035,
			"title": "Support channels and response times",
			"source": "help-center/support/sla",
			"text": "Starter customers get email support with a first response within 2 business days. ..."
		},
		{
			"id": "kb-security-data-retention",
			"score": 0.5566716,
			"title": "Data retention and deletion",
			"source": "help-center/security/data-retention",
			"text": "Customer data is retained for as long as the account is active. ..."
		}
	]
}
```

Scores are cosine similarities. They change slightly with query wording (e.g. `How long do refunds take?` scores 0.726 for the same top document), and would change if the embedding model or pooling were changed. Results are always ranked by score.

## Ask

```bash
curl -X POST http://localhost:8787/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "How long do refunds take?", "topK": 3}'
```

Live response (the generated wording can vary between runs; retrieval results are stable):

```json
{
	"answer": "Refunds are issued within 5-10 business days [kb-billing-refunds].",
	"sources": [
		{ "id": "kb-billing-refunds", "title": "Refund policy", "source": "help-center/billing/refunds" },
		{ "id": "kb-support-sla", "title": "Support channels and response times", "source": "help-center/support/sla" },
		{ "id": "kb-security-data-retention", "title": "Data retention and deletion", "source": "help-center/security/data-retention" }
	],
	"matches": [
		{ "id": "kb-billing-refunds", "score": 0.7260244, "title": "Refund policy", "source": "help-center/billing/refunds", "text": "..." },
		{
			"id": "kb-support-sla",
			"score": 0.60155463,
			"title": "Support channels and response times",
			"source": "help-center/support/sla",
			"text": "..."
		},
		{
			"id": "kb-security-data-retention",
			"score": 0.54090345,
			"title": "Data retention and deletion",
			"source": "help-center/security/data-retention",
			"text": "..."
		}
	]
}
```

`sources` lists every retrieved document; the answer cites only the one it used. Lower-ranked matches (here the support SLA and data retention articles) are passed to the model but are not relevant to the question.

Other endpoints and errors:

```bash
curl http://localhost:8787/health          # {"status":"ok","service":"cloudflare-vectorize-rag-demo"}
curl "http://localhost:8787/search"        # 400 {"error":"\"q\" is required and must be a non-empty string."}
curl "http://localhost:8787/search?q=x&topK=0"  # 400 {"error":"\"topK\" must be a positive integer."}
curl http://localhost:8787/nope            # 404 {"error":"Route not found: GET /nope"}
```

`topK` defaults to 3 and is capped at 10. Queries are limited to 1,000 characters.

## Deploy

```bash
npx wrangler deploy
curl -X POST https://cloudflare-vectorize-rag-demo.<your-subdomain>.workers.dev/seed
```

Deploying to `*.workers.dev` requires a workers.dev subdomain registered on the account (Workers & Pages > Overview in the dashboard).

## Why Vectorize

- **Co-located with compute.** The Worker, the embedding model and the index all run on Cloudflare's network, so a RAG request is three binding calls with no outbound network hops or third-party credentials.
- **No infrastructure to run.** No cluster sizing, no connection pooling, no separate vector DB bill or API key to rotate.
- **Metadata on the vector.** Small documents fit in metadata, so a single query returns ranked, ready-to-use context. Metadata indexes add filtering (e.g. by tenant or source) when needed.
- **Pairs with the rest of the platform.** D1, R2 and KV are available as bindings for document storage once content outgrows metadata.

## Limitations

- **Demo corpus.** Eight short synthetic documents, one vector each; no chunking. Long documents would need a chunking step with chunk IDs like `doc-id#0003`.
- **No ingestion API.** Documents are compiled into the Worker; `/seed` only indexes the built-in set.
- **Eventual consistency.** Vectorize mutations are asynchronous, so `/search` shortly after the first `/seed` can return no matches at all.
- **No relevance threshold or reranking.** All `topK` matches go into the prompt regardless of score. A score cutoff or `@cf/baai/bge-reranker-base` would improve precision.
- **No auth or rate limiting.** `/seed` is open; a real deployment would protect it (e.g. Cloudflare Access or a bearer secret) and rate-limit `/ask`, which runs an LLM call.
- **No retrieval evaluation.** There is no labelled query set measuring recall/nDCG; answer quality is checked manually.
- **Grounding is prompt-based.** The model is instructed to answer only from context and cite IDs, but citations are not verified against the retrieved set.
