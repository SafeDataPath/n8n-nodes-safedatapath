import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

// FCT-1676. Connect to SDP with OAuth2 (PKCE), the way HubSpot's OAuth2 credential works. Every field is
// hidden, so n8n shows its "Connect to SDP" button straight in the node. The SDP side (authorize and
// token endpoints, the public "n8n" client) is FCT-1628. Until it ships, Connect opens the SDP trial
// entry flow (/trial?entry=n8n) so the visitor can sign in or create an account; no token comes back yet.
export class SdpOAuth2Api implements ICredentialType {
	name = 'sdpOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'SDP OAuth2 API';

	documentationUrl = 'https://safedatapath.io';

	// Same logo as the node, so the Connect button and the credential page show SDP's own mark.
	icon: Icon = { light: 'file:SDP_LOGO.png', dark: 'file:sdp_logo_2.png' };

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			// Hidden: n8n offers its quick connect button only when the user has nothing to fill in. A local or
			// test SDP sets it on the n8n instance instead, with CREDENTIALS_OVERWRITE_DATA.
			type: 'hidden',
			default: 'https://n8n.safedatapath.eu',
		},
		{
			displayName: 'Use Dynamic Client Registration',
			name: 'useDynamicClientRegistration',
			type: 'hidden',
			default: false,
		},
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'pkce',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: '={{$self["baseUrl"].replace(/\\/+$/, "")}}/trial',
			required: true,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: '={{$self["baseUrl"].replace(/\\/+$/, "")}}/api/oauth2/token',
			required: true,
		},
		// A public PKCE client: n8n sends client_secret only when it is not empty.
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'hidden',
			default: 'n8n',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'hidden',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			// The trial flow reads its n8n skin from it. Kept out of authUrl: n8n adds its own query to that URL.
			default: 'entry=n8n',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
	];
}
