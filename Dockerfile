FROM node:24-trixie AS build
WORKDIR /xxscreeps
COPY patches ./patches
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .
RUN <<DONE
	set +x
	corepack enable
	pnpm fetch
DONE
COPY . .
RUN <<DONE
	set +x
	pnpm install --frozen-lockfile --offline
	pnpm run build
	npx xxscreeps test
	mkdir -p /runtime-packages
	pnpm --filter @xxscreeps/lodash3 pack --out "/runtime-packages/lodash3.tgz"
	pnpm --filter @xxscreeps/client pack --out "/runtime-packages/client.tgz"
	pnpm --filter @xxscreeps/redis pack --out "/runtime-packages/redis.tgz"
	pnpm --filter xxscreeps pack --out "/runtime-packages/xxscreeps.tgz"
DONE

FROM node:24-trixie
COPY --from=build /runtime-packages /opt/xxscreeps-packages
COPY extra-dependencies.json /opt/xxscreeps-packages/
COPY schema-archives/ /opt/archive-seed/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN corepack enable

WORKDIR /opt/runtime
RUN node --input-type=module <<'NODE'
import fs from 'node:fs';
const extra = JSON.parse(fs.readFileSync('/opt/xxscreeps-packages/extra-dependencies.json', 'utf8'));
const pkg = {
	name: 'xxscreeps-runtime',
	private: true,
	packageManager: 'pnpm@10.33.3',
	dependencies: {
		...(extra.dependencies ?? {}),
		'@xxscreeps/client': 'file:/opt/xxscreeps-packages/client.tgz',
		'@xxscreeps/lodash3': 'file:/opt/xxscreeps-packages/lodash3.tgz',
		'@xxscreeps/redis': 'file:/opt/xxscreeps-packages/redis.tgz',
		'xxscreeps': 'file:/opt/xxscreeps-packages/xxscreeps.tgz',
	},
	pnpm: {
		onlyBuiltDependencies: ['@xxscreeps/pathfinder', 'isolated-vm', 'ivm-inspect'],
	},
};
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
NODE
RUN pnpm install --prod --no-frozen-lockfile

WORKDIR /data
EXPOSE 21025
ENV NODE_OPTIONS="--no-node-snapshot --experimental-vm-modules --enable-source-maps --no-warnings"
ENV XXSCREEPS_DATA_DIR="/data"
ENTRYPOINT [ "/usr/local/bin/docker-entrypoint.sh" ]
