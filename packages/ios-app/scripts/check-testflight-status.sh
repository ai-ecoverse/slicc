#!/bin/bash
# Print TestFlight build status for SliccFollower from the local App
# Store Connect API key (the same one setup-testflight-secrets.sh
# expects in ~/.appstoreconnect/private_keys/).
#
#   processingState meanings:
#     PROCESSING  - Apple is still scanning + extracting symbols
#     VALID       - Ready to add testers / submit for review
#     INVALID     - Apple rejected the bundle (check email for details)
#     FAILED      - Generic failure
#
# Usage:
#   packages/ios-app/scripts/check-testflight-status.sh                 # default key/issuer/bundle
#   APPLE_API_KEY_ID=... APPLE_API_KEY_ISSUER_ID=... ./check-testflight-status.sh
#
# Requires: python3 with PyJWT and cryptography (`pip install pyjwt cryptography`).
set -euo pipefail

KEY_ID="${APPLE_API_KEY_ID:-DWXPL9LU63}"
ISSUER="${APPLE_API_KEY_ISSUER_ID:-13125f6b-67e9-4fa2-9c4a-ec54dc1fc873}"
BUNDLE="${APPLE_BUNDLE_ID:-com.sliccy.follower}"
P8="${APPLE_API_KEY_P8_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8}"

if [ ! -f "$P8" ]; then
  echo "error: API key not found at $P8" >&2
  exit 1
fi

KEY_ID="$KEY_ID" ISSUER="$ISSUER" BUNDLE="$BUNDLE" P8="$P8" python3 - <<'PY'
import jwt, time, json, os, sys, urllib.request, urllib.parse, pathlib

KEY_ID = os.environ["KEY_ID"]
ISSUER = os.environ["ISSUER"]
BUNDLE = os.environ["BUNDLE"]
P8     = pathlib.Path(os.environ["P8"])

token = jwt.encode(
    {"iss": ISSUER, "iat": int(time.time()), "exp": int(time.time()) + 20 * 60, "aud": "appstoreconnect-v1"},
    P8.read_text(),
    algorithm="ES256",
    headers={"kid": KEY_ID, "typ": "JWT"},
)

def call(path):
    req = urllib.request.Request(
        f"https://api.appstoreconnect.apple.com{path}",
        headers={"Authorization": f"Bearer {token}"})
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode()}

apps = call(f"/v1/apps?filter[bundleId]={urllib.parse.quote(BUNDLE)}")
if "data" not in apps or not apps["data"]:
    print("App lookup failed:", json.dumps(apps, indent=2))
    sys.exit(1)
app = apps["data"][0]
print(f"App: {app['attributes']['name']} ({BUNDLE}) id={app['id']}")

builds = call(
    f"/v1/builds?filter[app]={app['id']}"
    "&sort=-uploadedDate&limit=10"
    "&fields[builds]=version,uploadedDate,processingState,expired,minOsVersion"
)
print(f"\n{'Build':<8} {'State':<14} {'Uploaded':<26} {'Expired':<8} {'Min OS'}")
print("-" * 72)
for b in builds.get("data", []):
    a = b["attributes"]
    print(f"{a['version']:<8} {a['processingState']:<14} {a['uploadedDate']:<26} {str(a.get('expired')):<8} {a.get('minOsVersion','-')}")
if not builds.get("data"):
    print("(no builds yet)")
PY
