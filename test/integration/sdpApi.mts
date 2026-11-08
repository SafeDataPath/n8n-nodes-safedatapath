// Reads back from SDP what the node asked it to capture, with the same machine user key.

export interface VerificationSummary {
	verificationUrl?: string;
	issuedAt?: string;
	outputHash?: string;
}

export interface SummaryAnswer {
	status: number;
	summary: VerificationSummary | undefined;
	text: string;
}

export class SdpApi {
	private readonly baseUrl: string;
	private readonly apiKey: string;

	constructor(baseUrl: string, apiKey: string) {
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
	}

	/** An n8n run lands as a pipeline whose external id is the execution id. */
	async verificationSummary(executionId: string): Promise<SummaryAnswer> {
		const query = new URLSearchParams({ externalId: executionId });
		const response = await fetch(`${this.baseUrl}/api/pipeline/verification-summary?${query.toString()}`, {
			headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
		});
		const text = await response.text();
		const summary = response.ok && text ? (JSON.parse(text) as VerificationSummary) : undefined;
		return { status: response.status, summary, text };
	}
}
