/** M22 RECONCILE (Integrador) — o registro REAL dos handlers de conector no seam (a "1 linha do
 *  Integrador" prevista na M22-A-DESIGN-SPEC §4.4: B e C exportam handlers ESTRUTURALMENTE
 *  compatíveis SEM importar o seam — worktrees paralelas — e o Integrador os pluga aqui).
 *
 *  Por que um módulo dedicado e não um import side-effect: o registry é um Map em memória
 *  (connector-ingest.ts) vivo no PROCESSO do BFF (onde o webhook do Nango ingere). Centralizar o
 *  registro num boot idempotente, chamado de startWebServer(), evita depender de ordem de import e
 *  deixa explícito QUEM está vivo em produção. Determinístico, sem IO.
 *
 *  Cast por `unknown`: o seam declara `sourceSeed(): ConnectorSourceSeed` (zero-arg) e
 *  `normalize(record, ctx: ConnectorRecordCtx)`. B/C exportam variações estruturalmente usáveis pelo
 *  connectorCreateHandler/webhook (B: sourceSeed() zero-arg → {id,name,channel,type,recipe,sens};
 *  C: sourceSeed(id?,name?) → SourceRow, chamado sem args pelo create handler que lê só
 *  name/channel/type/recipe/sensitivity e gera o próprio id). Compatíveis em runtime; o cast só
 *  reconcilia a assinatura nominal entre worktrees que não se importaram. */
import { registerConnectorHandler, type ConnectorHandler } from "./connector-ingest.ts";
import { contaAzulConnector } from "./connectors/conta-azul.ts";
import { gmailConnector } from "./connectors/gmail.ts";

let _booted = false;

/** Registra os conectores de produção (idempotente — register usa "último ganha"). */
export function registerProductionConnectors(): void {
  if (_booted) return;
  registerConnectorHandler(contaAzulConnector as unknown as ConnectorHandler);
  registerConnectorHandler(gmailConnector as unknown as ConnectorHandler);
  _booted = true;
}
