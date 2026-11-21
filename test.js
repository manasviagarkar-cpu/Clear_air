import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEMO_LOCATIONS,
  DEFAULT_HOUSEHOLD,
  getAirQualityForCity,
  validateHousehold,
  generatePlan,
  answerQuestion,
  debounce,
} from './app.js';

let passed = 0;

function runTest(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

runTest('1. Severe pollution plus a child produces cautious outdoor advice and cleaner room', () => {
  const plan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'Delhi',
      sensitivities: ['Child under 12'],
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  assert.ok(plan.recommendations.length >= 4 && plan.recommendations.length <= 6);
  const outdoorRec = plan.recommendations.find((r) => r.id === 'outdoor-child-severe');
  assert.ok(outdoorRec, 'Expected child-specific severe outdoor recommendation');
  assert.match(outdoorRec.action, /indoors/i);
  assert.ok(
    plan.recommendations.some((r) => /cleaner-air room|purifier/i.test(r.action)),
    'Expected cleaner indoor room or bedroom purifier guidance'
  );
  assert.ok(plan.safetyCaveat.length > 0, 'Expected stronger safety caveat');
});

runTest('2. Outdoor commute plus poor air quality produces a transport alternative', () => {
  const plan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'Mumbai',
      sensitivities: ['None of these'],
      travelMode: 'Two-wheeler',
    },
    airQuality: DEMO_LOCATIONS.Mumbai,
  });

  const commuteRec = plan.recommendations.find((r) => r.id === 'commute-outdoor-shift');
  assert.ok(commuteRec, 'Expected outdoor commute transport alternative');
  assert.match(commuteRec.action, /public transit/i);
  assert.match(commuteRec.directImpact, /PM2\.5|emissions/i);
  assert.match(commuteRec.tradeoff, /longer|fare|time/i);
});

runTest('3. Windows-can-close without purifier produces indoor air and window timing advice', () => {
  const plan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      indoor: ['Windows can be closed'],
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  const windowRec = plan.recommendations.find((r) => r.id === 'indoor-windows-timing');
  assert.ok(windowRec, 'Expected window-closing timing recommendation');
  assert.match(windowRec.action, /windows/i);
  assert.match(windowRec.directImpact, /prevent polluted outdoor air/i);
  assert.ok(
    plan.recommendations.some((r) => r.id === 'cleaner-room-no-cost'),
    'Expected cleaner-air room recommendation when no purifier is present'
  );
});

runTest('4. Lowest-emission priority changes recommendation ranking and notes exposure tradeoff', () => {
  const exposurePlan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'Mumbai',
      travelMode: 'Private car',
      priority: 'Lowest exposure',
    },
    airQuality: DEMO_LOCATIONS.Mumbai,
  });

  const emissionPlan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'Mumbai',
      travelMode: 'Private car',
      priority: 'Lowest emissions',
    },
    airQuality: DEMO_LOCATIONS.Mumbai,
  });

  assert.notDeepEqual(
    exposurePlan.recommendations.map((r) => r.id),
    emissionPlan.recommendations.map((r) => r.id),
    'Recommendation order should differ by priority'
  );
  assert.equal(emissionPlan.recommendations[0].id, 'commute-car-guidance');
  assert.match(emissionPlan.tradeoffSummary, /not always be the lowest-exposure option/i);
});

runTest('5. Lowest-cost priority avoids unnecessary product purchases', () => {
  const plan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      indoor: ['Windows can be closed'],
      priority: 'Lowest cost',
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  const combinedText = plan.recommendations.map((r) => `${r.action} ${r.whyItMatters}`).join(' ');
  assert.doesNotMatch(combinedText, /buy a purifier|purchase an air purifier|shop for/i);
  assert.match(plan.prioritySummary, /before suggesting any purchases/i);
  assert.match(combinedText, /without buying new gear|zero-cost/i);
});

runTest('6. Vulnerable household members trigger a safety caveat even on moderate days', () => {
  const plan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'New York',
      sensitivities: ['Asthma or respiratory sensitivity'],
    },
    airQuality: DEMO_LOCATIONS['New York'],
  });

  assert.ok(plan.safetyCaveat.length > 0, 'Expected safety caveat for respiratory sensitivity');
  assert.match(plan.safetyCaveat, /medication|caution|irritation/i);
});

runTest('7. Assistant answers an outdoor-activity question using current context', () => {
  const res = answerQuestion({
    question: 'Can my child play outside today?',
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'Delhi',
      sensitivities: ['Child under 12'],
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  assert.equal(res.valid, true);
  assert.equal(res.inScope, true);
  assert.match(res.directAnswer, /Delhi/i);
  assert.match(res.directAnswer, /indoor play/i);
  assert.match(res.reasoning, /168 µg\/m³|286/);
  assert.ok(res.nextStep.length > 0);
  assert.ok(res.safetyCaveat.length > 0);
});

runTest('8. Assistant answers a window or ventilation question using current context', () => {
  const res = answerQuestion({
    question: 'Should I open the windows?',
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'Mumbai',
      indoor: ['Windows can be closed'],
    },
    airQuality: DEMO_LOCATIONS.Mumbai,
  });

  assert.equal(res.valid, true);
  assert.equal(res.inScope, true);
  assert.match(res.directAnswer, /windows closed/i);
  assert.match(res.reasoning, /Mumbai/i);
  assert.match(res.nextStep, /10–15 minutes|cross-breeze/i);
});

runTest('9. Unknown or medical questions receive a safe honest fallback', () => {
  const unknown = answerQuestion({
    question: 'What stock will rise tomorrow?',
    household: DEFAULT_HOUSEHOLD,
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  assert.equal(unknown.valid, true);
  assert.equal(unknown.inScope, false);
  assert.match(
    unknown.directAnswer,
    /I can help with household routines, outdoor timing, transport choices, and indoor air practices/i
  );

  const medical = answerQuestion({
    question: 'What inhaler dosage should I give during an asthma attack?',
    household: DEFAULT_HOUSEHOLD,
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  assert.equal(medical.valid, true);
  assert.equal(medical.inScope, false);
  assert.match(medical.directAnswer, /qualified healthcare professional/i);
});

runTest('10. Invalid or empty input is handled safely', () => {
  const emptyQ = answerQuestion({
    question: '   ',
    household: DEFAULT_HOUSEHOLD,
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.equal(emptyQ.valid, false);
  assert.ok(emptyQ.error.length > 0);

  const tooLongQ = answerQuestion({
    question: 'a'.repeat(350),
    household: DEFAULT_HOUSEHOLD,
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.equal(tooLongQ.valid, false);

  const badHousehold = validateHousehold({
    city: 'Mars',
    householdSize: '',
    sensitivities: [],
    travelMode: 'Jetpack',
    outdoorTime: null,
    indoor: [],
    priority: 'Invalid',
  });
  assert.equal(badHousehold.valid, false);
  assert.ok(Object.keys(badHousehold.errors).length >= 5);

  const safePlan = generatePlan({ household: null, airQuality: null });
  assert.ok(safePlan.recommendations.length >= 4 && safePlan.recommendations.length <= 6);
});

runTest('11. User-entered text is never inserted as unsafe HTML', () => {
  const xssPayload = '<img src=x onerror="alert(1)"> windows?';
  const res = answerQuestion({
    question: xssPayload,
    household: DEFAULT_HOUSEHOLD,
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  assert.equal(res.valid, true);
  assert.equal(res.question, xssPayload);

  const appSource = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.equal(appSource.includes('innerHTML'), false, 'app.js must not use innerHTML');
  assert.equal(appSource.includes('eval('), false, 'app.js must not use eval(');
});

runTest('12. Demo fallback data works when external or unknown city data is requested', () => {
  const fallback = getAirQualityForCity('Unknown Metropolis');
  assert.equal(fallback.isDemo, true);
  assert.equal(fallback.isFallback, true);
  assert.ok(Number.isFinite(fallback.aqi) && fallback.aqi > 0);
  assert.ok(Number.isFinite(fallback.pm25) && fallback.pm25 > 0);
  assert.match(fallback.interpretation, /fallback demo data/i);
});

runTest('13. Every recommendation explains direct impact and avoids medical promises', () => {
  for (const city of Object.keys(DEMO_LOCATIONS)) {
    const plan = generatePlan({
      household: { ...DEFAULT_HOUSEHOLD, city, travelMode: 'Work from home' },
      airQuality: DEMO_LOCATIONS[city],
    });
    assert.ok(plan.recommendations.length >= 4 && plan.recommendations.length <= 6);
    for (const rec of plan.recommendations) {
      assert.ok(rec.directImpact && rec.directImpact.length > 10);
      assert.ok(rec.tradeoff && rec.tradeoff.length > 10);
      const text = `${rec.action} ${rec.whyItMatters} ${rec.directImpact} ${rec.confidence}`;
      assert.doesNotMatch(
        text,
        /will prevent illness|guarantees safety|cures asthma|eliminates pollution/i
      );
    }
  }
});

runTest('14. Severe vs Moderate pollution produces visibly different recommendations', () => {
  const baseHousehold = {
    ...DEFAULT_HOUSEHOLD,
    sensitivities: ['None of these'],
    travelMode: 'Cycle',
  };
  const delhiPlan = generatePlan({
    household: { ...baseHousehold, city: 'Delhi' },
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  const nyPlan = generatePlan({
    household: { ...baseHousehold, city: 'New York' },
    airQuality: DEMO_LOCATIONS['New York'],
  });

  assert.notDeepEqual(
    delhiPlan.recommendations.map((r) => r.id),
    nyPlan.recommendations.map((r) => r.id)
  );
  assert.ok(delhiPlan.recommendations.some((r) => r.id === 'remote-work-study'));
  assert.ok(nyPlan.recommendations.some((r) => r.id === 'commute-active-moderate'));
});

runTest('15. Outdoor activity schedule changes action text meaningfully', () => {
  const morningPlan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      sensitivities: ['Older adult'],
      outdoorTime: 'Early morning',
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  const flexiblePlan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      sensitivities: ['Older adult'],
      outdoorTime: 'Flexible',
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  const morningRec = morningPlan.recommendations.find((r) => r.id === 'outdoor-timing-shift');
  const flexibleRec = flexiblePlan.recommendations.find((r) => r.id === 'outdoor-timing-shift');
  assert.match(morningRec.action, /early morning/i);
  assert.match(flexibleRec.action, /flexible/i);
  assert.notEqual(morningRec.action, flexibleRec.action);
});

runTest('16. Indoor combinations (purifier + gas + mechanical ventilation + not sure) alter plan and assistant', () => {
  const gasPurifierPlan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      indoor: ['Air purifier available', 'Windows can be closed', 'Cooking with gas'],
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.ok(gasPurifierPlan.recommendations.some((r) => r.id === 'bedroom-purifier'));
  const gasRec = gasPurifierPlan.recommendations.find((r) => r.id === 'indoor-combustion-control');
  assert.match(gasRec.action, /exhaust fan/i);

  const mechPlan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      indoor: ['Mechanical ventilation available'],
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.ok(mechPlan.recommendations.some((r) => r.id === 'mech-vent-filter'));

  const mechAnswer = answerQuestion({
    question: 'Should I open the windows?',
    household: {
      ...DEFAULT_HOUSEHOLD,
      indoor: ['Mechanical ventilation available'],
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.match(mechAnswer.directAnswer, /mechanical ventilation/i);

  const notSurePlan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      indoor: ['Not sure'],
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.ok(notSurePlan.recommendations.some((r) => r.id === 'indoor-check-seals'));
});

runTest('17. Work-from-home household receives batched errand and indoor alternatives', () => {
  const wfhPlan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      householdSize: '5+ people',
      travelMode: 'Work from home',
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  const wfhRec = wfhPlan.recommendations.find((r) => r.id === 'wfh-consolidate');
  assert.ok(wfhRec, 'Expected WFH errand-batching recommendation');
  assert.match(wfhRec.action, /5\+ people/i);
  assert.ok(wfhPlan.alternatives.some((a) => /deliveries/i.test(a.alternative)));

  const wfhAnswer = answerQuestion({
    question: 'What is the lowest-emission commute?',
    household: { ...DEFAULT_HOUSEHOLD, travelMode: 'Work from home' },
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.match(wfhAnswer.directAnswer, /Working from home already keeps your commute emissions at zero/i);
});

runTest('18. All four user priorities produce visibly distinct plans', () => {
  const base = {
    ...DEFAULT_HOUSEHOLD,
    city: 'Delhi',
    sensitivities: ['Asthma or respiratory sensitivity'],
    travelMode: 'Two-wheeler',
    indoor: ['Air purifier available', 'Windows can be closed'],
  };

  const priorities = ['Lowest exposure', 'Lowest emissions', 'Lowest cost', 'Balanced option'];
  const signatures = new Set(
    priorities.map((priority) => {
      const plan = generatePlan({
        household: { ...base, priority },
        airQuality: DEMO_LOCATIONS.Delhi,
      });
      return JSON.stringify(plan.recommendations.map((r) => `${r.id}:${r.action}`));
    })
  );

  assert.equal(signatures.size, 4, 'Each priority should yield a visibly distinct plan');
});

runTest('19. Adult respiratory and cardiovascular sensitivities tailor plan and assistant', () => {
  const respPlan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'Mumbai',
      sensitivities: ['Asthma or respiratory sensitivity'],
      outdoorTime: 'Early morning',
    },
    airQuality: DEMO_LOCATIONS.Mumbai,
  });
  const timingRec = respPlan.recommendations.find((r) => r.id === 'outdoor-timing-shift');
  assert.match(timingRec.whyItMatters, /airways|cardiovascular/i);

  const elderAnswer = answerQuestion({
    question: 'Can my elderly parent go for a morning walk?',
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'Delhi',
      sensitivities: ['Older adult'],
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.equal(elderAnswer.inScope, true);
  assert.match(elderAnswer.directAnswer, /older adult/i);
});

runTest('20. Accessibility markup, ARIA bindings, and reduced-motion styles are present', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

  assert.match(html, /<a class="skip-link" href="#main-content">/);
  assert.match(html, /<main id="main-content"[^>]*tabindex="-1"/);
  assert.match(html, /id="form-error-summary"[^>]*role="alert"[^>]*tabindex="-1"/);
  assert.match(html, /id="household-city"[^>]*aria-describedby="hint-city error-city"/);
  assert.match(html, /id="fieldset-sensitivities"[^>]*aria-describedby="hint-sensitivities error-sensitivities"/);
  assert.match(html, /id="fieldset-indoor"[^>]*aria-describedby="hint-indoor error-indoor"/);
  assert.match(html, /id="assistant-input"[^>]*aria-describedby="assistant-hint assistant-error"/);
  assert.match(html, /id="plan-live-region"[^>]*aria-live="polite"/);
  assert.match(html, /id="assistant-output"[^>]*aria-live="polite"/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
});

runTest('21. Hardened validation enforces indoor exclusivity and safe partial airQuality defaults', () => {
  const mixedIndoor = validateHousehold({
    ...DEFAULT_HOUSEHOLD,
    indoor: ['Air purifier available', 'Not sure'],
  });
  assert.equal(mixedIndoor.valid, false);
  assert.ok(mixedIndoor.errors.indoor);

  const partialPlan = generatePlan({
    household: DEFAULT_HOUSEHOLD,
    airQuality: { aqi: 240, pm25: 130 },
  });
  assert.equal(partialPlan.airQuality.severity, 'Severe');
  assert.ok(partialPlan.airQuality.wind.length > 0);
  assert.ok(partialPlan.recommendations.length >= 4);
});

runTest('22. Assistant handles word-stem variations for ventilation, cooking, and medical safety', () => {
  const ventRes = answerQuestion({
    question: 'What about ventilation today?',
    household: DEFAULT_HOUSEHOLD,
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.equal(ventRes.inScope, true);
  assert.equal(ventRes.topic, 'Windows & ventilation');

  const cookRes = answerQuestion({
    question: 'How can I reduce smoke when cooking with gas?',
    household: {
      ...DEFAULT_HOUSEHOLD,
      indoor: ['Windows can be closed', 'Cooking with gas'],
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.equal(cookRes.inScope, true);
  assert.equal(cookRes.topic, 'Bedroom & indoor air');

  const wheezingRes = answerQuestion({
    question: 'My child is wheezing, what should I do?',
    household: DEFAULT_HOUSEHOLD,
    airQuality: DEMO_LOCATIONS.Delhi,
  });
  assert.equal(wheezingRes.inScope, false);
  assert.match(wheezingRes.nextStep, /urgent medical care/i);
});

runTest('23. Interface labels demo snapshot and deterministic reasoning honestly', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /Demo snapshot · Illustrative values/);
  assert.match(html, /Demo reasoning mode · Deterministic local guidance/);
  assert.doesNotMatch(html, /Updated just now/i);
});

runTest('24. Modular TypeScript source files never use innerHTML or eval', () => {
  const srcDir = new URL('./src/', import.meta.url);
  const tsFiles = fs.readdirSync(srcDir).filter((name) => name.endsWith('.ts'));
  assert.ok(tsFiles.length >= 5, 'Expected modular TypeScript files under src/');
  for (const file of tsFiles) {
    const content = fs.readFileSync(new URL(`./src/${file}`, import.meta.url), 'utf8');
    assert.equal(content.includes('innerHTML'), false, `${file} must not use innerHTML`);
    assert.equal(content.includes('eval('), false, `${file} must not use eval(`);
  }
});

runTest('25. Weighted scoring table produces auditable deterministic score breakdowns', () => {
  const plan = generatePlan({
    household: {
      ...DEFAULT_HOUSEHOLD,
      city: 'Delhi',
      sensitivities: ['Child under 12'],
      priority: 'Lowest exposure',
    },
    airQuality: DEMO_LOCATIONS.Delhi,
  });

  assert.ok(Array.isArray(plan.scoringAudit) && plan.scoringAudit.length === plan.recommendations.length);
  const topAudit = plan.scoringAudit[0];
  assert.equal(topAudit.id, 'outdoor-child-severe');
  assert.equal(topAudit.totalScore, 134);
  assert.ok(topAudit.breakdown.some((b) => b.factor.includes('Lowest exposure') && b.contribution === 22));
});

try {
  let calls = 0;
  let lastVal = '';
  const debounced = debounce((val) => {
    calls += 1;
    lastVal = val;
  }, 20);

  debounced('first');
  debounced('second');
  debounced('third');
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(calls, 1, 'Expected rapid calls to coalesce into one');
  assert.equal(lastVal, 'third');

  debounced('cancelled');
  debounced.cancel();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(calls, 1, 'Expected cancel() to prevent queued invocation');

  passed += 1;
  console.log('PASS: 26. Debounce helper coalesces rapid calls and supports cancel()');
} catch (error) {
  console.error('FAIL: 26. Debounce helper coalesces rapid calls and supports cancel()');
  console.error(error);
  process.exitCode = 1;
}

console.log(`\nTotal passed: ${passed}`);
