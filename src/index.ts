#!/usr/bin/env node

import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RohlikAPI } from "./rohlik-api.js";
import { createSearchProductsTool } from "./tools/search-products.js";
import { createCartManagementTools } from "./tools/cart-management.js";
import { createShoppingListsTool } from "./tools/shopping-lists.js";
import { createAccountDataTool } from "./tools/account-data.js";
import { createOrderHistoryTool } from "./tools/order-history.js";
import { createDeliveryInfoTool } from "./tools/delivery-info.js";
import { createUpcomingOrdersTool } from "./tools/upcoming-orders.js";
import { createPremiumInfoTool } from "./tools/premium-info.js";
import { createDeliverySlotsTool } from "./tools/delivery-slots.js";
import { createAnnouncementsTool } from "./tools/announcements.js";
import { createReusableBagsTool } from "./tools/reusable-bags.js";
import { createOrderDetailTool } from "./tools/order-detail.js";
import { createFrequentItemsTool } from "./tools/frequent-items.js";
import { createMealSuggestionsTool } from "./tools/meal-suggestions.js";
import { createShoppingScenariosTool } from "./tools/shopping-scenarios.js";
import { createDiscountedItemsTool } from "./tools/discounted-items.js";
import { createProductCompositionTool } from "./tools/product-composition.js";

export interface Tool {
  name: string;
  definition: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
  };
  handler: (args: any) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

const server = new McpServer(
  { name: "rohlik-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Cache the API instance for the lifetime of the process so we authenticate
// once and reuse the session across tool calls. Without this, every tool call
// triggers a fresh login + logout pair against Rohlik's auth endpoint, which
// invites anti-fraud heuristics, 2FA challenges, and unnecessary latency.
let apiInstance: RohlikAPI | undefined;
function createRohlikAPI(): RohlikAPI {
  if (!apiInstance) {
    const username = process.env.ROHLIK_USERNAME;
    const password = process.env.ROHLIK_PASSWORD;
    if (!username || !password) {
      throw new Error("ROHLIK_USERNAME and ROHLIK_PASSWORD environment variables are required");
    }
    apiInstance = new RohlikAPI({ username, password });
  }
  return apiInstance;
}

const searchProducts = createSearchProductsTool(createRohlikAPI);
const cartTools = createCartManagementTools(createRohlikAPI);
const shoppingLists = createShoppingListsTool(createRohlikAPI);
const accountData = createAccountDataTool(createRohlikAPI);
const orderHistory = createOrderHistoryTool(createRohlikAPI);
const deliveryInfo = createDeliveryInfoTool(createRohlikAPI);
const upcomingOrders = createUpcomingOrdersTool(createRohlikAPI);
const premiumInfo = createPremiumInfoTool(createRohlikAPI);
const deliverySlots = createDeliverySlotsTool(createRohlikAPI);
const announcements = createAnnouncementsTool(createRohlikAPI);
const reusableBags = createReusableBagsTool(createRohlikAPI);
const orderDetail = createOrderDetailTool(createRohlikAPI);
const frequentItems = createFrequentItemsTool(createRohlikAPI);
const mealSuggestions = createMealSuggestionsTool(createRohlikAPI);
const shoppingScenarios = createShoppingScenariosTool();
const discountedItems = createDiscountedItemsTool(createRohlikAPI);
const productComposition = createProductCompositionTool(createRohlikAPI);

// Funneling every tool through one loosely-typed loop avoids TS2589
// ("type instantiation is excessively deep") that registerTool's per-call
// generic inference triggers under @modelcontextprotocol/sdk >=1.24.
const tools: Tool[] = [
  searchProducts,
  cartTools.addToCart,
  cartTools.getCartContent,
  cartTools.removeFromCart,
  shoppingLists,
  accountData,
  orderHistory,
  orderDetail,
  upcomingOrders,
  deliveryInfo,
  deliverySlots,
  premiumInfo,
  announcements,
  reusableBags,
  frequentItems,
  mealSuggestions,
  shoppingScenarios,
  discountedItems,
  productComposition,
];

for (const tool of tools) {
  server.registerTool(tool.name, tool.definition as any, tool.handler as any);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Rohlik MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
