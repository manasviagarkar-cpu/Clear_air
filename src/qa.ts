/**
 * @fileoverview Deterministic local Q&A reasoning engine for ClearAir.
 */

import { validateHousehold, normalizeAirQuality, sanitizeText } from './validation.ts';
import type { AirQuality } from './airQuality.ts';
import type { HouseholdProfile } from './validation.ts';

/**
 * Maximum permitted question length in characters.
 */
export const MAX_QUESTION_LENGTH = 300;

/**
 * Structured Q&A response returned by {@link answerQuestion}.
 */
export interface AssistantResponse {
  readonly valid: boolean;
  readonly error?: string;
  readonly inScope?: boolean;
  readonly question?: string;
  readonly topic?: string;
  readonly directAnswer?: string;
  readonly reasoning?: string;
  readonly nextStep?: string;
  readonly safetyCaveat?: string;
}

interface QaContext {
  readonly cleanQuestion: string;
  readonly qLower: string;
  readonly household: HouseholdProfile;
  readonly aq: AirQuality;
  readonly sensitivityPhrase: string;
  readonly safetyCaveat: string;
  readonly hasPurifier: boolean;
  readonly windowsCanClose: boolean;
  readonly hasMechVent: boolean;
  readonly cookingWithGas: boolean;
  readonly hasVulnerable: boolean;
  readonly isSevere: boolean;
  readonly isPoor: boolean;
  readonly isWfh: boolean;
  readonly isOutdoorCommute: boolean;
  readonly isCar: boolean;
}

function formatSensitivityPhrase(sensitivities: readonly string[]): string {
  const map: Record<string, string> = {
    'Child under 12': 'a child under 12',
    'Older adult': 'an older adult',
    'Asthma or respiratory sensitivity': 'someone with asthma or respiratory sensitivity',
    'Heart or cardiovascular sensitivity': 'someone with heart or cardiovascular sensitivity',
  };
  const active = sensitivities
    .filter((s) => s !== 'None of these')
    .map((s) => map[s] || s.toLowerCase());
  if (active.length === 0) return 'sensitive household members';
  if (active.length === 1) return active[0];
  return `${active.slice(0, -1).join(', ')} and ${active[active.length - 1]}`;
}

function buildQaContext(
  cleanQuestion: string,
  household: HouseholdProfile,
  aq: AirQuality
): QaContext {
  const { sensitivities, indoor, travelMode } = household;
  const hasVulnerable =
    sensitivities.includes('Child under 12') ||
    sensitivities.includes('Older adult') ||
    sensitivities.includes('Asthma or respiratory sensitivity') ||
    sensitivities.includes('Heart or cardiovascular sensitivity');
  const sensitivityPhrase = formatSensitivityPhrase(sensitivities);
  const isSevere = aq.severity === 'Severe' || aq.pm25 >= 120;
  const isPoor = !isSevere && (aq.severity === 'Poor' || aq.pm25 >= 45);

  return {
    cleanQuestion,
    qLower: cleanQuestion.toLowerCase(),
    household,
    aq,
    sensitivityPhrase,
    safetyCaveat: hasVulnerable
      ? `Because your household includes ${sensitivityPhrase}, take extra caution on ${aq.severity.toLowerCase()} days and seek medical care for any breathing trouble.`
      : 'This guidance is educational, not medical advice, and uses illustrative demo air-quality values.',
    hasPurifier: indoor.includes('Air purifier available'),
    windowsCanClose: indoor.includes('Windows can be closed'),
    hasMechVent: indoor.includes('Mechanical ventilation available'),
    cookingWithGas: indoor.includes('Cooking with gas'),
    hasVulnerable,
    isSevere,
    isPoor,
    isWfh: travelMode === 'Work from home',
    isOutdoorCommute: ['Walk', 'Cycle', 'Two-wheeler'].includes(travelMode),
    isCar: travelMode === 'Private car',
  };
}

function answerChildrenPlay(ctx: QaContext): AssistantResponse {
  const { cleanQuestion, aq, hasPurifier, isSevere, isPoor, safetyCaveat } = ctx;
  if (isSevere) {
    return {
      valid: true,
      inScope: true,
      question: cleanQuestion,
      topic: 'Children & outdoor play',
      directAnswer: `Today is best for indoor play in ${aq.city}. Skip prolonged outdoor play while conditions remain severe.`,
      reasoning: `Demo readings show AQI ${aq.aqi} (${aq.pm25} µg/m³ PM2.5, ${aq.wind.toLowerCase()} wind), which is severe. Children breathe more air per kilogram of body weight and run harder during play.`,
      nextStep: hasPurifier
        ? 'Set up active indoor games in a closed-window room with your purifier running on a steady setting.'
        : 'Set up indoor play in a closed-window room away from kitchen smoke or incense—at zero extra cost.',
      safetyCaveat,
    };
  }
  if (isPoor) {
    return {
      valid: true,
      inScope: true,
      question: cleanQuestion,
      topic: 'Children & outdoor play',
      directAnswer: `Keep outdoor play brief and lower-intensity today in ${aq.city}, ideally during ${aq.cleanerWindow}.`,
      reasoning: `PM2.5 is elevated at ${aq.pm25} µg/m³ (${aq.severity}). Shorter play away from busy streets may reduce total particle intake compared with rush-hour parks.`,
      nextStep:
        'Choose a quiet courtyard or park away from traffic and move indoors if anyone coughs or tires early.',
      safetyCaveat,
    };
  }
  return {
    valid: true,
    inScope: true,
    question: cleanQuestion,
    topic: 'Children & outdoor play',
    directAnswer: `Moderate outdoor play is reasonable in ${aq.city} today, especially away from busy roads.`,
    reasoning: `Demo conditions are ${aq.severity} (AQI ${aq.aqi}, PM2.5 ${aq.pm25} µg/m³, ${aq.wind.toLowerCase()}), though roadside corridors still peak during rush hours.`,
    nextStep: `Aim for ${aq.cleanerWindow} at parks set back from main roads.`,
    safetyCaveat,
  };
}

function answerWindows(ctx: QaContext): AssistantResponse {
  const { cleanQuestion, aq, hasMechVent, windowsCanClose, hasPurifier, cookingWithGas, isSevere, isPoor, safetyCaveat } = ctx;
  if (hasMechVent && (isSevere || isPoor)) {
    return {
      valid: true,
      inScope: true,
      question: cleanQuestion,
      topic: 'Windows & ventilation',
      directAnswer: `Keep windows closed in ${aq.city} today and rely on your mechanical ventilation if it is filtered.`,
      reasoning: `${aq.city} shows ${aq.pm25} µg/m³ PM2.5 (${aq.severity}). Filtered mechanical ventilation can supply fresh indoor airflow without letting unfiltered street smog blow inside.`,
      nextStep:
        'Verify that building filters are clean and keep street-facing windows shut during peak traffic hours.',
      safetyCaveat,
    };
  }
  if (!windowsCanClose) {
    return {
      valid: true,
      inScope: true,
      question: cleanQuestion,
      topic: 'Windows & ventilation',
      directAnswer:
        'Since your windows may not seal tightly, focus on reducing drafts in your main room and keeping indoor combustion near zero.',
      reasoning: `${aq.city} currently shows ${aq.pm25} µg/m³ PM2.5 (${aq.severity}). When outdoor air cannot be fully shut out, indoor smoke and gas cooking add directly to indoor particles.`,
      nextStep:
        'Use rolled towels along drafty sills in the main bedroom and vent kitchen steam while cooking.',
      safetyCaveat,
    };
  }
  if (isSevere || isPoor) {
    return {
      valid: true,
      inScope: true,
      question: cleanQuestion,
      topic: 'Windows & ventilation',
      directAnswer: `Keep windows closed now, especially during ${aq.peakSmogWindows}.`,
      reasoning: `With ${aq.city} at ${aq.pm25} µg/m³ PM2.5 (${aq.severity}) and ${aq.wind.toLowerCase()} air, open windows allow outdoor fine particles to settle indoors${
        hasPurifier ? ' and reduce your purifier’s effectiveness' : ''
      }.`,
      nextStep: cookingWithGas
        ? `Only crack a kitchen window briefly (10–15 minutes) while cooking with the kitchen door shut, or air out briefly during ${aq.cleanerWindow}.`
        : `Wait for ${aq.cleanerWindow} for a brief 10-minute cross-breeze if the room feels stuffy, then close up again.`,
      safetyCaveat,
    };
  }
  return {
    valid: true,
    inScope: true,
    question: cleanQuestion,
    topic: 'Windows & ventilation',
    directAnswer: `You can open windows briefly during ${aq.cleanerWindow}, while keeping street-facing windows shut at rush hour.`,
    reasoning: `In ${aq.city}, demo conditions are ${aq.severity} (${aq.pm25} µg/m³ PM2.5, ${aq.wind.toLowerCase()}), so daytime ventilation helps clear indoor CO2 and cooking moisture.`,
    nextStep: 'Open windows on the side away from main traffic for 15–20 minutes around midday.',
    safetyCaveat,
  };
}

function answerCommute(ctx: QaContext): AssistantResponse {
  const { cleanQuestion, qLower, aq, household, isWfh, isSevere, isPoor, isCar, isOutdoorCommute, safetyCaveat } = ctx;
  const mentionsMask = /\b(mask\w*|n95|kn95|ffp2|respirator\w*)\b/.test(qLower);
  const lowEmissionNote =
    'Public transit (metro, train, or shared bus) or combining errands into one off-peak trip is usually the lowest-emission urban option.';

  if (isWfh) {
    return {
      valid: true,
      inScope: true,
      question: cleanQuestion,
      topic: 'Commute & emissions',
      directAnswer: `Working from home already keeps your commute emissions at zero in ${aq.city}. For errands, public transit or one batched off-peak trip is the lowest-emission choice.`,
      reasoning: `With ${aq.city} at AQI ${aq.aqi} (${aq.pm25} µg/m³ PM2.5, ${aq.severity}) and your priority set to ${household.priority}, avoiding peak-hour road trips protects both emissions and air intake.`,
      nextStep: `Batch any errands into ${aq.cleanerWindow} and take enclosed transit or quiet side streets when practical.`,
      safetyCaveat,
    };
  }

  if (isSevere || isPoor) {
    let nextStep =
      'Take enclosed public transit if available, stand back from curb tailpipes while waiting, and batch errands into one trip.';
    if (isCar) {
      nextStep =
        'Consider public transit or carpooling when practical; if driving, switch cabin air to recirculate in congestion and avoid idling over 30 seconds.';
    } else if (isOutdoorCommute) {
      nextStep = `Switch your ${household.travelMode.toLowerCase()} trip to enclosed transit if practical today, or shift off peak traffic onto quiet side streets.`;
    }
    if (mentionsMask) {
      nextStep +=
        ' If traveling outdoors beside traffic, a well-fitting N95/FFP2 respirator helps filter fine particles better than a cloth mask.';
    }
    return {
      valid: true,
      inScope: true,
      question: cleanQuestion,
      topic: 'Commute & emissions',
      directAnswer: `${lowEmissionNote} Today in ${aq.city} (${aq.severity}), enclosed public transit also lowers direct roadside exposure compared with walking, cycling, or a two-wheeler.`,
      reasoning: `Your current travel mode is ${household.travelMode} and priority is ${household.priority}. While cycling or walking produces zero tailpipe emissions, heavy breathing beside ${aq.pm25} µg/m³ PM2.5 traffic increases particle intake.`,
      nextStep,
      safetyCaveat,
    };
  }

  return {
    valid: true,
    inScope: true,
    question: cleanQuestion,
    topic: 'Commute & emissions',
    directAnswer: `${lowEmissionNote} On a ${aq.severity.toLowerCase()} day like today in ${aq.city}, walking or cycling along quiet side streets is also a strong low-emission option.`,
    reasoning: `With AQI at ${aq.aqi} (${aq.pm25} µg/m³ PM2.5), shifting away from solo cars cuts neighborhood exhaust while keeping personal exposure manageable off main roads.`,
    nextStep: 'Choose side-street routes or public transit, and combine errands into a single loop.',
    safetyCaveat,
  };
}

function answerBedroomAir(ctx: QaContext): AssistantResponse {
  const { cleanQuestion, aq, household, hasPurifier, cookingWithGas, safetyCaveat } = ctx;
  if (hasPurifier) {
    const lowCostPurifier = household.priority === 'Lowest cost';
    return {
      valid: true,
      inScope: true,
      question: cleanQuestion,
      topic: 'Bedroom & indoor air',
      directAnswer: lowCostPurifier
        ? 'Close bedroom doors and windows before evening smog builds, and run your existing purifier on a low steady overnight speed to protect sleep air while keeping electricity use minimal.'
        : 'Close bedroom doors and windows before evening smog builds, and run your air purifier 45 minutes before bedtime and overnight on a quiet steady setting.',
      reasoning: `You indicated an air purifier is available while ${aq.city} is at ${aq.pm25} µg/m³ PM2.5 (${aq.severity}) and your priority is ${household.priority}. Containing one bedroom helps filtration work effectively without fighting outdoor air.`,
      nextStep: cookingWithGas
        ? 'Keep the kitchen door closed and exhaust fan on while cooking with gas so cooking particles do not drift toward bedrooms.'
        : 'Check that the purifier intake is unobstructed and avoid burning candles or incense indoors.',
      safetyCaveat,
    };
  }
  return {
    valid: true,
    inScope: true,
    question: cleanQuestion,
    topic: 'Bedroom & indoor air',
    directAnswer:
      'Even without a purifier, you can create a cleaner-air bedroom by closing windows during peak smog, damp-dusting surfaces, and eliminating indoor smoke—without buying new products.',
    reasoning: `In ${aq.city} (${aq.pm25} µg/m³ PM2.5, ${aq.severity}), keeping one sleeping room closed during ${aq.peakSmogWindows} and free of incense, candles, or cooking fumes helps keep overnight particle levels lower—at zero cost.`,
    nextStep: cookingWithGas
      ? 'Keep bedroom doors shut while cooking with gas, use pot lids and kitchen exhaust, and wipe bedroom floors with a damp cloth.'
      : 'Close bedroom windows before evening traffic peaks, damp-wipe surfaces, and skip candles or incense.',
    safetyCaveat,
  };
}

function answerOutdoorExercise(ctx: QaContext): AssistantResponse {
  const { cleanQuestion, aq, household, sensitivityPhrase, hasVulnerable, isSevere, safetyCaveat } = ctx;
  if (isSevere) {
    return {
      valid: true,
      inScope: true,
      question: cleanQuestion,
      topic: 'Outdoor exercise & timing',
      directAnswer: `Hold off on vigorous outdoor exercise in ${aq.city} today and move workouts indoors${
        hasVulnerable ? `, especially with ${sensitivityPhrase} in your household` : ''
      }.`,
      reasoning: `At AQI ${aq.aqi} (${aq.pm25} µg/m³ PM2.5, ${aq.wind.toLowerCase()} wind), deep breathing during exercise pulls far more fine particles into the lungs, especially during ${household.outdoorTime.toLowerCase()} traffic.`,
      nextStep:
        'Do gentle indoor stretching or bodyweight movement today; if an outdoor walk is unavoidable, keep the pace easy and consider a well-fitting N95/FFP2 respirator if comfortable.',
      safetyCaveat,
    };
  }
  return {
    valid: true,
    inScope: true,
    question: cleanQuestion,
    topic: 'Outdoor exercise & timing',
    directAnswer: `Aim for ${aq.cleanerWindow} on low-traffic paths rather than ${aq.peakSmogWindows}.`,
    reasoning: `${aq.city} is at ${aq.severity} (${aq.pm25} µg/m³ PM2.5). Midday warmth and ${aq.wind.toLowerCase()} airflow generally disperse street-level particles better than calm morning or evening hours, and your usual timing is ${household.outdoorTime.toLowerCase()}.`,
    nextStep: hasVulnerable
      ? 'Keep intensity light-to-moderate, stay away from busy roads, and carry any prescribed reliever medication if anyone has asthma.'
      : 'Pick parks or residential streets away from bus corridors and shorten the session if air feels hazy.',
    safetyCaveat,
  };
}

const MEDICAL_PATTERN =
  /\b(diagnos\w*|prescrib\w*|dosage|dose|inhaler|medication|medicine|chest pain|faint\w*|wheez\w*|shortness of breath|heart attack|asthma attack|doctor|physician|emergency|cure|symptom\w*)\b/;

const TOPIC_MATCHERS: ReadonlyArray<{ pattern: RegExp; handler: (ctx: QaContext) => AssistantResponse }> = [
  {
    pattern: /\b(child\w*|kid|kids|son|daughter|baby|babies|toddler\w*|play\w*|playground|school\w*)\b/,
    handler: answerChildrenPlay,
  },
  {
    pattern: /\b(window|windows|ventilat\w*|open|air out|fresh air|draft\w*|breeze)\b/,
    handler: answerWindows,
  },
  {
    pattern:
      /\b(commut\w*|transit|bus|buses|metro|train|car|cars|drive|driving|cycl\w*|bike|biking|two-wheeler|scooter|emission\w*|traffic|idling|idle|errand\w*|remote|work from home)\b/,
    handler: answerCommute,
  },
  {
    pattern:
      /\b(bedroom\w*|sleep\w*|night|purifier\w*|hepa|filter\w*|indoor\w*|room\w*|air quality inside|gas|cook\w*|kitchen|stove|incense|candle\w*|smoke)\b/,
    handler: answerBedroomAir,
  },
  {
    pattern:
      /\b(exercis\w*|walk\w*|run\w*|jog\w*|workout\w*|outdoor\w*|outside|mask\w*|n95|kn95|ffp2|respirator\w*|park\w*|morning|evening|older|elderly|senior\w*|asthma|heart)\b/,
    handler: answerOutdoorExercise,
  },
];

/**
 * Answers a plain-language household question about outdoor play, window
 * timing, commuting, or indoor air using deterministic topic matching and the
 * active city and household context.
 *
 * Returns `valid: false` for blank or over-length questions, and `inScope: false`
 * with a safe educational boundary for medical or unrelated questions.
 *
 * @param params - Question string plus current household profile and air-quality state.
 * @returns Structured assistant guidance or validation/out-of-scope response.
 */
export function answerQuestion(
  params: { question?: unknown; household?: unknown; airQuality?: unknown } = {}
): AssistantResponse {
  const cleanQuestion = sanitizeText(params.question);
  if (!cleanQuestion) {
    return {
      valid: false,
      error: 'Please enter a question about outdoor timing, windows, commuting, or indoor air.',
    };
  }
  if (cleanQuestion.length > MAX_QUESTION_LENGTH) {
    return {
      valid: false,
      error: `Please keep your question under ${MAX_QUESTION_LENGTH} characters.`,
    };
  }

  const { normalized: safeHousehold } = validateHousehold(params.household);
  const aq = normalizeAirQuality(params.airQuality, safeHousehold.city);
  const ctx = buildQaContext(cleanQuestion, safeHousehold, aq);

  if (MEDICAL_PATTERN.test(ctx.qLower)) {
    return {
      valid: true,
      inScope: false,
      question: cleanQuestion,
      topic: 'Out of scope (medical)',
      directAnswer:
        'I can help with household routines, outdoor timing, transport choices, and indoor air practices. For urgent symptoms or medical decisions, contact a qualified healthcare professional.',
      reasoning:
        'ClearAir is an educational planning tool using illustrative demo conditions and cannot evaluate symptoms or give medical advice.',
      nextStep:
        'If anyone is experiencing serious breathing difficulty, chest pain, fainting, or severe wheezing, seek urgent medical care right away.',
      safetyCaveat:
        'Always rely on a qualified clinician for asthma action plans, medication adjustments, or symptom checks.',
    };
  }

  for (const matcher of TOPIC_MATCHERS) {
    if (matcher.pattern.test(ctx.qLower)) {
      return matcher.handler(ctx);
    }
  }

  return {
    valid: true,
    inScope: false,
    question: cleanQuestion,
    topic: 'Outside scope',
    directAnswer:
      'I can help with household routines, outdoor timing, transport choices, and indoor air practices. For urgent symptoms or medical decisions, contact a qualified healthcare professional.',
    reasoning:
      'Your question did not match ClearAir’s local topics (children’s outdoor play, exercise timing, windows, commuting, emissions, or bedroom air).',
    nextStep:
      'Try one of the quick questions above or ask specifically about windows, commuting, outdoor play, or bedroom air.',
    safetyCaveat: 'Demo reasoning mode provides deterministic educational suggestions only.',
  };
}
