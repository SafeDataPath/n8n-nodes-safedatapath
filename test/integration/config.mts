// Settings of one integration run, read from the environment. A missing value stops the run.

export interface IntegrationConfig {
	/** n8n instance under test, without trailing slash. */
	n8nUrl: string;
	n8nApiKey: string;
	/** SDP address as n8n reaches it: the SDP credential's base URL. */
	sdpUrl: string;
	/** SDP machine user (AGENT) API key: PIPELINE_INSERT, and VERIFICATION_SUMMARY_SELECT to read the capture back. */
	sdpApiKey: string;
	/** Node type of the SDP node as installed on the instance. */
	sdpNodeType: string;
	/** When set, the installed n8n-nodes-sdp version must equal it. */
	expectedPackageVersion: string | undefined;
	/** Upper bound for SDP to capture a run and call back. */
	captureTimeoutMs: number;
	/**
	 * A human account that can approve the n8n Connect app (OAUTH_CODE_INSERT: TENANT_ADMIN, MANAGER or
	 * CREATOR, never AGENT). Drives the OAuth2 scenario the same way a visitor signing in and clicking
	 * Connect would, since nothing here can click a real button (FCT-1746).
	 */
	sdpOauthEmail: string;
	sdpOauthPassword: string;
	sdpOauthTenantAlias: string;
}

// ci.sh installs into n8n's custom directory, whose nodes n8n names CUSTOM.<name>. From npm it is n8n-nodes-sdp.sdp.
const DEFAULT_SDP_NODE_TYPE = 'CUSTOM.sdp';
const DEFAULT_CAPTURE_TIMEOUT_SECONDS = 120;

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing environment variable ${name}`);
	}
	return value;
}

function positiveInt(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer, got '${raw}'`);
	}
	return value;
}

export function loadConfig(): IntegrationConfig {
	return {
		n8nUrl: required('N8N_URL').replace(/\/+$/, ''),
		n8nApiKey: required('N8N_API_KEY'),
		sdpUrl: required('SDP_URL').replace(/\/+$/, ''),
		sdpApiKey: required('SDP_API_KEY'),
		sdpNodeType: process.env.N8N_SDP_NODE_TYPE?.trim() || DEFAULT_SDP_NODE_TYPE,
		expectedPackageVersion: process.env.N8N_SDP_PACKAGE_VERSION?.trim() || undefined,
		captureTimeoutMs: positiveInt('SDP_CAPTURE_TIMEOUT_SECONDS', DEFAULT_CAPTURE_TIMEOUT_SECONDS) * 1000,
		sdpOauthEmail: required('SDP_OAUTH_EMAIL'),
		sdpOauthPassword: required('SDP_OAUTH_PASSWORD'),
		sdpOauthTenantAlias: required('SDP_OAUTH_TENANT_ALIAS'),
	};
}
