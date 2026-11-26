#!/usr/bin/env bash
#
# Provisions everything the OAuth token-mediating backend needs in Google
# Cloud and in this GitHub repository. Idempotent: run it as often as you
# like; a second run changes nothing.
#
# Prerequisites
#   - gcloud authenticated as a project owner, and the project on the Blaze plan
#   - gh authenticated with admin rights on the repository
#   - node, for the Firebase CLI (run through npx), which deploys the Firestore
#     security rules. It uses `firebase login` or application-default
#     credentials.
#
# What it creates
#   - a Cloud KMS key ring with one EC P-256 signing key per OAuth client.
#     Keys are generated inside KMS and cannot be exported. KEY RINGS AND KEYS
#     CAN NEVER BE DELETED OR RENAMED, so the names below are permanent.
#   - a Firestore database of its own for the refresh replay store, closed to
#     every client by its security rules, with a TTL policy that deletes
#     entries a day after they are written
#   - the function's runtime service account, allowed to sign with those keys
#     and to use that one database, and nothing else
#   - a deploy service account that GitHub Actions impersonates through
#     Workload Identity Federation, only from the main branch of this repo.
#     No service-account key is ever created.
#   - a budget alert
#   - log-based metrics and alert policies for the backend
#   - the GitHub "production" environment (approval required) and the two
#     repository variables the deploy workflow reads
#
# Usage: infra/provision.sh [--dry-run]

set -euo pipefail

# Never stop to ask. With an API still disabled, gcloud would otherwise wait
# for a "enable it and retry?" answer, even during --dry-run.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="nubecita-2a4c1"
REPO="kikin81/nubecita-web"
DEPLOY_BRANCH="main"

KMS_LOCATION="us"
KMS_KEYRING="oauth-client-auth"
# One key per published client metadata file.
KMS_KEYS=("nubecita-prod" "nubecita-test" "nubecita-rehearsal")

# The refresh replay store (functions/src/replayStore.ts). The names must match
# functions/src/config.ts and firebase.json. A DATABASE'S LOCATION CAN NEVER BE
# CHANGED; it is the region the function runs in.
REPLAY_DATABASE="oauth-replay"
REPLAY_LOCATION="us-central1"
REPLAY_COLLECTION="refreshReplay"
REPLAY_TTL_FIELD="expireAt"

RUNTIME_SA_NAME="oauth-mediator"
DEPLOY_SA_NAME="github-deployer"
WIF_POOL="github"
WIF_PROVIDER="nubecita-web"

BUDGET_NAME="Nubecita OAuth backend"

# Where alerts are sent. Cloudflare Email Routing forwards this address.
ALERT_EMAIL="alerts@nubecita.app"
ALERT_CHANNEL_NAME="Nubecita backend alerts"
BUDGET_AMOUNT="5USD"

RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
APPSPOT_SA="${PROJECT_ID}@appspot.gserviceaccount.com"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

say() { printf '\n==> %s\n' "$*"; }

# For some minutes after an API is enabled, calls to it fail at random with
# "has not been used in project ... or it is disabled". Those are retried;
# every other failure is real.
api_not_ready() { [[ "$1" == *"it is disabled"* || "$1" == *"SERVICE_DISABLED"* ]]; }

run() {
  if $DRY_RUN; then
    # To stderr, so a caller that silences a command's output still sees it.
    printf '   [dry-run] %s\n' "$*" >&2
    return 0
  fi
  local output attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if output="$("$@" 2>&1)"; then
      [[ -n "$output" ]] && printf '%s\n' "$output"
      return 0
    fi
    # A resource created a moment ago (a service account, say) can also be
    # reported as missing by the next call that refers to it.
    if { ! api_not_ready "$output" && [[ "$output" != *"does not exist"* && "$output" != *"or it may not exist"* ]]; } ||
      ((attempt == 8)); then
      printf '%s\n' "$output" >&2
      return 1
    fi
    sleep 10
  done
}

# Prints a read-only command's output, retrying while its API is not ready.
query() {
  local output attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if output="$("$@" 2>/dev/null)"; then
      printf '%s\n' "$output"
      return 0
    fi
    output="$("$@" 2>&1 || true)"
    if ! api_not_ready "$output"; then return 1; fi
    ((attempt == 8)) || sleep 10
  done
  return 1
}

# True when the resource exists. A "not ready" answer is not a "no".
exists() {
  local output attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if output="$("$@" 2>&1)"; then return 0; fi
    if ! api_not_ready "$output"; then return 1; fi
    ((attempt == 8)) || sleep 10
  done
  echo "   API still not ready: $*" >&2
  exit 1
}

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

say "APIs"
run gcloud services enable --project "$PROJECT_ID" \
  cloudfunctions.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  eventarc.googleapis.com \
  cloudkms.googleapis.com \
  firestore.googleapis.com \
  firebaserules.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  firebasehosting.googleapis.com \
  firebaseextensions.googleapis.com \
  cloudbilling.googleapis.com \
  billingbudgets.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com

say "KMS key ring ${KMS_KEYRING} (${KMS_LOCATION})"
if exists gcloud kms keyrings describe "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT_ID"; then
  echo "   exists"
else
  run gcloud kms keyrings create "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT_ID"
fi

for key in "${KMS_KEYS[@]}"; do
  say "KMS signing key ${key}"
  if exists gcloud kms keys describe "$key" --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT_ID"; then
    echo "   exists"
  else
    run gcloud kms keys create "$key" \
      --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT_ID" \
      --purpose asymmetric-signing \
      --default-algorithm ec-sign-p256-sha256 \
      --protection-level software
  fi
done

say "Runtime service account ${RUNTIME_SA}"
if exists gcloud iam service-accounts describe "$RUNTIME_SA" --project "$PROJECT_ID"; then
  echo "   exists"
else
  run gcloud iam service-accounts create "$RUNTIME_SA_NAME" --project "$PROJECT_ID" \
    --display-name "OAuth token-mediating backend (runtime)"
fi
# Granted per key, never project-wide: this identity can sign with these keys
# and read their public halves. Its only other grant is the replay database,
# further down.
for key in "${KMS_KEYS[@]}"; do
  run gcloud kms keys add-iam-policy-binding "$key" \
    --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT_ID" \
    --member "serviceAccount:${RUNTIME_SA}" \
    --role roles/cloudkms.signerVerifier \
    --condition None >/dev/null
done

say "Firestore database ${REPLAY_DATABASE} (${REPLAY_LOCATION})"
# A database of its own rather than a collection in (default): access is
# granted per database, so this is what keeps the runtime identity out of
# anything else the project ever stores in Firestore.
if exists gcloud firestore databases describe --database "$REPLAY_DATABASE" --project "$PROJECT_ID"; then
  echo "   exists"
else
  run gcloud firestore databases create --database "$REPLAY_DATABASE" --project "$PROJECT_ID" \
    --location "$REPLAY_LOCATION" --type firestore-native
fi

say "Firestore security rules (deny every client)"
# The backend reaches the database as its service account, which rules do not
# apply to. Everyone else, including any app holding the project's public API
# key, is refused. Deploying rules that are already live changes nothing.
run npx --yes firebase-tools@15 deploy --only firestore:rules \
  --project "$PROJECT_ID" --config "${REPO_ROOT}/firebase.json" --non-interactive

say "Firestore TTL policy on ${REPLAY_COLLECTION}.${REPLAY_TTL_FIELD}"
# Entries stop being served 24 hours after they are written (the backend
# checks on read); this is what removes them from disk afterwards.
if query gcloud firestore fields ttls list --database "$REPLAY_DATABASE" --project "$PROJECT_ID" \
  --collection-group "$REPLAY_COLLECTION" --format='value(name)' | grep -q "/fields/${REPLAY_TTL_FIELD}\$"; then
  echo "   exists"
else
  # --async: turning a TTL policy on can take many minutes to finish.
  run gcloud firestore fields ttls update "$REPLAY_TTL_FIELD" --database "$REPLAY_DATABASE" --project "$PROJECT_ID" \
    --collection-group "$REPLAY_COLLECTION" --enable-ttl --async
fi

say "Replay store access for ${RUNTIME_SA}"
# Read and write documents in the replay database only. The condition's title
# is part of the binding's identity: changing it would add a second binding
# instead of replacing this one.
run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${RUNTIME_SA}" \
  --role roles/datastore.user \
  --condition "expression=resource.name==\"projects/${PROJECT_ID}/databases/${REPLAY_DATABASE}\",title=oauth-replay-database-only,description=OAuth backend refresh replay store" >/dev/null

say "Deploy service account ${DEPLOY_SA}"
if exists gcloud iam service-accounts describe "$DEPLOY_SA" --project "$PROJECT_ID"; then
  echo "   exists"
else
  run gcloud iam service-accounts create "$DEPLOY_SA_NAME" --project "$PROJECT_ID" \
    --display-name "GitHub Actions deploy (nubecita-web)"
fi
# What `firebase deploy --only functions,hosting` needs. It gets no KMS role:
# the identity that ships code cannot sign with the client keys.
DEPLOY_ROLES=(
  roles/cloudfunctions.admin
  roles/run.admin
  roles/firebasehosting.admin
  roles/firebaseextensions.viewer
  roles/artifactregistry.admin
  roles/serviceusage.serviceUsageConsumer
)
for role in "${DEPLOY_ROLES[@]}"; do
  run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${DEPLOY_SA}" --role "$role" --condition None >/dev/null
done
# Deploying a function that runs as the runtime identity requires acting as it.
run gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project "$PROJECT_ID" \
  --member "serviceAccount:${DEPLOY_SA}" --role roles/iam.serviceAccountUser --condition None >/dev/null

# firebase-tools refuses to deploy functions unless the deployer may act as the
# project's default App Engine service account, whichever identity the
# function actually runs as. Google creates that account with the project-wide
# Editor role. Nothing in this project runs as it (no App Engine app, and the
# function has its own identity), so Editor is removed first: the deployer
# then gets to "act as" an account that can do nothing.
#
# To undo: gcloud projects add-iam-policy-binding nubecita-2a4c1 \
#   --member serviceAccount:nubecita-2a4c1@appspot.gserviceaccount.com --role roles/editor
say "Default App Engine service account ${APPSPOT_SA}"
if query gcloud projects get-iam-policy "$PROJECT_ID" --flatten 'bindings[].members' \
  --filter "bindings.role=roles/editor AND bindings.members=serviceAccount:${APPSPOT_SA}" \
  --format 'value(bindings.role)' | grep -qx roles/editor; then
  run gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${APPSPOT_SA}" --role roles/editor --condition None >/dev/null
  echo "   removed roles/editor"
else
  echo "   holds no Editor role"
fi
run gcloud iam service-accounts add-iam-policy-binding "$APPSPOT_SA" --project "$PROJECT_ID" \
  --member "serviceAccount:${DEPLOY_SA}" --role roles/iam.serviceAccountUser --condition None >/dev/null

# 2nd-gen functions are BUILT as the Compute Engine default service account,
# and creating one requires acting as that account too. It is also created
# with project-wide Editor and is otherwise unused here (the Compute Engine
# API is off). It has to keep the ability to build, so Editor is swapped for
# the Cloud Build builder role: enough to build and store the function's
# image, and nothing else. The builder role is added before Editor is removed,
# so the account is never left unable to build.
#
# To undo: gcloud projects add-iam-policy-binding nubecita-2a4c1 \
#   --member serviceAccount:<project-number>-compute@developer.gserviceaccount.com --role roles/editor
say "Build service account ${BUILD_SA}"
run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${BUILD_SA}" --role roles/cloudbuild.builds.builder --condition None >/dev/null
if query gcloud projects get-iam-policy "$PROJECT_ID" --flatten 'bindings[].members' \
  --filter "bindings.role=roles/editor AND bindings.members=serviceAccount:${BUILD_SA}" \
  --format 'value(bindings.role)' | grep -qx roles/editor; then
  run gcloud projects remove-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${BUILD_SA}" --role roles/editor --condition None >/dev/null
  echo "   swapped roles/editor for roles/cloudbuild.builds.builder"
else
  echo "   holds no Editor role"
fi
run gcloud iam service-accounts add-iam-policy-binding "$BUILD_SA" --project "$PROJECT_ID" \
  --member "serviceAccount:${DEPLOY_SA}" --role roles/iam.serviceAccountUser --condition None >/dev/null

say "Workload Identity Federation (${REPO}@${DEPLOY_BRANCH} only)"
if exists gcloud iam workload-identity-pools describe "$WIF_POOL" --location global --project "$PROJECT_ID"; then
  echo "   pool exists"
else
  run gcloud iam workload-identity-pools create "$WIF_POOL" --location global --project "$PROJECT_ID" \
    --display-name "GitHub Actions"
fi
if exists gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
  --workload-identity-pool "$WIF_POOL" --location global --project "$PROJECT_ID"; then
  echo "   provider exists"
else
  run gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
    --workload-identity-pool "$WIF_POOL" --location global --project "$PROJECT_ID" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository=='${REPO}' && assertion.ref=='refs/heads/${DEPLOY_BRANCH}'"
fi
WIF_POOL_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}"
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --project "$PROJECT_ID" \
  --member "principalSet://iam.googleapis.com/${WIF_POOL_RESOURCE}/attribute.repository/${REPO}" \
  --role roles/iam.workloadIdentityUser --condition None >/dev/null

say "Budget alert (${BUDGET_AMOUNT})"
# --billing-project: bill these API calls to this project rather than to
# whatever quota project the local gcloud defaults to.
BILLING_ACCOUNT="$(query gcloud billing projects describe "$PROJECT_ID" --billing-project "$PROJECT_ID" \
  --format='value(billingAccountName)' | sed 's#billingAccounts/##' || true)"
if [[ -z "$BILLING_ACCOUNT" ]]; then
  if $DRY_RUN; then
    echo "   [dry-run] billing account not readable until the APIs above are enabled; would create the budget"
  else
    echo "   no billing account readable: is the project on the Blaze plan?" >&2
    exit 1
  fi
elif query gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --billing-project "$PROJECT_ID" \
  --format='value(displayName)' | grep -qx "$BUDGET_NAME"; then
  echo "   exists"
else
  run gcloud billing budgets create --billing-account "$BILLING_ACCOUNT" --billing-project "$PROJECT_ID" \
    --display-name "$BUDGET_NAME" \
    --budget-amount "$BUDGET_AMOUNT" \
    --filter-projects "projects/${PROJECT_NUMBER}" \
    --threshold-rule percent=0.5 \
    --threshold-rule percent=0.9 \
    --threshold-rule percent=1.0
fi

say "Log-based metrics"
# The backend writes one structured line per request (functions/src/log.ts).
# Each metric counts lines matching a filter on those fields.
BASE_FILTER='resource.type="cloud_run_revision" AND jsonPayload.message="oauth_mediator_request"'
metric() { # name, description, extra filter
  if exists gcloud logging metrics describe "$1" --project "$PROJECT_ID"; then
    echo "   $1 exists"
  else
    run gcloud logging metrics create "$1" --project "$PROJECT_ID" \
      --description "$2" --log-filter "${BASE_FILTER} AND $3"
  fi
}
metric oauth_mediator_backend_errors \
  "Requests the backend failed itself (5xx it produced, not relayed)" \
  'jsonPayload.origin="mediator" AND jsonPayload.status>=500'
metric oauth_mediator_relayed_invalid_grant \
  "invalid_grant answers relayed from authorization servers: each one ends a session" \
  'jsonPayload.upstreamError="invalid_grant"'
metric oauth_mediator_signin_attestation_failures \
  "Sign-in requests without a valid App Check token" \
  '(jsonPayload.kind="par" OR jsonPayload.kind="code_exchange") AND jsonPayload.attestation!="valid"'
metric oauth_mediator_replay_store_failures \
  "Refreshes the replay store could not be consulted for, or could not record" \
  'jsonPayload.replayStore:*'

say "Alert policies"
if query gcloud beta monitoring channels list --project "$PROJECT_ID" --format='value(displayName)' | grep -qxF "$ALERT_CHANNEL_NAME"; then
  echo "   notification channel exists"
else
  run gcloud beta monitoring channels create --project "$PROJECT_ID" \
    --display-name "$ALERT_CHANNEL_NAME" --type email \
    --channel-labels "email_address=${ALERT_EMAIL}" >/dev/null
fi
# Only this script's own channel: other channels in the project belong to
# other alerts.
CHANNELS="$(query gcloud beta monitoring channels list --project "$PROJECT_ID" \
  --filter "displayName=\"${ALERT_CHANNEL_NAME}\"" --format='value(name)' || true)"
CHANNELS_JSON="$(printf '%s\n' "$CHANNELS" | sed '/^$/d' | sed 's/.*/"&"/' | paste -sd, -)"
CHANNELS_CSV="$(printf '%s\n' "$CHANNELS" | sed '/^$/d' | paste -sd, -)"
# One "<resource name><TAB><display name>" line per policy.
EXISTING_POLICIES="$(query gcloud monitoring policies list --project "$PROJECT_ID" --format='value(name,displayName)' || true)"
policy() { # display name, metric, threshold, window seconds, documentation
  local existing
  existing="$(awk -F'\t' -v wanted="$1" '$2 == wanted {print $1; exit}' <<<"$EXISTING_POLICIES")"
  if [[ -n "$existing" ]]; then
    if [[ -n "$CHANNELS_CSV" ]]; then
      # Keeps an existing policy pointed at whatever channels exist now.
      run gcloud monitoring policies update "$existing" --project "$PROJECT_ID" \
        --set-notification-channels "$CHANNELS_CSV" >/dev/null
      echo "   $1 exists (notification channels synced)"
    else
      echo "   $1 exists"
    fi
    return
  fi
  local file
  file="$(mktemp)"
  cat >"$file" <<JSON
{
  "displayName": "$1",
  "combiner": "OR",
  "documentation": {"content": "$5", "mimeType": "text/markdown"},
  "notificationChannels": [${CHANNELS_JSON}],
  "conditions": [
    {
      "displayName": "$1",
      "conditionThreshold": {
        "filter": "metric.type=\"logging.googleapis.com/user/$2\" AND resource.type=\"cloud_run_revision\"",
        "aggregations": [
          {"alignmentPeriod": "${4}s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM"}
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": $3,
        "duration": "0s",
        "trigger": {"count": 1}
      }
    }
  ]
}
JSON
  run gcloud monitoring policies create --project "$PROJECT_ID" --policy-from-file "$file" >/dev/null
  rm -f "$file"
}
# Thresholds are starting points; tune them once real traffic shows the baseline.
policy "OAuth backend: errors" oauth_mediator_backend_errors 5 300 \
  "The backend itself is failing requests. Apps keep their sessions but cannot refresh. While the production client is still public, turning on bypass mode (MEDIATOR_BYPASS=true) sends apps to the direct path."
policy "OAuth backend: relayed invalid_grant spike" oauth_mediator_relayed_invalid_grant 20 600 \
  "Authorization servers are ending sessions at an unusual rate. Check for a reused jti, a wrong signing key, or a client metadata change."
policy "OAuth backend: sign-in attestation failures" oauth_mediator_signin_attestation_failures 20 600 \
  "Many sign-ins lack a valid App Check token. Check Play Integrity quota and the App Check console before turning enforcement on."
policy "OAuth backend: replay store failures" oauth_mediator_replay_store_failures 5 600 \
  "The refresh replay store (Firestore database oauth-replay) is failing. With replayStore=unavailable refreshes are being refused; with write_failed they go through but a lost response would end the session. Check the database exists and that the runtime service account still has its conditional roles/datastore.user binding."

say "GitHub environment and variables"
REVIEWER_ID="$(gh api user --jq .id)"
if $DRY_RUN; then
  echo "   [dry-run] create environment 'production' (reviewer ${REVIEWER_ID}, ${DEPLOY_BRANCH} only) and set repo variables"
else
  gh api --method PUT "repos/${REPO}/environments/production" --input - >/dev/null <<JSON
{
  "reviewers": [{"type": "User", "id": ${REVIEWER_ID}}],
  "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}
}
JSON
  if ! gh api "repos/${REPO}/environments/production/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx "$DEPLOY_BRANCH"; then
    gh api --method POST "repos/${REPO}/environments/production/deployment-branch-policies" \
      -f name="$DEPLOY_BRANCH" -f type=branch >/dev/null
  fi
  gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$REPO" \
    --body "${WIF_POOL_RESOURCE}/providers/${WIF_PROVIDER}"
  gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo "$REPO" --body "$DEPLOY_SA"
fi

say "Done"
echo "   Public keys for client metadata: infra/export-jwk.sh <key> <version> <kid>"
