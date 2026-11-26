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
#   - the GitHub "production" environment (approval required) and the two
#     repository variables the deploy workflow reads
#
# Usage: infra/provision.sh [--dry-run]

set -euo pipefail

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
    printf '   [dry-run] %s\n' "$*"
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
  billingbudgets.googleapis.com

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
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
if [[ -z "$BILLING_ACCOUNT" ]]; then
  echo "   no billing account linked: upgrade the project to Blaze first" >&2
  exit 1
fi
if gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --format='value(displayName)' | grep -qx "$BUDGET_NAME"; then
  echo "   exists"
else
  run gcloud billing budgets create --billing-account "$BILLING_ACCOUNT" \
    --display-name "$BUDGET_NAME" \
    --budget-amount "$BUDGET_AMOUNT" \
    --filter-projects "projects/${PROJECT_NUMBER}" \
    --threshold-rule percent=0.5 \
    --threshold-rule percent=0.9 \
    --threshold-rule percent=1.0
fi

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
