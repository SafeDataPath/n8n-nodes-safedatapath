// Workflows the suite creates on the instance. Every name and webhook path carries the run id.

import { randomUUID } from 'node:crypto';
import type { WorkflowDefinition, WorkflowNode } from './n8nApi.mts';

export const SDP_NODE_NAME = 'SafeDataPath';
export const FILE_NODE_NAME = 'Make file';
export const FILE_NAME = 'sdp-integration-test.txt';

// SDP reads the run back through the n8n API, so its data must be saved whatever the instance default.
const SETTINGS = {
	executionOrder: 'v1',
	saveDataSuccessExecution: 'all',
	saveDataErrorExecution: 'all',
	saveExecutionProgress: false,
};

export interface CredentialRef {
	id: string;
	name: string;
}

export interface CaptureWorkflowOptions {
	runId: string;
	sdpNodeType: string;
	credential: CredentialRef;
	fileContent: string;
	/** Adds a node after the SDP node that throws, so the run ends in error. */
	failAfterCapture: boolean;
	/** Which Authentication option the node uses, and the credential type that goes with it (FCT-1746). */
	authentication?: 'apiKey' | 'oAuth2';
	credentialType?: 'sdpApi' | 'sdpOAuth2Api';
}

function webhookNode(name: string, path: string): WorkflowNode {
	return {
		id: randomUUID(),
		name,
		type: 'n8n-nodes-base.webhook',
		typeVersion: 2,
		position: [0, 0],
		parameters: { httpMethod: 'POST', path, responseMode: 'onReceived', options: {} },
		webhookId: randomUUID(),
	};
}

function codeNode(name: string, jsCode: string, x: number): WorkflowNode {
	return {
		id: randomUUID(),
		name,
		type: 'n8n-nodes-base.code',
		typeVersion: 2,
		position: [x, 0],
		parameters: { jsCode },
	};
}

function link(target: string) {
	return { main: [[{ node: target, type: 'main' as const, index: 0 }]] };
}

export function startPath(runId: string): string {
	return `sdp-it-start-${runId}`;
}

/** Webhook, a node producing one text file, then the SDP node, version 2 on an API key. */
export function captureWorkflow(options: CaptureWorkflowOptions): WorkflowDefinition {
	const makeFile = codeNode(
		FILE_NODE_NAME,
		[
			`const content = Buffer.from(${JSON.stringify(options.fileContent)}, 'utf8');`,
			`const data = await this.helpers.prepareBinaryData(content, '${FILE_NAME}', 'text/plain');`,
			`return [{ json: { fileName: '${FILE_NAME}' }, binary: { data } }];`,
		].join('\n'),
		200,
	);
	const authentication = options.authentication ?? 'apiKey';
	const credentialType = options.credentialType ?? 'sdpApi';
	const sdp: WorkflowNode = {
		id: randomUUID(),
		name: SDP_NODE_NAME,
		type: options.sdpNodeType,
		typeVersion: 2,
		position: [400, 0],
		parameters: { authentication },
		credentials: { [credentialType]: options.credential },
	};
	const nodes = [webhookNode('Start', startPath(options.runId)), makeFile, sdp];
	const connections: WorkflowDefinition['connections'] = {
		Start: link(FILE_NODE_NAME),
		[FILE_NODE_NAME]: link(SDP_NODE_NAME),
	};
	if (options.failAfterCapture) {
		const fail = codeNode('Fail on purpose', `throw new Error('Failure on purpose (SDP integration test)');`, 600);
		nodes.push(fail);
		connections[SDP_NODE_NAME] = link(fail.name);
	}
	return {
		name: `SDP integration test ${options.runId}${options.failAfterCapture ? ' - failing' : ''}`,
		nodes,
		connections,
		settings: SETTINGS,
	};
}
