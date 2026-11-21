/**
 * @fileoverview Demo city air-quality profiles and lookup helpers for ClearAir.
 */

/**
 * Represents illustrative or local air-quality conditions for a city.
 */
export interface AirQuality {
  readonly city: string;
  readonly aqi: number;
  readonly pm25: number;
  readonly pm10: number;
  readonly temperatureC: number;
  readonly wind: string;
  readonly severity: 'Severe' | 'Poor' | 'Moderate';
  readonly interpretation: string;
  readonly cleanerWindow: string;
  readonly peakSmogWindows: string;
  readonly isDemo: boolean;
  readonly isFallback: boolean;
}

/**
 * Strips control characters and collapses whitespace without importing
 * validation.ts (prevents a circular dependency between airQuality and validation).
 *
 * @param value - Unknown raw text value.
 * @returns Sanitized plain-text string.
 */
function sanitizeCityName(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Illustrative winter air-quality profiles for supported demo cities.
 */
export const DEMO_LOCATIONS: Readonly<Record<string, AirQuality>> = {
  Delhi: {
    city: 'Delhi',
    aqi: 286,
    pm25: 168,
    pm10: 241,
    temperatureC: 14,
    wind: 'Calm',
    severity: 'Severe',
    interpretation:
      'Fine particles are high today. Limit unnecessary outdoor exposure, especially during stagnant traffic hours.',
    cleanerWindow: 'Early afternoon (1:00 PM – 3:30 PM) if wind picks up slightly',
    peakSmogWindows: 'Early morning (6:00 AM – 9:30 AM) and late evening (6:30 PM – 10:30 PM)',
    isDemo: true,
    isFallback: false,
  },
  Mumbai: {
    city: 'Mumbai',
    aqi: 132,
    pm25: 54,
    pm10: 91,
    temperatureC: 25,
    wind: 'Moderate',
    severity: 'Poor',
    interpretation:
      'Particle levels are elevated today. Sensitive family members should reduce intense outdoor exertion and shift errands away from busy roads.',
    cleanerWindow: 'Midday to mid-afternoon (11:30 AM – 3:30 PM)',
    peakSmogWindows: 'Morning rush (7:30 AM – 10:00 AM) and evening commute (6:00 PM – 9:00 PM)',
    isDemo: true,
    isFallback: false,
  },
  Bengaluru: {
    city: 'Bengaluru',
    aqi: 96,
    pm25: 38,
    pm10: 67,
    temperatureC: 21,
    wind: 'Light breeze',
    severity: 'Moderate',
    interpretation:
      'Air quality is moderate with a light breeze helping disperse traffic emissions. Midday windows are generally better than peak rush hours.',
    cleanerWindow: 'Midday (11:00 AM – 3:00 PM)',
    peakSmogWindows: 'Peak arterial traffic (8:00 AM – 10:30 AM and 5:30 PM – 8:30 PM)',
    isDemo: true,
    isFallback: false,
  },
  London: {
    city: 'London',
    aqi: 74,
    pm25: 28,
    pm10: 42,
    temperatureC: 9,
    wind: 'Breezy',
    severity: 'Moderate',
    interpretation:
      'Breezy winter air keeps particle buildup moderate, though roadside corridors remain higher during commute peaks.',
    cleanerWindow: 'Late morning to afternoon (10:30 AM – 3:30 PM)',
    peakSmogWindows: 'Cold calm mornings and evening rush (5:00 PM – 7:30 PM)',
    isDemo: true,
    isFallback: false,
  },
  'New York': {
    city: 'New York',
    aqi: 61,
    pm25: 19,
    pm10: 32,
    temperatureC: 7,
    wind: 'Moderate',
    severity: 'Moderate',
    interpretation:
      'Overall conditions are moderate. Routine outdoor activity is reasonable for most households, with light caution near heavy traffic.',
    cleanerWindow: 'Late morning through mid-afternoon (10:00 AM – 4:00 PM)',
    peakSmogWindows: 'Weekday corridor traffic peaks (7:30 AM – 9:30 AM and 4:30 PM – 7:00 PM)',
    isDemo: true,
    isFallback: false,
  },
};

/**
 * Returns the illustrative air-quality snapshot for a given city, or a clearly
 * labeled fallback demo profile when the requested city is unavailable.
 *
 * @param city - City name selected by the user or caller.
 * @returns Normalized demo or fallback AirQuality record.
 */
export function getAirQualityForCity(city: string): AirQuality {
  const cleanCity = sanitizeCityName(city);
  if (cleanCity && Object.prototype.hasOwnProperty.call(DEMO_LOCATIONS, cleanCity)) {
    return { ...DEMO_LOCATIONS[cleanCity] };
  }
  return {
    ...DEMO_LOCATIONS.Delhi,
    city: cleanCity || 'Delhi',
    isFallback: true,
    interpretation:
      'Illustrative fallback demo data is shown because live or city-specific readings are unavailable. Limit unnecessary outdoor exposure during stagnant traffic hours.',
  };
}
