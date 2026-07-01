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

const CAPTURE_PATH = '/api/n8n/capture';

export class Sdp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SDP',
		name: 'sdp',
		icon: { light: 'file:sdp.light.svg', dark: 'file:sdp.dark.svg' },
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
					'Place this node at the <b>end</b> of your workflow. When the run finishes, SDP fetches it from n8n and registers a verifiable pipeline (prompts, model, tokens, checksums). The pipeline appears in SDP a few seconds after the run - capture is asynchronous because the run is not finished while this node executes.',
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
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		let baseUrl = '';

		try {
			const executionId = this.getNodeParameter('executionId', 0) as string;

			const credentials = await this.getCredentials('sdpApi');
			baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');

			const options: IHttpRequestOptions = {
				method: 'POST',
				url: `${baseUrl}${CAPTURE_PATH}`,
				body: { executionId },
				json: true,
			};

			// Fire-and-forget: SDP registers the run once n8n reports it finished (the current run is still
			// in progress while this node executes, so capture cannot be synchronous).
			await this.helpers.httpRequestWithAuthentication.call(this, 'sdpApi', options);

			const result: IDataObject = {
				sdp: 'capture requested',
				executionId,
				message:
					'SDP will register this run once it finishes; the verifiable pipeline appears in SDP shortly after.',
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
