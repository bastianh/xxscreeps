#!/bin/sh
set -eu

TAG="${1:-}"
IMAGE_REPO="${IMAGE_REPO:-registry.zeta.w4rl0ck.dev/xxscreeps}"
PLATFORM="${PLATFORM:-linux/amd64}"
ARCHIVE_PATH="${ARCHIVE_PATH:-/tmp/xxscreeps.tar}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
IMAGE_REF="$IMAGE_REPO:$TAG"

if [ -z "$TAG" ]; then
	printf 'Usage: %s <tag>\n' "$0" >&2
	exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
	printf 'docker not found in PATH\n' >&2
	exit 1
fi

if ! command -v skopeo >/dev/null 2>&1; then
	printf 'skopeo not found in PATH\n' >&2
	exit 1
fi

printf 'Building %s for %s\n' "$IMAGE_REF" "$PLATFORM"
cd "$ROOT_DIR"
docker buildx build \
	--platform "$PLATFORM" \
	--provenance=false \
	--output "type=oci,dest=$ARCHIVE_PATH" \
	.

printf 'Pushing %s via skopeo\n' "$IMAGE_REF"
skopeo copy "oci-archive:$ARCHIVE_PATH" "docker://$IMAGE_REF"

printf 'Updating Kubernetes manifests to %s\n' "$IMAGE_REF"
node - <<'NODE' "$IMAGE_REPO" "$TAG" "$SCRIPT_DIR/kustomization.yaml" "$SCRIPT_DIR/pvc-shell.yaml"
const fs = require('node:fs');

const [ imageRepo, tag, kustomizationFile, pvcShellFile ] = process.argv.slice(2);

{
	const source = fs.readFileSync(kustomizationFile, 'utf8');
	let updated = source;
	const newNamePattern = /^(\s*newName:\s*).+$/m;
	const newTagPattern = /^(\s*newTag:\s*).+$/m;
	if (!newNamePattern.test(updated) || !newTagPattern.test(updated)) {
		throw new Error(`Expected images.newName and images.newTag entries in ${kustomizationFile}`);
	}
	updated = updated.replace(newNamePattern, `$1${imageRepo}`);
	updated = updated.replace(newTagPattern, `$1"${tag}"`);
	if (source === updated) {
		throw new Error(`No image reference updated in ${kustomizationFile}`);
	}
	fs.writeFileSync(kustomizationFile, updated);
}

{
	const source = fs.readFileSync(pvcShellFile, 'utf8');
	const escapedRepo = imageRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`${escapedRepo}:[^"'\\s]+`, 'g');
	const updated = source.replace(pattern, `${imageRepo}:${tag}`);
	if (source === updated) {
		throw new Error(`No image reference updated in ${pvcShellFile}`);
	}
	fs.writeFileSync(pvcShellFile, updated);
}
NODE

printf 'Done. Updated manifests to %s\n' "$IMAGE_REF"
