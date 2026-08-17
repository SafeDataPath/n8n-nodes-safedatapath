import { createHash } from 'crypto';
import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

// Every SDP endpoint lives under /api. Omitting that prefix does NOT fail loudly: the request falls through
// to SDP's single-page-app catch-all route, which answers 200 with index.html - so the caller happily treats a
// page of HTML as its response body. Hence the shared prefix rather than two independently written paths.
const API_PREFIX = '/api';
const CAPTURE_PATH = `${API_PREFIX}/n8n/capture`;
const UPLOAD_CHUNK_PATH = `${API_PREFIX}/pipeline/upload-chunk`;

/** Must stay SHA-512/base64: that is the pair SDP's HashValidator accepts (88 chars for 512 bits). */
const HASH_ALGORITHM = 'sha512';
const HASH_ENCODING = 'base64';

// /pipeline/upload-chunk verifies the assembled file against a SHA-512 HEX digest (its own doc comment says
// SHA-256; the server code computes SHA-512 - verified by reading SdpUtils.uploadChunk, not the doc comment).
const UPLOAD_HASH_ENCODING = 'hex';
// Balances round-trips against per-request memory/latency; SDP places no documented limit on this endpoint.
const UPLOAD_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;

/**
 * One file reaching this node. The hash is always computed. `fileTransferId` is set only when upload mode is
 * on - the file's bytes then travel to SDP's own storage too, not just its digest.
 */
interface BinaryDigest extends IDataObject {
	/** The node that produced the file — this is what ties the digest to the right trace in SDP. */
	nodeName: string;
	itemIndex: number;
	property: string;
	fileName?: string;
	mimeType?: string;
	bytes: number;
	algorithm: string;
	encoding: string;
	hash: string;
	fileTransferId?: string;
}

/**
 * Uploads one file to SDP via the same chunked endpoint the file-upload UI uses, and returns the transfer id
 * to pass to /api/n8n/capture. Chunking (rather than one request) keeps large files from needing the whole
 * buffer held twice (once already in memory from getBinaryDataBuffer, once in the HTTP client) at request time.
 */
async function uploadFile(
	ctx: IExecuteFunctions,
	baseUrl: string,
	buffer: Buffer,
	fileName: string,
): Promise<string> {
	const totalChunks = Math.max(1, Math.ceil(buffer.length / UPLOAD_CHUNK_SIZE_BYTES));
	const fileHash = createHash(HASH_ALGORITHM).update(buffer).digest(UPLOAD_HASH_ENCODING);
	// Empty on the first call: the server generates it and returns it for every call after (see
	// PipelineController.pipelineUploadChunk's own parameter doc).
	let transferId = '';
	for (let chunkId = 1; chunkId <= totalChunks; chunkId++) {
		const start = (chunkId - 1) * UPLOAD_CHUNK_SIZE_BYTES;
		// Native FormData/Blob (Node >=18 globals, no import needed): community nodes may not declare their
		// own runtime dependencies (n8n Cloud requirement), which rules out the 'form-data' package even
		// though n8n-workflow's own HTTP types are written against it - it structurally accepts this too.
		const formData = new FormData();
		formData.append(
			'fileChunk',
			new Blob([buffer.subarray(start, start + UPLOAD_CHUNK_SIZE_BYTES)]),
			fileName,
		);
		const options: IHttpRequestOptions = {
			method: 'POST',
			url: `${baseUrl}${UPLOAD_CHUNK_PATH}`,
			qs: { transferId, chunkId, totalChunks, fileHash },
			body: formData as unknown as IHttpRequestOptions['body'],
			// The response body is the bare transferId string, not a JSON document - asking n8n to parse it
			// as JSON would fail on an unquoted string.
			json: false,
		};
		transferId = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'sdpApi', options)) as string;
	}
	// The endpoint answers with a bare transfer id (a UUID). Anything else means the request did not reach it -
	// most likely SDP's SPA catch-all returning index.html with a 200, which would otherwise travel on as a
	// "transfer id" and only surface much later, server-side, as an unreadable file path.
	if (typeof transferId !== 'string' || !/^[0-9a-f-]{36}$/i.test(transferId.trim())) {
		throw new NodeOperationError(
			ctx.getNode(),
			`SDP upload did not return a transfer id. Got: ${String(transferId).slice(0, 120)}`,
			{ description: `POST ${baseUrl}${UPLOAD_CHUNK_PATH}` },
		);
	}
	return transferId.trim();
}

/**
 * Fingerprints every binary property on this node's input, and optionally uploads it to SDP's own storage.
 * <p>
 * Why here and not server-side: SDP's capture fetches the execution from the n8n API, and for a run whose
 * binaries are held out of memory that API returns a REFERENCE, not the bytes. Inside the node is the only
 * place the raw content is reachable at all.
 * <p>
 * `getBinaryDataBuffer` is the only correct accessor. n8n stores binary either inline (base64 in
 * `binary[prop].data`) or out of memory (filesystem/S3, where `data` is empty and only `id` is set) — reading
 * `.data` directly silently yields nothing in the second mode, which is the default on real deployments.
 */
async function collectBinaryDigests(
	ctx: IExecuteFunctions,
	baseUrl: string,
	uploadFiles: boolean,
): Promise<BinaryDigest[]> {
	const items = ctx.getInputData();
	let nodeName = '';
	try {
		nodeName = ctx.getInputSourceData().previousNode;
	} catch {
		// No source data when nothing is wired upstream: the digests still travel, unattributed.
	}

	const digests: BinaryDigest[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const binary = items[itemIndex].binary;
		if (!binary) {
			continue;
		}
		for (const property of Object.keys(binary)) {
			const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, property);
			const meta = binary[property];
			// Fall back to a synthetic name rather than leaving it unset: SDP hangs the download of a retained
			// file off its file_name metadata, so a nameless upload is stored but never offered for download.
			// The SAME value is used for the upload and reported here, so the two can never disagree.
			const fileName = meta.fileName ?? `${property}.bin`;
			digests.push({
				nodeName,
				itemIndex,
				property,
				fileName,
				mimeType: meta.mimeType,
				// The buffer's own length, not meta.fileSize: that one is a display string ("1.2 MB").
				bytes: buffer.length,
				algorithm: HASH_ALGORITHM,
				encoding: HASH_ENCODING,
				hash: createHash(HASH_ALGORITHM).update(buffer).digest(HASH_ENCODING),
				fileTransferId: uploadFiles ? await uploadFile(ctx, baseUrl, buffer, fileName) : undefined,
			});
		}
	}
	return digests;
}

export class Sdp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SDP',
		name: 'sdp',
		icon: { light: 'file:SDP_LOGO.png', dark: 'file:sdp_logo_2.png' },
		group: ['transform'],
		version: 1,
		subtitle: 'Capture this run in SDP',
		description:
			'Register this workflow run in SafeDataPath (SDP) as a cryptographically verifiable pipeline - including AI prompts, model and token usage. SDP captures the run once it finishes.',
		defaults: { name: 'SDP' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'sdpApi', required: true }],
		properties: [
			{
				displayName:
					'This node can sit <b>anywhere</b> in your workflow: it only asks SDP to capture the run, and SDP waits for the run to finish before fetching it from n8n. The pipeline therefore appears a few seconds after the run ends, not when this node executes. '
					+ 'In a branching workflow, placing it <b>first</b> is the safer choice - a node at the end of one branch is skipped whenever another branch runs. '
					+ 'The one trade-off: file fingerprinting below only covers files that actually reach this node, so a node placed first will not fingerprint anything.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Execution ID',
				name: 'executionId',
				type: 'string',
				default: '={{ $execution.id }}',
				required: true,
				description: 'The n8n execution SDP should capture. Defaults to the current run.',
			},
			{
				displayName: 'Fingerprint Files Reaching This Node',
				name: 'hashBinaryFiles',
				type: 'boolean',
				default: true,
				description:
					'Whether to compute a SHA-512 of every file (PDF, image, audio, CSV…) arriving at this node and '
					+ 'register only that digest. The file itself never leaves your n8n instance. Turn this off if the '
					+ 'upstream node produces very large files and you do not need them fingerprinted.',
			},
			{
				displayName: 'Upload Files to SDP (Keep Original)',
				name: 'uploadBinaryFiles',
				type: 'boolean',
				default: false,
				displayOptions: { show: { hashBinaryFiles: [true] } },
				description:
					'Whether to also upload each file to SDP\'s own storage, so it can be downloaded later from '
					+ 'SDP - not just verified against a hash. Off by default: SDP then becomes a holder of the file, '
					+ 'not only of its fingerprint. This decision is locked in the first time a node\'s schema is '
					+ 'created - turning it on for a node whose schema already exists (from an earlier run with this '
					+ 'off) verifies the hash but does not retroactively start keeping the file; that needs a '
					+ 'structural change to the workflow so a new schema version is created with this on.',
			},
			{
				displayName: 'Verify URL Webhook',
				name: 'callbackUrl',
				type: 'string',
				default: '',
				placeholder: 'https://n8n.example.com/webhook/sdp-verify',
				description:
					'Optional. An n8n Webhook URL (in a separate workflow). Once SDP registers the pipeline, it POSTs '
					+ '{ executionId, pipelineUuid, verifyUrl } here - so the Verify link is pushed back to n8n instead '
					+ 'of being polled. Leave empty to skip.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		let baseUrl = '';

		try {
			const executionId = this.getNodeParameter('executionId', 0) as string;
			const callbackUrl = (this.getNodeParameter('callbackUrl', 0, '') as string).trim();

			const credentials = await this.getCredentials('sdpApi');
			baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');

			const body: IDataObject = { executionId };
			if (callbackUrl) {
				body.callbackUrl = callbackUrl;
			}

			// Files are fingerprinted (and, if enabled, uploaded) BEFORE the capture request, so the digests
			// travel with it: the async capture that follows reads the run from the n8n API, where the bytes
			// are no longer reachable.
			const hashBinaryFiles = this.getNodeParameter('hashBinaryFiles', 0, true) as boolean;
			const uploadBinaryFiles = hashBinaryFiles && (this.getNodeParameter('uploadBinaryFiles', 0, false) as boolean);
			const binaryDigests = hashBinaryFiles ? await collectBinaryDigests(this, baseUrl, uploadBinaryFiles) : [];
			if (binaryDigests.length > 0) {
				body.binaryHashes = binaryDigests;
			}

			const options: IHttpRequestOptions = {
				method: 'POST',
				url: `${baseUrl}${CAPTURE_PATH}`,
				body,
				json: true,
			};

			// Fire-and-forget: SDP registers the run once n8n reports it finished (the current run is still
			// in progress while this node executes, so capture cannot be synchronous).
			await this.helpers.httpRequestWithAuthentication.call(this, 'sdpApi', options);

			const result: IDataObject = {
				sdp: 'capture requested',
				executionId,
				// Surfaced so the digest is visible in n8n at run time: it is what the customer recomputes on
				// their own copy of the file (`sha512sum -b file | xxd -r -p | base64`) to prove it is the one
				// SDP registered.
				filesFingerprinted: binaryDigests.length,
				...(binaryDigests.length > 0 ? { binaryHashes: binaryDigests } : {}),
				// The exact /verify/<pipelineUuid> link only exists after the async ingest (the run is not finished
				// while this node executes), so we surface the SDP instance URL: the captured pipeline - and its
				// Verify page - appears there a few seconds after the run ends.
				sdpUrl: baseUrl,
				message:
					`SDP will register this run once it finishes. Open SDP to verify the pipeline: ${baseUrl}`,
			};
			return [this.helpers.returnJsonArray(result)];
		} catch (error) {
			const err = error as {
				message?: string;
				httpCode?: string | number;
				statusCode?: number;
				code?: string;
				description?: string;
				response?: { statusCode?: number; status?: number; body?: unknown; data?: unknown };
				cause?: {
					code?: string;
					statusCode?: number;
					response?: { status?: number; statusCode?: number; body?: unknown; data?: unknown };
				};
			};
			const status =
				err.statusCode ??
				err.httpCode ??
				err.response?.statusCode ??
				err.response?.status ??
				err.cause?.statusCode ??
				err.cause?.response?.status ??
				err.cause?.response?.statusCode;
			const responseBody =
				err.response?.body ??
				err.response?.data ??
				err.cause?.response?.data ??
				err.cause?.response?.body ??
				err.description;
			const parts: string[] = [];
			if (status) parts.push(`HTTP ${status}`);
			if (err.code ?? err.cause?.code) parts.push(String(err.code ?? err.cause?.code));
			if (responseBody !== undefined && responseBody !== null) {
				parts.push(typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody));
			}
			const detail = parts.join(' - ') || err.message || 'unknown error';
			const targetUrl = `${baseUrl}${CAPTURE_PATH}`;

			if (this.continueOnFail()) {
				return [[{ json: { error: detail, url: targetUrl }, pairedItem: { item: 0 } }]];
			}
			throw new NodeOperationError(this.getNode(), error as Error, {
				message: `SDP capture request failed: ${detail}`,
				description: `POST ${targetUrl}`,
			});
		}
	}
}
