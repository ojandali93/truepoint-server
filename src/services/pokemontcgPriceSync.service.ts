// Bulk TCGPlayer USD sync via pokemontcg.io — invoked by POST /sync/prices/pokemontcg.
// Implement or replace with your pipeline (e.g. pokemontcg.io SDK + market_prices upsert).

export async function syncAllTCGPlayerPrices(): Promise<void> {
  console.warn(
    "[PTCGPriceSync] syncAllTCGPlayerPrices is not implemented — no-op",
  );
}
