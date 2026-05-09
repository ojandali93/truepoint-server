import axios, { AxiosInstance, AxiosError } from "axios";

export interface CardMarketPrices {
  cardmarket: {
    currency: string;
    lowest_near_mint: number | null;
    lowest_near_mint_DE?: number | null;
    lowest_near_mint_FR?: number | null;
    "30d_average": number | null;
    "7d_average": number | null;
    graded?: {
      psa?: { psa10?: number; psa9?: number; psa8?: number };
      cgc?: { cgc10?: number; cgc9?: number };
      bgs?: { bgs10?: number; bgs95?: number };
    };
  } | null;
  ebay: {
    currency: string;
    graded?: {
      psa?: Record<string, { median_price: number; sample_size: number }>;
      bgs?: Record<string, { median_price: number; sample_size: number }>;
      cgc?: Record<string, { median_price: number; sample_size: number }>;
    };
  } | null;
  tcg_player: {
    currency: string;
    market_price: number | null;
    mid_price: number | null;
  } | null;
}

export interface CardMarketCard {
  id: number;
  name: string;
  name_numbered: string;
  card_number: string;
  rarity: string;
  prices: CardMarketPrices;
  episode: { name: string; code: string };
  image: string;
}

export interface CardMarketSealedProduct {
  id: number;
  name: string;
  type: string;
  set: string;
  prices: {
    tcg_player?: { market_price: number | null };
    cardmarket?: { trend_price: number | null; avg30: number | null };
    ebay?: { median_price: number | null };
  };
}

export interface CardMarketExpansion {
  id: number;
  name: string;
  slug: string;
  released_at: string;
  logo: string;
  code: string;
  cards_total: number;
  cards_printed_total: number;
  series: { id: number; name: string; slug: string };
}

export interface CardMarketProduct {
  id: number;
  name: string;
  slug: string;
  prices: {
    cardmarket?: {
      currency: string;
      lowest: number | null;
      lowest_DE?: number | null;
      lowest_FR?: number | null;
    };
  };
  episode: {
    id: number;
    name: string;
    slug: string;
    code: string;
    logo: string;
  };
  image: string;
  tcggo_url: string;
}

class CardMarketClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: "https://cardmarket-api-tcg.p.rapidapi.com",
      timeout: 10000,
    });

    // Read API key at request time, not construction time
    this.client.interceptors.request.use((config) => {
      config.headers["x-rapidapi-key"] = process.env.RAPIDAPI_KEY ?? "";
      config.headers["x-rapidapi-host"] =
        process.env.RAPIDAPI_CARDMARKET_HOST ??
        "cardmarket-api-tcg.p.rapidapi.com";
      config.headers["Content-Type"] = "application/json";
      return config;
    });

    this.client.interceptors.response.use(
      (res) => res,
      (error: AxiosError) => {
        const status = error.response?.status;
        const messages: Record<number, string> = {
          401: "Invalid RapidAPI key",
          403: "CardMarket API access forbidden",
          429: "CardMarket API rate limit exceeded",
          404: "Not found in CardMarket database",
        };
        throw {
          status: status ?? 503,
          message: messages[status ?? 0] ?? `CardMarket API error ${status}`,
        };
      },
    );
  }

  async getAllExpansions(): Promise<CardMarketExpansion[]> {
    const results: CardMarketExpansion[] = [];
    let page = 0;

    while (true) {
      const res = await this.client.get<{ data: CardMarketExpansion[] }>(
        "/pokemon/episodes",
        { params: { page } },
      );
      const batch = res.data.data ?? [];
      results.push(...batch);
      if (batch.length < 20) break; // API returns 20 per page
      page++;
    }

    return results;
  }

  async getProductsByExpansion(
    expansionId: number,
  ): Promise<CardMarketProduct[]> {
    const results: CardMarketProduct[] = [];
    let page = 0;

    while (true) {
      const res = await this.client.get<{ data: CardMarketProduct[] }>(
        `/pokemon/episodes/${expansionId}/products`,
        { params: { page, sort: "price_highest" } },
      );
      const batch = res.data.data ?? [];
      results.push(...batch);
      if (batch.length < 20) break;
      page++;
    }

    return results;
  }

  // Get individual card singles for an expansion (not sealed products)
  async getCardsByExpansion(expansionId: number): Promise<CardMarketCard[]> {
    const results: CardMarketCard[] = [];
    let page = 0;

    while (true) {
      const res = await this.client.get<{ data: CardMarketCard[] }>(
        `/pokemon/episodes/${expansionId}/cards`,
        { params: { page } },
      );
      const batch = res.data.data ?? [];
      results.push(...batch);
      if (batch.length < 20) break;
      page++;
    }

    return results;
  }

  async getCardPrices(cardId: string | number): Promise<CardMarketCard> {
    const res = await this.client.get<CardMarketCard>(`/cards/${cardId}`);
    return res.data;
  }

  async searchCard(name: string, setCode?: string): Promise<CardMarketCard[]> {
    const res = await this.client.get<{ results: CardMarketCard[] }>(
      "/cards/search",
      {
        params: { q: name, set: setCode ?? undefined },
      },
    );
    return res.data.results ?? [];
  }

  async getSealedProducts(
    setCode?: string,
  ): Promise<CardMarketSealedProduct[]> {
    const res = await this.client.get<{ results: CardMarketSealedProduct[] }>(
      "/sealed",
      {
        params: { set: setCode ?? undefined, game: "pokemon" },
      },
    );
    return res.data.results ?? [];
  }

  async getSealedProductById(
    productId: string | number,
  ): Promise<CardMarketSealedProduct> {
    const res = await this.client.get<CardMarketSealedProduct>(
      `/sealed/${productId}`,
    );
    return res.data;
  }
}

export const cardMarketClient = new CardMarketClient();
