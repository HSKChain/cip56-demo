# CIP-56 dual-synchronizer local demo

A CIP-56 (Canton Token Standard) demo that runs in Docker on one machine. Copy this directory to deploy it. No sibling directory is required.

It starts two independent synchronizers:

- `global-sync`: a stand-in for the public settlement domain;
- `private-sync`: a stand-in for a private institutional domain;
- `participant-shared`: connected to both domains, and hosts the business parties, DARs, contracts, and reassignments.

The web page uses the Canton JSON Ledger API to show Holding issuance, visibility, the transfer lifecycle, and reassignment of the same Holding between the two domains. A pure reassignment keeps the contract ID unchanged. This is for local research and demos only, and is not suitable for production.

## Layout

```text
cip56-demo/
  localnet/                 # Canton dual-synchronizer network
    docker-compose.yaml
    configs/                # Node config and bootstrap
    scripts/                # Console scripts for DAR upload, parties, and similar tasks
    dars/                   # Compiled runtime DARs
  src/                      # Frontend
  server/                   # Express API and initialization script
  README.md
```

The seven DARs required at startup, in `localnet/dars/`:

```text
simple-token-0.3.1.dar
splice-api-token-metadata-v1-1.0.0.dar
splice-api-token-holding-v1-1.0.0.dar
splice-api-token-transfer-instruction-v1-1.0.0.dar
splice-api-token-allocation-v1-1.0.0.dar
splice-api-token-allocation-instruction-v1-1.0.0.dar
splice-api-token-allocation-request-v1-1.0.0.dar
```

The directory may also contain `simple-token-0.1.0.dar`, `simple-token-0.2.0.dar`, or `simple-token-0.3.0.dar`. Those are leftover older versions. `upload-dars.canton` does not use them.

A normal deployment does not need Daml source. This directory does not include the `simple-token` Daml project. The DARs are already in `localnet/dars/`.

## Machine requirements

- Docker Engine or Docker Desktop, with `docker compose`;
- Node.js `20.19.0` or newer (current dependencies such as Vite 8 require this; `22.12.0+` is recommended);
- npm;
- access to the npm registry and `europe-docker.pkg.dev` (to pull the Canton image);
- `curl` is recommended, for startup checks and API verification.

The Canton image version is pinned to `3.4.9` in `localnet/docker-compose.yaml`.

A normal deployment does **not** need a local Daml SDK. Rebuilding `simple-token` requires Daml SDK / `dpm` `3.4.10` and Java 21.

## Ports

Every port is bound to the loopback address `127.0.0.1`. Do not change that to `0.0.0.0`, and do not expose the local services to the public internet with a tunnel.

| Port | Purpose |
| --- | --- |
| `5011`–`5013` | `participant-global` (Ledger API / Admin API / JSON API) |
| `5021`–`5023` | `participant-private` |
| `5031`–`5033` | `participant-shared`; the demo uses the JSON API on `5033` |
| `8787` | Demo backend API |
| `5173` | Vite frontend |

## Deploy

Run the commands below from the `cip56-demo/` root. A fresh machine starts from an empty ledger: Canton uses in-memory storage, so every `docker compose up` must be initialized from scratch. There is no recoverable onchain state.

### 1. Start Canton

```bash
cd localnet
docker compose up -d canton
docker compose ps canton
```

The first start pulls `canton-base:3.4.9`. How long that takes depends on the network.

Wait until the `participant-shared` JSON API is ready:

```bash
until curl -fsS http://127.0.0.1:5033/v2/state/ledger-end; do
  echo "Waiting for the Canton JSON API..."
  sleep 2
done
echo
```

A response such as `{"offset":0}` means it is ready. If startup fails, read the logs:

```bash
docker compose logs canton
```

### 2. Upload DARs and vet them on both synchronizers

Still inside `localnet/`:

```bash
docker compose run --rm --no-TTY \
  --entrypoint bin/canton \
  console run /canton/host/scripts/upload-dars.canton \
  -c /app/additional-config.conf --no-tty \
  --log-level-stdout WARN --log-file-appender off
```

`--entrypoint bin/canton` bypasses the image `entrypoint.sh`, so `-c /app/additional-config.conf` is required. That file is the mounted `configs/console.conf`. The party-creation command below has the same requirement.

The script uploads the six CIP-56 interface DARs and `simple-token-0.3.1.dar` to `participant-shared`, and registers a vetting transaction on `global-sync` and on `private-sync`. A package must be vetted on each synchronizer separately.

Success ends with `UPLOAD_DONE`, and every DAR line shows both `@ global-sync` and `@ private-sync`.

Do not upload `simple-token-0.1.0.dar`, `simple-token-0.2.0.dar`, or `simple-token-0.3.0.dar`. They share the package name `simple-token` with `0.3.1` but have different contents, so they are not an upgrade. From this step on the Ledger API requires an audience token. Check whether the packages uploaded after the next section prepares that token.

### 3. Prepare the audience token

The JSON Ledger API uses an audience JWT, not a scope. Copy the local secret file first:

```bash
cp .env.example .env
```

`LEDGER_API_JWT_SECRET` in `.env` is only for Canton on this machine. This local config marks the token as privileged, so a separate ledger user is not required. The demo signs a fresh token on each request, with a 60-second lifetime.

Confirm the holding package is on `participant-shared`. The package ID comes from the bundled `splice-api-token-holding-v1-1.0.0.dar`:

```bash
cd ..
TOKEN=$(npx tsx -e "import { audienceAuthorization } from './server/auth/audienceJwt.ts'; process.stdout.write(audienceAuthorization() ?? '')")
curl -fsS http://127.0.0.1:5033/v2/packages -H "authorization: $TOKEN" \
  | grep 718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b
cd localnet
```

Do not continue initialization if that line is missing.

### 4. Install dependencies and initialize contracts

```bash
cd ..
npm install
npm run initialize
```

`npm run initialize` generates local Ed25519 keys for `RegistryAdmin`, `Alice`, `Bob`, `Carol`, and `Dave`, and registers them as external parties on both synchronizers. Private keys are written to `cip56-demo/.custody/keys.json` and are not stored on the participant.

It then creates one of each of the following on `global-sync` and on `private-sync`:

- `VisibilityPolicy`
- `SimpleTokenRules`

Each create, and every later business submission, is authorized by a single party. The demo calls prepare, then hashes `preparedTransaction` with the local algorithm and signs that hash. It does not use `preparedTransactionHash` returned by the node.

Initialization uses `RegistryAdmin` as the administrator, adds every business party whose hint does not start with `participant-` to the policy readers, and adds `HSKD` to the supported instrument list. The script can be run again. When Policy and Rules already exist on a synchronizer, it prints `existing`.

**Initialization does not issue any Holding.**

### 5. Start the API and the frontend

```bash
npm run dev
```

That command starts both of these:

- Backend API: `http://127.0.0.1:8787`
- Frontend: `http://127.0.0.1:5173`

The backend always calls the Canton JSON API at `http://127.0.0.1:5033`. It does not accept an arbitrary upstream URL from the browser.

Open <http://127.0.0.1:5173> in a browser.

## Issue the first Holding

1. Select `RegistryAdmin` in the page party selector.
2. Fill in **Issuance amount**.
3. Select **Issuance receiver**.
4. Click **Issue Holding**. This only creates an issuance instruction. The only authorizer is RegistryAdmin.
5. Switch the party to the receiver and click **Accept issuance** on the ACS card. Only the receiver authorizes this step. The Holding appears after acceptance.

Only `RegistryAdmin` can create an issuance instruction. The backend checks that role separately. Transfer, accept, reject, withdraw, and refresh visibility each have a single authorizer.

The Holding list at the top of the page is a **global read-only overview** and has no action buttons. Transfer, refresh visibility, and reassignment live on the **Active Contract Set (ACS)** cards for the selected party.

Reassignment permission belongs to the **Holding owner**:

- Only the current owner of that Holding can start a reassignment.
- `RegistryAdmin` cannot reassign on the owner's behalf.
- A Holding locked by an incomplete transfer cannot be reassigned.

A pure reassignment keeps the contract ID and only increments `reassignmentCounter`. Accepting a transfer and refreshing visibility use archive plus recreate, so they produce a new contract ID.

## Verify

After `npm run dev` is running:

```bash
curl -fsS http://127.0.0.1:8787/api/party-catalog
curl -fsS http://127.0.0.1:8787/api/state
```

Project checks:

```bash
npm test
npm run lint
npm run build
```

Optional end-to-end test against a real ledger:

```bash
npm run test:e2e
```

`test:e2e` writes to the current in-memory ledger: it issues a Holding, withdraws, rejects, and accepts a transfer, updates the allowlist, refreshes visibility, and reassigns the Holding to `private-sync`. Run it only where test data is acceptable.

## In-memory storage and recovery

Every sequencer, mediator, and the three participants use **in-memory storage**. `docker compose down`, recreating the `canton` container, or restarting Docker clears topology, DAR vetting, parties, and every contract. That is expected.

A first deployment on another machine is also a fresh initialization. There is no prior onchain state to reuse.

After a restart, repeat these four steps in order (`npm install` does not need to be repeated):

1. `cd localnet && docker compose up -d canton`, and wait until `5033` is ready.
2. Run `upload-dars.canton`.
3. Confirm the audience secret is still in `localnet/.env`.
4. `cd .. && npm run initialize`, then issue a Holding again in the UI as `RegistryAdmin`. If `.custody/keys.json` is still present, the same external-party keys are reused.

## Troubleshooting

### `npm run dev` is up, but the page has no data

Check that Canton is running and that DARs and parties have been initialized:

```bash
curl -fsS http://127.0.0.1:5033/v2/state/ledger-end
curl -fsS http://127.0.0.1:8787/api/party-catalog
```

An empty party catalog means `npm run initialize` did not finish, or the container was restarted and the external parties have not been registered again.

### Error `package names do not match upgradable packages` / `splice-api-token-holding-v1`

This is Canton's 3.4 `PACKAGE_NAMES_NOT_FOUND`. ACS reads, state refresh, and issuance all reference the package name `#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding`. If that name is missing from the participant's upgradeable package-name table, the request is rejected immediately.

The bundled holding DAR metadata is:

- package name: `splice-api-token-holding-v1`
- package version: `1.0.0`
- package id: `718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b`

Seeing `RegistryAdmin` in the party dropdown only means party creation succeeded. It does not mean the DAR was uploaded. A log title such as "Unable to read ledger state" refers to the node that hosts the JSON API, not a query for a party named `participant-shared`.

What to do:

1. From `cip56-demo/localnet`, re-run `upload-dars.canton` with the command in this README that includes `-c /app/additional-config.conf`.
2. Confirm the output contains `splice-api-token-holding-v1-1.0.0.dar @ global-sync`, `@ private-sync`, and `UPLOAD_DONE`. An older command that omitted `-c` fails immediately and uploads nothing.
3. Use the `curl /v2/packages | grep 718a0f77...` command from the previous section to confirm the package ID is on `5033`.
4. From `cip56-demo`, run `npm run initialize` again. Do not upload `simple-token-0.1.0.dar`.
5. The image must be `canton-base:3.4.9`. Do not switch to another Canton version.

### Port already in use

Stop the process or other Compose project that holds a port from the table above, then start again. Do not rebind the port to `0.0.0.0` to work around the conflict.

### Issue returns 403

The issue actor must be `RegistryAdmin`. Switch identity in the party selector, and confirm party creation and `npm run initialize` have already run.

### A Holding cannot be reassigned

Check that the selected party is that Holding's owner, the Holding is not locked by an incomplete transfer, the action is on an ACS contract card rather than the read-only list at the top, and the source synchronizer matches the domain that currently hosts the contract. The Canton 3.4 reassignment API has no external-signature field, so an external party cannot complete a reassignment today. Issue, accept, transfer, withdraw, and refresh go through prepare and then a local signature.

### The top list has no action buttons

That is intentional. The top list is a summary. Every contract-level action is on an ACS card below it.

## Rebuild simple-token (optional)

This directory does not contain Daml source. If `canton-token-template/` is next to it, and this machine has Daml SDK 3.4.10 and Java 17:

```bash
cd ../canton-token-template/simple-token
dpm build
cp .daml/dist/simple-token-0.3.1.dar ../../cip56-demo/localnet/dars/
```

After a rebuild, repeat DAR upload and every step after it. Without that source, use the DARs already in `localnet/dars/`.

## Stop

Press `Ctrl+C` in the terminal running `npm run dev`, then:

```bash
cd localnet
docker compose down
```

`docker compose down` drops the current in-memory ledger. The next start must be initialized again with the recovery steps above.
