import axios, { AxiosInstance, AxiosError } from 'axios';

export interface CardMarketPrices {
  cardmarket: {
    currency: string;
    lowest_near_mint: number | null;
    lowest_near_mint_DE?: number | null;
    lowest_near_mint_FR?: number | null;
    '30d_average': number | null;
    '7d_average': number | null;
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

class CardMarketClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://cardmarket-api.p.rapidapi.com',
      timeout: 10000,
      headers: {
        'x-rapidapi-key': process.env.RAPIDAPI_KEY ?? '',
        'x-rapidapi-host':
          process.env.RAPIDAPI_CARDMARKET_HOST ?? 'cardmarket-api.p.rapidapi.com',
        'Content-Type': 'application/json',
      },
    });

    this.client.interceptors.response.use(
      (res) => res,
      (error: AxiosError) => {
        const status = error.response?.status;
        const messages: Record<number, string> = {
          401: 'Invalid RapidAPI key',
          403: 'CardMarket API access forbidden — check your subscription plan',
          429: 'CardMarket API rate limit exceeded',
          404: 'Card not found in CardMarket database',
        };
        throw {
          status: status ?? 503,
          message: messages[status ?? 0] ?? `CardMarket API error ${status}`,
        };
      }
    );
  }

  async getCardPrices(cardId: string | number): Promise<CardMarketCard> {
    const res = await this.client.get<CardMarketCard>(`/cards/${cardId}`);
    return res.data;
  }

  async searchCard(name: string, setCode?: string): Promise<CardMarketCard[]> {
    const res = await this.client.get<{ results: CardMarketCard[] }>('/cards/search', {
      params: { q: name, set: setCode ?? undefined },
    });
    return res.data.results ?? [];
  }

  async getSealedProducts(setCode?: string): Promise<CardMarketSealedProduct[]> {
    const res = await this.client.get<{ results: CardMarketSealedProduct[] }>('/sealed', {
      params: { set: setCode ?? undefined, game: 'pokemon' },
    });
    return res.data.results ?? [];
  }

  async getSealedProductById(productId: string | number): Promise<CardMarketSealedProduct> {
    const res = await this.client.get<CardMarketSealedProduct>(`/sealed/${productId}`);
    return res.data;
  }
}

export const cardMarketClient = new CardMarketClient();
