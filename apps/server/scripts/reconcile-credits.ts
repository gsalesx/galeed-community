/** M-PAY-H (Onda 6) — RECONCILIAÇÃO do ledger de créditos (job/CLI, FORA do request path).
 *
 *  INVARIANTE de dinheiro (contrato M-PAY-H): o saldo materializado que o gate lê
 *  (`galeed_credit_wallet.balance`) tem de ser IGUAL a `sum(galeed_credit_ledger.delta)` por conta — o
 *  razão é append-only e é a verdade; a carteira é a projeção rápida. Este script confere isso em todas
 *  as carteiras, relata as que divergiram (drift) e, com `--repair`, CASA a carteira ao razão (fonte da
 *  verdade): `balance = sum(ledger.delta)` (e baixa trial_remaining p/ caber). NÃO posta entrada no razão
 *  — mexer na soma que É a verdade reabriria o drift; o reparo é uma projeção idempotente (re-rodar é
 *  no-op porque a carteira já bate). Ver reconcileCredits em core/platform/credits.ts.
 *
 *  Uso:
 *    set -a; . ./.env; set +a
 *    npx tsx apps/server/scripts/reconcile-credits.ts            # só relatório (dry-run)
 *    npx tsx apps/server/scripts/reconcile-credits.ts --repair   # posta os ajustes
 *
 *  Saída: lista cada carteira com drift (balanceDrift / trialDrift / trialOverBalance) e um sumário.
 *  Exit code 0 sempre (job de observação); o operador lê o relatório. NÃO debita uso nem credita grant.
 */
import { reconcileCredits } from "../src/core/platform/credits.ts";
import { closeEngines } from "../src/core/platform/engine.ts";

async function main() {
  const repair = process.argv.includes("--repair");
  const report = await reconcileCredits({ repair });

  console.log(`[reconcile] carteiras conferidas: ${report.walletsChecked}`);
  if (report.drifted.length === 0) {
    console.log("[reconcile] OK — todas consistentes (sum(ledger.delta) == balance, trial coerente).");
  } else {
    console.log(`[reconcile] DRIFT em ${report.drifted.length} carteira(s):`);
    for (const d of report.drifted) {
      console.log(
        `  conta=${d.accountId} balance=${d.balance} ledgerSum=${d.ledgerSum} ` +
          `balanceDrift=${d.balanceDrift} trialRemaining=${d.trialRemaining} ` +
          `trialExpected=${d.trialExpected} trialDrift=${d.trialDrift} ` +
          `trialOverBalance=${d.trialOverBalance}`,
      );
    }
  }
  if (repair) console.log(`[reconcile] --repair: ${report.repaired} carteira(s) casada(s) ao razão (balance = sum(ledger.delta)).`);
  else if (report.drifted.length > 0) console.log("[reconcile] (dry-run — rode com --repair para corrigir.)");

  await closeEngines();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[reconcile] ERRO", e instanceof Error ? e.message : e);
    process.exit(1);
  });
