/**
 * @fileoverview Declarative weighted scoring table and candidate recommendation rules for ClearAir.
 *
 * Decision scoring is expressed as an explicit weighted-scoring table
 * (`SCORING_WEIGHT_TABLE` and per-rule `factors` arrays of factor -> weight ->
 * contribution) evaluated by {@link evaluateCandidateScore} in `./planEngine.ts`.
 */

import type { CandidateSpec, RuleEvaluationContext, PlanStep } from './planEngine.ts';

/**
 * Auditable weighted-scoring table documenting every factor weight used across
 * the ClearAir decision model (factor -> weight -> scope).
 */
export const SCORING_WEIGHT_TABLE = {
  // Base rule priorities (category starting points)
  OUTDOOR_CHILD_SEVERE_BASE: { factor: 'Child outdoors during severe smog (base)', weight: 112 },
  OUTDOOR_TIMING_SHIFT_BASE: { factor: 'Outdoor timing shift (base)', weight: 94 },
  INDOOR_WINDOWS_TIMING_BASE: { factor: 'Peak-hour window sealing (base)', weight: 92 },
  COMMUTE_OUTDOOR_SHIFT_BASE: { factor: 'Open-air commute shift (base)', weight: 92 },
  MECH_VENT_FILTER_BASE: { factor: 'Mechanical ventilation check (base)', weight: 90 },
  BEDROOM_PURIFIER_BASE: { factor: 'Bedroom purifier protocol (base)', weight: 88 },
  CLEANER_ROOM_NO_COST_BASE: { factor: 'Zero-cost cleaner-air room (base)', weight: 86 },
  COMMUTE_WFH_CONSOLIDATE_BASE: { factor: 'Work-from-home errand batching (base)', weight: 84 },
  COMMUTE_REMOTE_WORK_BASE: { factor: 'Remote work or study option (base)', weight: 84 },
  INDOOR_CHECK_SEALS_BASE: { factor: 'Uncertain window seal check (base)', weight: 84 },
  INDOOR_SEAL_GAPS_BASE: { factor: 'Draft & gap sealing (base)', weight: 83 },
  COMMUTE_CAR_GUIDANCE_BASE: { factor: 'Private car recirculation & no-idling (base)', weight: 82 },
  INDOOR_COMBUSTION_BASE: { factor: 'Indoor combustion source control (base)', weight: 81 },
  COMMUTE_TRANSIT_BASE: { factor: 'Public transit guidance (base)', weight: 80 },
  COMMUTE_ACTIVE_MODERATE_BASE: { factor: 'Moderate-day active commute (base)', weight: 76 },
  COMMUTE_ERRAND_CONSOL_BASE: { factor: 'Errand trip consolidation (base)', weight: 75 },
  OUTDOOR_MODERATE_WINDOW_BASE: { factor: 'Moderate-day outdoor window (base)', weight: 74 },

  // Priority multipliers / adjustments
  PRIORITY_LOWEST_EXPOSURE: { factor: 'User priority: Lowest exposure (outdoor/remote)', weight: 22 },
  PRIORITY_LOWEST_EMISSIONS: { factor: 'User priority: Lowest emissions (commute/errands)', weight: 28 },
  PRIORITY_LOWEST_COST: { factor: 'User priority: Lowest cost (zero-cost steps)', weight: 20 },
  PRIORITY_BALANCED: { factor: 'User priority: Balanced option', weight: 4 },

  // Situational context weights
  SEVERE_SMOG_OUTDOOR_COMMUTE: { factor: 'Severe smog + outdoor/remote/car boost', weight: 8 },
  SEVERE_SMOG_SLIGHT_BOOST: { factor: 'Severe smog + cleaner room / mech vent', weight: 6 },
  VULNERABLE_HOUSEHOLD: { factor: 'Vulnerable household member present', weight: 12 },
  VULNERABLE_PURIFIER_OR_MOD: { factor: 'Vulnerable member + purifier / moderate day', weight: 10 },
  GAS_COOKING_PRESENT: { factor: 'Indoor cooking with gas', weight: 15 },
  RESPIRATORY_INDOOR_SMOKE: { factor: 'Asthma/respiratory sensitivity + indoor sources', weight: 10 },
  LARGE_HOUSEHOLD_EXTRA: { factor: 'Large household (5+ people) scale factor', weight: 6 },
  NON_SMALL_HOUSEHOLD_ERRANDS: { factor: 'Multi-person errand volume (3+ people)', weight: 4 },
  LOW_COST_POWER_PENALTY: { factor: 'De-prioritize powered equipment under Lowest cost', weight: -4 },
} as const;

// Reusable predicates for scoring factors
const isLowestExposure = (c: RuleEvaluationContext) => c.priority === 'Lowest exposure';
const isLowestEmissions = (c: RuleEvaluationContext) => c.priority === 'Lowest emissions';
const isLowestCost = (c: RuleEvaluationContext) => c.priority === 'Lowest cost';
const isBalanced = (c: RuleEvaluationContext) => c.priority === 'Balanced option';

/**
 * Declarative recommendation rules and their explicit weighted scoring tables.
 */
export const PLAN_RULES: readonly CandidateSpec[] = [
  // 1a. Outdoor play for children under severe pollution
  {
    id: 'outdoor-child-severe',
    baseScore: SCORING_WEIGHT_TABLE.OUTDOOR_CHILD_SEVERE_BASE.weight,
    eligible: (c) => c.isSevere && c.hasChild,
    factors: [
      { id: 'priority-exposure', factor: 'Priority: Lowest exposure', weight: 22, applies: isLowestExposure },
      { id: 'priority-balanced', factor: 'Priority: Balanced option', weight: 4, applies: isBalanced },
      { id: 'priority-cost', factor: 'Zero-cost indoor substitution', weight: 8, applies: isLowestCost },
    ],
    buildStep: (c) => ({
      id: 'outdoor-child-severe',
      label: 'Outdoor play & exercise · Skip peak hours',
      action:
        'Keep children indoors for active play today and replace outdoor sports with calm indoor movement.',
      whyItMatters: `${c.aq.city} has severe fine-particle pollution (${c.aq.pm25} µg/m³ PM2.5) with ${c.aq.wind.toLowerCase()} air, and children breathe faster per body weight.`,
      directImpact: 'May reduce peak PM2.5 exposure during stagnant smog hours.',
      tradeoff: 'Requires organizing indoor games or quiet time at home instead of park play.',
      confidence: 'Usually helps lower total daily particle intake.',
    }),
  },

  // 1b. Outdoor timing shift for severe pollution or poor + vulnerable
  {
    id: 'outdoor-timing-shift',
    baseScore: SCORING_WEIGHT_TABLE.OUTDOOR_TIMING_SHIFT_BASE.weight,
    eligible: (c) => !(c.isSevere && c.hasChild) && (c.isSevere || (c.isPoor && c.hasVulnerable)),
    factors: [
      { id: 'priority-exposure', factor: 'Priority: Lowest exposure', weight: 22, applies: isLowestExposure },
      { id: 'priority-balanced', factor: 'Priority: Balanced option', weight: 4, applies: isBalanced },
      { id: 'vulnerable', factor: 'Vulnerable household member', weight: 12, applies: (c) => c.hasVulnerable },
      { id: 'priority-cost', factor: 'Zero-cost schedule shift', weight: 10, applies: isLowestCost },
    ],
    buildStep: (c) => {
      const timingCopy: Record<string, string> = {
        'Early morning':
          'Early morning traps winter smog near street level; pause outdoor workouts today or shift brief errands to midday when air mixes better.',
        Evening:
          'Evening cooling traps rush-hour exhaust close to the ground; move outdoor activity indoors or finish errands before late afternoon.',
      };
      const action = c.canShiftSchedule
        ? `Because your schedule is flexible, move essential outdoor tasks to ${c.aq.cleanerWindow} and keep exertion light.`
        : timingCopy[c.household.outdoorTime] ||
          `Even at midday, ${c.aq.city} is ${c.aq.severity.toLowerCase()}; keep outdoor time brief, avoid main roads, and skip heavy exertion.`;

      const vulnNote =
        c.hasRespiratory || c.hasHeart
          ? ' Cold polluted air can irritate sensitive airways and cardiovascular systems more quickly.'
          : c.hasOlderAdult
            ? ' Older adults face higher risk from fine-particle buildup during stagnant hours.'
            : '';

      return {
        id: 'outdoor-timing-shift',
        label: `Outdoor timing · ${c.household.outdoorTime}`,
        action,
        whyItMatters: `With PM2.5 at ${c.aq.pm25} µg/m³ (${c.aq.severity}) and ${c.aq.wind.toLowerCase()} conditions, ${c.household.outdoorTime.toLowerCase()} routines carry higher particle exposure.${vulnNote}`,
        directImpact: 'May reduce peak PM2.5 exposure compared with exercising in stagnant traffic periods.',
        tradeoff: 'Shifting timing can conflict with school or work schedules and may shorten workouts.',
        confidence: 'A lower-exposure option when practical.',
      };
    },
  },

  // 1c. Outdoor routing on moderate days
  {
    id: 'outdoor-moderate-window',
    baseScore: SCORING_WEIGHT_TABLE.OUTDOOR_MODERATE_WINDOW_BASE.weight,
    eligible: (c) => !c.isSevere && !(c.isPoor && c.hasVulnerable),
    factors: [
      { id: 'priority-cost', factor: 'Zero-cost route/timing shift', weight: 10, applies: isLowestCost },
      { id: 'vulnerable', factor: 'Vulnerable household member', weight: 10, applies: (c) => c.hasVulnerable },
    ],
    buildStep: (c) => {
      let action = `During your ${c.household.outdoorTime.toLowerCase()} routine, choose residential side streets at least a block away from bus and truck lanes.`;
      if (c.canShiftSchedule) {
        action = `Schedule walks or exercise during ${c.aq.cleanerWindow} along tree-lined or residential streets.`;
      } else if (c.household.outdoorTime === 'Midday') {
        action =
          'Your midday outdoor window already avoids rush-hour peaks; stick to parks or side streets away from arterial traffic.';
      }
      return {
        id: 'outdoor-moderate-window',
        label: `Outdoor activity · ${c.household.outdoorTime}`,
        action,
        whyItMatters: `Even on ${c.aq.severity.toLowerCase()} days (${c.aq.pm25} µg/m³ PM2.5), particle levels spike close to idling cars and buses${
          c.hasVulnerable ? ', which matters more for sensitive household members' : ''
        }.`,
        directImpact: 'May reduce roadside fine-particle exposure without giving up daily movement.',
        tradeoff: 'Quieter detour routes can add 5–10 minutes to a walk or run.',
        confidence: 'Usually helps reduce traffic-corridor exposure.',
      };
    },
  },

  // 2a. Work-from-home errand consolidation
  {
    id: 'wfh-consolidate',
    baseScore: SCORING_WEIGHT_TABLE.COMMUTE_WFH_CONSOLIDATE_BASE.weight,
    eligible: (c) => c.isWfh,
    factors: [
      { id: 'priority-emissions', factor: 'Priority: Lowest emissions', weight: 28, applies: isLowestEmissions },
      { id: 'priority-balanced', factor: 'Priority: Balanced option', weight: 4, applies: isBalanced },
      { id: 'priority-cost', factor: 'Zero-cost errand batching', weight: 12, applies: isLowestCost },
    ],
    buildStep: (c) => ({
      id: 'wfh-consolidate',
      label: 'Daily errands · Work-from-home day',
      action: c.isLargeHousehold
        ? `Keep ${c.household.householdSize} off peak roads by batching groceries, school pick-ups, and errands into one midday loop.`
        : 'Stay off peak roads by batching groceries or pharmacy errands into a single midday trip or consolidated delivery.',
      whyItMatters: `Working from home already eliminates commute emissions; batching errands keeps your household out of ${c.aq.peakSmogWindows} traffic.`,
      directImpact: 'Reduces unnecessary vehicle emissions and avoids peak roadside PM2.5.',
      tradeoff: 'Requires planning errands ahead rather than making quick separate trips.',
      confidence: 'Usually helps keep both emissions and exposure lower.',
    }),
  },

  // 2b. Open-air commute shift during poor/severe smog
  {
    id: 'commute-outdoor-shift',
    baseScore: SCORING_WEIGHT_TABLE.COMMUTE_OUTDOOR_SHIFT_BASE.weight,
    eligible: (c) => !c.isWfh && c.isOutdoorCommute && (c.isSevere || c.isPoor),
    factors: [
      { id: 'priority-emissions', factor: 'Priority: Lowest emissions', weight: 26, applies: isLowestEmissions },
      { id: 'priority-exposure', factor: 'Priority: Lowest exposure', weight: 16, applies: isLowestExposure },
      { id: 'severe', factor: 'Severe air quality', weight: 8, applies: (c) => c.isSevere },
    ],
    buildStep: (c) => {
      const modeLower = c.household.travelMode.toLowerCase();
      let action = `Consider enclosed public transit or a shared ride instead of an open ${modeLower} commute during ${c.aq.city}’s ${c.aq.severity.toLowerCase()} smog.`;
      if (isLowestEmissions(c)) {
        action = `When practical, switch today’s ${modeLower} commute to enclosed public transit or shared travel, or shift timing outside rush hours.`;
      } else if (isLowestCost(c)) {
        action = `If switching from ${modeLower} to transit is not in the budget today, leave outside ${c.aq.peakSmogWindows} and take quieter side streets away from heavy buses.`;
      }

      return {
        id: 'commute-outdoor-shift',
        label: `Daily travel · ${c.household.travelMode}`,
        action,
        whyItMatters: `Open ${modeLower} commutes expose travelers directly to tailpipe exhaust while ${c.aq.city} sits at ${c.aq.aqi} AQI (${c.aq.severity}).`,
        directImpact:
          'May reduce direct roadside PM2.5 inhalation while keeping per-person transport emissions low.',
        tradeoff: isLowestCost(c)
          ? 'Side-street timing adds travel minutes, while transit trades zero fare for lower smog inhalation.'
          : 'Public transit or shared rides can take longer door-to-door and add modest fare cost compared with walking or cycling.',
        confidence: 'A lower-exposure and lower-emission option when practical.',
      };
    },
  },

  // 2c. Private car guidance
  {
    id: 'commute-car-guidance',
    baseScore: SCORING_WEIGHT_TABLE.COMMUTE_CAR_GUIDANCE_BASE.weight,
    eligible: (c) => !c.isWfh && c.isCar,
    factors: [
      { id: 'priority-emissions', factor: 'Priority: Lowest emissions', weight: 28, applies: isLowestEmissions },
      { id: 'priority-balanced', factor: 'Priority: Balanced option', weight: 4, applies: isBalanced },
      { id: 'severe', factor: 'Severe air quality', weight: 8, applies: (c) => c.isSevere },
      {
        id: 'large-emissions',
        factor: 'Large household carpool potential',
        weight: 6,
        applies: (c) => c.isLargeHousehold && isLowestEmissions(c),
      },
    ],
    buildStep: (c) => ({
      id: 'commute-car-guidance',
      label: 'Daily travel · Private car',
      action: isLowestEmissions(c)
        ? c.isLargeHousehold
          ? 'Shift solo trips to public transit, combine school/work drop-offs into one shared carpool, and switch off your engine whenever parked over 30 seconds.'
          : 'Use public transit, carpool, or combine trips to cut solo car miles, and shut off your engine whenever parked over 30 seconds.'
        : 'Set cabin ventilation to recirculate in heavy traffic, avoid engine idling, and replace solo errands with shared or public transit when practical.',
      whyItMatters:
        'Cold winter engines and idling in congestion add fine particles and nitrogen oxides directly into neighborhood air.',
      directImpact:
        'Reduces unnecessary vehicle emissions and helps limit polluted roadside air entering the cabin.',
      tradeoff:
        'Recirculation can feel stuffy on long drives (briefly refresh air on open roads), and transit or carpooling takes more coordination.',
      confidence: 'Usually helps lower both local exhaust and cabin buildup.',
    }),
  },

  // 2d. Public transit guidance
  {
    id: 'commute-transit-guidance',
    baseScore: SCORING_WEIGHT_TABLE.COMMUTE_TRANSIT_BASE.weight,
    eligible: (c) => !c.isWfh && c.isTransit,
    factors: [
      { id: 'priority-emissions', factor: 'Priority: Lowest emissions', weight: 28, applies: isLowestEmissions },
      { id: 'priority-balanced', factor: 'Priority: Balanced option', weight: 4, applies: isBalanced },
    ],
    buildStep: (c) => ({
      id: 'commute-transit-guidance',
      label: 'Daily travel · Public transit',
      action:
        c.isSevere || c.isPoor
          ? 'Keep using public transit, wait a few steps back from bus tailpipes at stops, and choose enclosed rail/metro over open roadside waiting when available.'
          : 'Keep using public transit for main trips, and stand clear of idling curb exhaust lanes while waiting.',
      whyItMatters:
        'Public transit moves more people with lower per-person emissions than private cars or two-wheelers.',
      directImpact: 'Reduces per-person transport emissions and avoids heavy exertion in street smog.',
      tradeoff: 'Station platforms and crowded buses may still have elevated particle levels at rush hour.',
      confidence: 'A practical low-emission option for urban commutes.',
    }),
  },

  // 2e. Moderate-day active commute (walk, cycle, two-wheeler)
  {
    id: 'commute-active-moderate',
    baseScore: SCORING_WEIGHT_TABLE.COMMUTE_ACTIVE_MODERATE_BASE.weight,
    eligible: (c) => !c.isWfh && !c.isCar && !c.isTransit && c.isModerate,
    factors: [
      { id: 'priority-emissions', factor: 'Priority: Lowest emissions', weight: 28, applies: isLowestEmissions },
      { id: 'priority-balanced', factor: 'Priority: Balanced option', weight: 4, applies: isBalanced },
      { id: 'priority-cost', factor: 'Zero-cost active commute', weight: 8, applies: isLowestCost },
    ],
    buildStep: (c) => ({
      id: 'commute-active-moderate',
      label: `Daily travel · ${c.household.travelMode}`,
      action:
        'Continue low-emission travel along quieter back streets, and keep a steady pace rather than riding right behind diesel buses or trucks.',
      whyItMatters:
        'Heavy breathing directly behind tailpipes pulls concentrated exhaust deeper into airways even on moderate days.',
      directImpact: 'Keeps daily travel low-emission while moderating roadside particle intake.',
      tradeoff: 'Side-street detours or a gentler pace can add 5–10 minutes to commute time.',
      confidence: 'Usually helps balance low emissions with lower exposure.',
    }),
  },

  // 2f. Remote work or study flexibility
  {
    id: 'remote-work-study',
    baseScore: SCORING_WEIGHT_TABLE.COMMUTE_REMOTE_WORK_BASE.weight,
    eligible: (c) => !c.isWfh && (c.isSevere || (c.isPoor && c.hasVulnerable)) && !isLowestCost(c),
    factors: [
      { id: 'severe', factor: 'Severe air quality', weight: 8, applies: (c) => c.isSevere },
      { id: 'priority-exposure', factor: 'Priority: Lowest exposure', weight: 20, applies: isLowestExposure },
      { id: 'priority-emissions', factor: 'Priority: Lowest emissions', weight: 12, applies: isLowestEmissions },
    ],
    buildStep: (c) => ({
      id: 'remote-work-study',
      label: 'Schedule flexibility · Remote work or study',
      action:
        'When your workplace or school allows, work or study remotely today to skip peak-smog commuting altogether.',
      whyItMatters: `Skipping one commute day in ${c.aq.city} (${c.aq.aqi} AQI) eliminates both roadside exposure and daily commute emissions.`,
      directImpact: 'May substantially reduce daily peak PM2.5 inhalation and avoids commute emissions.',
      tradeoff: 'Not realistic for in-person roles, school labs, or households without remote options.',
      confidence: 'A high-impact lower-exposure option when practical.',
    }),
  },

  // 2g. Errand consolidation for non-WFH households
  {
    id: 'errand-consolidation',
    baseScore: SCORING_WEIGHT_TABLE.COMMUTE_ERRAND_CONSOL_BASE.weight,
    eligible: (c) => !c.isWfh,
    factors: [
      { id: 'priority-emissions', factor: 'Priority: Lowest emissions', weight: 28, applies: isLowestEmissions },
      { id: 'priority-balanced', factor: 'Priority: Balanced option', weight: 4, applies: isBalanced },
      { id: 'priority-cost', factor: 'Zero-cost fuel saving', weight: 10, applies: isLowestCost },
      { id: 'multi-person', factor: 'Multi-person household errand load', weight: 4, applies: (c) => !c.isSmallHousehold },
    ],
    buildStep: () => ({
      id: 'errand-consolidation',
      label: 'Afternoon · Errands & cold starts',
      action:
        'Consolidate shopping, pharmacy, and pick-up errands into one planned trip rather than multiple short cold-start drives.',
      whyItMatters:
        'Short cold-start engine trips produce disproportionately high tailpipe emissions and put people near curb traffic repeatedly.',
      directImpact: 'Reduces unnecessary vehicle emissions and cuts total time spent near traffic.',
      tradeoff: 'Takes a bit of advance list-making so small items wait for one combined run.',
      confidence: 'Usually helps reduce both fuel use and neighborhood emissions.',
    }),
  },

  // 3a. Window timing when windows close
  {
    id: 'indoor-windows-timing',
    baseScore: SCORING_WEIGHT_TABLE.INDOOR_WINDOWS_TIMING_BASE.weight,
    eligible: (c) => c.windowsCanClose,
    factors: [
      { id: 'priority-cost', factor: 'Priority: Lowest cost', weight: 20, applies: isLowestCost },
      { id: 'priority-exposure', factor: 'Priority: Lowest exposure', weight: 14, applies: isLowestExposure },
      { id: 'severe', factor: 'Severe air quality', weight: 8, applies: (c) => c.isSevere },
    ],
    buildStep: (c) => ({
      id: 'indoor-windows-timing',
      label: 'Indoor air · Window timing',
      action: c.isModerate
        ? `Keep street-facing windows shut during ${c.aq.peakSmogWindows}, and air out rooms for 15–20 minutes during ${c.aq.cleanerWindow}.`
        : `Keep windows and exterior doors closed during ${c.aq.peakSmogWindows}, and air out rooms briefly for 10–15 minutes only if midday air looks clearer.`,
      whyItMatters: `At ${c.aq.pm25} µg/m³ PM2.5 outdoors, leaving windows open during calm hours lets fine soot drift steadily indoors.`,
      directImpact:
        'Helps prevent polluted outdoor air from entering the room during the worst period.',
      tradeoff:
        'Indoor air can feel warm or stale when sealed, so brief cross-ventilation during cleaner midday hours is helpful.',
      confidence: 'Usually helps reduce indoor particle spikes at zero cost.',
    }),
  },

  // 3b. Uncertain indoor seals
  {
    id: 'indoor-check-seals',
    baseScore: SCORING_WEIGHT_TABLE.INDOOR_CHECK_SEALS_BASE.weight,
    eligible: (c) => !c.windowsCanClose && c.indoorNotSure,
    factors: [
      { id: 'priority-cost', factor: 'Priority: Lowest cost', weight: 20, applies: isLowestCost },
      { id: 'priority-exposure', factor: 'Priority: Lowest exposure', weight: 10, applies: isLowestExposure },
    ],
    buildStep: () => ({
      id: 'indoor-check-seals',
      label: 'Indoor air · Check seals & airflow',
      action:
        'Check which room closes most tightly against outdoor drafts and use rolled towels along loose sills during peak smog hours.',
      whyItMatters:
        'When indoor sealing is uncertain, identifying one tighter interior room helps keep winter soot out during calm inversions.',
      directImpact: 'May reduce outdoor fine particles drifting into your main living space without cost.',
      tradeoff: 'Requires quick room checks and simple draft blocking rather than automated filtration.',
      confidence: 'Consider when practical as a zero-cost first step.',
    }),
  },

  // 3c. Leaky / non-closing windows draft control
  {
    id: 'indoor-seal-gaps',
    baseScore: SCORING_WEIGHT_TABLE.INDOOR_SEAL_GAPS_BASE.weight,
    eligible: (c) => !c.windowsCanClose && !c.indoorNotSure,
    factors: [
      { id: 'priority-cost', factor: 'Priority: Lowest cost', weight: 20, applies: isLowestCost },
      { id: 'priority-exposure', factor: 'Priority: Lowest exposure', weight: 10, applies: isLowestExposure },
    ],
    buildStep: () => ({
      id: 'indoor-seal-gaps',
      label: 'Indoor air · Draft & zone control',
      action:
        'Use rolled towels or temporary weatherstripping on leaky window gaps in the room where your household spends the most time.',
      whyItMatters:
        'When windows do not seal tightly, winter smog seeps in continuously during calm inversions.',
      directImpact: 'May reduce outdoor fine particles drifting into your main living space.',
      tradeoff: 'Requires simple household setup and does not replace mechanical filtration.',
      confidence: 'Consider when practical as a low-cost barrier.',
    }),
  },

  // 4a. Bedroom air purifier guidance
  {
    id: 'bedroom-purifier',
    baseScore: SCORING_WEIGHT_TABLE.BEDROOM_PURIFIER_BASE.weight,
    eligible: (c) => c.hasPurifier,
    factors: [
      { id: 'vulnerable', factor: 'Vulnerable household member', weight: 10, applies: (c) => c.hasVulnerable },
      { id: 'priority-exposure', factor: 'Priority: Lowest exposure', weight: 18, applies: isLowestExposure },
      { id: 'priority-cost-penalty', factor: 'Electricity-saving speed preference', weight: -4, applies: isLowestCost },
    ],
    buildStep: (c) => {
      const targetRoom = c.hasVulnerable
        ? `the closed bedroom used by ${c.sensitivityPhrase}`
        : 'your main closed bedroom';
      return {
        id: 'bedroom-purifier',
        label: 'Evening & sleep · Bedroom air',
        action: isLowestCost(c)
          ? `Close the door to ${targetRoom} and run your existing purifier on a low, energy-saving steady speed overnight rather than full blast all day.`
          : `Close the door to ${targetRoom} and run your HEPA air purifier on medium-high 45 minutes before bedtime, then keep it on a quiet steady speed overnight.`,
        whyItMatters:
          'Households spend 7–9 hours asleep; lowering particles in one closed bedroom gives lungs a long recovery break.',
        directImpact: 'May improve bedroom air quality before sleep.',
        tradeoff: 'Uses modest electricity and gentle fan noise overnight.',
        confidence: 'Usually helps lower indoor PM2.5 in closed rooms.',
      };
    },
  },

  // 4b. Zero-cost cleaner-air room when no purifier is available
  {
    id: 'cleaner-room-no-cost',
    baseScore: SCORING_WEIGHT_TABLE.CLEANER_ROOM_NO_COST_BASE.weight,
    eligible: (c) => !c.hasPurifier,
    factors: [
      { id: 'vulnerable', factor: 'Vulnerable household member', weight: 12, applies: (c) => c.hasVulnerable },
      { id: 'priority-cost', factor: 'Zero-cost habit', weight: 20, applies: isLowestCost },
      { id: 'severe', factor: 'Severe air quality', weight: 6, applies: (c) => c.isSevere },
    ],
    buildStep: (c) => ({
      id: 'cleaner-room-no-cost',
      label: 'Indoor sanctuary · Cleaner-air room',
      action: c.isLargeHousehold
        ? 'Designate one quiet interior bedroom for sensitive family members or sleepers: keep its door and windows shut during peak smog, damp-dust surfaces, and keep cooking smoke out.'
        : 'Designate one quiet interior bedroom as a cleaner-air room: keep its door and windows shut during peak smog, damp-dust surfaces, and skip indoor smoke sources.',
      whyItMatters:
        'Even without an air purifier, keeping one low-traffic room closed and free of indoor smoke keeps particle buildup noticeably lower—without buying new gear.',
      directImpact:
        'May reduce overnight exposure for sensitive family members using zero-cost habits.',
      tradeoff:
        'Requires coordinating household routines in one shared room and periodic damp cleaning.',
      confidence: 'A practical, zero-cost way that may reduce indoor exposure.',
    }),
  },

  // 5. Indoor combustion control
  {
    id: 'indoor-combustion-control',
    baseScore: SCORING_WEIGHT_TABLE.INDOOR_COMBUSTION_BASE.weight,
    eligible: () => true,
    factors: [
      { id: 'gas-cooking', factor: 'Cooking with gas', weight: 15, applies: (c) => c.cookingWithGas },
      { id: 'priority-cost', factor: 'Zero-cost source reduction', weight: 20, applies: isLowestCost },
      { id: 'respiratory', factor: 'Respiratory sensitivity', weight: 10, applies: (c) => c.hasRespiratory },
      {
        id: 'large-gas',
        factor: 'Large household cooking volume',
        weight: 6,
        applies: (c) => c.isLargeHousehold && c.cookingWithGas,
      },
    ],
    buildStep: (c) => ({
      id: 'indoor-combustion-control',
      label: 'Home routines · Indoor sources',
      action: c.cookingWithGas
        ? 'Use the kitchen exhaust fan (or crack a kitchen window briefly with the kitchen door shut while cooking), cover pots with lids, and avoid incense or candles.'
        : 'Avoid burning incense, candles, mosquito coils, or indoor smoke today, and damp-mop dust instead of dry sweeping.',
      whyItMatters: c.cookingWithGas
        ? 'Gas burners and frying release extra fine particles and nitrogen dioxide that linger longer when windows stay closed for smog.'
        : 'When outdoor smog keeps windows shut, even small indoor combustion sources build up quickly inside the home.',
      directImpact: 'Reduces avoidable indoor fine-particle and gas spikes.',
      tradeoff: 'Skip traditional scented candles or incense and take an extra minute to vent cooking steam.',
      confidence: 'Usually helps keep indoor air cleaner without extra cost.',
    }),
  },

  // 6. Mechanical ventilation filter check
  {
    id: 'mech-vent-filter',
    baseScore: SCORING_WEIGHT_TABLE.MECH_VENT_FILTER_BASE.weight,
    eligible: (c) => c.hasMechVent,
    factors: [
      { id: 'severe', factor: 'Severe air quality', weight: 6, applies: (c) => c.isSevere },
      { id: 'priority-exposure', factor: 'Priority: Lowest exposure', weight: 12, applies: isLowestExposure },
      { id: 'priority-cost-penalty', factor: 'Filter upgrade cost caution', weight: -4, applies: isLowestCost },
    ],
    buildStep: (c) => ({
      id: 'mech-vent-filter',
      label: 'Building airflow · Mechanical ventilation',
      action: isLowestCost(c)
        ? 'Check if your building’s mechanical ventilation already uses clean filters before opening windows, and pause unfiltered outdoor intake during peak smog.'
        : 'Confirm your mechanical ventilation uses clean pleated filters (such as MERV-13 if supported) and avoid pulling unfiltered outdoor air during peak smog hours.',
      whyItMatters:
        'Unfiltered mechanical intake can pull outdoor PM2.5 indoors, whereas well-filtered systems supply fresh air without opening windows.',
      directImpact: 'May reduce outdoor particle entry while maintaining fresh indoor airflow.',
      tradeoff: 'Filter checks or upgrades depend on building access and system compatibility.',
      confidence: 'Consider when practical depending on building controls.',
    }),
  },
];

