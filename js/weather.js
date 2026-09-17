// Weather from Open-Meteo (free, no key). Location from the browser or a city search.
import { kvGet, kvSet } from './db.js';

const WMO = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
};
export const describe = (code) => WMO[code] || ['—', '🌡️'];

const DEFAULT_PLACE = { name: 'New Delhi', lat: 28.6139, lon: 77.209, source: 'default' };

export async function getPlace() {
  return kvGet('place', null);
}
export const setPlace = (p) => kvSet('place', p);

export function geolocate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Location is not available on this device'));
    navigator.geolocation.getCurrentPosition(
      (pos) => res({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => rej(new Error(err.code === 1 ? 'Location permission was denied' : 'Could not get your location')),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 30 * 60 * 1000 },
    );
  });
}

async function reverseName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const j = await r.json();
    return j.city || j.locality || j.principalSubdivision || 'Your location';
  } catch {
    return 'Your location';
  }
}

export async function placeFromGps() {
  const { lat, lon } = await geolocate();
  const p = { name: await reverseName(lat, lon), lat, lon, source: 'gps' };
  await setPlace(p);
  return p;
}

/** Use the saved place; on first run try GPS, and fall back to a default city. */
export async function resolvePlace() {
  const saved = await getPlace();
  if (saved) {
    if (saved.source === 'gps') {
      // Refresh quietly in case the user has moved; keep the old one if it fails.
      placeFromGps().catch(() => {});
    }
    return saved;
  }
  try {
    return await placeFromGps();
  } catch {
    return DEFAULT_PLACE;
  }
}

export async function searchCity(q) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
  const j = await r.json();
  return (j.results || []).map((x) => ({
    name: x.name,
    detail: [x.admin1, x.country].filter(Boolean).join(', '),
    lat: x.latitude,
    lon: x.longitude,
    source: 'search',
  }));
}

export async function fetchWeather(place) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: place.lat,
    longitude: place.lon,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max',
    timezone: 'auto',
    forecast_days: 3,
  });
  const r = await fetch(url);
  if (!r.ok) throw new Error('Weather service unavailable');
  const j = await r.json();
  const day = (i) => ({
    code: j.daily.weather_code[i],
    max: j.daily.temperature_2m_max[i],
    min: j.daily.temperature_2m_min[i],
    feelsMax: j.daily.apparent_temperature_max[i],
    feelsMin: j.daily.apparent_temperature_min[i],
    rainChance: j.daily.precipitation_probability_max[i] ?? 0,
    uv: j.daily.uv_index_max[i] ?? 0,
    wind: j.daily.wind_speed_10m_max[i] ?? 0,
  });
  const data = {
    fetchedAt: Date.now(),
    current: {
      temp: j.current.temperature_2m,
      feels: j.current.apparent_temperature,
      humidity: j.current.relative_humidity_2m,
      precip: j.current.precipitation,
      code: j.current.weather_code,
      wind: j.current.wind_speed_10m,
    },
    days: [day(0), day(1), day(2)],
  };
  await kvSet('weatherCache', { place, data });
  return data;
}

export async function cachedWeather() {
  return kvGet('weatherCache', null);
}

/** The single "how it'll feel while you're out" number the stylist dresses for. */
export function dressingTemp(day) {
  return 0.65 * day.feelsMax + 0.35 * day.feelsMin;
}

export const fmtTemp = (c, unit) => (unit === 'f' ? `${Math.round(c * 9 / 5 + 32)}°` : `${Math.round(c)}°`);

export function summarize(place, w, dayIdx, unit = 'c') {
  const d = w.days[dayIdx];
  const [label] = describe(d.code);
  const when = dayIdx === 0 ? 'Today' : 'Tomorrow';
  return `${when} in ${place.name}: ${label.toLowerCase()}, ${fmtTemp(d.min, unit)}–${fmtTemp(d.max, unit)} (feels ${fmtTemp(d.feelsMin, unit)}–${fmtTemp(d.feelsMax, unit)}), ` +
    `${d.rainChance}% chance of rain, UV ${Math.round(d.uv)}, wind up to ${Math.round(d.wind)} km/h` +
    (dayIdx === 0 ? `. Right now ${fmtTemp(w.current.temp, unit)}, humidity ${w.current.humidity}%.` : '.');
}
