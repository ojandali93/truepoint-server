// src/services/productSync.service.ts
// Deprecated — product/price sync now handled by tcgapisSync.service.ts
// Kept as stub to avoid import errors in other files

export const syncAllProducts = async (): Promise<void> => {
  console.log('[ProductSync] Deprecated — use TCGAPIs sync instead');
};

export const syncProductsForSet = async (setId: string, setName: string): Promise<void> => {
  console.log(`[ProductSync] Deprecated — use TCGAPIs sync for set ${setName} (${setId})`);
};
