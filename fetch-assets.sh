#!/usr/bin/env sh
# Downloads the pose-estimation runtime and models into web/vendor (about 25 MB). Run once.
set -eu
cd "$(dirname "$0")/web"
mkdir -p vendor/wasm
tmp=$(mktemp -d)
curl -fsSL https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.14.tgz | tar xz -C "$tmp"
cp "$tmp/package/vision_bundle.mjs" vendor/
cp "$tmp/package/wasm/vision_wasm_internal.js" "$tmp/package/wasm/vision_wasm_internal.wasm" vendor/wasm/
rm -rf "$tmp"
for m in full lite; do
  curl -fsSL -o "vendor/pose_landmarker_$m.task" \
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_$m/float16/1/pose_landmarker_$m.task"
done
echo "Assets ready in web/vendor:"; ls -la vendor vendor/wasm
