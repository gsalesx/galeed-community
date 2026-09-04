/** Auth "custom" do Zapier: URL do Galeed + chave gld_ (Bearer em toda request via middleware).
 *  O teste de conexão lista os ingestores (GET /v1/ingestors, autenticado). */
'use strict';

const authentication = {
	type: 'custom',
	fields: [
		{
			key: 'baseUrl',
			label: 'URL do Galeed',
			required: true,
			helpText:
				'A origem do seu Galeed, sem /v1 no fim (ex.: `https://galeed.suaempresa.com`). É o mesmo endereço do painel.',
		},
		{
			key: 'apiToken',
			label: 'Chave da API (gld_...)',
			required: true,
			type: 'password',
			helpText:
				'Gere no painel em **Conectar → chaves do cérebro**. Pra ingerir, a chave precisa de `can_ingest`; pra Perguntar/ler, convide o bot em **Acesso** com **"Todas as áreas (acesso total)"**.',
		},
	],
	test: {
		url: '{{bundle.authData.baseUrl}}/v1/ingestors',
	},
	connectionLabel: 'Galeed em {{bundle.authData.baseUrl}}',
};

/** injeta o Bearer em TODA request (padrão Zapier de custom auth). */
const addBearer = (request, z, bundle) => {
	if (bundle.authData.apiToken) {
		request.headers = request.headers || {};
		request.headers.Authorization = `Bearer ${bundle.authData.apiToken}`;
	}
	return request;
};

module.exports = { authentication, addBearer };
