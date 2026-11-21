/**
 * @fileoverview Input sanitization, household validation, and air-quality normalization.
 */

import { DEMO_LOCATIONS, getAirQualityForCity } from './airQuality.ts';
import type { AirQuality } from './airQuality.ts';

/**
 * Validated household profile used by the plan engine and Q&A assistant.
 */
export interface HouseholdProfile {
  city: string;
  householdSize: string;
  sensitivities: string[];
  travelMode: string;
  outdoorTime: string;
  indoor: string[];
  priority: string;
}

/**
 * Known field keys on HouseholdProfile.
 */
export type HouseholdFieldKey = keyof HouseholdProfile;

/**
 * Result returned by {@link validateHousehold}.
 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: Partial<Record<HouseholdFieldKey, string>>;
  readonly normalized: HouseholdProfile;
}

/**
 * Allowed option sets for household configuration controls.
 */
export const VALID_OPTIONS = {
  cities: Object.keys(DEMO_LOCATIONS),
  householdSizes: ['1–2 people', '3–4 people', '5+ people'],
  sensitivities: [
    'Child under 12',
    'Older adult',
    'Asthma or respiratory sensitivity',
    'Heart or cardiovascular sensitivity',
    'None of these',
  ],
  travelModes: [
    'Walk',
    'Cycle',
    'Public transit',
    'Private car',
    'Two-wheeler',
    'Work from home',
  ],
  outdoorTimes: ['Early morning', 'Midday', 'Evening', 'Flexible'],
  indoorOptions: [
    'Air purifier available',
    'Windows can be closed',
    'Mechanical ventilation available',
    'Cooking with gas',
    'Not sure',
  ],
  priorities: ['Lowest exposure', 'Lowest emissions', 'Lowest cost', 'Balanced option'],
} as const;

/**
 * Default household profile loaded on initial visit and after reset.
 */
export const DEFAULT_HOUSEHOLD: Readonly<HouseholdProfile> = {
  city: 'Delhi',
  householdSize: '3–4 people',
  sensitivities: ['Child under 12'],
  travelMode: 'Private car',
  outdoorTime: 'Early morning',
  indoor: ['Windows can be closed'],
  priority: 'Balanced option',
};

/**
 * Strips ASCII control characters and collapses repeated whitespace into single spaces.
 *
 * @param value - Raw unknown input value.
 * @returns Sanitized plain-text string (empty string for non-string input).
 */
export function sanitizeText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extracts and deduplicates valid selections from a multi-select raw input array.
 *
 * @param rawList - Candidate array from form data or test input.
 * @param allowed - Allowed option strings.
 * @returns Deduplicated valid option strings.
 */
function extractValidChoices(rawList: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(rawList)) {
    return [];
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of rawList) {
    const text = sanitizeText(item);
    if (allowed.includes(text) && !seen.has(text)) {
      seen.add(text);
      cleaned.push(text);
    }
  }
  return cleaned;
}

/**
 * Validates raw household form input and returns field-level errors alongside a
 * normalized {@link HouseholdProfile} populated with safe defaults for invalid fields.
 *
 * @param rawHousehold - Untrusted household object from DOM form data or callers.
 * @returns Validation status, error map, and normalized household profile.
 */
export function validateHousehold(rawHousehold: unknown): ValidationResult {
  const input: Record<string, unknown> =
    rawHousehold && typeof rawHousehold === 'object'
      ? (rawHousehold as Record<string, unknown>)
      : {};
  const errors: Partial<Record<HouseholdFieldKey, string>> = {};

  const city = sanitizeText(input.city);
  const hasValidCity = VALID_OPTIONS.cities.includes(city);
  if (!hasValidCity) {
    errors.city = 'Please choose one of the available demo cities.';
  }

  const householdSize = sanitizeText(input.householdSize);
  const hasValidSize = (VALID_OPTIONS.householdSizes as readonly string[]).includes(householdSize);
  if (!hasValidSize) {
    errors.householdSize = 'Please select your household size.';
  }

  const sensitivities = extractValidChoices(input.sensitivities, VALID_OPTIONS.sensitivities);
  if (sensitivities.length === 0) {
    errors.sensitivities = 'Select at least one sensitivity option, or choose "None of these".';
  } else if (sensitivities.includes('None of these') && sensitivities.length > 1) {
    errors.sensitivities = 'Choose either specific household sensitivities or "None of these".';
  }

  const travelMode = sanitizeText(input.travelMode);
  const hasValidTravel = (VALID_OPTIONS.travelModes as readonly string[]).includes(travelMode);
  if (!hasValidTravel) {
    errors.travelMode = 'Please select your main daily travel method.';
  }

  const outdoorTime = sanitizeText(input.outdoorTime);
  const hasValidOutdoor = (VALID_OPTIONS.outdoorTimes as readonly string[]).includes(outdoorTime);
  if (!hasValidOutdoor) {
    errors.outdoorTime = 'Please choose when outdoor activity usually happens.';
  }

  const indoor = extractValidChoices(input.indoor, VALID_OPTIONS.indoorOptions);
  if (indoor.length === 0) {
    errors.indoor = 'Select at least one indoor environment condition, or choose "Not sure".';
  } else if (indoor.includes('Not sure') && indoor.length > 1) {
    errors.indoor = 'Choose either specific indoor conditions or "Not sure".';
  }

  const priority = sanitizeText(input.priority);
  const hasValidPriority = (VALID_OPTIONS.priorities as readonly string[]).includes(priority);
  if (!hasValidPriority) {
    errors.priority = 'Please select your main priority for today.';
  }

  const normalized: HouseholdProfile = {
    city: hasValidCity ? city : DEFAULT_HOUSEHOLD.city,
    householdSize: hasValidSize ? householdSize : DEFAULT_HOUSEHOLD.householdSize,
    sensitivities: sensitivities.length > 0 ? sensitivities : [...DEFAULT_HOUSEHOLD.sensitivities],
    travelMode: hasValidTravel ? travelMode : DEFAULT_HOUSEHOLD.travelMode,
    outdoorTime: hasValidOutdoor ? outdoorTime : DEFAULT_HOUSEHOLD.outdoorTime,
    indoor: indoor.length > 0 ? indoor : [...DEFAULT_HOUSEHOLD.indoor],
    priority: hasValidPriority ? priority : DEFAULT_HOUSEHOLD.priority,
  };

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalized,
  };
}

/**
 * Derives a severity tier from explicit label or numeric AQI / PM2.5 thresholds.
 *
 * @param severity - Candidate severity string.
 * @param aqi - Numeric AQI value.
 * @param pm25 - Numeric PM2.5 value in µg/m³.
 * @returns Validated severity tier.
 */
function resolveSeverity(severity: unknown, aqi: number, pm25: number): AirQuality['severity'] {
  if (severity === 'Severe' || severity === 'Poor' || severity === 'Moderate') {
    return severity;
  }
  if (aqi >= 200 || pm25 >= 120) {
    return 'Severe';
  }
  if (aqi >= 101 || pm25 >= 45) {
    return 'Poor';
  }
  return 'Moderate';
}

/**
 * Returns a finite number when valid, or the supplied numeric fallback.
 *
 * @param value - Candidate numeric input.
 * @param fallback - Fallback number from city baseline.
 * @returns Validated finite number.
 */
function finiteOrFallback(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Normalizes a partial or untrusted air-quality object against the nearest demo city
 * baseline so downstream decision rules always receive complete numeric fields.
 *
 * @param airQuality - Partial or full AirQuality object.
 * @param fallbackCity - City name used when `airQuality.city` is absent.
 * @returns Complete normalized AirQuality object.
 */
export function normalizeAirQuality(airQuality: unknown, fallbackCity: string): AirQuality {
  if (!airQuality || typeof airQuality !== 'object') {
    return getAirQualityForCity(fallbackCity);
  }
  const aq = airQuality as Record<string, unknown>;
  const base = getAirQualityForCity(typeof aq.city === 'string' ? aq.city : fallbackCity);
  const aqi = finiteOrFallback(aq.aqi, base.aqi);
  const pm25 = finiteOrFallback(aq.pm25, base.pm25);
  const pm10 = finiteOrFallback(aq.pm10, base.pm10);

  return {
    ...base,
    city: sanitizeText(aq.city) || base.city,
    aqi,
    pm25,
    pm10,
    temperatureC: finiteOrFallback(aq.temperatureC, base.temperatureC),
    wind: sanitizeText(aq.wind) || base.wind,
    severity: resolveSeverity(aq.severity, aqi, pm25),
    interpretation: sanitizeText(aq.interpretation) || base.interpretation,
    cleanerWindow: sanitizeText(aq.cleanerWindow) || base.cleanerWindow,
    peakSmogWindows: sanitizeText(aq.peakSmogWindows) || base.peakSmogWindows,
    isDemo: aq.isDemo !== undefined ? Boolean(aq.isDemo) : base.isDemo,
    isFallback: aq.isFallback !== undefined ? Boolean(aq.isFallback) : base.isFallback,
  };
}
