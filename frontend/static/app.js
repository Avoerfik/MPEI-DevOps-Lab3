import { api } from './api.js';
import { buildSchedule, formatRange, parseLocal, toMoscowISO } from './recurrence.js';

const $ = (sel, root = document) => root.querySelector(sel);

const form = $('#template-form');
const preview = $('#preview');
const previewList = $('#preview-list');
const previewSummary = $('#preview-summary');
const previewErrors = $('#preview-errors');
const saveResult = $('#save-result');
const saveBtn = $('#save-btn');
const statusBanner = $('#status-banner');

// Состояние между предпросмотром и сохранением.
let cachedSeries = null;         // {name, description} — payload для POST /series
let cachedOperations = null;     // [{op:'create', fields:{...}}] без series_id
let cachedSchedule = null;       // [{startsAt, endsAt}] для отрисовки
let createdSeries = null;        // серверная серия после POST /series
let pendingOperations = null;    // те же операции с series_id, для повторного сохранения
let pendingIdempotencyKey = null;

// ---------- Утилиты ----------

function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function showBanner(message, kind = 'info') {
  statusBanner.textContent = message;
  statusBanner.classList.remove('hidden', 'error');
  if (kind === 'error') statusBanner.classList.add('error');
}

function hideBanner() {
  statusBanner.classList.add('hidden');
}

function fillSelect(name, items) {
  const select = form.elements[name];
  select.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
}

function clearPlan() {
  cachedSeries = null;
  cachedOperations = null;
  cachedSchedule = null;
  createdSeries = null;
  pendingOperations = null;
  pendingIdempotencyKey = null;
}

// ---------- Начальная инициализация ----------

async function waitForBackend(timeoutMs = 60000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await api.healthReady()) return;
    } catch {
      // Сеть может быть ещё не готова — просто ждём следующей попытки.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Бэкенд не стал готов за ${timeoutMs / 1000} с`);
}

function setDefaultStartAt() {
  // «Завтра 19:00 по Москве»
  const mskNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const tomorrow = new Date(mskNow.getTime() + 24 * 60 * 60 * 1000);
  const y = tomorrow.getUTCFullYear();
  const mo = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
  const d = String(tomorrow.getUTCDate()).padStart(2, '0');
  form.elements.starts_at.value = `${y}-${mo}-${d}T19:00`;
}

async function loadCatalogs() {
  const [artists, venues, genres, ageRatings] = await Promise.all([
    api.fetchArtists(),
    api.fetchVenues(),
    api.listGenres(),
    api.listAgeRatings(),
  ]);

  fillSelect('artist_id', artists.map((a) => ({ value: a.id, label: a.name })));
  fillSelect(
    'venue_id',
    venues.map((v) => ({
      value: v.id,
      label: `${v.name} — ${v.formatted_address}`,
    })),
  );
  fillSelect('genre_code', genres.data.map((g) => ({ value: g.code, label: g.name })));
  fillSelect(
    'age_rating',
    ageRatings.data.map((a) => ({ value: String(a.code), label: a.name })),
  );

  // По умолчанию выбираем площадку с координатами (чтобы future-фильтры
  // вроде /events/nearby тоже работали осмысленно).
  const mappedVenue = venues.find((v) => v.latitude !== null);
  if (mappedVenue) form.elements.venue_id.value = mappedVenue.id;
}

async function bootstrap() {
  setDefaultStartAt();
  form.classList.add('loading');
  showBanner('Подключаемся к бэкенду…');
  try {
    await waitForBackend();
    await loadCatalogs();
    hideBanner();
    form.classList.remove('loading');
  } catch (error) {
    showBanner('Не удалось загрузить справочники: ' + error.message, 'error');
    form.classList.remove('loading');
  }
}

// ---------- Сбор формы ----------

function readForm() {
  if (!form.reportValidity()) return null;

  const data = new FormData(form);

  const intervalAmount = Number(data.get('interval_amount'));
  const intervalUnit = String(data.get('interval_unit'));
  const repeatCount = Number(data.get('repeat_count'));
  const durationMinutes = Number(data.get('duration_minutes'));

  if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 200) {
    throw new Error('Количество повторений должно быть целым от 1 до 200');
  }
  if (!Number.isInteger(intervalAmount) || intervalAmount < 1) {
    throw new Error('Интервал должен быть целым положительным числом');
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
    throw new Error('Длительность должна быть целым положительным числом минут');
  }

  const startLocal = parseLocal(String(data.get('starts_at')));
  const schedule = buildSchedule(
    startLocal,
    intervalAmount,
    intervalUnit,
    repeatCount,
    durationMinutes,
  );

  const series = {
    name: String(data.get('series_name') || '').trim(),
    description: String(data.get('series_description') || '').trim() || null,
  };

  const templateFields = {
    title: String(data.get('title') || '').trim(),
    description: String(data.get('description') || '').trim() || null,
    artist_id: String(data.get('artist_id')),
    venue_id: String(data.get('venue_id')),
    genre_code: String(data.get('genre_code')),
    price_rub: Number(data.get('price_rub')),
    age_rating: Number(data.get('age_rating')),
    ticket_quota: Number(data.get('ticket_quota')),
    status: String(data.get('status')),
    tags: [],
  };

  const operations = schedule.map((s) => ({
    op: 'create',
    fields: {
      ...templateFields,
      starts_at: toMoscowISO(s.startsAt),
      ends_at: toMoscowISO(s.endsAt),
    },
  }));

  return { series, operations, schedule };
}

// ---------- Отрисовка ----------

function renderSchedule(schedule, outcome) {
  previewList.innerHTML = '';

  const errorsByIndex = new Map();
  let generalError = null;
  let summary = `Событий к созданию: ${schedule.length}`;

  if (outcome && outcome.pending) {
    summary += ' (проверяем на сервере…)';
    previewErrors.classList.add('hidden');
  } else if (outcome && outcome.ok) {
    for (const err of outcome.result.errors || []) {
      if (typeof err.operation_index === 'number') {
        errorsByIndex.set(err.operation_index, err);
      }
    }
    const failed = errorsByIndex.size;
    summary += failed === 0
      ? ' — все операции прошли проверку'
      : ` — ${failed} из ${schedule.length} не прошли проверку`;
    if (failed === 0) {
      previewErrors.classList.add('hidden');
    } else {
      previewErrors.textContent =
        'Некоторые операции не прошли проверку сервера. Исправьте форму и нажмите «Показать расписание» ещё раз.';
      previewErrors.classList.remove('hidden');
    }
  } else if (outcome && outcome.error) {
    generalError = outcome.error.message;
    summary += ' (проверка не удалась)';
    previewErrors.textContent = 'Ошибка запроса: ' + generalError;
    previewErrors.classList.remove('hidden');
  }

  previewSummary.textContent = summary;

  schedule.forEach((occurrence, index) => {
    const li = document.createElement('li');
    const err = errorsByIndex.get(index);
    if (err) li.classList.add('error');

    const line = document.createElement('div');
    line.className = 'sched-line';

    const rangeText = formatRange(occurrence.startsAt, occurrence.endsAt);
    const [startPart, endPart] = rangeText.split(' — ');

    const dateSpan = document.createElement('span');
    dateSpan.className = 'sched-date';
    dateSpan.textContent = startPart;
    line.appendChild(dateSpan);

    const dash = document.createElement('span');
    dash.className = 'sched-dash';
    dash.textContent = '—';
    line.appendChild(dash);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'sched-time';
    timeSpan.textContent = endPart;
    line.appendChild(timeSpan);

    const tag = document.createElement('span');
    tag.className = 'sched-tag';
    tag.textContent = 'МСК';
    line.appendChild(tag);

    li.appendChild(line);

    if (err) {
      const errDiv = document.createElement('div');
      errDiv.className = 'sched-error';
      const suffix = err.details && Object.keys(err.details).length
        ? ' — ' + JSON.stringify(err.details)
        : '';
      errDiv.textContent = `[${err.code}] ${err.message}${suffix}`;
      li.appendChild(errDiv);
    }

    previewList.appendChild(li);
  });
}

// ---------- Обработчики ----------

async function onPreview() {
  saveResult.classList.add('hidden');
  saveResult.className = 'result hidden';

  let plan;
  try {
    plan = readForm();
  } catch (error) {
    alert(error.message);
    return;
  }
  if (!plan) return; // form.reportValidity() уже показал ошибки

  clearPlan();
  cachedSeries = plan.series;
  cachedOperations = plan.operations;
  cachedSchedule = plan.schedule;

  preview.classList.remove('hidden');
  renderSchedule(plan.schedule, { pending: true });
  saveBtn.disabled = true;
  saveBtn.textContent = 'Проверка…';

  let outcome;
  try {
    const result = await api.bulk({ dry_run: true, operations: plan.operations });
    outcome = { ok: true, result };
  } catch (error) {
    outcome = { ok: false, error };
  }

  renderSchedule(plan.schedule, outcome);
  saveBtn.textContent = 'Сохранить серию';
  saveBtn.disabled = !(outcome.ok && (outcome.result.errors || []).length === 0);

  preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function onSave() {
  if (!cachedSeries || !cachedOperations) return;

  saveResult.className = 'result hidden';
  saveBtn.disabled = true;
  saveBtn.textContent = 'Сохранение…';

  try {
    if (!createdSeries) {
      createdSeries = await api.createSeries(cachedSeries);
    }
    if (!pendingOperations) {
      pendingOperations = cachedOperations.map((op) => ({
        op: 'create',
        fields: { ...op.fields, series_id: createdSeries.id },
      }));
    }
    if (!pendingIdempotencyKey) {
      pendingIdempotencyKey = uuid();
    }

    const result = await api.bulk(
      { dry_run: false, operations: pendingOperations },
      pendingIdempotencyKey,
    );
    if (result.errors && result.errors.length > 0) {
      throw new Error(`${result.errors.length} операций не сохранились`);
    }

    saveResult.className = 'result success';
    saveResult.textContent =
      `Создана серия «${createdSeries.name}» и ${result.created} событий.`;
    saveResult.classList.remove('hidden');

    saveBtn.textContent = 'Готово';
    saveBtn.disabled = true;

    // Сбрасываем только состояние сохранения, но не саму форму:
    // пользователь может захотеть сделать похожую серию.
    clearPlan();
    cachedSeries = null;
    cachedOperations = null;
    cachedSchedule = null;
  } catch (error) {
    saveResult.className = 'result error';
    saveResult.textContent = 'Ошибка сохранения: ' + error.message;
    saveResult.classList.remove('hidden');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Повторить сохранение';
    // createdSeries, pendingOperations и pendingIdempotencyKey сохраняются:
    // повторный клик переиспользует их и не создаёт дубликатов.
  }
}

function onReset() {
  clearPlan();
  preview.classList.add('hidden');
  previewList.innerHTML = '';
  previewSummary.textContent = '';
  previewErrors.classList.add('hidden');
  saveResult.className = 'result hidden';
  saveBtn.disabled = true;
  saveBtn.textContent = 'Сохранить серию';
}

// ---------- Привязка событий ----------

$('#preview-btn').addEventListener('click', onPreview);
$('#reset-btn').addEventListener('click', onReset);
saveBtn.addEventListener('click', onSave);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  onPreview();
});

bootstrap();