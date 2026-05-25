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
COPY --from=build /runtime-packages /opt/xxscreeps
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
WORKDIR /data
EXPOSE 21025
ENV NODE_OPTIONS="--no-node-snapshot --experimental-vm-modules --enable-source-maps --no-warnings"
ENV XXSCREEPS_DATA_DIR="/data"
ENV XXSCREEPS_PACKAGE_DIR="/opt/xxscreeps"
ENTRYPOINT [ "/usr/local/bin/docker-entrypoint.sh" ]
