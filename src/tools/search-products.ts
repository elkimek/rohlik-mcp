import { z } from "zod";
import { RohlikAPI } from "../rohlik-api.js";

/**
 * Check if a product's composition contains any of the excluded allergens.
 * Uses bidirectional substring matching to handle compound API strings like
 * "mléko a výrobky z mléka" matching "mléko".
 */
export function matchesExcludedAllergen(composition: any, excludeAllergens: string[]): boolean {
  const allergens = composition?.allergens || {};
  const contained = allergens.contained || [];
  const possiblyContained = allergens.possiblyContained || [];
  const allAllergens = [...contained, ...possiblyContained];
  
  const normalizedExclude = excludeAllergens.map(a => a.toLowerCase().trim());
  
  return normalizedExclude.some(ex => 
    allAllergens.some((apiAllergen: string) => {
      const a = apiAllergen.toLowerCase();
      return a.includes(ex) || ex.includes(a);
    })
  );
}

/**
 * Recursively scan ingredients for additives (type: "additive").
 * Returns true if any additive is found, false if ingredients exist but no additives,
 * and true if ingredient data is completely missing (unknown = unsafe).
 */
export function hasAdditivesOrUnknown(composition: any): boolean {
  const ingredients = composition?.ingredients;
  if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
    return true; // unknown = unsafe
  }

  function scan(ingredientList: any[]): boolean {
    for (const ing of ingredientList) {
      if (ing?.type === "additive") return true;
      if (ing?.ingredients && Array.isArray(ing.ingredients)) {
        if (scan(ing.ingredients)) return true;
      }
    }
    return false;
  }

  return scan(ingredients);
}

export function createSearchProductsTool(createRohlikAPI: () => RohlikAPI) {
  return {
    name: "search_products",
    definition: {
      title: "Search Products",
      description: "Search for products on Rohlik.cz by name. Optionally verify ingredients and filter out products containing specific allergens or additives.",
      inputSchema: {
        product_name: z.string().min(1, "Product name cannot be empty").describe("The name or search term for the product"),
        limit: z.number().min(1).max(50).default(10).describe("Maximum number of products to return (1-50, default: 10)"),
        favourite_only: z.boolean().default(false).describe("Whether to return only favourite products (default: false)"),
        exclude_allergens: z.array(z.string()).optional().describe("List of allergens to exclude (e.g. ['Mléko', 'Ořechy']). If provided, composition data will be fetched for each result and products containing these allergens will be filtered out."),
        require_no_additives: z.boolean().default(false).describe("If true, filter out products that contain additives. Composition data will be fetched for each result."),
        include_composition: z.boolean().default(false).describe("If true, include full composition data (ingredients, allergens, nutrition) for each product. Note: this makes the search slower as it fetches composition for each result.")
      }
    },
    handler: async (args: { 
      product_name: string; 
      limit?: number; 
      favourite_only?: boolean;
      exclude_allergens?: string[];
      require_no_additives?: boolean;
      include_composition?: boolean;
    }) => {
      const { 
        product_name, 
        limit = 10, 
        favourite_only = false,
        exclude_allergens,
        require_no_additives = false,
        include_composition = false
      } = args;

      const needsComposition = include_composition || (exclude_allergens && exclude_allergens.length > 0) || require_no_additives;
      const safetyFilterActive = (exclude_allergens && exclude_allergens.length > 0) || require_no_additives;

      try {
        const api = createRohlikAPI();
        let results = await api.searchProducts(product_name, Math.min(limit * 2, 50), favourite_only);

        // Fetch composition data if needed — use batch method to avoid N× login/logout
        if (needsComposition && results.length > 0) {
          const productIds = results.map((p: any) => p.id);
          const compositions = await api.getProductCompositions(productIds);

          const enrichedResults = [];
          for (const product of results) {
            const composition = compositions.get(product.id);

            // P1 FIX: Unknown composition is UNSAFE when safety filters are active
            // Only skip when a safety filter is actually on — not for include_composition alone
            if (composition === null && safetyFilterActive) {
              continue;
            }

            // No filter active — include product without composition data
            if (composition === null) {
              enrichedResults.push(product);
              continue;
            }

            let skip = false;

            // P1 FIX: Substring matching for compound allergen strings
            if (exclude_allergens && exclude_allergens.length > 0) {
              if (matchesExcludedAllergen(composition, exclude_allergens)) {
                skip = true;
              }
            }

            // P1 FIX: Filter by additives — treat missing additive fields as "unknown = unsafe"
            if (!skip && require_no_additives) {
              if (hasAdditivesOrUnknown(composition)) {
                skip = true;
              }
            }

            if (!skip) {
              enrichedResults.push({
                ...product,
                composition: include_composition ? composition : undefined
              });
            }
          }
          results = enrichedResults;
        }

        // Limit results
        results = results.slice(0, limit);

        if (results.length === 0) {
          const filterNote = safetyFilterActive ? " (after applying safety filters — unknown/missing composition data is treated as unsafe)" : "";
          return {
            content: [{ type: "text" as const, text: `No products found${filterNote} for "${product_name}".` }]
          };
        }

        const verifiedLabel = safetyFilterActive ? " (safety-verified for ingredients)" : (include_composition ? " (with composition data where available)" : "");
        const output = `Found ${results.length} products${verifiedLabel}:\n\n` +
          results.map((product: any) => {
            const priceInfo = product.salePrice
              ? `Price: ${product.salePrice} (was ${product.originalPrice}, -${product.discountPercentage}%)`
              : `Price: ${product.price}`;
            let entry = `• ${product.name} (${product.brand})\n  ${priceInfo}\n  Amount: ${product.amount}\n  ID: ${product.id}`;

            if (product.composition) {
              const comp = product.composition;
              const allergens = comp.allergens || {};
              const contained = allergens.contained || [];
              const possiblyContained = allergens.possiblyContained || [];
              if (contained.length > 0) {
                entry += `\n  ⚠️ Contains: ${contained.join(", ")}`;
              }
              if (possiblyContained.length > 0) {
                entry += `\n  ⚠️ May contain: ${possiblyContained.join(", ")}`;
              }
              const hasAdditives = hasAdditivesOrUnknown(comp);
              if (!hasAdditives) {
                entry += `\n  ✅ No additives`;
              } else if (comp.ingredients && comp.ingredients.length > 0) {
                entry += `\n  ❌ Contains additives`;
              }
              const ingredients = comp.ingredients || [];
              if (ingredients.length > 0) {
                const ingredientNames = ingredients.map((i: any) => i.name).join(", ");
                entry += `\n  Ingredients: ${ingredientNames.slice(0, 200)}${ingredientNames.length > 200 ? "..." : ""}`;
              }
            }

            return entry;
          }).join('\n\n');

        return {
          content: [{ type: "text" as const, text: output }]
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true
        };
      }
    }
  };
}
