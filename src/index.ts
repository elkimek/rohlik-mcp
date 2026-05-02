#!/usr/bin/env node

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

const server = new McpServer(
  {
    name: "rohlik-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

function getCredentials() {
  const username = process.env.ROHLIK_USERNAME;
  const password = process.env.ROHLIK_PASSWORD;

  if (!username || !password) {
    throw new Error('ROHLIK_USERNAME and ROHLIK_PASSWORD environment variables are required');
  }

  return { username, password };
}

function createRohlikAPI() {
  const credentials = getCredentials();
  return new RohlikAPI(credentials);
}

// Register all tools
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

// Registering each tool as a separate generic call causes TS2589 ("type
// instantiation is excessively deep") under @modelcontextprotocol/sdk >=1.24,
// because registerTool infers a heavy type from each Zod inputSchema. Funneling
// every tool through a single loosely-typed entry collapses inference to one
// call site and keeps type-checking tractable.
const tools: Array<{ name: string; definition: any; handler: any }> = [
  // Core functionality
  searchProducts,
  cartTools.addToCart,
  cartTools.getCartContent,
  cartTools.removeFromCart,
  shoppingLists,
  accountData,
  // Order management
  orderHistory,
  orderDetail,
  upcomingOrders,
  // Delivery management
  deliveryInfo,
  deliverySlots,
  // Account features
  premiumInfo,
  announcements,
  reusableBags,
  // Smart shopping features
  frequentItems,
  mealSuggestions,
  shoppingScenarios,
  // Deals & discounts
  discountedItems,
  // Product composition & safety
  productComposition,
];

for (const tool of tools) {
  server.registerTool(tool.name, tool.definition, tool.handler);
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