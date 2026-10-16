// Minimal client for the n8n public API (v1) used by the integration suite.

export interface WorkflowNode {
	id: string;
	name: string;
	type: string;
	typeVersion: number;
	position: [number, number];
	parameters: Record<string, unknown>;
	credentials?: Record<string, { id: string; name: string }>;
	webhookId?: string;
}

export interface WorkflowDefinition {
	name: string;
	nodes: WorkflowNode[];
	connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }>;
	settings: Record<string, unknown>;
}

export interface NodeRun {
	data?: { main?: Array<Array<{ json: Record<string, unknown> }> | null> };
	error?: { message?: string };
}

export interface Execution {
	id: string;
	workflowId: string;
	status: string;
	finished: boolean;
	data?: { resultData?: { runData?: Record<string, NodeRun[]>; error?: { message?: string } } };
}

interface Page<T> {
	data: T[];
	nextCursor?: string | null;
}

export class N8nApi {
	private readonly baseUrl: string;
	private readonly apiKey: string;

	constructor(baseUrl: string, apiKey: string) {
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
			method,
			headers: { 'X-N8N-API-KEY': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`n8n API ${method} ${path} answered HTTP ${response.status}: ${text}`);
		}
		return (text ? JSON.parse(text) : undefined) as T;
	}

	listCommunityPackages(): Promise<Array<{ packageName: string; installedVersion: string }>> {
		return this.call('GET', '/community-packages');
	}

	createCredential(name: string, type: string, data: Record<string, unknown>): Promise<{ id: string; name: string }> {
		return this.call('POST', '/credentials', { name, type, data });
	}

	async deleteCredential(id: string): Promise<void> {
		await this.call('DELETE', `/credentials/${id}`);
	}

	createWorkflow(definition: WorkflowDefinition): Promise<{ id: string }> {
		return this.call('POST', '/workflows', definition);
	}

	async activateWorkflow(id: string): Promise<void> {
		await this.call('POST', `/workflows/${id}/activate`);
	}

	async deleteWorkflow(id: string): Promise<void> {
		await this.call('DELETE', `/workflows/${id}`);
	}

	async listExecutions(workflowId: string): Promise<Execution[]> {
		const query = new URLSearchParams({ workflowId, includeData: 'true', limit: '20' });
		const page = await this.call<Page<Execution>>('GET', `/executions?${query.toString()}`);
		return page.data;
	}

	/** Calls a production webhook. Answers the HTTP status only: a failing workflow may still have run. */
	async callWebhook(path: string, body: unknown): Promise<number> {
		const response = await fetch(`${this.baseUrl}/webhook/${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		await response.text();
		return response.status;
	}
}
