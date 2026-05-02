import { z } from "zod";
import { RohlikAPI } from "../rohlik-api.js";

export function createProductCompositionTool(createRohlikAPI: () => RohlikAPI) {
  return {
    name: "get_product_composition",
    definition: {
      title: "Get Product Composition",
      description: "Get detailed composition, ingredients, allergens, and nutritional data for a specific product by ID. Essential for verifying ingredients before purchase.",
      inputSchema: {
        product_id: z.number().describe("The numeric ID of the product to analyze")
      }
    },
    handler: async (args: { product_id: number }) => {
      const { product_id } = args;
      try {
        const api = createRohlikAPI();
        const composition = await api.getProductComposition(product_id);

        if (!composition) {
          return {
            content: [{ type: "text" as const, text: `No composition data found for product ${product_id}` }],
            isError: true
          };
        }

        const lines: string[] = [];
        lines.push(`# Product Composition (ID: ${product_id})\n`);

        // Allergens
        const allergens = composition.allergens || {};
        const contained = allergens.contained || [];
        const possiblyContained = allergens.possiblyContained || [];

        if (contained.length > 0 || possiblyContained.length > 0) {
          lines.push("## Allergens");
          if (contained.length > 0) {
            lines.push(`**Contains:** ${contained.join(", ")}`);
          }
          if (possiblyContained.length > 0) {
            lines.push(`**May contain traces of:** ${possiblyContained.join(", ")}`);
          }
          lines.push("");
        }

        // Ingredients
        const ingredients = composition.ingredients || [];
        if (ingredients.length > 0) {
          lines.push("## Ingredients");
          for (const ing of ingredients) {
            let line = `• ${ing.name || "Unknown"}`;
            if (ing.eNumber) line += ` (${ing.eNumber})`;
            if (ing.percentage) line += ` — ${ing.percentage}%`;
            lines.push(line);
          }
          lines.push("");
        }

        // Nutritional values
        const nutritionRaw = composition.nutritionalValues;
        let nutritionLines: string[] = [];

        if (Array.isArray(nutritionRaw) && nutritionRaw.length > 0) {
          // API returns array of { name, values: { per100g, perPortion } }
          for (const item of nutritionRaw) {
            const name = item.name || item.label || "Unknown";
            const val = item.values?.per100g ?? item.values?.perPortion ?? item.value ?? "";
            if (val) nutritionLines.push(`• ${name}: ${val}`);
          }
        } else if (nutritionRaw && typeof nutritionRaw === "object" && Object.keys(nutritionRaw).length > 0) {
          // Flat object format
          if (nutritionRaw.energy) nutritionLines.push(`• Energy: ${nutritionRaw.energy}`);
          if (nutritionRaw.fat) nutritionLines.push(`• Fat: ${nutritionRaw.fat}`);
          if (nutritionRaw.saturatedFat) nutritionLines.push(`• Saturated Fat: ${nutritionRaw.saturatedFat}`);
          if (nutritionRaw.carbohydrates) nutritionLines.push(`• Carbohydrates: ${nutritionRaw.carbohydrates}`);
          if (nutritionRaw.sugars) nutritionLines.push(`• Sugars: ${nutritionRaw.sugars}`);
          if (nutritionRaw.protein) nutritionLines.push(`• Protein: ${nutritionRaw.protein}`);
          if (nutritionRaw.salt) nutritionLines.push(`• Salt: ${nutritionRaw.salt}`);
          if (nutritionRaw.fiber) nutritionLines.push(`• Fiber: ${nutritionRaw.fiber}`);
        }

        if (nutritionLines.length > 0) {
          lines.push("## Nutritional Values (per 100g/100ml)");
          lines.push(...nutritionLines);
          lines.push("");
        }

        // Additive scores
        if (composition.additiveScoreMax !== undefined || composition.withoutAdditives !== undefined) {
          lines.push("## Additive Info");
          if (composition.withoutAdditives !== undefined) {
            lines.push(`• Without additives: ${composition.withoutAdditives ? "Yes ✅" : "No ❌"}`);
          }
          if (composition.additiveScoreMax !== undefined) {
            lines.push(`• Additive score: ${composition.additiveScoreMax}`);
          }
          if (composition.harmfulnessScore !== undefined) {
            lines.push(`• Harmfulness score: ${composition.harmfulnessScore}`);
          }
          lines.push("");
        }

        // Additional flags
        const flags = [];
        if (composition.organic) flags.push("Organic");
        if (composition.vegan) flags.push("Vegan");
        if (composition.vegetarian) flags.push("Vegetarian");
        if (composition.glutenFree) flags.push("Gluten-free");
        if (composition.lactoseFree) flags.push("Lactose-free");
        if (flags.length > 0) {
          lines.push(`**Dietary flags:** ${flags.join(", ")}`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }]
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
