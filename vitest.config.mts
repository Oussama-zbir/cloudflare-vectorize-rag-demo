import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			// AI and Vectorize are mocked in the tests, so never open a remote proxy to Cloudflare.
			remoteBindings: false,
		}),
	],
});
