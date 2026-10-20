import { createHash } from 'crypto';
import {
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
// Search terms of the node picker (FCT-1746). n8n reads this file, not description.codex, for a node it
// loads from its custom folder, which is how SafeDataPath installs it.
import codex from './Sdp.node.json';

// Every SafeDataPath endpoint lives under /api. Without the prefix the request falls through to the
// single-page-app catch-all, which answers 200 with index.html: a "success" that captured nothing.
const CAPTURE_PATH = '/api/n8n/capture';

/** Must stay SHA-512/base64: that is the pair SafeDataPath's HashValidator accepts. */
const HASH_ALGORITHM = 'sha512';
const HASH_ENCODING = 'base64';

// FCT-1746: a capture never holds the workflow for long, and a short outage gets two more chances.
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 2_000];

/** One file reaching this node: only its digest travels, the file stays in n8n. */
interface BinaryDigest extends IDataObject {
	/** The node that produced the file: it ties the digest to the right trace. */
	nodeName: string;
	itemIndex: number;
	property: string;
	fileName?: string;
	mimeType?: string;
	bytes: number;
	algorithm: string;
	encoding: string;
	hash: string;
}

// FCT-1676. The credential each Authentication option signs in with.
const CREDENTIAL_BY_AUTHENTICATION: Record<string, string> = {
	apiKey: 'sdpApi',
	oAuth2: 'sdpOAuth2Api',
};

// OAuth2 first on purpose: it is the one-click way, decided on FCT-1676.
const AUTHENTICATION_OPTIONS: INodePropertyOptions[] = [
	{ name: 'OAuth2 (SafeDataPath, Microsoft or Google)', value: 'oAuth2' },
	{ name: 'API Key (Machine User)', value: 'apiKey' },
];

/**
 * Shown in the output panel of this run (FCT-1778). The run stays green, so this is the only sign in n8n that
 * SafeDataPath did not get it. SafeDataPath may still record it later from the n8n API.
 */
function warnNotRecorded(ctx: IExecuteFunctions, executionId: string, reason: string): void {
	ctx.addExecutionHints({
		message: `SafeDataPath did not record run ${executionId}: ${reason}`,
		type: 'warning',
		location: 'outputPane',
	});
}

/** The credential of the Authentication option chosen on this node. API Key for a node saved before it existed. */
function credentialName(ctx: IExecuteFunctions): string {
	const authentication = ctx.getNodeParameter('authentication', 0, 'apiKey') as string;
	return CREDENTIAL_BY_AUTHENTICATION[authentication] ?? CREDENTIAL_BY_AUTHENTICATION.apiKey;
}

/**
 * Fingerprints every file on this node's input.
 * <p>
 * Here and not server-side: SafeDataPath reads the run back from the n8n API, which returns a reference, not
 * the bytes, for files held out of memory. `getBinaryDataBuffer` is the only accessor that works for every
 * storage mode (memory, filesystem, S3).
 */
async function collectBinaryDigests(ctx: IExecuteFunctions): Promise<BinaryDigest[]> {
	const items = ctx.getInputData();
	let nodeName = '';
	try {
		nodeName = ctx.getInputSourceData().previousNode;
	} catch {
		// Nothing wired upstream: the digests still travel, unattributed.
	}
	const digests: BinaryDigest[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const binary = items[itemIndex].binary;
		if (!binary) {
			continue;
		}
		for (const property of Object.keys(binary)) {
			const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, property);
			digests.push({
				nodeName,
				itemIndex,
				property,
				fileName: binary[property].fileName,
				mimeType: binary[property].mimeType,
				bytes: buffer.length,
				algorithm: HASH_ALGORITHM,
				encoding: HASH_ENCODING,
				hash: createHash(HASH_ALGORITHM).update(buffer).digest(HASH_ENCODING),
			});
		}
	}
	return digests;
}

/** The HTTP status of a failed request, wherever n8n's error wrapping put it. */
function statusOf(error: unknown): number | undefined {
	const err = error as {
		httpCode?: string | number;
		statusCode?: number;
		response?: { status?: number; statusCode?: number };
		cause?: { statusCode?: number; response?: { status?: number; statusCode?: number } };
	};
	const raw =
		err.httpCode ??
		err.statusCode ??
		err.response?.statusCode ??
		err.response?.status ??
		err.cause?.statusCode ??
		err.cause?.response?.status ??
		err.cause?.response?.statusCode;
	const status = Number(raw);
	return Number.isFinite(status) ? status : undefined;
}

/** A refused credential will be refused again: no point retrying it. */
function isCredentialRefused(error: unknown): boolean {
	const status = statusOf(error);
	return status === 401 || status === 403;
}

function describe(error: unknown): string {
	const status = statusOf(error);
	const message = (error as { message?: string }).message ?? String(error);
	return status ? `HTTP ${status}: ${message}` : message;
}

/**
 * Posts the capture request, up to 1 + RETRY_DELAYS_MS.length attempts. Returns the last error, or undefined
 * once one attempt succeeds: the caller logs it, it never reaches the workflow.
 */
async function requestCapture(
	ctx: IExecuteFunctions,
	credential: string,
	options: IHttpRequestOptions,
): Promise<unknown> {
	for (let attempt = 0; ; attempt++) {
		try {
			await ctx.helpers.httpRequestWithAuthentication.call(ctx, credential, options);
			return undefined;
		} catch (error) {
			if (isCredentialRefused(error) || attempt >= RETRY_DELAYS_MS.length) {
				return error;
			}
			await sleep(RETRY_DELAYS_MS[attempt]);
		}
	}
}

export class Sdp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SafeDataPath',
		name: 'sdp',
		icon: { light: 'file:SDP_LOGO.png', dark: 'file:sdp_logo_2.png' },
		group: ['transform'],
		// FCT-1676. Version 2 only changes the Authentication default to OAuth2. A node saved as version 1
		// keeps API Key, so an existing workflow keeps its credential.
		version: [1, 2],
		defaultVersion: 2,
		// Present tense, n8n's own word for a run ("Execute workflow"), and no repeat of the node's own
		// name shown right above it: the original text truncated on the canvas at typical node width.
		subtitle: 'Captures this execution',
		description: 'Turn every workflow run into verifiable proof',
		defaults: { name: 'SafeDataPath' },
		// One run, one record: a second node would only add a second request for the same run.
		maxNodes: 1,
		codex: { alias: codex.alias },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		// FCT-1676. One credential per Authentication option: n8n then shows its "Setup credential" dropdown.
		credentials: [
			{ name: 'sdpApi', required: true, displayOptions: { show: { authentication: ['apiKey'] } } },
			{ name: 'sdpOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: AUTHENTICATION_OPTIONS,
				// API Key, so a workflow saved before this option existed keeps its credential.
				default: 'apiKey',
				displayOptions: { show: { '@version': [1] } },
			},
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: AUTHENTICATION_OPTIONS,
				// OAuth2, so a new node opens on n8n's "Connect" button.
				default: 'oAuth2',
				displayOptions: { show: { '@version': [2] } },
			},
			{
				displayName:
					'Place this node first in your workflow. SafeDataPath records the run once it finishes, so the record appears a few seconds after the run ends.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Execution ID',
				name: 'executionId',
				type: 'hidden',
				default: '={{ $execution.id }}',
			},
		],
	};

	/**
	 * Asks SafeDataPath to record this run, then hands the input items on unchanged. It never stops the
	 * workflow (FCT-1746): a failed capture is logged and the run carries on. The one exception is a manual
	 * run with a missing or refused credential, where the person testing the node needs to see why.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const executionId = (this.getNodeParameter('executionId', 0, '') as string) || this.getExecutionId();
		const manual = this.getMode() === 'manual';
		const credential = credentialName(this);

		let baseUrl = '';
		try {
			const credentials = await this.getCredentials(credential);
			baseUrl = String(credentials.baseUrl ?? '').replace(/\/+$/, '');
		} catch (error) {
			this.logger.warn(`SafeDataPath: run ${executionId} not recorded, no credential: ${describe(error)}`);
			warnNotRecorded(this, executionId, 'no usable credential.');
			if (manual && !this.continueOnFail()) {
				throw new NodeOperationError(this.getNode(), 'Connect a SafeDataPath credential to record this run.', {
					description: 'Open the node and choose or create a SafeDataPath credential.',
				});
			}
			return [items];
		}

		let failure: unknown;
		try {
			const body: IDataObject = { executionId };
			// So SafeDataPath can name the run before it reads it back from n8n (FCT-1779).
			const workflowName = this.getWorkflow().name;
			if (workflowName) {
				body.workflowName = workflowName;
			}
			// FCT-1785: SafeDataPath reads the run back from this n8n, not from one address set on its server.
			const instanceUrl = (this.getInstanceBaseUrl() ?? '').replace(/\/+$/, '');
			if (instanceUrl) {
				body.instanceUrl = instanceUrl;
			}
			const binaryDigests = await collectBinaryDigests(this);
			if (binaryDigests.length > 0) {
				body.binaryHashes = binaryDigests;
			}
			failure = await requestCapture(this, credential, {
				method: 'POST',
				url: `${baseUrl}${CAPTURE_PATH}`,
				body,
				json: true,
				timeout: REQUEST_TIMEOUT_MS,
			});
		} catch (error) {
			// Reading a file can fail too: the run still carries on.
			failure = error;
		}
		if (failure !== undefined) {
			this.logger.warn(
				`SafeDataPath: run ${executionId} not recorded at ${baseUrl}${CAPTURE_PATH}: ${describe(failure)}`,
			);
			warnNotRecorded(this, executionId, `${describe(failure)}.`);
			if (manual && isCredentialRefused(failure) && !this.continueOnFail()) {
				throw new NodeOperationError(this.getNode(), 'SafeDataPath refused this credential.', {
					description: `Reconnect the credential or check its key. ${describe(failure)}`,
				});
			}
		}
		return [items];
	}
}
