// Клиент REST API бэкенда moscow-events.
// Все запросы идут по относительному префиксу /api/v1, который nginx
// проксирует в контейнер backend.

const BASE = '/api/v1';

async function request(method, path, body, headers = {}) {
  const init = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(BASE + path, init);
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) {
    const error = new Error(
      (data && data.error && data.error.message) || response.statusText || 'Request failed'
    );
    error.status = response.status;
    error.code = data && data.error && data.error.code;
    error.details = data && data.error && data.error.details;
    throw error;
  }
  return data;
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

// Обходит страницы коллекции до полного результата.
async function fetchAll(fetcher, params = {}, pageSize = 100) {
  const all = [];
  let page = 1;
  while (true) {
    const chunk = await fetcher({ ...params, page, page_size: pageSize });
    all.push(...chunk.data);
    if (chunk.data.length < pageSize || all.length >= chunk.meta.total) break;
    page += 1;
  }
  return all;
}

export const api = {
  listGenres: () => request('GET', '/meta/genres'),
  listDistricts: () => request('GET', '/meta/districts'),
  listAgeRatings: () => request('GET', '/meta/age-ratings'),

  fetchArtists: () => fetchAll(p => request('GET', `/artists${queryString(p)}`)),
  fetchVenues: () => fetchAll(p => request('GET', `/venues${queryString(p)}`)),

  createSeries: (body) => request('POST', '/series', body),

  bulk: (payload, idempotencyKey) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    return request('POST', '/events/bulk', payload, headers);
  },

  healthReady: async () => {
    const response = await fetch('/health/ready');
    return response.ok;
  },
};