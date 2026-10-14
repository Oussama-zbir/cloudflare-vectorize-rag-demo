/**
 * Sample knowledge base: internal help-center articles for a fictional SaaS product ("Acme Cloud").
 *
 * IDs are deterministic, so re-running POST /seed overwrites the same vectors instead of duplicating them.
 * Each document is well under Vectorize's 10 KiB per-vector metadata limit, so the full text is
 * stored as metadata and no separate document store is needed.
 */
export interface KnowledgeDocument {
	id: string;
	title: string;
	text: string;
	source: string;
}

export const SAMPLE_DOCUMENTS: KnowledgeDocument[] = [
	{
		id: 'kb-billing-refunds',
		title: 'Refund policy',
		source: 'help-center/billing/refunds',
		text: 'Annual plans can be refunded in full within 30 days of purchase. After 30 days, annual plans are refunded pro rata for the unused months, minus a 10% processing fee. Monthly plans are not refundable, but can be cancelled at any time and stay active until the end of the billing period. Refunds are issued to the original payment method within 5-10 business days.',
	},
	{
		id: 'kb-billing-invoices',
		title: 'Invoices and payment methods',
		source: 'help-center/billing/invoices',
		text: 'Invoices are generated on the first day of each billing cycle and can be downloaded as PDF from Settings > Billing. Accepted payment methods are credit card, SEPA direct debit, and bank transfer for annual plans above 5,000 USD. VAT IDs added before the invoice date are shown on the invoice; invoices cannot be reissued retroactively.',
	},
	{
		id: 'kb-security-sso',
		title: 'Single sign-on (SSO)',
		source: 'help-center/security/sso',
		text: 'SSO is available on the Business and Enterprise plans and supports SAML 2.0 and OpenID Connect. Okta, Microsoft Entra ID and Google Workspace are tested identity providers. Once SSO is enforced, password login is disabled for all members except the account owner, who keeps a break-glass password. SCIM user provisioning is available on Enterprise only.',
	},
	{
		id: 'kb-security-data-retention',
		title: 'Data retention and deletion',
		source: 'help-center/security/data-retention',
		text: 'Customer data is retained for as long as the account is active. After an account is closed, data is soft-deleted and kept for 30 days so it can be restored on request, then permanently deleted from primary storage. Encrypted backups expire within a further 35 days. Audit logs are kept for 1 year on Business and 7 years on Enterprise.',
	},
	{
		id: 'kb-api-rate-limits',
		title: 'API rate limits',
		source: 'docs/api/rate-limits',
		text: 'The REST API allows 100 requests per minute per API key on the Starter plan and 1,000 requests per minute on Business and Enterprise. Requests over the limit receive HTTP 429 with a Retry-After header in seconds. Clients should retry with exponential backoff. Bulk endpoints count as one request regardless of the number of items, up to 500 items per call.',
	},
	{
		id: 'kb-api-webhooks',
		title: 'Webhook delivery and retries',
		source: 'docs/api/webhooks',
		text: 'Webhooks are sent as HTTPS POST requests with a JSON body and an X-Acme-Signature header containing an HMAC-SHA256 signature of the body. Endpoints must respond with a 2xx status within 10 seconds. Failed deliveries are retried up to 8 times over 24 hours with exponential backoff, after which the webhook is disabled and the account owner is notified by email.',
	},
	{
		id: 'kb-account-roles',
		title: 'User roles and permissions',
		source: 'help-center/account/roles',
		text: 'Workspaces have four roles. Owners manage billing and can delete the workspace. Admins manage members, integrations and security settings. Members create and edit projects. Viewers have read-only access and are free of charge. Only one owner is allowed per workspace; ownership can be transferred to an existing admin from Settings > Members.',
	},
	{
		id: 'kb-support-sla',
		title: 'Support channels and response times',
		source: 'help-center/support/sla',
		text: 'Starter customers get email support with a first response within 2 business days. Business customers get chat and email support with a first response within 8 business hours. Enterprise customers get 24/7 support for severity-1 incidents with a 1-hour first response target and a named customer success manager. The status page is at status.acme.example.',
	},
];
