import axios, { AxiosInstance, AxiosError } from "axios";

export interface JustTcgPrice {
  condition: string;
  price: number | null;
  foil_price: number | null;
  currency: string;
  source: string;
  last_updated: string;
}

export interface JustTcgCard {
  id: string;
  name: string;
  set_name: string;
  set_code: string;
  number: string;
  rarity: string;
  language: string;
  prices: JustTcgPrice[];
}

export interface JustTcgSearchResult {
  data: JustTcgCard[];
  total: number;
  page: number;
  per_page: number;
}

class JustTcgClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: "https://api.justtcg.com/v1",
      timeout: 8000,
    });

    this.client.interceptors.request.use((config) => {
      config.headers["Authorization"] =
        `Bearer ${process.env.JUSTTCG_API_KEY ?? ""}`;
      config.headers["Content-Type"] = "application/json";
      return config;
    });

    this.client.interceptors.response.use(
      (res) => res,
      (error: AxiosError) => {
        const status = error.response?.status;
        const messages: Record<number, string> = {
          401: "Invalid JustTCG API key",
          429: "JustTCG rate limit exceeded",
          404: "Card not found in JustTCG database",
        };
        throw {
          status: status ?? 503,
          message: messages[status ?? 0] ?? `JustTCG API error ${status}`,
        };
      },
    );
  }

  async getCardPrices(cardId: string): Promise<JustTcgCard> {
    const res = await this.client.get<JustTcgCard>(`/cards/${cardId}`);
    return res.data;
  }

  async searchCards(
    name: string,
    options?: { setCode?: string; language?: string; page?: number },
  ): Promise<JustTcgSearchResult> {
    const res = await this.client.get<JustTcgSearchResult>("/cards/search", {
      params: {
        q: name,
        game: "pokemon",
        set: options?.setCode,
        language: options?.language ?? "en",
        page: options?.page ?? 1,
        per_page: 20,
      },
    });
    return res.data;
  }

  async getCardsBySet(
    setCode: string,
    language = "en",
  ): Promise<JustTcgCard[]> {
    const res = await this.client.get<JustTcgSearchResult>("/cards/search", {
      params: { game: "pokemon", set: setCode, language, per_page: 250 },
    });
    return res.data.data ?? [];
  }
}

export const justTcgClient = new JustTcgClient();
