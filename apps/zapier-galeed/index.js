/** Zapier App do Galeed — ver ZAPIER.md na raiz do repo (como publicar privada + convite). */
'use strict';

const { version } = require('./package.json');
const { authentication, addBearer } = require('./authentication');
const creates = require('./creates');

module.exports = {
	version,
	platformVersion: require('zapier-platform-core').version,
	authentication,
	beforeRequest: [addBearer],
	creates: {
		[creates.ingerirTexto.key]: creates.ingerirTexto,
		[creates.mensagemDeChat.key]: creates.mensagemDeChat,
		[creates.transcricaoDeReuniao.key]: creates.transcricaoDeReuniao,
		[creates.formularioLead.key]: creates.formularioLead,
		[creates.planilhaTabela.key]: creates.planilhaTabela,
		[creates.perguntar.key]: creates.perguntar,
	},
};
