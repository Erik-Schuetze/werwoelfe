# Werewolves LLM Game Harness

This is a deterministic Go moderator for an experiment in which 8–18 DeepSeek-controlled players play **The Werewolves of Millers Hollow**. The game engine, rather than a model, owns roles, phases, legal actions, votes, eliminations, and victory conditions. The official game rules are preserved verbatim in [`docs/rules.md`](docs/rules.md).

## Run locally

1. Create a non-secret configuration: `cp config.example.json config.json`. Use 8–18 unique players; `roles` is optional and defaults to the recommended core setup (Werewolves, one Fortune Teller, and Villagers).
2. Export the API key without placing it in configuration or source control: `export DEEPSEEK_API_KEY='...'`.
3. Run a game: `go run ./cmd/werwoelfe -config config.json -seed 42`.

The CLI uses DeepSeek's `/chat/completions` endpoint and requests JSON mode, and every reply is a single JSON object whose discriminator field is `action`. It defaults to the current `deepseek-flash` model; the retired `deepseek-chat` model name should not be used. Thinking mode is explicitly disabled to preserve direct player-action responses and make temperature effective. Each completion receives a fresh, role-scoped snapshot with durable facts and a bounded recent history; the complete raw history remains available only to the trusted local operator store. Every player is told that the moderator's record — eliminations, revealed roles, ballots and their own private results — is true, and that everything else they say is a claim: lying, bluffing and false role claims are expected play rather than cheating. Each action may also carry a short private `thought` (at most 400 characters) that the moderator stores for that player alone; it never enters another player's prompt and appears only in the operator console's director view. A missing `thought` is fine — it is never required and never fails a run. `model.temperature` defaults to `1.0` and accepts values from `0` to `2`. Before the first introduction, one extra setup call at `model.character_temperature` (default `1.2`, set to `0` to disable) casts the whole village at once: every player gets a short, role-agnostic speaking voice — how they speak and argue (tempo, directness, how they take a challenge) rather than a trade or identity, deliberately kept distinct across the cast so no two sound alike, and with no tics, catchphrases, or dialect. Each voice is stored privately and layered on top of that player's configured `personality` in later prompts; if the call fails or is disabled, players simply keep their configured `personality`. Each invalid model output or failed request is retried only up to `model.max_retries`. A single utterance is capped per phase — 320 characters for an introduction or a removed Sheriff's dying words, 480 for a discussion speech or a Werewolf plan, and 500 for a required final statement — and anything longer is cut and ends with the neutral marker `[Time is up.]`. The cut lands on the last sentence or word that fits, so a long message loses its tail rather than being severed mid-word. Other exhausted failures stop the game explicitly. Omit `model.max_retries` to use the default of 2, or set it to `0` to disable retries. `-seed` makes role assignment reproducible; omit it for a fresh seed. `-timeout` defaults to 15 minutes.

Each completed run writes a sanitized `game-result.json` by default. It records the actual seed, model metadata, final role assignments, the winner, duration, and public event history. It never includes the API key, private prompts, Fortune Teller results, or Werewolf deliberation. Use `-result path/to/result.json` to choose a distinct result file, or `-result ''` to disable it. The optional `-events path/to/events.ndjson` appends every game event as it occurs, including private recipient-scoped events, followed by a terminal result or failure record; it is intended only for the trusted local operator console.

## Run with Docker

```sh
docker build -t werwoelfe .
mkdir -p results
docker run --rm \
  -e DEEPSEEK_API_KEY \
  -v "$PWD/config.json:/config.json:ro" \
  -v "$PWD/results:/results" \
  werwoelfe -config /config.json -result /results/game-result.json
```

## Local operator console

The private operator console is a Next.js application in [`web/`](web). It creates and follows one run per game — a local Docker container during development, or a Kubernetes Job in a cluster — and never exposes the DeepSeek key to a console viewer. Trusted local console viewers receive every game event, including private Werewolf meal choices and Fortune Teller results, along with final role assignments and sanitized run metadata. Public `player_removed` events include the eliminated player ID and revealed role so the live board can update without interpreting transcript text.

```sh
cp web/.env.example .env
# Set DEEPSEEK_API_KEY in .env.
docker compose build game operator
docker compose up operator
```

Open <http://localhost:3000>. The console writes SQLite state and per-run artifacts under `./data/`, which is ignored by Git. It launches only the configured `werwoelfe-game:local` image with generated input/output mounts; do not expose this service or its Docker socket to an untrusted network. While a game is active, its detail page can refresh manually, pause browser polling, stop the managed run, or restart it with the same configuration and a fresh seed. Stopped runs are retained as cancelled in the archive.

The game detail page is a spectator stage, not a transcript dump. It presents one beat at a time under paced playback, tuned so a run can actually be followed at human reading speed: a stage card for the scene in front of you, a player table carrying each seat's role badge and marking who holds the floor, a stakes rail tracking the case on the table alongside the vote board and the night ledger, and a scrub strip along the bottom that distinguishes the beats already played from those still ahead. Playback offers speeds from 0.25× to instant, pause, previous and next, seek by clicking a beat, and a jump-to-live chip for catching up to a run still in progress; the cursor is anchored to event sequence numbers, so the page's 1.5-second refresh appends new beats without re-timing the ones you have already watched. Dialogue types on word by word at a reading pace rather than appearing whole, because a line cannot be re-read once the next one pushes it down. Space or K play and pause, the arrow keys and comma/period step one beat at a time, Home and End jump to the start or to live, S reveals the current line at once, and the address bar carries the current beat so a half-watched run can be bookmarked and resumed. The full transcript of the run stays reachable below, and at the director level it is joined by the raw private event record.

Three truth levels govern what a viewer is allowed to know. **Blind** shows the game as the village sees it. **Spectator**, the default, shows the audience the true roles and how the room is walking past the answer while the village stays in the dark. **Director** adds the raw private event record. The players' private reasoning is a separate toggle, offered at both the spectator and director levels but never at blind. Ground truth is read from the finished run's roster or, on a live run, rebuilt from the private night channels from the first night onward, so the spectator view needs no engine support. The earlier `audience`/`director` spoiler setting migrates automatically: a viewer who had chosen to hide private content lands on **blind**, never on omniscient.

For web-only development, set `DEEPSEEK_API_KEY` and run:

```sh
cd web
npm install
npm run dev
```

The local Docker daemon is the **development** path: it needs no cluster and starts a game in seconds. The server process needs access to that daemon, and Compose names it explicitly with `WERWOELFE_RUNTIME=docker` rather than leaning on auto-detection. Configure `WERWOELFE_DATA_DIR`, `WERWOELFE_GAME_IMAGE`, `WERWOELFE_MAX_CONCURRENT_RUNS`, and `WERWOELFE_MAX_RUN_MINUTES` through the environment as needed. When the server itself runs in a container with the host Docker socket, set `WERWOELFE_DOCKER_DATA_DIR` to the host-visible path backing `WERWOELFE_DATA_DIR`; Compose does this automatically.

### Kubernetes

In a cluster the console schedules games differently: rather than running a container on the local daemon, it creates one Kubernetes Job per game through the Kubernetes API and follows that Job to completion, so it needs no Docker socket and no Docker CLI. It does need a ServiceAccount whose Role permits creating, getting, listing, watching, and deleting Jobs and reading pod logs in the target namespace. The same `ReadWriteOnce` volume that the console mounts at `/data` is mounted by each game Job, so a run's configuration, event stream, and result all live on one persistent volume; because an `RWO` volume attaches to only one node, each game Job is pinned to the node the console itself runs on, which means the console pod and its game Jobs must share a node. `DEEPSEEK_API_KEY` reaches the game pod directly from a Secret through a `secretKeyRef`, so the console never handles the key and it never appears in the console's own environment or in a Job manifest. Select this path with `WERWOELFE_RUNTIME=kubernetes`, or leave that blank and let the in-cluster service-account environment choose it; the full set of settings is documented in [`web/.env.example`](web/.env.example).

## Public viewer

The same Next.js application backs two deployments: the private operator console described above, and a stateless public viewer that shows an audience index and game pages with no operator affordance at all. The public deployment, served at `werwoelfe.erik-schuetze.dev`, holds no volume, no Docker socket, no ServiceAccount, and no `DEEPSEEK_API_KEY`. It reads neither the SQLite database nor the data directory; its only outbound call is to the operator's read-only `/api/public/*` API, which never ingests and never writes, so public traffic can never reach the writer's write path. `failed` and `cancelled` runs are hidden from the audience index, and their game pages answer 404 rather than showing a run that was abandoned or stopped.

Set `WERWOELFE_MODE=viewer` to turn the same image into that audience-only instance. In this mode the application serves only `/viewer` and `/api/viewer/*` and answers 404 to every other path — including `/`, `/games/*`, and the operator's own `/api/games/*` — so the deployed viewer exposes neither the launch form nor the mutating routes. Leave `WERWOELFE_MODE` blank, or set it to `operator`, for the private console; any other value is an error rather than a silent default, so a typo cannot promote a public deployment into an operator. The viewer's own settings — `WERWOELFE_OPERATOR_URL`, `WERWOELFE_OPERATOR_TIMEOUT_MS`, `WERWOELFE_VIEWER_POLL_MS`, and `WERWOELFE_VIEWER_CACHE_MS` — are read only in viewer mode and are documented in [`web/.env.example`](web/.env.example).

To run both locally, bring up the operator and the viewer together:

```sh
docker compose build game operator viewer
docker compose up operator viewer
```

The viewer reaches the operator over the Compose network at `http://operator:3000` and listens on <http://localhost:3001>; because `/` is not one of its routes, its audience index lives at <http://localhost:3001/viewer>. The operator console stays on <http://localhost:3000>.

Two `next dev` processes started in the same directory share a single `.next` build directory and corrupt each other, so do not run the operator and the viewer that way. Use the Compose services above, or check out a second `git worktree` for the second process.

## Experiment protocol

Every player first makes one opening Town Hall introduction, then the village elects a Sheriff. The elected Sheriff is followed by the first night (Fortune Teller investigation, three private Werewolf planning rounds, then secret Werewolf meal selection) and dawn resolution before the first discussion begins. Each introduction is a required concise statement that names the speaker and states whether or why they intend to run for Sheriff; role claims and bluffing are permitted. Every day after dawn has exactly three Town Hall rounds, where every living player may independently `speak`, `pass`, or `agree` with a case already on the table once per round, followed by a required final statement from every living player and an exile vote. Agreeing records a public endorsement of another player (`<name> agrees with <target>: …`, or a nod when no words are given) instead of re-arguing a case the village has already heard. Passing is a normal move — silence is not treated as suspicious — and the starting speaker rotates each round so the same player does not anchor the day; an elected Sheriff opens the first round of each day and then rejoins the rotation. Every ballot is published with its tally, so the public record cannot be misremembered, and a Werewolf is explicitly free to claim a role they do not hold or invent a result they never obtained. Each exile is followed by the next night and dawn. The initial playable roles are Werewolf, Villager, Fortune Teller, and the elected Sheriff title. A player’s role is publicly revealed when they are eliminated, and the final role assignments are recorded in the sanitized result artifact.

Every Sheriff-election, exile, and revote ballot is public as it is cast. A player may cast any legal ballot even when it differs from the target named in their final statement; the mismatch remains available as public evidence on later days. Every player, including the Sheriff, contributes one vote to the initial exile tally. If that tally is tied and the Sheriff's chosen candidate is among those tied, the Sheriff receives one additional deciding vote for that candidate; otherwise, the engine runs a restricted revote.

Before each nightly meal choice, living Werewolves receive two private planning rounds to discuss the target and their public strategy for the coming day. Those plans are private and never clipped tighter than the public speech limit. They then submit meal choices privately. The highest-supported target is selected; an equal split uses a deterministic player-ID tiebreak so an otherwise valid disagreement never aborts a game.

When a Sheriff is removed, the engine asks that player to name the one living player they trust most as their successor, with a brief reason, before continuing the interrupted phase; the appointment and reason are recorded publicly.

CLI output remains public-only. The trusted local operator event stream includes private events with their intended recipients, while the in-memory event history keeps Fortune Teller results, Werewolf plans, and Werewolf choices out of other players' model contexts and transcripts.

## Kubernetes Job

Build and publish an image, then replace the placeholder image in `deploy/job.yaml`:

```sh
docker build -t ghcr.io/OWNER/werwoelfe:TAG .
kubectl apply -f deploy/configmap.example.yaml
kubectl create secret generic deepseek-api --from-literal=api-key="$DEEPSEEK_API_KEY"
kubectl apply -f deploy/job.yaml
```

The configuration is mounted as a ConfigMap and the API key is injected from a Kubernetes Secret. The example Job does not persist `game-result.json`; mount a writable volume and set `-result` to a path on that volume for durable Kubernetes results. These manifests run the engine standalone, one game against one hand-written ConfigMap; they are not how the operator console schedules games, which creates its own Jobs as described under **Kubernetes** above. Do not commit a real `config.json`, `.env`, API key, private event history, or model prompts containing private game information.

## Test

```sh
go test ./...
```
