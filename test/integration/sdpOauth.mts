// Drives the SDP side of the n8n Connect app (FCT-1740), the same three calls n8n itself makes when a
// visitor signs in and approves: log in, approve, exchange the code. Nothing here can click a real
// button, so a human account and password stand in for "a visitor who already has one."

import { createHash, randomBytes } from 'node:crypto';

export interface OAuthTokenData {
	access_token: string;
	token_type: string;
	expires_in: number;
	refresh_token: string;
}

function base64url(buffer: Buffer): string {
	return buffer.toString('base64url');
}

async function json<T>(response: Response, what: string): Promise<T> {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${what} answered HTTP ${response.status}: ${text}`);
	}
	return JSON.parse(text) as T;
}

/**
 * Signs in, approves the Connect app, and exchanges the code: the same outcome a visitor gets by
 * clicking Connect in the node, signing in with a password, Microsoft or Google, then approving.
 *
 * @param redirectUri must be on the origin n8n's own OAuth2 callback uses (sdp.trial.n8n-redirect-origins).
 */
export async function obtainOauthToken(
	sdpUrl: string,
	email: string,
	password: string,
	tenantAlias: string,
	redirectUri: string,
): Promise<OAuthTokenData> {
	const loginResponse = await fetch(`${sdpUrl}/api/ba/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password, tenantAlias }),
	});
	const login = await json<{ token: { uuid: string } }>(loginResponse, 'SDP login');

	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash('sha256').update(verifier).digest());
	const state = base64url(randomBytes(12));

	const authorizeResponse = await fetch(`${sdpUrl}/api/oauth2/authorize`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token.uuid}` },
		body: JSON.stringify({
			redirectUri,
			state,
			codeChallenge: challenge,
			codeChallengeMethod: 'S256',
			approved: true,
		}),
	});
	const authorize = await json<{ redirectUrl: string }>(authorizeResponse, 'SDP OAuth2 authorize');
	const code = new URL(authorize.redirectUrl).searchParams.get('code');
	if (!code) {
		throw new Error(`SDP OAuth2 authorize answered no code: ${authorize.redirectUrl}`);
	}

	const tokenResponse = await fetch(`${sdpUrl}/api/oauth2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: 'n8n',
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});
	return json<OAuthTokenData>(tokenResponse, 'SDP OAuth2 token exchange');
}
