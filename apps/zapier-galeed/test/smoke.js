/** Smoke INDEPENDENTE da Zapier App — roda a app localmente (createAppTester, sem conta Zapier)
 *  contra um Galeed vivo. Uso:
 *    GALEED_URL=http://localhost:8790 GALEED_TOKEN=gld_live_... node test/smoke.js */
'use strict';

const zapier = require('zapier-platform-core');
const App = require('../index');

const appTester = zapier.createAppTester(App);
zapier.tools.env.inject();

const authData = {
	baseUrl: process.env.GALEED_URL || 'http://localhost:8790',
	apiToken: process.env.GALEED_TOKEN || '',
};

async function main() {
	if (!authData.apiToken) {
		console.error('defina GALEED_TOKEN (chave gld_ com can_ingest).');
		process.exit(1);
	}

	// 1. teste de auth (o mesmo que o botão "Test" do Zapier roda)
	const auth = await appTester(App.authentication.test, { authData });
	console.log(`✓ auth: ${auth.data ? auth.data.ingestors.length : auth.ingestors.length} ingestores visíveis`);

	// 2. ação de ingestão (texto)
	const ingest = await appTester(App.creates.ingerir_texto.operation.perform, {
		authData,
		inputData: {
			title: 'Smoke da Zapier App',
			text: 'A Zapier App do Galeed foi validada de ponta a ponta em ' + new Date().toISOString().slice(0, 10) + '.',
			ref: 'zapier-smoke-1',
		},
	});
	console.log(`✓ ingerir_texto: status=${ingest.status} enfileirados=${ingest.enfileirados} dedupados=${ingest.dedupados}`);

	// 3. ação de leitura (perguntar) — exige bot com acesso total (ver ZAPIER.md)
	const ask = await appTester(App.creates.perguntar.operation.perform, {
		authData,
		inputData: { question: 'Quando é a manutenção do aparelho de peeling?' },
	});
	console.log(`✓ perguntar: "${String(ask.answer).slice(0, 90)}..."`);

	console.log('\nsmoke OK — as 3 pontas (auth, ingestão, pergunta) funcionaram.');
}

main().catch((e) => {
	console.error('smoke FALHOU:', e.message || e);
	process.exit(1);
});
