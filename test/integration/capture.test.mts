// End-to-end: the SDP node runs on a real n8n, and SDP captures the run as a pipeline.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { loadConfig } from './config.mts';
import type { IntegrationConfig } from './config.mts';
import { N8nApi } from './n8nApi.mts';
import type { Execution } from './n8nApi.mts';
import { SdpApi } from './sdpApi.mts';
import type { VerificationSummary } from './sdpApi.mts';
import { FILE_NAME, SDP_NODE_NAME, captureWorkflow, startPath } from './workflows.mts';
import type { CredentialRef } from './workflows.mts';
import { obtainOauthToken } from './sdpOauth.mts';

const POLL_INTERVAL_MS = 2000;
const RUN_TIMEOUT_MS = 60_000;
// Chosen, not measured: well above the few seconds a capture takes once the run has ended.
const NO_CAPTURE_WAIT_MS = 30_000;
const PACKAGE_NAME = 'n8n-nodes-sdp';
const TERMINAL_STATUSES = new Set(['success', 'error', 'crashed', 'canceled']);

let config: IntegrationConfig;
let n8n: N8nApi;
let sdp: SdpApi;
let runId: string;
let goodCredential: CredentialRef;
let badCredential: CredentialRef;
let oauthCredential: CredentialRef;
// The wrong key case reads "no pipeline" as a refusal only once a capture was seen in this same run.
let captureSeen = false;
const createdWorkflows: string[] = [];
const createdCredentials: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = await probe();
		if (found !== undefined) {
			return found;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}

function firstOutput(execution: Execution, nodeName: string): Record<string, unknown> | undefined {
	return execution.data?.resultData?.runData?.[nodeName]?.[0]?.data?.main?.[0]?.[0]?.json;
}

/** Creates and activates one capture workflow, fires it, and waits for its run to end. */
async function runScenario(
	scenario: string,
	credential: CredentialRef,
	failAfterCapture: boolean,
	authOptions: { authentication: 'apiKey' | 'oAuth2'; credentialType: 'sdpApi' | 'sdpOAuth2Api' } = {
		authentication: 'apiKey',
		credentialType: 'sdpApi',
	},
): Promise<Execution> {
	const scenarioId = `${runId}-${scenario}`;
	const workflow = await n8n.createWorkflow(
		captureWorkflow({
			runId: scenarioId,
			sdpNodeType: config.sdpNodeType,
			credential,
			fileContent: `SDP integration test ${scenarioId}\n`,
			failAfterCapture,
			...authOptions,
		}),
	);
	createdWorkflows.push(workflow.id);
	await n8n.activateWorkflow(workflow.id);

	const status = await n8n.callWebhook(startPath(scenarioId), { scenario });
	assert.equal(status, 200, `webhook of scenario ${scenario} answered HTTP ${status}`);

	return waitFor(`the run of scenario ${scenario} to end`, RUN_TIMEOUT_MS, async () => {
		const [latest] = await n8n.listExecutions(workflow.id);
		return latest && TERMINAL_STATUSES.has(latest.status) ? latest : undefined;
	});
}

/** The node never stops the run: it hands its input on, whatever SDP answered. */
function assertPassedThrough(execution: Execution): void {
	const output = firstOutput(execution, SDP_NODE_NAME);
	assert.ok(output, `the SDP node produced no output in execution ${execution.id}`);
	assert.equal(output.fileName, FILE_NAME);
}

function waitForCapture(executionId: string): Promise<VerificationSummary> {
	return waitFor(`SDP to capture execution ${executionId}`, config.captureTimeoutMs, async () => {
		const answer = await sdp.verificationSummary(executionId);
		if (answer.status === 404) {
			return undefined;
		}
		assert.equal(answer.status, 200, `verification-summary for ${executionId}: ${answer.text}`);
		return answer.summary;
	});
}

function assertCaptured(summary: VerificationSummary): void {
	assert.equal(typeof summary.verificationUrl, 'string');
	assert.ok((summary.verificationUrl as string).length > 0, 'verificationUrl is empty');
	captureSeen = true;
}

before(async () => {
	config = loadConfig();
	n8n = new N8nApi(config.n8nUrl, config.n8nApiKey);
	sdp = new SdpApi(config.sdpUrl, config.sdpApiKey);
	runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

	if (config.expectedPackageVersion) {
		const installed = (await n8n.listCommunityPackages()).find((p) => p.packageName === PACKAGE_NAME);
		assert.ok(installed, `${PACKAGE_NAME} is not installed on ${config.n8nUrl}`);
		assert.equal(installed.installedVersion, config.expectedPackageVersion);
	}

	const good = await n8n.createCredential(`SDP integration test ${runId}`, 'sdpApi', {
		baseUrl: config.sdpUrl,
		apiKey: config.sdpApiKey,
	});
	createdCredentials.push(good.id);
	goodCredential = { id: good.id, name: good.name };

	const bad = await n8n.createCredential(`SDP integration test ${runId} - wrong key`, 'sdpApi', {
		baseUrl: config.sdpUrl,
		apiKey: `wrong-key-on-purpose-${runId}`,
	});
	createdCredentials.push(bad.id);
	badCredential = { id: bad.id, name: bad.name };

	// The same three calls n8n itself makes once a visitor signs in and clicks Connect (FCT-1740).
	const oauthTokenData = await obtainOauthToken(
		config.sdpUrl,
		config.sdpOauthEmail,
		config.sdpOauthPassword,
		config.sdpOauthTenantAlias,
		`${config.n8nUrl}/rest/oauth2-credential/callback`,
	);
	// Once oauthTokenData is present, the public API validates against the base oAuth2Api shape alone,
	// not the full sdpOAuth2Api type: SDP's own hidden fields (baseUrl, grantType, authUrl...) are then
	// refused as unknown, and three base-type fields SDP never uses become required regardless. Found by
	// probing the schema directly; the editor UI never hits this, it only ever submits the full type.
	const oauth = await n8n.createCredential(`SDP integration test ${runId} - oauth2`, 'sdpOAuth2Api', {
		serverUrl: '',
		sendAdditionalBodyProperties: false,
		additionalBodyProperties: '{}',
		oauthTokenData,
	});
	createdCredentials.push(oauth.id);
	oauthCredential = { id: oauth.id, name: oauth.name };
});

// Cleans every attempt, then fails loudly if one did not go through.
after(async () => {
	if (!n8n) {
		return;
	}
	const failures: string[] = [];
	for (const id of createdWorkflows) {
		await n8n.deleteWorkflow(id).catch((e: Error) => failures.push(`workflow ${id}: ${e.message}`));
	}
	for (const id of createdCredentials) {
		await n8n.deleteCredential(id).catch((e: Error) => failures.push(`credential ${id}: ${e.message}`));
	}
	if (failures.length > 0) {
		throw new Error(`Cleanup left objects on the instance:\n${failures.join('\n')}`);
	}
});

test('a successful run is captured by SDP', { timeout: RUN_TIMEOUT_MS * 5 }, async () => {
	const execution = await runScenario('ok', goodCredential, false);
	assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
	assertPassedThrough(execution);

	assertCaptured(await waitForCapture(String(execution.id)));
});

test('a failed run is still captured by SDP', { timeout: RUN_TIMEOUT_MS * 5 }, async () => {
	const execution = await runScenario('fail', goodCredential, true);
	assert.equal(execution.status, 'error');
	assertPassedThrough(execution);

	assertCaptured(await waitForCapture(String(execution.id)));
});

test('a wrong SDP API key captures nothing and does not stop the run', { timeout: RUN_TIMEOUT_MS * 3 }, async () => {
	assert.ok(captureSeen, 'no capture was seen in this run, so "nothing captured" would prove nothing');
	const execution = await runScenario('badkey', badCredential, false);
	assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
	assertPassedThrough(execution);

	await sleep(NO_CAPTURE_WAIT_MS);
	const answer = await sdp.verificationSummary(String(execution.id));
	assert.equal(answer.status, 404, `execution ${execution.id} was captured with a wrong key: ${answer.text}`);
});

// The expected path for a real visitor (FCT-1746): sign in, approve Connect, no API key ever typed in.
test('a run captured through OAuth2 Connect, the same as a signed-in visitor', { timeout: RUN_TIMEOUT_MS * 5 }, async () => {
	const execution = await runScenario('oauth2', oauthCredential, false, {
		authentication: 'oAuth2',
		credentialType: 'sdpOAuth2Api',
	});
	assert.equal(execution.status, 'success', execution.data?.resultData?.error?.message);
	assertPassedThrough(execution);

	assertCaptured(await waitForCapture(String(execution.id)));
});
