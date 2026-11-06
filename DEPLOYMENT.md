# Running the API and background worker separately

The API and background worker are separate Node processes. The API serves requests and enqueues pricing workbook jobs; the worker processes those jobs from MongoDB. They can run on the same machine locally or on separate cloud servers.

## Local development

Create `BE/.env` from `.env.example`, then start each process in a separate terminal from the repository root:

```powershell
npm --prefix BE run dev
npm --prefix BE run worker:dev
```

Both processes load `BE/.env` by path, so the current working directory does not affect configuration. For local development, `MONGODB_JOBS_URI` can be omitted; both processes use `MONGODB_URI` and the `MONGODB_JOBS_DB` database (default `billforbill_jobs`).

## Separate cloud servers

Deploy the same backend revision and install its production dependencies on both servers. Configure environment variables in the hosting platform's secret/configuration settings rather than copying a development `.env` file.

**API server:** run `npm start`. It needs `MONGODB_URI`, `MONGODB_JOBS_URI`, `MONGODB_JOBS_DB`, `PORT`, `TLS_MODE=proxy`, `FRONTEND_ORIGIN`, and the application's auth configuration. The API needs access to both the application database and the jobs database because it enqueues jobs, stores uploaded workbook files, and reads job status/results.

**Worker server:** run `npm run worker`. It needs the same `MONGODB_URI`, `MONGODB_JOBS_URI`, and `MONGODB_JOBS_DB` values as the API. It does not serve HTTP, so it does not need `PORT`, TLS certificates, `FRONTEND_ORIGIN`, or `OTP_HASH_SECRET`.

`MONGODB_URI` must identify the application database. `MONGODB_JOBS_URI` can be a different MongoDB deployment; both services must use the same `MONGODB_JOBS_DB` value on that deployment. Give both services network access and MongoDB credentials that permit the application operations and job/GridFS reads and writes. If `MONGODB_JOBS_URI` is omitted, both services use `MONGODB_URI` for the jobs database.

Run exactly one worker initially. Additional worker instances can claim jobs atomically, but production scaling should be load-tested with the chosen MongoDB capacity. Use the cloud platform's process supervisor to restart either service on failure. On shutdown, the worker finishes its current job before closing its MongoDB connections.

For public production traffic, terminate HTTPS at the hosting platform or reverse proxy and run the API with `TLS_MODE=proxy`. The worker has no HTTP listener and does not use TLS settings.
