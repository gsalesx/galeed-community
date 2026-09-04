// M-PAY-B — cria (idempotente) os Products + Prices do Galeed no Stripe da conta de STRIPE_SECRET_KEY.
// Idempotência: Prices ancorados em lookup_key (galeed_<tier>_monthly[_founder]); Products por
// metadata.galeed_tier (search). Re-rodar é seguro (reusa o que existe).
//
// Rodar:  set -a; . ./.env; set +a; npx tsx apps/server/scripts/stripe-setup.ts
import { getStripe, TIERS, priceLookupKey, type Cohort } from "../src/core/platform/stripe.ts";

const stripe = getStripe();

async function findOrCreateProduct(tier: string, name: string): Promise<string> {
  const found = await stripe.products.search({ query: `metadata['galeed_tier']:'${tier}'`, limit: 1 });
  if (found.data[0]) return found.data[0].id;
  const p = await stripe.products.create({
    name: `Galeed ${name}`,
    metadata: { galeed_tier: tier },
  });
  return p.id;
}

async function findOrCreatePrice(
  productId: string,
  tier: string,
  cohort: Cohort,
  amount: number,
): Promise<{ id: string; created: boolean }> {
  const key = priceLookupKey(tier, cohort);
  const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  if (found.data[0]) return { id: found.data[0].id, created: false };
  const price = await stripe.prices.create({
    product: productId,
    currency: "brl",
    unit_amount: amount,
    recurring: { interval: "month" },
    lookup_key: key,
    transfer_lookup_key: true,
    metadata: { galeed_tier: tier, galeed_cohort: cohort },
  });
  return { id: price.id, created: true };
}

async function main(): Promise<void> {
  for (const t of TIERS) {
    const product = await findOrCreateProduct(t.tier, t.name);
    const std = await findOrCreatePrice(product, t.tier, "standard", t.brl);
    const fnd = await findOrCreatePrice(product, t.tier, "founder", t.founderBrl);
    console.log(
      `${t.name.padEnd(9)} product=${product}  std=${std.id}${std.created ? " (novo)" : ""}  ` +
        `founder=${fnd.id}${fnd.created ? " (novo)" : ""}`,
    );
  }
  console.log("OK — Products/Prices prontos (lookup_key: galeed_<tier>_monthly[_founder]).");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("stripe-setup falhou:", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
