/**
 * Unit tests for search-products filtering logic
 *
 * Tests the safety-critical allergen and additive matching functions:
 * - matchesExcludedAllergen: bidirectional substring matching for compound strings
 * - hasAdditivesOrUnknown: additive detection with "missing = unsafe" semantics
 */

import { describe, it, expect } from 'vitest';
import { matchesExcludedAllergen, hasAdditivesOrUnknown } from '../src/tools/search-products.js';

describe('matchesExcludedAllergen', () => {
  it('should match exact allergen strings', () => {
    const composition = {
      allergens: {
        contained: ['Mléko'],
        possiblyContained: []
      }
    };
    expect(matchesExcludedAllergen(composition, ['Mléko'])).toBe(true);
  });

  it('should match compound API strings via substring (excluded is substring of API)', () => {
    const composition = {
      allergens: {
        contained: ['mléko a výrobky z mléka'],
        possiblyContained: []
      }
    };
    // User says "mléko" but API says "mléko a výrobky z mléka"
    expect(matchesExcludedAllergen(composition, ['mléko'])).toBe(true);
  });

  it('should match compound API strings via substring (API is substring of excluded)', () => {
    const composition = {
      allergens: {
        contained: ['ořechy'],
        possiblyContained: []
      }
    };
    // User says "ořechy a výrobky z ořechů" but API just says "ořechy"
    expect(matchesExcludedAllergen(composition, ['ořechy a výrobky z ořechů'])).toBe(true);
  });

  it('should check both contained and possiblyContained', () => {
    const composition = {
      allergens: {
        contained: [],
        possiblyContained: ['Může obsahovat stopy lepku']
      }
    };
    // Note: Czech inflection means "lepek" (nominative) != "lepku" (genitive)
    // Substring matching handles exact substrings; users should search for "lepku"
    expect(matchesExcludedAllergen(composition, ['lepku'])).toBe(true);
  });

  it('should demonstrate Czech inflection limitation', () => {
    const composition = {
      allergens: {
        contained: ['Může obsahovat stopy lepku'],
        possiblyContained: []
      }
    };
    // "lepek" (nominative) does NOT substring-match "lepku" (genitive)
    // This is a known limitation of simple substring matching for inflected languages
    expect(matchesExcludedAllergen(composition, ['lepek'])).toBe(false);
  });

  it('should handle multiple excluded allergens', () => {
    const composition = {
      allergens: {
        contained: ['Sója'],
        possiblyContained: []
      }
    };
    expect(matchesExcludedAllergen(composition, ['Mléko', 'Sója', 'Ořechy'])).toBe(true);
  });

  it('should be case-insensitive', () => {
    const composition = {
      allergens: {
        contained: ['MLÉKO A VÝROBKY Z MLÉKA'],
        possiblyContained: []
      }
    };
    expect(matchesExcludedAllergen(composition, ['mléko'])).toBe(true);
  });

  it('should trim whitespace from excluded allergens', () => {
    const composition = {
      allergens: {
        contained: ['Mléko'],
        possiblyContained: []
      }
    };
    expect(matchesExcludedAllergen(composition, ['  mléko  '])).toBe(true);
  });

  it('should return false when no allergens match', () => {
    const composition = {
      allergens: {
        contained: ['Mléko'],
        possiblyContained: ['Ořechy']
      }
    };
    expect(matchesExcludedAllergen(composition, ['lepek', 'vejce'])).toBe(false);
  });

  it('should return false when composition has no allergens', () => {
    const composition = {
      allergens: {
        contained: [],
        possiblyContained: []
      }
    };
    expect(matchesExcludedAllergen(composition, ['Mléko'])).toBe(false);
  });

  it('should return false when composition has no allergens field', () => {
    const composition = { ingredients: [] };
    expect(matchesExcludedAllergen(composition, ['Mléko'])).toBe(false);
  });

  it('should return false when excludeAllergens is empty', () => {
    const composition = {
      allergens: {
        contained: ['Mléko'],
        possiblyContained: []
      }
    };
    expect(matchesExcludedAllergen(composition, [])).toBe(false);
  });
});

describe('hasAdditivesOrUnknown', () => {
  it('should return true when withoutAdditives is false', () => {
    const composition = { withoutAdditives: false };
    expect(hasAdditivesOrUnknown(composition)).toBe(true);
  });

  it('should return true when additiveScoreMax > 0', () => {
    const composition = { additiveScoreMax: 3 };
    expect(hasAdditivesOrUnknown(composition)).toBe(true);
  });

  it('should return false when withoutAdditives is true', () => {
    const composition = { withoutAdditives: true };
    expect(hasAdditivesOrUnknown(composition)).toBe(false);
  });

  it('should return false when additiveScoreMax is 0', () => {
    const composition = { additiveScoreMax: 0 };
    expect(hasAdditivesOrUnknown(composition)).toBe(false);
  });

  it('should return true when both additive fields are missing (unknown = unsafe)', () => {
    const composition = {
      allergens: { contained: [], possiblyContained: [] },
      ingredients: []
    };
    expect(hasAdditivesOrUnknown(composition)).toBe(true);
  });

  it('should return false when withoutAdditives is true even if additiveScoreMax is missing', () => {
    const composition = { withoutAdditives: true };
    expect(hasAdditivesOrUnknown(composition)).toBe(false);
  });

  it('should return true when withoutAdditives is missing but additiveScoreMax > 0', () => {
    const composition = { additiveScoreMax: 1 };
    expect(hasAdditivesOrUnknown(composition)).toBe(true);
  });

  it('should return true for null composition', () => {
    expect(hasAdditivesOrUnknown(null)).toBe(true);
  });

  it('should return true for undefined composition', () => {
    expect(hasAdditivesOrUnknown(undefined)).toBe(true);
  });
});
