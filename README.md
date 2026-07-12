# Meeting Finder 007

Find the closest recovery meeting anywhere in South Africa. Pulls AA, NA, and CA
meetings from each fellowship's public meeting list, and sorts them by distance
from the user.

**Privacy by design:** no accounts, no analytics, no cookies. Geolocation is
used in the browser only and never sent anywhere. The whole meeting dataset
ships to the client, so distance sorting happens on the device.

## How it works

- `scripts/collect.mjs` scrapes the three sources and writes
  `public/data/meetings.json` (~700 meetings, all with coordinates):
  - **AA** (`aasouthafrica.org.za`) — TSML plugin JSON cache, filename
    discovered from the meetings page each run
  - **NA** (`na.org.za`) — same TSML plugin on 4 regional sub-sites
    (wc, jhb, kzn, pta)
  - **CA** (`ca.org.za`) — static HTML pages parsed with cheerio; coordinates
    resolved from Google Maps links, cached in `scripts/geocache.json`
- `.github/workflows/refresh-data.yml` re-runs the collector weekly and
  commits the result, which triggers a redeploy.
- The Next.js app (`app/`) is fully static and client-side.

## Development

```bash
npm install
npm run collect   # refresh public/data/meetings.json
npm run dev       # http://localhost:3000
```

## Disclaimer

Independent community project. Not affiliated with, endorsed by, or a service
of Alcoholics Anonymous, Narcotics Anonymous, or Cocaine Anonymous. Meeting
details come from each fellowship's public meeting lists. Always confirm with
the group where possible.
