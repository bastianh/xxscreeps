#!/bin/sh
set -eu

DATA_DIR="${XXSCREEPS_DATA_DIR:-/data}"
PACKAGE_DIR="${XXSCREEPS_PACKAGE_DIR:-/opt/xxscreeps}"
PACKAGE_MANAGER="pnpm@10.33.3"
STAMP_FILE="$DATA_DIR/.xxscreeps-runtime-stamp"

mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

export DATA_DIR PACKAGE_DIR PACKAGE_MANAGER STAMP_FILE

node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR;
const packageDir = process.env.PACKAGE_DIR;
const packageManager = process.env.PACKAGE_MANAGER;
const extraDependenciesPath = path.join(dataDir, 'extra-dependencies.json');
const packageJsonPath = path.join(dataDir, 'package.json');

const desiredDependencies = {
	'@xxscreeps/client': `file:${path.join(packageDir, 'client.tgz')}`,
	'@xxscreeps/lodash3': `file:${path.join(packageDir, 'lodash3.tgz')}`,
	'@xxscreeps/redis': `file:${path.join(packageDir, 'redis.tgz')}`,
	'xxscreeps': `file:${path.join(packageDir, 'xxscreeps.tgz')}`,
};
const onlyBuiltDependencies = [
	'@xxscreeps/pathfinder',
	'isolated-vm',
	'ivm-inspect',
];

function writeFileAtomic(filePath, content) {
	const tempPath = path.join(dataDir, `.${path.basename(filePath)}.${process.pid}.tmp`);
	fs.writeFileSync(tempPath, content);
	fs.renameSync(tempPath, filePath);
}

let packageJson = {};
let packageJsonExists = true;
try {
	packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
} catch (error) {
	if (error.code !== 'ENOENT') {
		throw error;
	}
	packageJsonExists = false;
}

if (!packageJsonExists) {
	try {
		const extraDependencies = JSON.parse(fs.readFileSync(extraDependenciesPath, 'utf8'));
		if (extraDependencies && typeof extraDependencies === 'object') {
			packageJson = {
				...packageJson,
				...extraDependencies,
			};
		}
	} catch (error) {
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}
}

packageJson.name ??= 'xxscreeps-data';
packageJson.private = true;
packageJson.packageManager = packageManager;
packageJson.dependencies = {
	...(packageJson.dependencies ?? {}),
	...desiredDependencies,
};
packageJson.pnpm = {
	...(packageJson.pnpm ?? {}),
	onlyBuiltDependencies,
};

writeFileAtomic(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
NODE

INSTALL_FINGERPRINT="$(node --input-type=module <<'NODE'
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const dataDir = process.env.DATA_DIR;
const packageDir = process.env.PACKAGE_DIR;
const hash = crypto.createHash('sha256');

for (const file of [
	path.join(dataDir, 'package.json'),
	path.join(packageDir, 'client.tgz'),
	path.join(packageDir, 'lodash3.tgz'),
	path.join(packageDir, 'redis.tgz'),
	path.join(packageDir, 'xxscreeps.tgz'),
]) {
	hash.update(fs.readFileSync(file));
}

process.stdout.write(hash.digest('hex'));
NODE
)"

NEEDS_INSTALL=0
if [ ! -x "$DATA_DIR/node_modules/.bin/xxscreeps" ]; then
	NEEDS_INSTALL=1
elif [ ! -f "$STAMP_FILE" ] || [ "$(cat "$STAMP_FILE")" != "$INSTALL_FINGERPRINT" ]; then
	NEEDS_INSTALL=1
fi

if [ "$NEEDS_INSTALL" -eq 1 ]; then
	corepack enable
	pnpm install --prod --no-frozen-lockfile
	STAMP_TMP_FILE="$(mktemp "$DATA_DIR/.xxscreeps-runtime-stamp.XXXXXX")"
	printf '%s\n' "$INSTALL_FINGERPRINT" > "$STAMP_TMP_FILE"
	mv -f "$STAMP_TMP_FILE" "$STAMP_FILE"
fi

exec "$DATA_DIR/node_modules/.bin/xxscreeps" "$@"
