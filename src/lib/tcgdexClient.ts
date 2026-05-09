// src/lib/tcgdexClient.ts
import axios, { AxiosInstance } from 'axios';

export interface TCGdexVariants {
  normal: boolean;
  reverse: boolean;
  holo: boolean;
  firstEdition: boolean;
}

export interface TCGdexCardBrief {
  id: string;
  localId: string;
  name: string;
  image?: string;
  rarity?: string;
  variants?: TCGdexVariants; // only present on full card response
  foil?: string;
}

export interface TCGdexCardFull extends TCGdexCardBrief {
  category: string;
  variants: TCGdexVariants; // always present on full card
}

class TCGdexClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.tcgdex.net/v2/en',
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ─── Get cards for a set ───────────────────────────────────────────────────
  // Step 1: GET /sets/{setId} → brief card list (no variants)
  // Step 2: GET /cards/{cardId} for each card → full card with variants
  // The individual card endpoint always includes variants.

  async getSetCards(setId: string): Promise<TCGdexCardBrief[]> {
    const idsToTry = [setId, ...this.getIdVariants(setId)];
    let briefCards: TCGdexCardBrief[] = [];
    let resolvedSetId = setId;

    // Step 1 — get the brief card list to know which cards exist
    for (const id of idsToTry) {
      try {
        const res = await this.client.get<{ cards?: TCGdexCardBrief[] }>(`/sets/${id}`);
        const cards = res.data?.cards ?? [];
        if (cards.length > 0) {
          briefCards = cards;
          resolvedSetId = id;
          console.log(`[TCGdex] ✓ Set ${id} → ${cards.length} cards (fetching full data...)`);
          break;
        }
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) continue;
        console.error(`[TCGdex] Error fetching set ${id}: ${status ?? err?.message}`);
        continue;
      }
    }

    if (!briefCards.length) return [];

    // Step 2 — fetch full card data in batches to get variant fields
    // Use the TCGdex card IDs (e.g. sv01-001) not our DB IDs
    const fullCards = await this.fetchCardsInBatches(briefCards);
    console.log(`[TCGdex] ✓ Set ${resolvedSetId} → ${fullCards.length}/${briefCards.length} full cards fetched`);
    return fullCards;
  }

  // Fetch full card data in parallel batches with rate limiting
  private async fetchCardsInBatches(
    cards: TCGdexCardBrief[],
    batchSize = 20,
    delayMs = 200
  ): Promise<TCGdexCardBrief[]> {
    const results: TCGdexCardBrief[] = [];

    for (let i = 0; i < cards.length; i += batchSize) {
      const batch = cards.slice(i, i + batchSize);
      const fetched = await Promise.all(
        batch.map((card) => this.getCard(card.id).catch(() => null))
      );
      for (const card of fetched) {
        if (card) results.push(card);
      }
      // Polite delay between batches to avoid rate limiting
      if (i + batchSize < cards.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    return results;
  }

  // ─── Get a single card's full data ────────────────────────────────────────
  async getCard(cardId: string): Promise<TCGdexCardFull | null> {
    try {
      const res = await this.client.get<TCGdexCardFull>(`/cards/${cardId}`);
      return res.data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      // Don't log every 404 — just return null
      return null;
    }
  }

  // ─── Get all sets ──────────────────────────────────────────────────────────
  async getAllSets(): Promise<{ id: string; name: string; releaseDate?: string }[]> {
    try {
      const res = await this.client.get('/sets');
      return res.data ?? [];
    } catch (err: any) {
      console.error('[TCGdex] getAllSets error:', err?.message);
      return [];
    }
  }

  // ─── ID variant generation ─────────────────────────────────────────────────
  // Key insight from diagnosis: TCGdex uses sv01 but our DB uses sv1.
  // Also: swsh12pt5 → swsh12.5 format in some cases.

  getIdVariants(setId: string): string[] {
    const variants: string[] = [];

    // sv1 → sv01, sv2 → sv02 ... sv9 → sv09 (but sv10 stays sv10)
    // swsh1 → swsh01, swsh2 → swsh02 etc.
    const zeroPadded = setId.replace(
      /^([a-z]+)(\d)([a-z]|pt\d|$)/i,
      (_match, prefix, digit, suffix) => `${prefix}0${digit}${suffix}`
    );
    if (zeroPadded !== setId) variants.push(zeroPadded);

    // Handle pt5 suffix: sv3pt5 → sv03pt5
    const ptPadded = setId.replace(
      /^([a-z]+)(\d)(pt\d+)$/i,
      (_match, prefix, digit, suffix) => `${prefix}0${digit}${suffix}`
    );
    if (ptPadded !== setId && !variants.includes(ptPadded)) variants.push(ptPadded);

    return variants;
  }

  // ─── Build a DB-ID → TCGdex-ID lookup for a set ───────────────────────────
  // Our DB: sv1-001   TCGdex: sv01-001
  // We need to translate when looking up variant data

  buildIdMap(tcgdexCards: TCGdexCardBrief[]): Map<string, TCGdexCardBrief> {
    const map = new Map<string, TCGdexCardBrief>();

    for (const card of tcgdexCards) {
      // Store by TCGdex ID (e.g. sv01-001)
      map.set(card.id, card);

      // Also store by normalized ID (sv1-001) for DB matching
      const normalizedId = this.normalizeCardId(card.id);
      if (normalizedId !== card.id) {
        map.set(normalizedId, card);
      }
    }

    return map;
  }

  // sv01-001 → sv1-001 (remove zero padding from set number)
  normalizeCardId(tcgdexId: string): string {
    return tcgdexId.replace(
      /^([a-z]+)0(\d[a-z0-9]*)(-)/i,
      '$1$2$3'
    );
  }
}

export const tcgdexClient = new TCGdexClient();
