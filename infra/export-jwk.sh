#!/usr/bin/env bash
#
# Prints the public half of a client signing key as the JWK to put in a client
# metadata file's "jwks". The private half never leaves Cloud KMS.
#
# Usage:   infra/export-jwk.sh <key> <version> <kid>
# Example: infra/export-jwk.sh nubecita-test 1 test-1

set -euo pipefail

if [[ $# -ne 3 ]]; then
  sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi

KEY="$1"
VERSION="$2"
KID="$3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -f "$ROOT/functions/lib/jwk.js" ]]; then
  echo "Build the functions first: (cd functions && npm ci && npm run build)" >&2
  exit 1
fi

gcloud kms keys versions get-public-key "$VERSION" \
  --key "$KEY" --keyring oauth-client-auth --location us --project nubecita-2a4c1 \
  | KID="$KID" node -e '
      const {publicJwkFromPem} = require(process.argv[1]);
      let pem = "";
      process.stdin.on("data", (chunk) => (pem += chunk));
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify(publicJwkFromPem(pem, process.env.KID), null, 2) + "\n");
      });
    ' "$ROOT/functions/lib/jwk.js"
