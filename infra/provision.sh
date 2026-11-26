#!/usr/bin/env bash
#
# Provisions everything the OAuth token-mediating backend needs in Google
# Cloud and in this GitHub repository. Idempotent: run it as often as you
# like; a second run changes nothing.
#
# Prerequisites
#   - gcloud authenticated as a project owner, and the project on the Blaze plan
#   - gh authenticated with admin rights on the repository
#
# What it creates
#   - a Cloud KMS key ring with one EC P-256 signing key per OAuth client.
#     Keys are generated inside KMS and cannot be exported. KEY RINGS AND KEYS
#     CAN NEVER BE DELETED OR RENAMED, so the names below are permanent.
#   - the function's runtime service account, allowed to sign with those keys
#     and nothing else
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

RUNTIME_SA_NAME="oauth-mediator"
DEPLOY_SA_NAME="github-deployer"
WIF_POOL="github"
WIF_PROVIDER="nubecita-web"

BUDGET_NAME="Nubecita OAuth backend"
BUDGET_AMOUNT="5USD"

RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

say() { printf '\n==> %s\n' "$*"; }
run() {
  if $DRY_RUN; then
    # To stderr, so a caller that silences a command's output still sees it.
    printf '   [dry-run] %s\n' "$*" >&2
  else
    "$@"
  fi
}
exists() { "$@" >/dev/null 2>&1; }

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

say "APIs"
run gcloud services enable --project "$PROJECT_ID" \
  cloudfunctions.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  eventarc.googleapis.com \
  cloudkms.googleapis.com \
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
# and read their public halves, and can do nothing else.
for key in "${KMS_KEYS[@]}"; do
  run gcloud kms keys add-iam-policy-binding "$key" \
    --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT_ID" \
    --member "serviceAccount:${RUNTIME_SA}" \
    --role roles/cloudkms.signerVerifier \
    --condition None >/dev/null
done

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
  --member "serviceAccount:${DEPLOY_SA}" --role roles/iam.serviceAccountUser >/dev/null

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
  --role roles/iam.workloadIdentityUser >/dev/null

say "Budget alert (${BUDGET_AMOUNT})"
# --billing-project: bill these API calls to this project rather than to
# whatever quota project the local gcloud defaults to.
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT_ID" --billing-project "$PROJECT_ID" \
  --format='value(billingAccountName)' 2>/dev/null | sed 's#billingAccounts/##' || true)"
if [[ -z "$BILLING_ACCOUNT" ]]; then
  if $DRY_RUN; then
    echo "   [dry-run] billing account not readable until the APIs above are enabled; would create the budget"
  else
    echo "   no billing account readable: is the project on the Blaze plan?" >&2
    exit 1
  fi
elif gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --billing-project "$PROJECT_ID" \
  --format='value(displayName)' 2>/dev/null | grep -qx "$BUDGET_NAME"; then
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

say "Alert policies"
CHANNELS="$(gcloud beta monitoring channels list --project "$PROJECT_ID" --format='value(name)' 2>/dev/null || true)"
if [[ -z "$CHANNELS" ]]; then
  echo "   no notification channel in this project yet: policies will be created but notify no one."
  echo "   Add one in Cloud Monitoring -> Alerting -> Edit notification channels, then re-run this script."
fi
CHANNELS_JSON="$(printf '%s\n' "$CHANNELS" | sed '/^$/d' | sed 's/.*/"&"/' | paste -sd, -)"
EXISTING_POLICIES="$(gcloud alpha monitoring policies list --project "$PROJECT_ID" --format='value(displayName)' 2>/dev/null || true)"
policy() { # display name, metric, threshold, window seconds, documentation
  if grep -qxF "$1" <<<"$EXISTING_POLICIES"; then
    echo "   $1 exists"
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
  run gcloud alpha monitoring policies create --project "$PROJECT_ID" --policy-from-file "$file" >/dev/null
  rm -f "$file"
}
# Thresholds are starting points; tune them once real traffic shows the baseline.
policy "OAuth backend: errors" oauth_mediator_backend_errors 5 300 \
  "The backend itself is failing requests. Apps keep their sessions but cannot refresh. While the production client is still public, turning on bypass mode (MEDIATOR_BYPASS=true) sends apps to the direct path."
policy "OAuth backend: relayed invalid_grant spike" oauth_mediator_relayed_invalid_grant 20 600 \
  "Authorization servers are ending sessions at an unusual rate. Check for a reused jti, a wrong signing key, or a client metadata change."
policy "OAuth backend: sign-in attestation failures" oauth_mediator_signin_attestation_failures 20 600 \
  "Many sign-ins lack a valid App Check token. Check Play Integrity quota and the App Check console before turning enforcement on."

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
