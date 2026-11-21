/**
 * @fileoverview Browser DOM caching, debounced event wiring, and DocumentFragment
 * batched rendering for ClearAir.
 */

import { DEFAULT_HOUSEHOLD, validateHousehold } from './validation.ts';
import { getAirQualityForCity } from './airQuality.ts';
import { generatePlan } from './planEngine.ts';
import { answerQuestion, MAX_QUESTION_LENGTH } from './qa.ts';
import type { AirQuality } from './airQuality.ts';
import type { HouseholdFieldKey, HouseholdProfile } from './validation.ts';
import type { PlanResult } from './planEngine.ts';
import type { AssistantResponse } from './qa.ts';

const CHAR_COUNT_DEBOUNCE_MS = 160;
const PLAN_REGEN_DEBOUNCE_MS = 175;

/**
 * A debounced function handle with an explicit `cancel` method so submit and
 * reset actions can flush or discard queued triggers immediately.
 */
export interface DebouncedFn<TArgs extends unknown[]> {
  (...args: TArgs): void;
  cancel: () => void;
}

/**
 * Delays invoking `fn` until `delayMs` milliseconds have elapsed since the
 * most recent call.
 *
 * @param fn - Callback to debounce.
 * @param delayMs - Delay duration in milliseconds.
 * @returns Debounced wrapper with a `.cancel()` method.
 */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number
): DebouncedFn<TArgs> {
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const debounced = ((...args: TArgs): void => {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    timerId = setTimeout(() => {
      timerId = null;
      fn(...args);
    }, delayMs);
  }) as DebouncedFn<TArgs>;

  debounced.cancel = (): void => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  return debounced;
}

/**
 * Module-level cached DOM element references queried once on load in a browser.
 */
const DOM =
  typeof document !== 'undefined'
    ? {
        contextCitySelect: document.getElementById('context-city-select') as HTMLSelectElement | null,
        householdCitySelect: document.getElementById('household-city') as HTMLSelectElement | null,
        aqSeverityPanel: document.getElementById('aq-severity-panel'),
        aqSeveritySymbol: document.getElementById('aq-severity-symbol'),
        aqSeverityText: document.getElementById('aq-severity-text'),
        aqInterpretation: document.getElementById('aq-interpretation'),
        aqAqi: document.getElementById('aq-aqi'),
        aqPm25: document.getElementById('aq-pm25'),
        aqPm10: document.getElementById('aq-pm10'),
        aqTemp: document.getElementById('aq-temp'),
        aqWind: document.getElementById('aq-wind'),

        householdForm: document.getElementById('household-form') as HTMLFormElement | null,
        mainTravelSelect: document.getElementById('main-travel') as HTMLSelectElement | null,
        outdoorActivitySelect: document.getElementById('outdoor-activity') as HTMLSelectElement | null,
        resetProfileBtn: document.getElementById('reset-profile-btn') as HTMLButtonElement | null,
        formErrorSummary: document.getElementById('form-error-summary'),
        planSection: document.getElementById('plan-section'),
        planLiveRegion: document.getElementById('plan-live-region'),
        planCount: document.getElementById('plan-count'),
        planSafetyBanner: document.getElementById('plan-safety-banner'),
        planSafetyText: document.getElementById('plan-safety-text'),
        planList: document.getElementById('plan-list'),

        whyPrioritySummary: document.getElementById('why-priority-summary'),
        whyTradeoffSummary: document.getElementById('why-tradeoff-summary'),
        signalsList: document.getElementById('signals-list'),
        alternativesGrid: document.getElementById('alternatives-grid'),

        assistantForm: document.getElementById('assistant-form') as HTMLFormElement | null,
        assistantInput: document.getElementById('assistant-input') as HTMLTextAreaElement | null,
        assistantCharCount: document.getElementById('assistant-char-count'),
        assistantCharStatus: document.getElementById('assistant-char-status'),
        assistantError: document.getElementById('assistant-error'),
        assistantOutput: document.getElementById('assistant-output'),
        quickButtons: Array.from(document.querySelectorAll('.quick-btn')) as HTMLButtonElement[],

        fieldsetHouseholdSize: document.getElementById('fieldset-householdSize'),
        fieldsetSensitivities: document.getElementById('fieldset-sensitivities'),
        fieldsetIndoor: document.getElementById('fieldset-indoor'),
        fieldsetPriority: document.getElementById('fieldset-priority'),

        householdSizeRadios: Array.from(
          document.querySelectorAll('#household-form input[name="householdSize"]')
        ) as HTMLInputElement[],
        sensitivityCheckboxes: Array.from(
          document.querySelectorAll('#household-form input[name="sensitivities"]')
        ) as HTMLInputElement[],
        indoorCheckboxes: Array.from(
          document.querySelectorAll('#household-form input[name="indoor"]')
        ) as HTMLInputElement[],
        priorityRadios: Array.from(
          document.querySelectorAll('#household-form input[name="priority"]')
        ) as HTMLInputElement[],

        errorElements: {
          city: document.getElementById('error-city'),
          householdSize: document.getElementById('error-householdSize'),
          sensitivities: document.getElementById('error-sensitivities'),
          travelMode: document.getElementById('error-travelMode'),
          outdoorTime: document.getElementById('error-outdoorTime'),
          indoor: document.getElementById('error-indoor'),
          priority: document.getElementById('error-priority'),
        } as Record<HouseholdFieldKey, HTMLElement | null>,
      }
    : null;

/**
 * Appends a `<dt>/<dd>` pair wrapped in a `<div>` to a definition list or fragment
 * using safe `textContent` assignment.
 *
 * @param container - Target `<dl>` element or `DocumentFragment`.
 * @param term - Definition term text.
 * @param description - Definition description text.
 * @param className - Optional wrapper `<div>` class name.
 */
export function appendDefinitionRow(
  container: Element | DocumentFragment,
  term: string,
  description: string,
  className?: string
): void {
  const wrap = document.createElement('div');
  if (className) {
    wrap.className = className;
  }
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = description;
  wrap.appendChild(dt);
  wrap.appendChild(dd);
  container.appendChild(wrap);
}

/**
 * Renders the current air-quality severity badge and readings into the cached
 * DOM elements.
 *
 * @param aq - Normalized AirQuality snapshot.
 */
export function renderAirQuality(aq: AirQuality): void {
  if (
    !DOM ||
    !DOM.aqSeverityPanel ||
    !DOM.aqSeveritySymbol ||
    !DOM.aqSeverityText ||
    !DOM.aqInterpretation ||
    !DOM.aqAqi ||
    !DOM.aqPm25 ||
    !DOM.aqPm10 ||
    !DOM.aqTemp ||
    !DOM.aqWind
  ) {
    return;
  }
  const symbolMap: Record<AirQuality['severity'], string> = {
    Severe: '!!',
    Poor: '!',
    Moderate: '~',
  };
  DOM.aqSeverityPanel.setAttribute('data-severity', aq.severity);
  DOM.aqSeveritySymbol.textContent = symbolMap[aq.severity] || '!';
  DOM.aqSeverityText.textContent = `Severity: ${aq.severity}`;
  DOM.aqInterpretation.textContent = aq.interpretation;
  DOM.aqAqi.textContent = String(aq.aqi);
  DOM.aqPm25.textContent = `${aq.pm25} µg/m³`;
  DOM.aqPm10.textContent = `${aq.pm10} µg/m³`;
  DOM.aqTemp.textContent = `${aq.temperatureC}°C`;
  DOM.aqWind.textContent = aq.wind;
}

/**
 * Renders the personalized daily plan, decision-transparency section, and
 * sustainable alternatives using batched `DocumentFragment` writes.
 *
 * @param planResult - Generated plan result from {@link generatePlan}.
 */
export function renderPlan(planResult: PlanResult): void {
  if (
    !DOM ||
    !DOM.planCount ||
    !DOM.planSafetyBanner ||
    !DOM.planSafetyText ||
    !DOM.planList ||
    !DOM.whyPrioritySummary ||
    !DOM.whyTradeoffSummary ||
    !DOM.signalsList ||
    !DOM.alternativesGrid
  ) {
    return;
  }

  DOM.planCount.textContent = `${planResult.recommendations.length} steps`;

  if (planResult.safetyCaveat) {
    DOM.planSafetyBanner.hidden = false;
    DOM.planSafetyText.textContent = planResult.safetyCaveat;
  } else {
    DOM.planSafetyBanner.hidden = true;
    DOM.planSafetyText.textContent = '';
  }

  const planFragment = document.createDocumentFragment();
  for (const rec of planResult.recommendations) {
    const li = document.createElement('li');
    li.className = 'plan-item';

    const top = document.createElement('div');
    top.className = 'plan-item-top';

    const labelEl = document.createElement('span');
    labelEl.className = 'plan-item-label';
    labelEl.textContent = rec.label;

    const confEl = document.createElement('span');
    confEl.className = 'plan-item-confidence';
    confEl.textContent = rec.confidence;

    top.appendChild(labelEl);
    top.appendChild(confEl);

    const actionEl = document.createElement('h3');
    actionEl.className = 'plan-item-action';
    actionEl.textContent = rec.action;

    const whyEl = document.createElement('p');
    whyEl.className = 'plan-item-why';
    whyEl.textContent = rec.whyItMatters;

    const details = document.createElement('dl');
    details.className = 'plan-item-details';
    appendDefinitionRow(details, 'Direct impact', rec.directImpact, 'plan-detail');
    appendDefinitionRow(details, 'Tradeoff', rec.tradeoff, 'plan-detail');

    li.appendChild(top);
    li.appendChild(actionEl);
    li.appendChild(whyEl);
    li.appendChild(details);
    planFragment.appendChild(li);
  }
  DOM.planList.replaceChildren(planFragment);

  DOM.whyPrioritySummary.textContent = planResult.prioritySummary;
  DOM.whyTradeoffSummary.textContent = planResult.tradeoffSummary;

  const signalsFragment = document.createDocumentFragment();
  for (const sig of planResult.signals) {
    appendDefinitionRow(signalsFragment, sig.label, sig.value, 'signal-item');
  }
  DOM.signalsList.replaceChildren(signalsFragment);

  const alternativesFragment = document.createDocumentFragment();
  for (const alt of planResult.alternatives) {
    const card = document.createElement('article');
    card.className = 'alternative-card';

    const title = document.createElement('h3');
    title.textContent = alt.alternative;

    const dl = document.createElement('dl');
    dl.className = 'alternative-meta';
    appendDefinitionRow(dl, 'Exposure benefit', alt.exposureBenefit);
    appendDefinitionRow(dl, 'Emissions benefit', alt.emissionsBenefit);
    appendDefinitionRow(dl, 'Convenience or cost tradeoff', alt.tradeoff);

    card.appendChild(title);
    card.appendChild(dl);
    alternativesFragment.appendChild(card);
  }
  DOM.alternativesGrid.replaceChildren(alternativesFragment);
}

/**
 * Renders a validated Q&A response inside the assistant output region using a
 * single batched `DocumentFragment` replacement.
 *
 * @param result - Assistant response from {@link answerQuestion}.
 */
export function renderAssistantResponse(result: AssistantResponse): void {
  if (!DOM || !DOM.assistantOutput) {
    return;
  }

  const fragment = document.createDocumentFragment();

  const echo = document.createElement('p');
  echo.className = 'assistant-question-echo';
  echo.textContent = `Question: "${result.question || ''}"`;
  fragment.appendChild(echo);

  const dl = document.createElement('dl');
  dl.className = 'assistant-response-grid';
  appendDefinitionRow(dl, 'Direct answer', result.directAnswer || '', 'assistant-block');
  appendDefinitionRow(dl, 'Reasoning from your context', result.reasoning || '', 'assistant-block');
  appendDefinitionRow(dl, 'Practical next step', result.nextStep || '', 'assistant-block');
  fragment.appendChild(dl);

  if (result.safetyCaveat) {
    const caveat = document.createElement('p');
    caveat.className = 'assistant-caveat';
    caveat.textContent = result.safetyCaveat;
    fragment.appendChild(caveat);
  }

  DOM.assistantOutput.replaceChildren(fragment);
}

function cloneDefaultHousehold(): HouseholdProfile {
  return {
    ...DEFAULT_HOUSEHOLD,
    sensitivities: [...DEFAULT_HOUSEHOLD.sensitivities],
    indoor: [...DEFAULT_HOUSEHOLD.indoor],
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia) &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Initializes the ClearAir interactive web interface, wiring cached controls,
 * debounced character counter and plan regeneration handlers, accessibility
 * live announcements, and initial render.
 */
export function initClearAirApp(): void {
  if (
    !DOM ||
    !DOM.contextCitySelect ||
    !DOM.householdCitySelect ||
    !DOM.householdForm ||
    !DOM.mainTravelSelect ||
    !DOM.outdoorActivitySelect ||
    !DOM.resetProfileBtn ||
    !DOM.formErrorSummary ||
    !DOM.planSection ||
    !DOM.planLiveRegion ||
    !DOM.assistantForm ||
    !DOM.assistantInput ||
    !DOM.assistantCharCount ||
    !DOM.assistantCharStatus ||
    !DOM.assistantError ||
    !DOM.assistantOutput
  ) {
    return;
  }

  const ui = {
    contextCitySelect: DOM.contextCitySelect,
    householdCitySelect: DOM.householdCitySelect,
    householdForm: DOM.householdForm,
    mainTravelSelect: DOM.mainTravelSelect,
    outdoorActivitySelect: DOM.outdoorActivitySelect,
    resetProfileBtn: DOM.resetProfileBtn,
    formErrorSummary: DOM.formErrorSummary,
    planSection: DOM.planSection,
    planLiveRegion: DOM.planLiveRegion,
    assistantForm: DOM.assistantForm,
    assistantInput: DOM.assistantInput,
    assistantCharCount: DOM.assistantCharCount,
    assistantCharStatus: DOM.assistantCharStatus,
    assistantError: DOM.assistantError,
    assistantOutput: DOM.assistantOutput,
    quickButtons: DOM.quickButtons,
    householdSizeRadios: DOM.householdSizeRadios,
    sensitivityCheckboxes: DOM.sensitivityCheckboxes,
    indoorCheckboxes: DOM.indoorCheckboxes,
    priorityRadios: DOM.priorityRadios,
    errorElements: DOM.errorElements,
  };

  const sessionState = {
    household: cloneDefaultHousehold(),
    airQuality: getAirQualityForCity(DEFAULT_HOUSEHOLD.city),
    lastQuestion: '',
  };

  let assistantTimerId: ReturnType<typeof setTimeout> | null = null;

  const fieldControlMap: Record<
    HouseholdFieldKey,
    { label: string; target: HTMLElement | null; getFocusEl: () => HTMLElement | null }
  > = {
    city: {
      label: 'City or location',
      target: ui.householdCitySelect,
      getFocusEl: () => ui.householdCitySelect,
    },
    householdSize: {
      label: 'Household size',
      target: DOM.fieldsetHouseholdSize,
      getFocusEl: () => ui.householdSizeRadios[0] || null,
    },
    sensitivities: {
      label: 'Household sensitivities',
      target: DOM.fieldsetSensitivities,
      getFocusEl: () => ui.sensitivityCheckboxes[0] || null,
    },
    travelMode: {
      label: 'Main daily travel',
      target: ui.mainTravelSelect,
      getFocusEl: () => ui.mainTravelSelect,
    },
    outdoorTime: {
      label: 'Typical outdoor activity',
      target: ui.outdoorActivitySelect,
      getFocusEl: () => ui.outdoorActivitySelect,
    },
    indoor: {
      label: 'Indoor environment',
      target: DOM.fieldsetIndoor,
      getFocusEl: () => ui.indoorCheckboxes[0] || null,
    },
    priority: {
      label: 'Main priority',
      target: DOM.fieldsetPriority,
      getFocusEl: () => ui.priorityRadios[0] || null,
    },
  };

  function clearFieldError(key: HouseholdFieldKey): void {
    const el = ui.errorElements[key];
    if (el) {
      el.hidden = true;
      el.textContent = '';
    }
    const mapping = fieldControlMap[key];
    if (mapping && mapping.target) {
      mapping.target.removeAttribute('aria-invalid');
    }
  }

  function clearFormErrors(): void {
    ui.formErrorSummary.hidden = true;
    ui.formErrorSummary.replaceChildren();
    (Object.keys(fieldControlMap) as HouseholdFieldKey[]).forEach(clearFieldError);
  }

  function showFormErrors(errors: Partial<Record<HouseholdFieldKey, string>>): void {
    const messages = Object.entries(errors) as Array<[HouseholdFieldKey, string]>;
    const summaryFragment = document.createDocumentFragment();

    const title = document.createElement('p');
    title.className = 'error-summary-title';
    title.textContent = `Please fix ${messages.length} ${
      messages.length === 1 ? 'field' : 'fields'
    } before building your plan:`;
    summaryFragment.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'error-summary-list';

    for (const [key, msg] of messages) {
      const mapping = fieldControlMap[key];
      const el = ui.errorElements[key];
      if (el) {
        el.hidden = false;
        el.textContent = msg;
      }
      if (mapping && mapping.target) {
        mapping.target.setAttribute('aria-invalid', 'true');
      }

      const li = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'error-summary-link';
      link.href = `#error-${encodeURIComponent(key)}`;
      link.textContent = `${mapping ? mapping.label : key}: ${msg}`;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const focusEl = mapping?.getFocusEl();
        if (focusEl) {
          focusEl.focus();
        }
      });
      li.appendChild(link);
      list.appendChild(li);
    }

    summaryFragment.appendChild(list);
    ui.formErrorSummary.replaceChildren(summaryFragment);
    ui.formErrorSummary.hidden = false;
    ui.formErrorSummary.focus({ preventScroll: true });
    ui.formErrorSummary.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'nearest',
    });
  }

  function syncCheckboxExclusivity(
    checkboxes: readonly HTMLInputElement[],
    exclusiveValue: string,
    changedInput: HTMLInputElement
  ): void {
    if (changedInput.value === exclusiveValue && changedInput.checked) {
      for (const cb of checkboxes) {
        if (cb.value !== exclusiveValue) {
          cb.checked = false;
        }
      }
    } else if (changedInput.value !== exclusiveValue && changedInput.checked) {
      for (const cb of checkboxes) {
        if (cb.value === exclusiveValue) {
          cb.checked = false;
        }
      }
    }
  }

  function setFormToDefaults(): void {
    ui.householdCitySelect.value = DEFAULT_HOUSEHOLD.city;
    ui.contextCitySelect.value = DEFAULT_HOUSEHOLD.city;

    for (const input of ui.householdSizeRadios) {
      input.checked = input.value === DEFAULT_HOUSEHOLD.householdSize;
    }
    for (const input of ui.sensitivityCheckboxes) {
      input.checked = DEFAULT_HOUSEHOLD.sensitivities.includes(input.value);
    }
    ui.mainTravelSelect.value = DEFAULT_HOUSEHOLD.travelMode;
    ui.outdoorActivitySelect.value = DEFAULT_HOUSEHOLD.outdoorTime;
    for (const input of ui.indoorCheckboxes) {
      input.checked = DEFAULT_HOUSEHOLD.indoor.includes(input.value);
    }
    for (const input of ui.priorityRadios) {
      input.checked = input.value === DEFAULT_HOUSEHOLD.priority;
    }
  }

  function readFormValues(): Record<string, unknown> {
    const formData = new FormData(ui.householdForm);
    return {
      city: formData.get('city') || '',
      householdSize: formData.get('householdSize') || '',
      sensitivities: formData.getAll('sensitivities'),
      travelMode: formData.get('travelMode') || '',
      outdoorTime: formData.get('outdoorTime') || '',
      indoor: formData.getAll('indoor'),
      priority: formData.get('priority') || '',
    };
  }

  function updateAssistantCharCounter(): void {
    const len = ui.assistantInput.value.length;
    ui.assistantCharCount.textContent = `${len} / ${MAX_QUESTION_LENGTH}`;
    const remaining = MAX_QUESTION_LENGTH - len;
    if (remaining === 30 || remaining === 10 || remaining === 0) {
      ui.assistantCharStatus.textContent =
        remaining === 0
          ? `Maximum ${MAX_QUESTION_LENGTH} characters reached.`
          : `${remaining} characters remaining.`;
    } else if (ui.assistantCharStatus.textContent) {
      ui.assistantCharStatus.textContent = '';
    }
    if (!ui.assistantError.hidden && len > 0 && len <= MAX_QUESTION_LENGTH) {
      ui.assistantError.hidden = true;
      ui.assistantError.textContent = '';
      ui.assistantInput.removeAttribute('aria-invalid');
    }
  }

  const debouncedCharCounter = debounce(updateAssistantCharCounter, CHAR_COUNT_DEBOUNCE_MS);

  function askAssistant(rawQuestion: string): void {
    if (assistantTimerId !== null) {
      clearTimeout(assistantTimerId);
      assistantTimerId = null;
    }

    const result = answerQuestion({
      question: rawQuestion,
      household: sessionState.household,
      airQuality: sessionState.airQuality,
    });

    if (!result.valid) {
      ui.assistantError.hidden = false;
      ui.assistantError.textContent = result.error || '';
      ui.assistantInput.setAttribute('aria-invalid', 'true');
      ui.assistantInput.focus();
      return;
    }

    ui.assistantError.hidden = true;
    ui.assistantError.textContent = '';
    ui.assistantInput.removeAttribute('aria-invalid');
    sessionState.lastQuestion = result.question || '';

    if (prefersReducedMotion()) {
      ui.assistantOutput.removeAttribute('aria-busy');
      renderAssistantResponse(result);
      return;
    }

    ui.assistantOutput.setAttribute('aria-busy', 'true');
    const loading = document.createElement('p');
    loading.className = 'assistant-loading';
    loading.textContent = `Checking ${sessionState.airQuality.city} conditions and your household context…`;
    ui.assistantOutput.replaceChildren(loading);

    assistantTimerId = setTimeout(() => {
      assistantTimerId = null;
      ui.assistantOutput.removeAttribute('aria-busy');
      renderAssistantResponse(result);
    }, 140);
  }

  function syncAndRenderPlan(city: string): PlanResult {
    if (assistantTimerId !== null) {
      clearTimeout(assistantTimerId);
      assistantTimerId = null;
      ui.assistantOutput.removeAttribute('aria-busy');
    }

    const aq = getAirQualityForCity(city);
    sessionState.airQuality = aq;
    sessionState.household.city = aq.city;
    ui.contextCitySelect.value = aq.city;
    ui.householdCitySelect.value = aq.city;
    renderAirQuality(aq);

    const planResult = generatePlan({
      household: sessionState.household,
      airQuality: sessionState.airQuality,
    });
    renderPlan(planResult);

    if (sessionState.lastQuestion) {
      const refreshed = answerQuestion({
        question: sessionState.lastQuestion,
        household: sessionState.household,
        airQuality: sessionState.airQuality,
      });
      if (refreshed.valid) {
        renderAssistantResponse(refreshed);
      }
    }

    return planResult;
  }

  function updateCityContext(city: string, announce: boolean): void {
    syncAndRenderPlan(city);
    if (announce) {
      const aq = sessionState.airQuality;
      ui.planLiveRegion.textContent = `Updated air-quality context and plan for ${aq.city} (${aq.severity}, AQI ${aq.aqi}).`;
    }
  }

  const debouncedCityUpdate = debounce((city: string) => {
    updateCityContext(city, true);
  }, PLAN_REGEN_DEBOUNCE_MS);

  const debouncedValidProfileRefresh = debounce((normalized: HouseholdProfile) => {
    sessionState.household = normalized;
    const planResult = syncAndRenderPlan(normalized.city);
    ui.planLiveRegion.textContent = `Personalized daily plan updated for ${sessionState.airQuality.city} with ${planResult.recommendations.length} recommendations.`;
  }, PLAN_REGEN_DEBOUNCE_MS);

  // --- Event listeners ---
  ui.contextCitySelect.addEventListener('change', (event) => {
    const city = (event.target as HTMLSelectElement).value;
    ui.householdCitySelect.value = city;
    clearFieldError('city');
    debouncedValidProfileRefresh.cancel();
    debouncedCityUpdate(city);
  });

  ui.householdCitySelect.addEventListener('change', (event) => {
    const city = (event.target as HTMLSelectElement).value;
    ui.contextCitySelect.value = city;
    clearFieldError('city');
    debouncedValidProfileRefresh.cancel();
    debouncedCityUpdate(city);
  });

  ui.householdForm.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.name === 'sensitivities') {
      syncCheckboxExclusivity(
        ui.sensitivityCheckboxes,
        'None of these',
        target as HTMLInputElement
      );
    } else if (target.name === 'indoor') {
      syncCheckboxExclusivity(ui.indoorCheckboxes, 'Not sure', target as HTMLInputElement);
    }

    const fieldName = target.name as HouseholdFieldKey;
    const mapping =
      fieldName && Object.prototype.hasOwnProperty.call(fieldControlMap, fieldName)
        ? fieldControlMap[fieldName]
        : null;

    const validation = validateHousehold(readFormValues());
    if (mapping && (mapping.target?.hasAttribute('aria-invalid') || !ui.formErrorSummary.hidden)) {
      if (!validation.errors[fieldName]) {
        clearFieldError(fieldName);
        if (validation.valid && !ui.formErrorSummary.hidden) {
          clearFormErrors();
        }
      }
    }

    if (validation.valid && target.name !== 'city') {
      debouncedValidProfileRefresh(validation.normalized);
    }
  });

  ui.householdForm.addEventListener('submit', (event) => {
    event.preventDefault();
    debouncedCityUpdate.cancel();
    debouncedValidProfileRefresh.cancel();
    clearFormErrors();

    const validation = validateHousehold(readFormValues());
    if (!validation.valid) {
      showFormErrors(validation.errors);
      return;
    }

    sessionState.household = validation.normalized;
    const planResult = syncAndRenderPlan(validation.normalized.city);

    ui.planLiveRegion.textContent = `Personalized daily plan updated for ${sessionState.airQuality.city} with ${planResult.recommendations.length} recommendations.`;

    ui.planSection.focus({ preventScroll: true });
    ui.planSection.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
  });

  ui.resetProfileBtn.addEventListener('click', () => {
    debouncedCityUpdate.cancel();
    debouncedValidProfileRefresh.cancel();
    clearFormErrors();
    setFormToDefaults();
    sessionState.household = cloneDefaultHousehold();
    updateCityContext(DEFAULT_HOUSEHOLD.city, false);
    ui.planLiveRegion.textContent = `Household profile reset to defaults for ${sessionState.airQuality.city} (${sessionState.airQuality.severity}, AQI ${sessionState.airQuality.aqi}).`;
  });

  ui.assistantInput.addEventListener('input', () => {
    debouncedCharCounter();
  });

  ui.assistantForm.addEventListener('submit', (event) => {
    event.preventDefault();
    debouncedCharCounter.cancel();
    updateAssistantCharCounter();
    askAssistant(ui.assistantInput.value);
  });

  for (const btn of ui.quickButtons) {
    btn.addEventListener('click', () => {
      const q = (btn.getAttribute('data-question') || btn.textContent || '').trim();
      ui.assistantInput.value = q;
      debouncedCharCounter.cancel();
      updateAssistantCharCounter();
      askAssistant(q);
    });
  }

  // Initial synchronous render
  syncAndRenderPlan(DEFAULT_HOUSEHOLD.city);
}

// Self-bootstrap in browser only
if (typeof document !== 'undefined') {
  initClearAirApp();
}
