/**
 * @fileoverview Data-driven weighted scoring plan engine for ClearAir.
 *
 * Decision scoring is expressed as an explicit weighted-scoring table
 * (`SCORING_WEIGHT_TABLE` and per-rule `factors` arrays of factor -> weight ->
 * contribution) evaluated by {@link evaluateCandidateScore}. This keeps ranking
 * auditable and deterministic while keeping rule selection clean.
 */

import { validateHousehold, normalizeAirQuality } from './validation.ts';
import { SCORING_WEIGHT_TABLE, PLAN_RULES } from './planRules.ts';
import type { AirQuality } from './airQuality.ts';
import type { HouseholdProfile } from './validation.ts';

export { SCORING_WEIGHT_TABLE, PLAN_RULES } from './planRules.ts';

/**
 * A single prioritized recommendation step shown in the daily clean-air plan.
 */
export interface PlanStep {
  readonly id: string;
  readonly label: string;
  readonly action: string;
  readonly whyItMatters: string;
  readonly directImpact: string;
  readonly tradeoff: string;
  readonly confidence: string;
}

/**
 * One factor's evaluated contribution to a candidate recommendation's total score.
 */
export interface ScoreContribution {
  readonly factor: string;
  readonly weight: number;
  readonly contribution: number;
}

/**
 * Audit entry recording how a candidate recommendation scored.
 */
export interface CandidateScoreAudit {
  readonly id: string;
  readonly totalScore: number;
  readonly breakdown: readonly ScoreContribution[];
}

/**
 * A sustainable lower-emission alternative with exposure/emissions tradeoffs.
 */
export interface SustainableAlternative {
  readonly alternative: string;
  readonly exposureBenefit: string;
  readonly emissionsBenefit: string;
  readonly tradeoff: string;
}

/**
 * Complete plan output returned by {@link generatePlan}.
 */
export interface PlanResult {
  readonly household: HouseholdProfile;
  readonly airQuality: AirQuality;
  readonly recommendations: PlanStep[];
  readonly signals: Array<{ label: string; value: string }>;
  readonly prioritySummary: string;
  readonly tradeoffSummary: string;
  readonly safetyCaveat: string;
  readonly alternatives: SustainableAlternative[];
  readonly scoringAudit: CandidateScoreAudit[];
}

/**
 * Normalized boolean and derived context flags passed to rule predicates.
 */
export interface RuleEvaluationContext {
  readonly household: HouseholdProfile;
  readonly aq: AirQuality;
  readonly priority: string;
  readonly sensitivityPhrase: string;
  readonly isLargeHousehold: boolean;
  readonly isSmallHousehold: boolean;
  readonly hasChild: boolean;
  readonly hasOlderAdult: boolean;
  readonly hasRespiratory: boolean;
  readonly hasHeart: boolean;
  readonly hasVulnerable: boolean;
  readonly hasPurifier: boolean;
  readonly windowsCanClose: boolean;
  readonly hasMechVent: boolean;
  readonly cookingWithGas: boolean;
  readonly indoorNotSure: boolean;
  readonly isSevere: boolean;
  readonly isPoor: boolean;
  readonly isModerate: boolean;
  readonly isOutdoorCommute: boolean;
  readonly isCar: boolean;
  readonly isTransit: boolean;
  readonly isWfh: boolean;
  readonly canShiftSchedule: boolean;
}

/**
 * Declarative factor row in a rule's weighted scoring table.
 */
export interface ScoringFactor {
  readonly id: string;
  readonly factor: string;
  readonly weight: number;
  readonly applies: (ctx: RuleEvaluationContext) => boolean;
}

/**
 * Declarative recommendation rule evaluated by {@link generatePlan}.
 */
export interface CandidateSpec {
  readonly id: string;
  readonly baseScore: number;
  readonly eligible: (ctx: RuleEvaluationContext) => boolean;
  readonly factors: readonly ScoringFactor[];
  readonly buildStep: (ctx: RuleEvaluationContext) => PlanStep;
}

/**
 * Formats active household sensitivity labels into a readable noun phrase.
 *
 * @param sensitivities - Validated household sensitivities list.
 * @returns Human-readable phrase (e.g., "a child under 12 and an older adult").
 */
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

/**
 * Builds derived boolean flags used across all declarative scoring factors.
 *
 * @param household - Normalized household profile.
 * @param aq - Normalized air-quality context.
 * @returns Context object for rule evaluation.
 */
function createRuleContext(household: HouseholdProfile, aq: AirQuality): RuleEvaluationContext {
  const { sensitivities, indoor, travelMode, outdoorTime, priority, householdSize } = household;
  const hasChild = sensitivities.includes('Child under 12');
  const hasOlderAdult = sensitivities.includes('Older adult');
  const hasRespiratory = sensitivities.includes('Asthma or respiratory sensitivity');
  const hasHeart = sensitivities.includes('Heart or cardiovascular sensitivity');
  const isSevere = aq.severity === 'Severe' || aq.pm25 >= 120;
  const isPoor = !isSevere && (aq.severity === 'Poor' || aq.pm25 >= 45);

  return {
    household,
    aq,
    priority,
    sensitivityPhrase: formatSensitivityPhrase(sensitivities),
    isLargeHousehold: householdSize === '5+ people',
    isSmallHousehold: householdSize === '1–2 people',
    hasChild,
    hasOlderAdult,
    hasRespiratory,
    hasHeart,
    hasVulnerable: hasChild || hasOlderAdult || hasRespiratory || hasHeart,
    hasPurifier: indoor.includes('Air purifier available'),
    windowsCanClose: indoor.includes('Windows can be closed'),
    hasMechVent: indoor.includes('Mechanical ventilation available'),
    cookingWithGas: indoor.includes('Cooking with gas'),
    indoorNotSure: indoor.includes('Not sure'),
    isSevere,
    isPoor,
    isModerate: !isSevere && !isPoor,
    isOutdoorCommute: ['Walk', 'Cycle', 'Two-wheeler'].includes(travelMode),
    isCar: travelMode === 'Private car',
    isTransit: travelMode === 'Public transit',
    isWfh: travelMode === 'Work from home',
    canShiftSchedule: outdoorTime === 'Flexible',
  };
}

/**
 * Evaluates a declarative {@link CandidateSpec} against a {@link RuleEvaluationContext}
 * using its weighted-scoring factor table, returning the numeric total score and
 * an auditable breakdown of every active contribution.
 *
 * @param spec - Candidate rule definition.
 * @param ctx - Derived household and air-quality evaluation context.
 * @returns Total score and factor-by-factor contribution breakdown.
 */
export function evaluateCandidateScore(
  spec: CandidateSpec,
  ctx: RuleEvaluationContext
): { totalScore: number; breakdown: ScoreContribution[] } {
  let totalScore = spec.baseScore;
  const breakdown: ScoreContribution[] = [
    { factor: 'Base rule priority', weight: spec.baseScore, contribution: spec.baseScore },
  ];

  for (const entry of spec.factors) {
    if (entry.applies(ctx)) {
      totalScore += entry.weight;
      breakdown.push({
        factor: entry.factor,
        weight: entry.weight,
        contribution: entry.weight,
      });
    }
  }

  return { totalScore, breakdown };
}

function buildPrioritySummary(ctx: RuleEvaluationContext): string {
  const { priority, aq, household, sensitivityPhrase, hasVulnerable } = ctx;
  if (priority === 'Lowest exposure') {
    return `We prioritized exposure reduction because ${aq.city} is at ${aq.severity.toLowerCase()} PM2.5 (${aq.pm25} µg/m³)${
      hasVulnerable ? ` and your ${household.householdSize} household includes ${sensitivityPhrase}` : ''
    }.`;
  }
  if (priority === 'Lowest emissions') {
    return `We prioritized low-emission habits—transit, shared or batched trips, and zero-idling routines—adapted to ${aq.city}’s ${aq.severity.toLowerCase()} (${aq.pm25} µg/m³ PM2.5) conditions and your ${household.travelMode.toLowerCase()} routine.`;
  }
  if (priority === 'Lowest cost') {
    return 'We prioritized free, immediate adjustments—window timing, schedule shifts, and avoiding indoor smoke—before suggesting any purchases.';
  }
  return `We balanced exposure reduction and lower emissions because ${aq.city} is at ${aq.severity.toLowerCase()} PM2.5 (${aq.pm25} µg/m³)${
    hasVulnerable ? ` and your household includes ${sensitivityPhrase}` : ''
  }.`;
}

function buildTradeoffSummary(priority: string): string {
  const map: Record<string, string> = {
    'Lowest emissions':
      'The lowest-emission option—such as walking or cycling beside heavy traffic—may not always be the lowest-exposure option during winter smog, so enclosed transit or quieter side-street timing is recommended.',
    'Lowest cost':
      'Free behavioral steps avoid equipment costs, though keeping windows shut during peak hours can feel warm or stale without brief midday airing.',
    'Lowest exposure':
      'Minimizing particle intake may require skipping outdoor exercise, shifting errands to midday, or choosing enclosed transit over open cycling or two-wheelers.',
  };
  return (
    map[priority] ||
    'The lowest-exposure option may take more planning or indoor time, while the lowest-emission option may require public transit, shared travel, or consolidated errands.'
  );
}

function buildSafetyCaveat(ctx: RuleEvaluationContext): string {
  const { hasVulnerable, isSevere, isPoor, sensitivityPhrase, aq } = ctx;
  if (hasVulnerable && (isSevere || isPoor)) {
    return `Because your household includes ${sensitivityPhrase} during ${aq.severity.toLowerCase()} air quality (${aq.pm25} µg/m³ PM2.5), keep outdoor time brief, watch for coughing or shortness of breath, and follow your clinician’s action plan if anyone has asthma or heart conditions.`;
  }
  if (hasVulnerable) {
    return `Even on moderate days, ${sensitivityPhrase} may experience irritation near heavy traffic. Keep any prescribed rescue medication handy.`;
  }
  if (isSevere) {
    return 'At severe PM2.5 levels, even healthy adults may experience throat irritation or fatigue from prolonged outdoor exertion.';
  }
  return '';
}

function buildSustainableAlternatives(ctx: RuleEvaluationContext): SustainableAlternative[] {
  const { household, aq, isWfh, isCar, isOutdoorCommute, hasPurifier } = ctx;
  const lowCostOrNoPurifier = household.priority === 'Lowest cost' || !hasPurifier;

  return [
    {
      alternative: isWfh
        ? 'Batch deliveries and errands into one midday window'
        : 'Combine errands into one off-peak trip',
      exposureBenefit: 'Cuts repeated curb and intersection PM2.5 exposure during rush hours.',
      emissionsBenefit: 'Avoids extra cold-start engine trips that emit higher winter particulates.',
      tradeoff: 'Requires planning one list ahead instead of making quick spontaneous trips.',
    },
    {
      alternative: isCar || isOutdoorCommute
        ? 'Use public transit or shared travel on high-smog days'
        : 'Stay with shared transit or off-peak routing',
      exposureBenefit: isOutdoorCommute
        ? 'Enclosed metro or rail cabins may reduce direct roadside soot inhalation compared with open two-wheelers or cycling.'
        : 'Reduces time spent idling in congested bumper-to-bumper exhaust plumes.',
      emissionsBenefit: 'Lowers per-person tailpipe emissions across the city corridor.',
      tradeoff: 'May add transfer wait time or modest transit fare compared with solo travel.',
    },
    {
      alternative: isWfh
        ? 'Use electric appliances or pot lids to cut indoor cooking fumes'
        : 'Avoid unnecessary vehicle idling at pick-ups and gates',
      exposureBenefit: isWfh
        ? 'Reduces indoor fine-particle and NO2 spikes when windows stay shut.'
        : 'Prevents exhaust from pooling right outside schools, apartment gates, and sidewalks.',
      emissionsBenefit: isWfh
        ? 'Uses less fuel energy when heating water or food covered.'
        : 'Eliminates wasted fuel burn and stationary fine-particle emissions.',
      tradeoff: isWfh
        ? 'Takes minor kitchen routine adjustments and lid cleanup.'
        : 'Cabin heating or cooling pauses briefly while parked with the engine off.',
    },
    {
      alternative: lowCostOrNoPurifier
        ? 'Coordinate building or school cleaner-air window schedules'
        : `Shift outdoor exercise to ${aq.cleanerWindow}`,
      exposureBenefit: lowCostOrNoPurifier
        ? 'Helps keep shared indoor spaces closed during peak smog and aired out together at midday.'
        : 'May reduce peak PM2.5 exposure compared with stagnant morning or evening hours.',
      emissionsBenefit: lowCostOrNoPurifier
        ? 'Zero equipment or energy footprint compared with extra mechanical cooling.'
        : 'Encourages walking or active routines on neighborhood paths without extra driving.',
      tradeoff: lowCostOrNoPurifier
        ? 'Depends on neighbors or school staff agreeing on shared timing.'
        : 'Midday scheduling can conflict with work or school hours unless flexible.',
    },
  ];
}

/**
 * Generates a personalized, deterministic daily clean-air plan by evaluating
 * eligible rules from {@link PLAN_RULES} against the household profile and
 * air-quality snapshot, ranking them via {@link evaluateCandidateScore}, and
 * returning the top 4–6 steps along with decision-transparency metadata.
 *
 * @param params - Optional household profile and air-quality snapshot.
 * @returns Ranked daily plan, decision signals, tradeoffs, safety caveat, and alternatives.
 */
export function generatePlan(
  params: { household?: unknown; airQuality?: unknown } = {}
): PlanResult {
  const { normalized: safeHousehold } = validateHousehold(params.household);
  const aq = normalizeAirQuality(params.airQuality, safeHousehold.city);
  const ctx = createRuleContext(safeHousehold, aq);

  const scored = PLAN_RULES.filter((rule) => rule.eligible(ctx)).map((rule) => {
    const { totalScore, breakdown } = evaluateCandidateScore(rule, ctx);
    return {
      score: totalScore,
      breakdown,
      step: rule.buildStep(ctx),
    };
  });

  scored.sort((a, b) => b.score - a.score || a.step.id.localeCompare(b.step.id));
  const topScored = scored.slice(0, 6);

  const signals = [
    { label: 'Current pollution severity', value: `${aq.severity} (AQI ${aq.aqi})` },
    { label: 'PM2.5 condition', value: `${aq.pm25} µg/m³ · Wind: ${aq.wind}` },
    {
      label: 'Household sensitivities',
      value: `${safeHousehold.sensitivities.join(', ')} (${safeHousehold.householdSize})`,
    },
    { label: 'Main travel mode', value: `${safeHousehold.travelMode} · ${safeHousehold.outdoorTime}` },
    { label: 'Indoor environment', value: safeHousehold.indoor.join(', ') },
    { label: 'User priority', value: safeHousehold.priority },
  ];

  return {
    household: safeHousehold,
    airQuality: aq,
    recommendations: topScored.map((entry) => entry.step),
    signals,
    prioritySummary: buildPrioritySummary(ctx),
    tradeoffSummary: buildTradeoffSummary(safeHousehold.priority),
    safetyCaveat: buildSafetyCaveat(ctx),
    alternatives: buildSustainableAlternatives(ctx),
    scoringAudit: topScored.map((entry) => ({
      id: entry.step.id,
      totalScore: entry.score,
      breakdown: entry.breakdown,
    })),
  };
}
