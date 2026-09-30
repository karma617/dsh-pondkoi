/**
 * Live weather via Open-Meteo, ported from the shell build's
 * `KoiPondWindow.fetchOpenMeteoWeather`.
 *
 * Geolocation is IP-based and every request is best-effort: a failure returns
 * null so the garden falls back to its local seasonal/time-of-day art instead of
 * showing a broken state. No API key is involved.
 */

const GEO_PROVIDERS = [
  { url: 'http://ip-api.com/json', timeout: 5_000, read: body => ({ lat: body.lat, lon: body.lon }) },
  { url: 'https://ipwho.is/', timeout: 4_000, read: body => ({ lat: body.latitude, lon: body.longitude }) },
]

/** Shanghai, used when neither geolocation provider answers. */
const FALLBACK = { lat: 31.2304, lon: 121.4737 }

async function resolveLocation() {
  for (const provider of GEO_PROVIDERS) {
    try {
      const response = await fetch(provider.url, { signal: AbortSignal.timeout(provider.timeout) })
      if (!response.ok) continue
      const { lat, lon } = provider.read(await response.json())
      if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon }
      }
    } catch {
      // Try the next provider.
    }
  }
  return FALLBACK
}

export async function fetchLiveWeather() {
  try {
    const { lat, lon } = await resolveLocation()
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4)
      + '&longitude=' + lon.toFixed(4)
      + '&current=weather_code,precipitation,rain,snowfall&timezone=auto'
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) return null
    const data = await response.json()
    if (!data.current) return null
    return {
      weatherCode: Number(data.current.weather_code) || 0,
      rain: Number(data.current.rain) || 0,
      snowfall: Number(data.current.snowfall) || 0,
    }
  } catch {
    return null
  }
}
