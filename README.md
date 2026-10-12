# SF Transit Pipeline

Ingests SF Muni schedule and real-time data from [511.org](https://511.org/open-data/transit), reconciles what's scheduled against what's actually running, and tracks reliability over time.

**Status:** milestone 1 (versioned static schedule ingest) is done.

## Running it

Requires Node 24+ and Docker.

```sh
cp .env.example .env        # then add your 511 API token
npm install
npm run db:up               # Postgres + Redis
npm run db:migrate
npm run ingest:static       # download Muni's schedule and load it
npm test
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run ingest:static -- --file feed.zip` | Load a GTFS zip from disk without using an API request |
| `npm run worker` | Run the job worker, which checks for a new schedule daily |
| `npm run typecheck` | Type-check the project |
| `npm run db:down` | Stop the containers (data is kept in Docker volumes) |

## How static ingest works

511 republishes each agency's schedule as a [GTFS](https://gtfs.org/documentation/schedule/reference/) zip whenever it changes. Each download is loaded as a **feed version**:

1. **Skip if unchanged.** The zip's SHA-256 is compared with the active version. Most daily checks end here.
2. **Load alongside the current schedule.** Every row is tagged with its `feed_version_id`, and each file is streamed into Postgres with `COPY`.
3. **Validate.** Cross-file references (trips pointing at missing routes, stop times at missing stops) are counted and stored on the version, not treated as fatal.
4. **Activate atomically.** Loading and activation happen in one transaction. Readers always see one complete schedule, and a failed load leaves the previous one untouched.
5. **Prune.** Older superseded versions beyond `KEEP_FEED_VERSIONS` are deleted.

### Design decisions

- **Versioned rows, not truncate-and-reload.** Truncating would leave the schedule empty or half-loaded mid-ingest. Versions also make it possible to diff schedule changes later.
- **Streaming `COPY`.** Muni's `stop_times.txt` has millions of rows. Streaming keeps memory flat, and `COPY` is much faster than batched `INSERT`s.
- **Times stored as seconds after the start of the service day.** GTFS allows times like `25:30:00` for trips that run past midnight, so they can't be stored as `time`.
- **Advisory lock per operator.** Two ingests (a manual run plus the scheduled one) can't overlap. The second one skips.
- **Errors are classified.** Bad feed data and invalid tokens fail immediately. Rate limits, outages and network errors are retried with exponential backoff, so retries don't waste the API's 60-requests-per-hour budget.

### Known limitations

- Pruning deletes rows with `ON DELETE CASCADE`, which is slow at Muni's scale. Partitioning GTFS tables by feed version would make pruning an instant `DROP`.

## Roadmap

1. ~~Versioned static schedule ingest~~
2. Real-time poller: vehicle positions and trip updates (protobuf), within the rate-limit budget
3. Reconciliation: ghost buses, trips missing from the schedule, stale vehicles, delay metrics
4. Hardening: dead-letter handling, metrics, alerting
5. API, React dashboard and deployment
