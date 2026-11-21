/**
 * app.js — Public ES module facade for ClearAir.
 *
 * Re-exports every symbol consumed by test.js and bootstraps the browser UI
 * module (`src/ui.ts`) when running inside a document context.
 */

export { DEMO_LOCATIONS, getAirQualityForCity } from './src/airQuality.ts';

export {
  VALID_OPTIONS,
  DEFAULT_HOUSEHOLD,
  sanitizeText,
  validateHousehold,
  normalizeAirQuality,
} from './src/validation.ts';

export {
  SCORING_WEIGHT_TABLE,
  PLAN_RULES,
  evaluateCandidateScore,
  generatePlan,
} from './src/planEngine.ts';

export { MAX_QUESTION_LENGTH, answerQuestion } from './src/qa.ts';

export {
  debounce,
  appendDefinitionRow,
  renderAirQuality,
  renderPlan,
  renderAssistantResponse,
  initClearAirApp,
} from './src/ui.ts';

