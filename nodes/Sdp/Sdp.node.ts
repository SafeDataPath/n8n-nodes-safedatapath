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

const REGISTER_FROM_EXECUTION_PATH = '/api/pipeline/register-from-execution';

export class Sdp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SDP',
		name: 'sdp',
		icon: { light: 'file:sdp.light.svg', dark: 'file:sdp.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description:
			'Register workflow execution provenance in SafeDataPath (SDP) with cryptographic checksums',
		defaults: { name: 'SDP' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'sdpApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Register Execution',
						value: 'registerExecution',
						action: 'Register a workflow execution with auto schema',
						description: 'Hash the data passing through this node and register it as an SDP pipeline. SDP auto-models the schema on the first run.',
					},
				],
				default: 'registerExecution',
			},
			{
				displayName: 'Workflow ID',
				name: 'workflowId',
				type: 'string',
				default: '={{ $workflow.id }}',
				required: true,
				description: 'Identifies the workflow. Combined with the "wf-" prefix to form the SDP schema alias.',
			},
			{
				displayName: 'Workflow Name',
				name: 'workflowName',
				type: 'string',
				default: '={{ $workflow.name }}',
			},
			{
				displayName: 'Execution ID',
				name: 'executionId',
				type: 'string',
				default: '={{ $execution.id }}',
				required: true,
				description:
					'Identifies this run. Stored as the SDP pipeline externalId. A duplicate run is rejected with HTTP 409',
			},
			{
				displayName: 'Step Name',
				name: 'stepName',
				type: 'string',
				default: 'data',
				description: 'Name recorded in SDP for the data passing through this node',
			},
			{
				displayName: 'Step Type',
				name: 'stepType',
				type: 'string',
				default: 'n8n',
			},
			{
				displayName: 'Hash Algorithm',
				name: 'hashAlgorithm',
				type: 'options',
				options: [
					{ name: 'SHA-256', value: 'SHA-256' },
					{ name: 'SHA-512', value: 'SHA-512' },
				],
				default: 'SHA-256',
			},
			{
				displayName: 'Hash Encoding',
				name: 'hashEncoding',
				type: 'options',
				options: [
					{ name: 'Base64', value: 'BASE64' },
					{ name: 'Hex', value: 'HEX' },
				],
				default: 'HEX',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		let baseUrl = '';

		try {
			const workflowId = this.getNodeParameter('workflowId', 0) as string;
			const workflowName = this.getNodeParameter('workflowName', 0) as string;
			const executionId = this.getNodeParameter('executionId', 0) as string;
			const stepName = (this.getNodeParameter('stepName', 0) as string) || 'data';
			const stepType = this.getNodeParameter('stepType', 0) as string;
			const hashAlgorithm = this.getNodeParameter('hashAlgorithm', 0) as string;
			const hashEncoding = this.getNodeParameter('hashEncoding', 0) as string;

			// Deterministic, canonical serialization of the data passing through this node, so the same
			// data always yields the same checksum (a precondition for a reproducible proof).
			const canonical = JSON.stringify(items.map((item) => item.json));
			const algorithm = hashAlgorithm === 'SHA-512' ? 'sha512' : 'sha256';
			const encoding = hashEncoding === 'BASE64' ? 'base64' : 'hex';
			const outputHash = createHash(algorithm).update(canonical, 'utf8').digest(encoding);

			// This node only knows its own canvas position; full-workflow layout capture is handled by
			// the SDP-side polling integration (which reads every node's position from the n8n API).
			const [posX, posY] = this.getNode().position ?? [];

			// Provenance details about the data entering this node.
			let sourceNode: string | undefined;
			try {
				sourceNode = this.getInputSourceData()?.previousNode;
			} catch {
				// No upstream source (e.g. fed directly by a trigger).
			}
			const executedAt = new Date().toISOString();

			const body: IDataObject = {
				workflowId,
				executionId,
				hashAlgorithm,
				hashEncoding,
				nodes: [
					{
						name: stepName,
						type: stepType || undefined,
						outputHash,
						x: typeof posX === 'number' ? Math.round(posX) : undefined,
						y: typeof posY === 'number' ? Math.round(posY) : undefined,
						sourceNode: sourceNode || undefined,
						executedAt,
						itemCount: items.length,
					},
				],
			};
			if (workflowName) {
				body.workflowName = workflowName;
			}

			const credentials = await this.getCredentials('sdpApi');
			baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');

			const options: IHttpRequestOptions = {
				method: 'POST',
				url: `${baseUrl}${REGISTER_FROM_EXECUTION_PATH}`,
				body,
				json: true,
			};

			const response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				'sdpApi',
				options,
			)) as IDataObject;

			return [this.helpers.returnJsonArray(response)];
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
			const body =
				err.response?.body ??
				err.response?.data ??
				err.cause?.response?.data ??
				err.cause?.response?.body ??
				err.description;
			const parts: string[] = [];
			if (status) parts.push(`HTTP ${status}`);
			if (err.code ?? err.cause?.code) parts.push(String(err.code ?? err.cause?.code));
			if (body !== undefined && body !== null) {
				parts.push(typeof body === 'string' ? body : JSON.stringify(body));
			}
			const detail = parts.join(' - ') || err.message || 'unknown error';
			const targetUrl = `${baseUrl}${REGISTER_FROM_EXECUTION_PATH}`;

			if (this.continueOnFail()) {
				return [[{ json: { error: detail, url: targetUrl }, pairedItem: { item: 0 } }]];
			}
			throw new NodeOperationError(this.getNode(), error as Error, {
				message: `SDP registration failed: ${detail}`,
				description: `POST ${targetUrl}`,
			});
		}
	}
}
