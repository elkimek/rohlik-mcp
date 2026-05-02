# Testing Guide

This directory contains all tests for the Rohlik MCP server.

## Test Structure

```
tests/
├── README.md                       # This file
├── helpers.ts                      # Mock data generators and test utilities
├── frequent-items.test.ts          # Unit tests for frequency analysis
├── meal-suggestions.test.ts        # Unit tests for meal suggestions
├── search-products-filter.test.ts  # Unit tests for allergen/additive filters
├── rohlik-api.test.ts              # HTTP-layer tests (cookie jar, retry, addToCart, login)
├── validate-api.ts                 # Integration tests against real API
├── validation-results.json         # API validation results (generated)
└── validation-report.html          # HTML report (generated)
```

## Test Categories

### Unit Tests

Pure-logic tests with no real network calls:

- **`frequent-items.test.ts`** - Frequency counting, average price calculation, sorting, and category grouping
- **`meal-suggestions.test.ts`** - Category filtering, meal type mapping, and sorting algorithms
- **`search-products-filter.test.ts`** - Allergen substring matching and additive detection (safety-critical filters)

### HTTP-layer Tests

`rohlik-api.test.ts` replaces `node-fetch` with a `vi.fn()` and scripts response sequences to verify:

- Cookie jar parses `Set-Cookie` name=value pairs and replays them as a clean `Cookie:` header
- Cookie value rotation (server replaces a cookie on a later response)
- `ensureLoggedIn` lock: concurrent calls share a single `/login` round-trip
- 401 invalidates the session and retries once with a fresh login
- When the retry also fails, `RohlikAPIError` carries `status` and the response body
- `addToCart` returns `{ added, failed }` with per-product reasons
- Login success heuristic rejects responses without a `status` field

**What we test:**
- ✅ Data transformation algorithms
- ✅ Frequency counting and aggregation
- ✅ Price averaging calculations
- ✅ Category filtering and matching
- ✅ Sorting by frequency/quantity
- ✅ Allergen and additive safety filters
- ✅ Cookie/session/retry behavior in `RohlikAPI` via mocked `node-fetch`
- ✅ Edge cases (empty data, missing fields, failed orders, etc.)

**What we DON'T test:**
- ❌ Real API calls (use `npm run validate-api` for that)
- ❌ Simple pass-through tools (no logic worth covering)

### Integration Tests

Tests that verify the MCP works with the real Rohlik API:

- **`validate-api.ts`** - Validates all 11 API endpoints used by the MCP

Run with: `npm run validate-api`

## Running Tests

### Run all unit tests
```bash
npm test
```

### Run tests in watch mode (for development)
```bash
npm run test:watch
```

### Run tests with coverage report
```bash
npm run test:coverage
```

### Run API validation (integration tests)
```bash
npm run validate-api
```

## Writing Tests

### Using Mock Helpers

The `helpers.ts` file provides utilities for creating mock data:

```typescript
import {
  createMockProduct,
  createMockOrderDetail,
  createBreakfastProducts,
  createOrdersWithRepeatedProducts
} from './helpers.js';

// Create a single product
const product = createMockProduct({
  productId: '123',
  productName: 'Test Product',
  price: 50.00
});

// Create products for specific meal types
const breakfastItems = createBreakfastProducts();

// Create orders with repeated products (for frequency tests)
const orders = createOrdersWithRepeatedProducts();
```

### Test Structure Example

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createFrequentItemsTool } from '../src/tools/frequent-items.js';
import { createMockProduct, createMockOrderDetail } from './helpers.js';

describe('feature name', () => {
  describe('specific functionality', () => {
    it('should do something specific', async () => {
      // Arrange: Set up mock data
      const product = createMockProduct();
      const mockAPI = {
        getOrderHistory: vi.fn().mockResolvedValue([...]),
        getOrderDetail: vi.fn().mockResolvedValue(...)
      };

      // Act: Execute the function
      const tool = createFrequentItemsTool(() => mockAPI as any);
      const result = await tool.handler({});

      // Assert: Verify the result
      expect(result.content[0].text).toContain('expected output');
    });
  });
});
```

## Test Coverage

Our tests focus on the **data transformation logic** in smart shopping features:

### `frequent-items.ts` Coverage

| Feature | Test Coverage |
|---------|---------------|
| Frequency counting | ✅ Multiple products across orders |
| Average price calculation | ✅ Including missing prices |
| Quantity aggregation | ✅ Different quantities per order |
| Category grouping | ✅ Per-category breakdown |
| Sorting by frequency | ✅ Descending order |
| Top N items limiting | ✅ Respects `top_items` param |
| Last order date tracking | ✅ Most recent date |
| Edge cases | ✅ Empty history, no products, failed orders |

### `meal-suggestions.ts` Coverage

| Feature | Test Coverage |
|---------|---------------|
| Category filtering | ✅ Breakfast, lunch, dinner, snacks, etc. |
| Case-insensitive matching | ✅ Category name variations |
| Sorting by frequency | ✅ When `prefer_frequent=true` |
| Sorting by quantity | ✅ When `prefer_frequent=false` |
| Items count limiting | ✅ Respects `items_count` param |
| All meal types | ✅ 7 meal types supported |
| Output formatting | ✅ Emojis, product IDs, categories |
| Edge cases | ✅ No matches, empty history, missing data |

## Why Unit Tests?

**Value of unit tests for this project:**

1. **Algorithm verification** - Smart shopping features use non-trivial algorithms:
   - Frequency counting across multiple orders
   - Average price calculation with weighted averages
   - Category filtering with fuzzy matching
   - Multi-level sorting (frequency + recency)

2. **Edge case coverage** - Tests ensure robustness:
   - Empty order history
   - Missing product data (no name, no price, no category)
   - Failed API calls (one order fails, others succeed)
   - Extreme values (0 orders, 100 orders)

3. **Regression prevention** - Tests catch bugs when refactoring:
   - Changing sorting logic
   - Modifying category mappings
   - Updating price calculations

4. **Fast feedback loop** - Unit tests run in milliseconds:
   - No API calls required
   - No authentication needed
   - Instant verification during development

5. **Documentation** - Tests serve as examples of how the algorithms work

## What We Don't Test

To keep tests maintainable and focused, we **don't** unit-test:

- ❌ Simple pass-through tool wrappers (`get_cart_content`, `get_premium_info`, etc.) — they only stringify a single `RohlikAPI` call
- ❌ Real network requests (use `npm run validate-api` for end-to-end coverage)
- ❌ Output formatting details (minor wording changes shouldn't break tests)

The API client (`rohlik-api.ts`) **is** covered by `rohlik-api.test.ts` via mocked `node-fetch`.

## Integration Testing

For real API verification, use the validation tool:

```bash
npm run validate-api
```

This will:
- Test all 11 API endpoints
- Show detailed HTTP logs
- Generate JSON results: `tests/validation-results.json`
- Create HTML report: `tests/validation-report.html`

**When to use:**
- After Rohlik API changes
- To debug authentication issues
- Before releasing new versions
- To verify endpoint availability

## Continuous Integration

`.github/workflows/ci.yml` runs `tsc --noEmit`, `npm run build`, and `npm test` on every push and PR against `main` for Node 18, 20, and 22. `.github/workflows/codeql.yml` runs CodeQL with the `security-extended` and `security-and-quality` query packs on the same triggers plus a weekly cron.

## Debugging Tests

### View detailed test output
```bash
npm test -- --reporter=verbose
```

### Run specific test file
```bash
npm test frequent-items.test.ts
```

### Run specific test case
```bash
npm test -- -t "should count product frequency"
```

### Debug with Node inspector
```bash
node --inspect-brk ./node_modules/vitest/vitest.mjs run
```

## Contributing

When adding new smart features with data transformation logic:

1. **Add mock helpers** in `helpers.ts`
2. **Write unit tests** following the existing structure
3. **Test edge cases** (empty data, missing fields, etc.)
4. **Document what you test** in this README
5. **Run coverage** to ensure good test coverage

### Test Naming Convention

- **Describe blocks**: Feature or functionality being tested
- **It blocks**: Specific behavior in plain English
- **Use "should"**: Clear expectation of behavior

Example:
```typescript
describe('frequency counting', () => {
  it('should count product frequency correctly across multiple orders', () => {
    // test code
  });
});
```

## Troubleshooting

### Tests fail with "Cannot find module"
- Run `npm run build` first to compile TypeScript
- Check that `.js` extensions are used in imports

### Mock API not working
- Ensure you're using `vi.fn().mockResolvedValue()` for async functions
- Check that the mock API matches the expected interface

### Coverage report not generating
- Install coverage provider: `npm install -D @vitest/coverage-v8`
- Run: `npm run test:coverage`

### Integration tests fail
- Check credentials in Claude Desktop config
- Enable debug mode: `ROHLIK_DEBUG=true npm run validate-api`
- Verify network connectivity to Rohlik servers

## Resources

- **Vitest Documentation**: https://vitest.dev/
- **MCP Specification**: https://modelcontextprotocol.io/
- **Project README**: ../README.md
- **User Guide**: ../docs/README.md

---

**Last updated**: 2026-05-02
