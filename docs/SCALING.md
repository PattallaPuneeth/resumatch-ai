# Match throughput with 1, 2 and 3 ML workers

Measured on 29 Oct 2026 on one laptop (Docker Desktop with 4 CPUs), mock LLM, with
`scripts/bench/match_throughput.mjs`. Each run: 3 throwaway users, 1 resume each, 6 job posts
each, then all **18 matches enqueued at once** through the public API and polled until every
result exists. Every run uses fresh text (a random tag in the resume and job posts), because the
worker caches embeddings and reranker scores by text; repeating the same documents would measure
the cache. Extra workers were started with `docker run` from the running worker's image and
settings. Per-worker counts come from each container's log.

| Workers | Runs | Throughput (matches/s) | p95 latency | Failed | Who scored the 18 matches |
| :---: | :---: | :---: | :---: | :---: | :--- |
| 1 | 2 | 1.10, 1.18 | 15.1–16.3 s | 0 | main worker: 18 |
| 2 | 3 | 3.01, 4.17, 6.81 | 2.5–5.7 s | 0 | e.g. 13 + 5; one run 0 + 18 |
| 3 | 3 | 3.55, 4.78, 4.97 | 3.5–5.0 s | 0 | e.g. 7 + 8 + 3, 7 + 7 + 4 |

## What this shows

- **A second worker drains a burst 3–6× faster.** More than 2× because a single worker also
  runs the embedding job that every new job post creates, and the burst's matches wait behind
  them; a second worker takes over part of either.
- **A third worker adds nothing here.** Throughput levels off around 5 matches/s: with 4 CPUs the
  pipeline is CPU-bound (the reranker and embedder use several threads each), so more processes
  only share the same cores. Scaling further needs more CPU, not more workers on one machine.
- **Variance is large** (3.0–6.8 matches/s with 2 workers), so treat these as ranges.
- Zero failed matches and no duplicates in any run; jobs are shared through BullMQ.

## Limits

- An 18-match burst, not sustained load: a k6 soak test with several workers is still to do
  (see [PERFORMANCE.md](PERFORMANCE.md) for the existing k6 results).
- The API limits job creation and match requests to 20 per minute per client IP, so one
  machine cannot drive larger bursts without raising `RATE_LIMIT_MULTIPLIER`.
- `ml-worker` has a fixed `container_name` in `docker-compose.yml`, so `docker compose --scale`
  does not work; this benchmark starts the extra workers with `docker run`.

## Reproduce

```bash
node scripts/bench/match_throughput.mjs --users 3 --per-user 6 --label "1 worker"
# start an extra worker from the running one, wait for "Starting BullMQ workers", run again
docker inspect resumatch-ml-worker --format '{{range .Config.Env}}{{println .}}{{end}}' > worker.env
docker run -d --name resumatch-ml-worker-2 --network project-cbp_resumatch-network \
  --env-file worker.env "$(docker inspect resumatch-ml-worker --format '{{.Image}}')" python -m ml.worker
```

Leave a minute between runs (rate limit), and delete `worker.env` afterwards: it contains the
worker's secrets.
