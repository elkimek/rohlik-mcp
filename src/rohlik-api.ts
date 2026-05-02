import fetch, { RequestInit, Response } from 'node-fetch';
import { Product, SearchResult, CartContent, RohlikCredentials, RohlikAPIResponse, AccountData } from './types.js';
import { getAcceptLanguage } from './locale.js';

const BASE_URL = process.env.ROHLIK_BASE_URL || 'https://www.rohlik.cz';
const DEBUG = process.env.ROHLIK_DEBUG === 'true';

export class RohlikAPIError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = 'RohlikAPIError';
  }
}

export interface AddToCartResult {
  added: number[];
  failed: Array<{ productId: number; reason: string }>;
}

function debugLog(...args: unknown[]) {
  if (DEBUG) console.error('[ROHLIK_DEBUG]', ...args);
}

function getSetCookies(response: Response): string[] {
  const headers = response.headers as unknown as {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
    get: (name: string) => string | null;
  };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  if (typeof headers.raw === 'function') return headers.raw()['set-cookie'] || [];
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export class RohlikAPI {
  private credentials: RohlikCredentials;
  private userId?: number;
  private addressId?: number;
  private cookieJar = new Map<string, string>();
  private loggedIn = false;
  private loginPromise?: Promise<void>;
  private lastRequestTime = 0;
  private readonly minRequestInterval = 100;

  constructor(credentials: RohlikCredentials) {
    this.credentials = credentials;
  }

  private async rateLimit(): Promise<void> {
    const wait = this.minRequestInterval - (Date.now() - this.lastRequestTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastRequestTime = Date.now();
  }

  private buildCookieHeader(): string {
    return Array.from(this.cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private absorbCookies(response: Response): void {
    for (const raw of getSetCookies(response)) {
      const firstPair = raw.split(';')[0];
      const eq = firstPair.indexOf('=');
      if (eq <= 0) continue;
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();
      if (name) this.cookieJar.set(name, value);
    }
  }

  private async rawFetch(url: string, options: RequestInit): Promise<Response> {
    await this.rateLimit();
    const cookie = this.buildCookieHeader();
    const headers: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': getAcceptLanguage(),
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Referer': BASE_URL,
      'Origin': BASE_URL,
      'sec-ch-ua': '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      ...(cookie && { Cookie: cookie }),
      ...((options.headers as Record<string, string>) || {}),
    };
    const response = await fetch(`${BASE_URL}${url}`, { ...options, headers });
    this.absorbCookies(response);
    return response;
  }

  private async makeRequest<T>(
    url: string,
    options: RequestInit = {},
    skipAuth = false,
  ): Promise<RohlikAPIResponse<T>> {
    if (!skipAuth) await this.ensureLoggedIn();

    let response = await this.rawFetch(url, options);

    // Retry once with fresh login if session has expired.
    if (!skipAuth && (response.status === 401 || response.status === 403)) {
      debugLog(`Auth expired (${response.status}) on ${url}, re-authenticating`);
      this.loggedIn = false;
      this.cookieJar.clear();
      await this.ensureLoggedIn();
      response = await this.rawFetch(url, options);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new RohlikAPIError(
        `HTTP ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`,
        response.status,
        body,
      );
    }

    return (await response.json()) as RohlikAPIResponse<T>;
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this.loggedIn) return;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.performLogin().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async performLogin(): Promise<void> {
    const loginData = {
      email: this.credentials.username,
      password: this.credentials.password,
      name: '',
    };

    let response: RohlikAPIResponse<any>;
    try {
      response = await this.makeRequest<any>(
        '/services/frontend-service/login',
        { method: 'POST', body: JSON.stringify(loginData) },
        true,
      );
    } catch (error) {
      if (error instanceof RohlikAPIError) {
        if (error.status === 401 || error.status === 403) {
          throw new RohlikAPIError('Invalid credentials — please check ROHLIK_USERNAME and ROHLIK_PASSWORD', error.status, error.body);
        }
        throw error;
      }
      throw new RohlikAPIError(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    debugLog('Login response:', response);

    const status = response.status;
    if (status !== 200 && status !== 202) {
      const responseAny = response as any;
      const errorMessage =
        response.messages?.[0]?.content ||
        responseAny.message ||
        responseAny.error ||
        `Login failed with status ${status}`;
      throw new RohlikAPIError(`Login failed: ${errorMessage}`, status);
    }

    if (!response.data?.user?.id) {
      throw new RohlikAPIError('Login succeeded but no user data was returned');
    }

    this.userId = response.data.user.id;
    this.addressId = response.data?.address?.id;
    this.loggedIn = true;
    debugLog(`Login successful. User ID: ${this.userId}, Address ID: ${this.addressId}`);
  }

  async logout(): Promise<void> {
    if (!this.loggedIn) return;
    try {
      await this.rawFetch('/services/frontend-service/logout', { method: 'POST' });
    } catch (error) {
      debugLog('Logout error (ignored):', error);
    } finally {
      this.loggedIn = false;
      this.cookieJar.clear();
      this.userId = undefined;
      this.addressId = undefined;
    }
  }

  async searchProducts(
    productName: string,
    limit: number = 10,
    favouriteOnly: boolean = false,
  ): Promise<SearchResult[]> {
    const searchParams = new URLSearchParams({
      search: productName,
      offset: '0',
      limit: String(limit + 5),
      companyId: '1',
      filterData: JSON.stringify({ filters: [] }),
      canCorrect: 'true',
    });

    const response = await this.makeRequest<any>(`/services/frontend-service/search-metadata?${searchParams}`);
    let products = response.data?.productList || [];

    products = products.filter((p: any) => !p.badge?.some((b: any) => b.slug === 'promoted'));
    if (favouriteOnly) products = products.filter((p: any) => p.favourite);
    products = products.slice(0, limit);

    return products.map((p: any) => {
      const activeSale = p.sales?.find((s: any) => s.active);
      const result: any = {
        id: p.productId,
        name: p.productName,
        price: `${p.price.full} ${p.price.currency}`,
        brand: p.brand,
        amount: p.textualAmount,
      };
      if (activeSale) {
        result.salePrice = `${activeSale.price.full} ${activeSale.price.currency}`;
        result.originalPrice = `${activeSale.originalPrice.full} ${activeSale.originalPrice.currency}`;
        result.discountPercentage = activeSale.discountPercentage;
        result.saleType = activeSale.type;
      }
      return result;
    });
  }

  async addToCart(products: Product[]): Promise<AddToCartResult> {
    const added: number[] = [];
    const failed: Array<{ productId: number; reason: string }> = [];

    for (const product of products) {
      try {
        await this.makeRequest('/services/frontend-service/v2/cart', {
          method: 'POST',
          body: JSON.stringify({
            actionId: null,
            productId: product.product_id,
            quantity: product.quantity,
            recipeId: null,
            source: 'true:Shopping Lists',
          }),
        });
        added.push(product.product_id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failed.push({ productId: product.product_id, reason });
      }
    }

    return { added, failed };
  }

  async getCartContent(): Promise<CartContent> {
    const response = await this.makeRequest<any>('/services/frontend-service/v2/cart');
    const data = response.data || {};
    return {
      total_price: data.totalPrice || 0,
      total_items: Object.keys(data.items || {}).length,
      can_make_order: data.submitConditionPassed || false,
      products: Object.entries(data.items || {}).map(([productId, productData]: [string, any]) => ({
        id: productId,
        cart_item_id: productData.orderFieldId || '',
        name: productData.productName || '',
        quantity: productData.quantity || 0,
        price: productData.price || 0,
        category_name: productData.primaryCategoryName || '',
        brand: productData.brand || '',
      })),
    };
  }

  async removeFromCart(orderFieldId: string): Promise<boolean> {
    try {
      await this.makeRequest(
        `/services/frontend-service/v2/cart?orderFieldId=${encodeURIComponent(orderFieldId)}`,
        { method: 'DELETE' },
      );
      return true;
    } catch (error) {
      debugLog(`Failed to remove cart item ${orderFieldId}:`, error);
      return false;
    }
  }

  async getShoppingList(shoppingListId: string): Promise<{ name: string; products: any[] }> {
    const response = await this.makeRequest<any>(`/api/v1/shopping-lists/id/${encodeURIComponent(shoppingListId)}`);
    const listData = response.data || response;
    return {
      name: listData?.name || 'Unknown List',
      products: listData?.products || [],
    };
  }

  async getAccountData(): Promise<AccountData> {
    const result: AccountData = {};

    const endpoints = {
      delivery: '/services/frontend-service/first-delivery?reasonableDeliveryTime=true',
      next_order: '/api/v3/orders/upcoming',
      announcements: '/services/frontend-service/announcements/top',
      bags: '/api/v1/reusable-bags/user-info',
      timeslot: '/services/frontend-service/v1/timeslot-reservation',
      last_order: '/api/v3/orders/delivered?offset=0&limit=1',
      premium_profile: '/services/frontend-service/premium/profile',
      delivery_announcements: '/services/frontend-service/announcements/delivery',
      delivered_orders: '/api/v3/orders/delivered?offset=0&limit=50',
    } as const;

    for (const [key, path] of Object.entries(endpoints)) {
      try {
        const response = await this.makeRequest<any>(path);
        (result as any)[key] = response.data || response;
      } catch (error) {
        debugLog(`Error fetching ${key}:`, error);
        (result as any)[key] = null;
      }
    }

    if (this.userId && this.addressId) {
      try {
        const path = `/services/frontend-service/timeslots-api/0?userId=${this.userId}&addressId=${this.addressId}&reasonableDeliveryTime=true`;
        const response = await this.makeRequest<any>(path);
        result.next_delivery_slot = response.data || response;
      } catch (error) {
        debugLog('Error fetching next_delivery_slot:', error);
        result.next_delivery_slot = null;
      }
    } else {
      result.next_delivery_slot = null;
    }

    try {
      result.cart = await this.getCartContent();
    } catch (error) {
      debugLog('Error fetching cart:', error);
      result.cart = undefined;
    }

    return result;
  }

  async getOrderHistory(limit: number = 50): Promise<any> {
    const response = await this.makeRequest<any>(`/api/v3/orders/delivered?offset=0&limit=${limit}`);
    return response.data || response;
  }

  async getDeliveryInfo(): Promise<any> {
    const response = await this.makeRequest<any>('/services/frontend-service/first-delivery?reasonableDeliveryTime=true');
    return response.data || response;
  }

  async getUpcomingOrders(): Promise<any> {
    const response = await this.makeRequest<any>('/api/v3/orders/upcoming');
    return response.data || response;
  }

  async getPremiumInfo(): Promise<any> {
    const response = await this.makeRequest<any>('/services/frontend-service/premium/profile');
    return response.data || response;
  }

  async getDeliverySlots(): Promise<any> {
    await this.ensureLoggedIn();
    if (!this.userId || !this.addressId) {
      throw new RohlikAPIError('User ID or Address ID not available');
    }
    const response = await this.makeRequest<any>(
      `/services/frontend-service/timeslots-api/0?userId=${this.userId}&addressId=${this.addressId}&reasonableDeliveryTime=true`,
    );
    return response.data || response;
  }

  async getAnnouncements(): Promise<any> {
    const response = await this.makeRequest<any>('/services/frontend-service/announcements/top');
    return response.data || response;
  }

  async getReusableBagsInfo(): Promise<any> {
    const response = await this.makeRequest<any>('/api/v1/reusable-bags/user-info');
    return response.data || response;
  }

  async getSalesCategories(): Promise<{ id: number; name: string; slug: string }[]> {
    const subResponse = await this.makeRequest<any>('/api/v1/categories/sales/subcategories');
    const categoryIds: number[] = (subResponse as any).categoryIds || [];
    if (categoryIds.length === 0) return [];

    const params = new URLSearchParams();
    for (const id of categoryIds) params.append('categories', String(id));
    params.append('type', 'favorite-sales');

    const catResponse = await this.makeRequest<any>(`/api/v1/categories?${params}`);
    const categories = Array.isArray(catResponse) ? catResponse : [];
    return categories.map((c: any) => ({ id: c.categoryId, name: c.name, slug: c.slug }));
  }

  async getDiscountedProducts(
    saleType: string = 'sales',
    categoryId: number | null = null,
    page: number = 0,
    size: number = 14,
    sort: string = 'recommended',
  ): Promise<any[]> {
    const categoryPath = categoryId !== null ? `/${encodeURIComponent(String(categoryId))}` : '';
    const listParams = new URLSearchParams({
      page: String(page),
      size: String(size),
      sort,
      filter: '',
      excludeProductIds: '',
    });

    const listResponse = await this.makeRequest<any>(
      `/api/v1/categories/${encodeURIComponent(saleType)}${categoryPath}/products?${listParams}`,
    );
    const productIds: number[] = (listResponse as any).productIds || [];
    if (productIds.length === 0) return [];

    const cardParams = new URLSearchParams();
    for (const id of productIds) cardParams.append('products', String(id));
    cardParams.append('categoryType', saleType);

    const cardResponse = await this.makeRequest<any>(`/api/v1/products/card?${cardParams}`);
    return Array.isArray(cardResponse) ? cardResponse : [];
  }

  async getOrderDetail(orderId: string): Promise<any> {
    const response = await this.makeRequest<any>(`/api/v3/orders/${encodeURIComponent(orderId)}`);
    return response.data || response;
  }

  async getProductComposition(productId: number): Promise<any | null> {
    const response = await this.makeRequest<any>(`/api/v1/products/${encodeURIComponent(String(productId))}/composition`);
    return response.data ?? null;
  }

  async getProductCompositions(productIds: number[]): Promise<Map<number, any | null>> {
    const results = new Map<number, any | null>();
    for (let i = 0; i < productIds.length; i++) {
      const id = productIds[i];
      try {
        const response = await this.makeRequest<any>(`/api/v1/products/${encodeURIComponent(String(id))}/composition`);
        results.set(id, response.data ?? null);
      } catch (error) {
        debugLog(`Failed to fetch composition for product ${id}:`, error);
        results.set(id, null);
      }
      if (i < productIds.length - 1) await new Promise(r => setTimeout(r, 100));
    }
    return results;
  }
}
