# ClearAir

**Challenge vertical:** Urban Air Quality Assistant (Virtual PromptWars · Challenge 6)  
**Tagline:** Make the next clean-air choice.

ClearAir is a calm, compact public-service web application that helps families and households navigate severe winter smog and urban air pollution. It turns illustrative local air-quality conditions and household context into practical daily routines, indoor air improvements, and lower-emission alternatives.

## User Problem

Winter temperature inversions and stagnant traffic trap fine particulate matter (`PM2.5` and `PM10`) at street level. Generic air-quality alerts rarely answer practical household questions—such as whether a child should play outside, when to keep windows closed, how to adjust a two-wheeler or car commute, or what to do without owning an air purifier.

## Main User Flow

1. **Inspect current air-quality context:** Choose a demo city (`Delhi`, `Mumbai`, `Bengaluru`, `London`, or `New York`) to review illustrative AQI, `PM2.5`, `PM10`, temperature, wind, severity label, and a plain-language interpretation.
2. **Enter household context:** Specify household size, sensitivities (children, older adults, asthma/respiratory, cardiovascular), main daily travel, typical outdoor timing, indoor environment, and main priority (`Lowest exposure`, `Lowest emissions`, `Lowest cost`, or `Balanced option`).
3. **Review personalized daily plan:** Generates 4–6 prioritized steps, each explaining the action, why it matters, its direct impact, practical tradeoffs, and hedged confidence language.
4. **Verify decision transparency:** The **Why this plan?** section shows every signal used, why the priority was chosen, and key exposure vs. emission tradeoffs.
5. **Ask ClearAir (Demo reasoning mode):** Ask quick or custom questions about outdoor play, window timing, commuting, or bedroom air using deterministic local reasoning.
6. **Explore sustainable alternatives & safety note:** Review lower-emission shifts and clear educational/medical safety boundaries.

## Recommendation Logic

The decision engine lives in `generatePlan({ household, airQuality })` in `src/planEngine.ts` (re-exported via `app.js`). It evaluates pollution severity, `PM2.5`, household sensitivities, schedule flexibility, travel mode, indoor capabilities, and user priority against an explicit weighted-scoring table (`PLAN_RULES` + `SCORING_WEIGHT_TABLE`) to score and rank 4–6 actions:

- **Severe pollution + child:** Prioritizes indoor play, cleaner-air room setup, and stronger safety caveats.
- **Poor/severe pollution + outdoor commute:** Suggests enclosed public transit or off-peak timing with honest fare/time tradeoffs.
- **Lowest-emission priority:** Elevates transit, carpooling, consolidated errands, and zero-idling while noting when low-emission active travel increases personal smog exposure.
- **Lowest-cost priority:** Focuses on free schedule shifts, window timing, and eliminating indoor smoke before recommending any purchases.
- **No purifier + windows can close:** Recommends peak-hour sealing, brief midday airing, and one low-traffic cleaner-air bedroom.

## Scoring Model

Each eligible rule starts from its category base score and adds matching factor weights from `SCORING_WEIGHT_TABLE` (`factor → weight → contribution`), evaluated deterministically by `evaluateCandidateScore()`:

| Factor | Weight | Effect |
| --- | ---: | --- |
| Child outdoors in severe smog (base) | `112` | Surfaces indoor play and cleaner-room steps first |
| Outdoor timing / window sealing / open commute (base) | `92–94` | Elevates peak-smog avoidance and roadside protection |
| Mechanical ventilation / bedroom purifier / cleaner room (base) | `86–90` | Prioritizes bedroom and building-airflow protection |
| Work-from-home / remote study / car / transit / indoor sources (base) | `80–84` | Ranks daily travel and indoor-combustion habits |
| Errand consolidation / moderate outdoor window (base) | `74–76` | Includes practical trip-batching and off-arterial options |
| Priority: `Lowest emissions` | `+12` to `+28` | Boosts transit/carpool/errands (`+28`), open-commute shift (`+26`), and remote work (`+12`) |
| Priority: `Lowest exposure` | `+10` to `+22` | Boosts outdoor/child/timing (`+22`), remote work (`+20`), purifier (`+18`), sealing (`+10` to `+14`), and mech vent (`+12`) |
| Priority: `Lowest cost` | `+8` to `+20` | Boosts zero-cost habits (`+20` indoor/cleaner room, `+12` WFH, `+10` timing/errands, `+8` child/moderate commute; `-4` powered purifier/filter upgrade) |
| Priority: `Balanced option` | `+4` | Balances moderate exposure and emissions boosts across core rules |
| Gas cooking / respiratory sensitivity | `+15` / `+10` | Elevates kitchen exhaust and smoke elimination |
| Vulnerable household member | `+10` to `+12` | Raises protection (`+12` outdoor timing / cleaner room, `+10` purifier / moderate day) |
| Severe smog | `+6` to `+8` | Scales urgency (`+8` open commute / car / remote work / window timing, `+6` cleaner room / mech vent) |
| Multi-person / large household (`3+` / `5+ people`) | `+4` / `+6` | Scales errand consolidation (`+4` for `3+`) and large-home carpool/gas cooking (`+6` for `5+`) |

## How Location Demo Data Works

`DEMO_LOCATIONS` in `app.js` holds illustrative winter-smog profiles for five cities (`Delhi`, `Mumbai`, `Bengaluru`, `London`, `New York`). `getAirQualityForCity(city)` returns the selected city profile or falls back cleanly to clearly labeled illustrative demo data if a city is missing or unavailable. Values are explicitly labeled **Demo data** and are never presented as live readings.

## Why No Database & Why Demo Reasoning Mode

- **No database:** Avoiding a backend database keeps personal household details (sensitivities, routines, location) strictly in transient browser memory for the current session—eliminating storage risk and sign-in friction.
- **Demo reasoning mode:** `answerQuestion({ question, household, airQuality })` provides fast, explainable, deterministic responses without exposing API keys in browser code or inventing live AI connections.

## Integrating Live AQI or AI Safely Later

To connect a live AQI API or Gemini model later without breaking security rules:

1. Add a lightweight server-side proxy endpoint (e.g., `/api/aqi` and `/api/ask`) that holds `GEMINI_API_KEY` and AQI provider keys strictly in server environment variables.
2. Validate and bound client payloads server-side, pass only anonymized city + non-identifying household tags, and return structured educational guidance with ClearAir's medical disclaimer.
3. Fall back gracefully to `getAirQualityForCity` and `answerQuestion` when offline or unconfigured.

## Security, Privacy & Accessibility Decisions

- **Privacy:** Collects no names, emails, exact street addresses, or medical records; stores state only in JavaScript memory during the session.
- **XSS & input safety:** All user text is length-bounded (`300` characters max), sanitized, and rendered strictly via `textContent` / safe DOM APIs (zero `innerHTML` or `eval`).
- **Accessibility:** Semantic `<header>`, `<main>`, `<section>`, `<form>`, `<fieldset>`/`<legend>`, and `<footer>`; single `<h1>` with logical `<h2>`/`<h3>` hierarchy; visible `:focus-visible` outlines; 44px+ touch targets; `aria-live="polite"` announcements; `prefers-reduced-motion` support; and status communicated via text and symbol alongside color.

## Testing & Running Locally

Run the unit test suite with Node.js (tested on Node 22):

```bash
npm test
# or directly:
node test.js
```

To build or serve the static site locally:

```bash
npm run build
npx serve .
```

## Assumptions & Known Limitations

- Air-quality values are illustrative demo profiles rather than real-time sensor feeds.
- Demo reasoning mode recognizes household air-quality topics via deterministic keyword matching and returns an honest fallback for medical or unrelated questions.

## Repository Rules

- Public GitHub repository
- `main` branch only
- Repository size kept well below 10 MB
