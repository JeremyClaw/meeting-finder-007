'use client';

import { useEffect, useMemo, useState } from 'react';

type Meeting = {
  id: string;
  fellowship: 'AA' | 'NA' | 'CA';
  name: string;
  day: number;
  time: string;
  endTime: string | null;
  address: string;
  region: string;
  lat: number;
  lng: number;
  types: string[];
  notes: string | null;
  sourceUrl: string | null;
};

type Data = {
  updated: string;
  counts: { AA: number; NA: number; CA: number; total: number };
  meetings: Meeting[];
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FELLOWSHIPS = ['AA', 'NA', 'CA'] as const;
const PAGE_SIZE = 25;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function saToday(): number {
  // Day of week in South Africa, 0=Sunday (matches the data's TSML convention)
  const name = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: 'Africa/Johannesburg',
  }).format(new Date());
  return DAYS.indexOf(name);
}

function formatTime(t: string) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatDistance(km: number) {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export default function Home() {
  const [data, setData] = useState<Data | null>(null);
  const [origin, setOrigin] = useState<{ lat: number; lng: number; label: string } | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [fellowships, setFellowships] = useState<Set<string>>(new Set(FELLOWSHIPS));
  const [day, setDay] = useState<number | null>(null);
  const [todayOnly, setTodayOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  useEffect(() => {
    fetch('/data/meetings.json')
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError('Could not load meeting data. Please try again.'));
  }, []);

  function locate() {
    setError(null);
    if (!navigator.geolocation) {
      setError('Your browser does not support location. Try searching by suburb instead.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'your location' });
        setLocating(false);
        setLimit(PAGE_SIZE);
      },
      () => {
        setLocating(false);
        setError(
          'Location was blocked or unavailable. You can search by suburb or town instead, no permission needed.'
        );
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    );
  }

  async function searchPlace(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setError(null);
    setLocating(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=za&q=${encodeURIComponent(q)}`
      );
      const results = await res.json();
      if (!results.length) {
        setError(`Could not find "${q}". Try a nearby town or a broader suburb name.`);
      } else {
        setOrigin({ lat: Number(results[0].lat), lng: Number(results[0].lon), label: q });
        setLimit(PAGE_SIZE);
      }
    } catch {
      setError('Search is unavailable right now. Try the location button instead.');
    }
    setLocating(false);
  }

  function toggleFellowship(f: string) {
    setFellowships((prev) => {
      const next = new Set(prev);
      if (next.has(f)) {
        if (next.size > 1) next.delete(f);
      } else {
        next.add(f);
      }
      return next;
    });
    setLimit(PAGE_SIZE);
  }

  const results = useMemo(() => {
    if (!data || !origin) return [];
    const today = saToday();
    return data.meetings
      .filter((m) => fellowships.has(m.fellowship))
      .filter((m) => (todayOnly ? m.day === today : day === null ? true : m.day === day))
      .map((m) => ({ ...m, km: haversineKm(origin.lat, origin.lng, m.lat, m.lng) }))
      .sort((a, b) => a.km - b.km);
  }, [data, origin, fellowships, day, todayOnly]);

  const shown = results.slice(0, limit);

  return (
    <>
      <header className="site-header">
        <div className="wrap">
          <span className="wordmark">
            Meeting Finder<b>007</b>
          </span>
          <span className="label">South Africa</span>
        </div>
      </header>

      <section className="hero">
        <div className="wrap">
          <h1>
            Find a meeting.
            <br />
            <em>Start where you are.</em>
          </h1>
          <p>
            The closest AA, NA and CA meetings anywhere in South Africa. No sign-up, no tracking.
            Your location never leaves your phone.
          </p>

          <button className="btn-primary" onClick={locate} disabled={locating}>
            {locating ? 'Finding you…' : 'Find meetings near me'}
          </button>

          <div className="or-row">
            <hr className="hairline" />
            <span className="label">or</span>
            <hr className="hairline" />
          </div>

          <form className="search-row" onSubmit={searchPlace}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search suburb or town"
              aria-label="Search suburb or town"
            />
            <button type="submit">Go</button>
          </form>

          {error && <div className="error-note">{error}</div>}

          {!origin && data && (
            <div className="stats">
              <div>
                <span className="num">{data.counts.total}</span>
                <span className="label">Meetings</span>
              </div>
              <div>
                <span className="num">3</span>
                <span className="label">Fellowships</span>
              </div>
              <div>
                <span className="num">7</span>
                <span className="label">Days a week</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {origin && data && (
        <>
          <div className="filters">
            <div className="wrap">
              <div className="chip-row">
                {FELLOWSHIPS.map((f) => (
                  <button
                    key={f}
                    className={`chip ${fellowships.has(f) ? 'on' : ''}`}
                    onClick={() => toggleFellowship(f)}
                  >
                    {f}
                  </button>
                ))}
                <button
                  className={`chip today ${todayOnly ? 'on' : ''}`}
                  onClick={() => {
                    setTodayOnly(!todayOnly);
                    setDay(null);
                    setLimit(PAGE_SIZE);
                  }}
                >
                  Today
                </button>
              </div>
              <div className="chip-row">
                {DAYS.map((d, i) => (
                  <button
                    key={d}
                    className={`chip ${!todayOnly && day === i ? 'on' : ''}`}
                    onClick={() => {
                      setDay(day === i ? null : i);
                      setTodayOnly(false);
                      setLimit(PAGE_SIZE);
                    }}
                  >
                    {d.slice(0, 3)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <main className="wrap">
            <div className="results-head">
              <span className="label">
                {results.length} meetings near {origin.label}
              </span>
            </div>

            {shown.map((m) => (
              <article className="card" key={m.id}>
                <div className="card-top">
                  <span className={`badge ${m.fellowship}`}>{m.fellowship}</span>
                  <span className="dist">{formatDistance(m.km)}</span>
                </div>
                <h3>{m.name}</h3>
                <div className="when">
                  {DAYS[m.day]}s <span>at</span> {formatTime(m.time)}
                  {m.endTime && <span> to {formatTime(m.endTime)}</span>}
                </div>
                <div className="addr">{m.address.replace(/, South Africa$/, '')}</div>
                {m.types.length > 0 && (
                  <div className="tags">
                    {m.types.map((t) => (
                      <span className="tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div className="card-links">
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${m.lat},${m.lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Directions
                  </a>
                  {m.sourceUrl && (
                    <a className="quiet" href={m.sourceUrl} target="_blank" rel="noopener noreferrer">
                      Details
                    </a>
                  )}
                </div>
              </article>
            ))}

            {shown.length === 0 && (
              <div className="empty">
                <div className="serif">No meetings match those filters.</div>
                <p>Try widening the day filter or switching fellowships back on.</p>
              </div>
            )}

            {results.length > limit && (
              <button className="show-more" onClick={() => setLimit(limit + PAGE_SIZE)}>
                Show more ({results.length - limit} remaining)
              </button>
            )}
          </main>
        </>
      )}

      <footer className="site-footer">
        <div className="wrap">
          <span className="label">About this finder</span>
          <p>
            Meeting Finder 007 is an independent community project. It is not affiliated with,
            endorsed by, or a service of Alcoholics Anonymous, Narcotics Anonymous, or Cocaine
            Anonymous. Meeting details come from each fellowship&apos;s public meeting list and are
            refreshed regularly. Always confirm with the group if you can.
          </p>
          <p>
            No analytics, no cookies, no accounts. If you use the location button, your position is
            used on your device only. If you search by suburb, only the words you type are sent to
            the OpenStreetMap search service to find the place.
          </p>
          <p>
            Spotted an error?{' '}
            <a href="mailto:deej@deejburke.co.za?subject=Meeting%20Finder%20correction">
              Send a correction
            </a>
            .
          </p>
        </div>
      </footer>
    </>
  );
}
