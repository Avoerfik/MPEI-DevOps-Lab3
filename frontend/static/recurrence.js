// Расчёт повторяющегося расписания.
//
// Все даты в приложении — это московское «настенное» время (Europe/Moscow,
// UTC+03:00, без перехода на летнее время с 2014 года). Чтобы не путаться
// с часовыми поясами, мы представляем такое время как Date, у которого
// UTC-компоненты (getUTCFullYear, getUTCHours и т.д.) равны компонентам
// московского настенного времени. Тогда арифметика по UTC совпадает
// с арифметикой по Москве без переходов.

const MINUTE_MS = 60 * 1000;

// "YYYY-MM-DDTHH:mm" или "YYYY-MM-DDTHH:mm:ss" -> Date (МСК wall-clock)
export function parseLocal(value) {
  if (typeof value !== 'string') throw new Error('Invalid datetime value');
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error('Invalid datetime: ' + value);
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0));
}

// Date (МСК wall-clock) -> "YYYY-MM-DDTHH:mm"
export function formatLocal(date) {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

// Date (МСК wall-clock) -> RFC 3339 с московским смещением
export function toMoscowISO(date) {
  return formatLocal(date) + ':00+03:00';
}

// Прибавляет к дате указанное количество единиц интервала.
// Для месяцев день месяца «прижимается» к последнему дню месяца.
export function addInterval(date, amount, unit) {
  const result = new Date(date.getTime());
  if (unit === 'days') {
    result.setUTCDate(result.getUTCDate() + amount);
    return result;
  }
  if (unit === 'weeks') {
    result.setUTCDate(result.getUTCDate() + amount * 7);
    return result;
  }
  if (unit === 'months') {
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + amount);
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0))
      .getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
  }
  throw new Error('Unknown interval unit: ' + unit);
}

// Строит массив { startsAt, endsAt } для count повторений.
export function buildSchedule(startDate, intervalAmount, intervalUnit, count, durationMinutes) {
  if (!Number.isInteger(count) || count < 1) throw new Error('Count must be a positive integer');
  if (!Number.isInteger(intervalAmount) || intervalAmount < 1) {
    throw new Error('Interval must be a positive integer');
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
    throw new Error('Duration must be a positive integer');
  }
  const durationMs = durationMinutes * MINUTE_MS;
  const schedule = [];
  let current = new Date(startDate.getTime());
  for (let i = 0; i < count; i += 1) {
    schedule.push({
      startsAt: new Date(current.getTime()),
      endsAt: new Date(current.getTime() + durationMs),
    });
    current = addInterval(current, intervalAmount, intervalUnit);
  }
  return schedule;
}

// "2027-03-21 19:00 — 21:00" или "2027-03-21 23:00 — 2027-03-22 01:00"
export function formatRange(startDate, endDate) {
  const start = formatLocal(startDate);
  const end = formatLocal(endDate);
  const startDateStr = start.slice(0, 10);
  const endDateStr = end.slice(0, 10);
  const startTime = start.slice(11);
  const endTime = end.slice(11);
  if (startDateStr === endDateStr) {
    return `${startDateStr} ${startTime} — ${endTime}`;
  }
  return `${startDateStr} ${startTime} — ${endDateStr} ${endTime}`;
}