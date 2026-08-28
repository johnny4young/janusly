#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
image=${IMAGE:-janusly:supply-chain}
artifact_dir=${SUPPLY_CHAIN_DIR:-$root/artifacts/supply-chain}
sbom_generator=${JANUSLY_BUILDKIT_SBOM_GENERATOR:-docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9}
syft_image=${JANUSLY_SYFT_IMAGE:-anchore/syft@sha256:95fe0835e5bebc6f8b1f8acef68d47d63d594ef4c0f25c097ff853b23cbac74c}
work_dir=

umask 077

die() {
  printf 'supply-chain-local: %s\n' "$*" >&2
  exit 2
}

validate_configuration() {
  [[ "$image" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
    die 'IMAGE must be an explicit local repository:tag reference'
  [[ "$sbom_generator" =~ @sha256:[0-9a-f]{64}$ ]] ||
    die 'JANUSLY_BUILDKIT_SBOM_GENERATOR must be pinned by sha256 digest'
  [[ "$syft_image" =~ @sha256:[0-9a-f]{64}$ ]] ||
    die 'JANUSLY_SYFT_IMAGE must be pinned by sha256 digest'
  [[ "$artifact_dir" == /* ]] || artifact_dir=$root/$artifact_dir
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then rm -rf -- "$work_dir"; fi
  exit "$exit_status"
}

validate_configuration
if [[ ${JANUSLY_SUPPLY_CHAIN_SELFTEST:-0} == 1 ]]; then
  jq -n \
    --arg image "$image" \
    --arg sbomGenerator "$sbom_generator" \
    --arg syftImage "$syft_image" \
    '{image:$image,sbomGenerator:$sbomGenerator,syftImage:$syftImage,provenanceMode:"max",spdxVersion:"SPDX-2.3",signed:false,published:false}'
  exit 0
fi

for command in docker git jq shasum; do
  command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
done
bash "$root/scripts/assert-clean-source.sh"
[[ ! -e "$artifact_dir" && ! -L "$artifact_dir" ]] ||
  die "artifact directory already exists: $artifact_dir"
mkdir -p "$(dirname -- "$artifact_dir")"
work_dir=$(mktemp -d "${artifact_dir}.tmp.XXXXXX")
trap cleanup EXIT INT TERM

commit=$(git -C "$root" rev-parse HEAD)
tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
short_commit=$(git -C "$root" rev-parse --short HEAD)
metadata=$work_dir/build-metadata.json

docker build \
  --provenance=mode=max \
  --attest="type=sbom,generator=$sbom_generator" \
  --metadata-file "$metadata" \
  --build-arg "JANUSLY_BUILD_COMMIT=$commit" \
  --build-arg "JANUSLY_BUILD_TREE=$tree" \
  --build-arg "JANUSLY_BUILD_ID=$short_commit" \
  --load \
  --tag "$image" \
  "$root"

jq -e \
  --arg commit "$commit" \
  --arg tree "$tree" \
  '."containerimage.digest" | test("^sha256:[0-9a-f]{64}$")' \
  "$metadata" >/dev/null || die 'BuildKit metadata is missing the image digest'
jq -e \
  --arg commit "$commit" \
  --arg tree "$tree" \
  '."buildx.build.provenance".invocation.parameters.args["build-arg:JANUSLY_BUILD_COMMIT"] == $commit and
   ."buildx.build.provenance".invocation.parameters.args["build-arg:JANUSLY_BUILD_TREE"] == $tree and
   (."buildx.build.provenance".materials | length >= 3) and
   all(."buildx.build.provenance".materials[]; .digest.sha256 | test("^[0-9a-f]{64}$"))' \
  "$metadata" >/dev/null || die 'BuildKit provenance does not match the current source'

docker image inspect "$image" >"$work_dir/image-inspect.json"
jq -e --arg commit "$commit" --arg tree "$tree" \
  '.[0].Config.Labels["org.opencontainers.image.revision"] == $commit and
   .[0].Config.Labels["io.janusly.source-tree"] == $tree and
   .[0].Config.User == "nonroot:nonroot"' \
  "$work_dir/image-inspect.json" >/dev/null || die 'image labels, tree, or non-root user do not match'

docker run --rm "$image" provenance >"$work_dir/runtime-provenance.json"
jq -e --arg commit "$commit" --arg tree "$tree" \
  '.commit == $commit and .tree == $tree and .verified == true' \
  "$work_dir/runtime-provenance.json" >/dev/null || die 'runtime provenance does not match the image'

docker save --output "$work_dir/janusly-image.tar" "$image"
docker run --rm --volume "$work_dir:/work" "$syft_image" \
  scan docker-archive:/work/janusly-image.tar \
  --output spdx-json=/work/janusly.spdx.json \
  --source-name Janusly \
  --source-version "$commit" \
  --quiet

package_count=$(jq -er \
  'select(.spdxVersion == "SPDX-2.3") | (.packages | length) | select(. > 0)' \
  "$work_dir/janusly.spdx.json") || die 'Syft did not produce a non-empty SPDX 2.3 document'
image_digest=$(jq -er '."containerimage.digest"' "$metadata")
image_id=$(jq -er '.[0].Id' "$work_dir/image-inspect.json")
jq -n \
  --arg commit "$commit" \
  --arg tree "$tree" \
  --arg image "$image" \
  --arg imageDigest "$image_digest" \
  --arg imageId "$image_id" \
  --arg sbomGenerator "$sbom_generator" \
  --arg syftImage "$syft_image" \
  --argjson packageCount "$package_count" \
  '{schemaVersion:1,git:{commit:$commit,tree:$tree},image:{reference:$image,digest:$imageDigest,id:$imageId},provenance:{mode:"max",buildkitMetadata:true,signed:false,published:false},sbom:{format:"SPDX-2.3",packages:$packageCount,buildkitGenerator:$sbomGenerator,standaloneGenerator:$syftImage}}' \
  >"$work_dir/summary.json"

(
  cd "$work_dir"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256
) >"$work_dir/SHA256SUMS"
chmod -R go-w "$work_dir"
mv "$work_dir" "$artifact_dir"
work_dir=
printf 'supply-chain-local: passed image=%s evidence=%s\n' "$image" "$artifact_dir"
