import type { Schema } from './config.js';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import jsYaml from 'js-yaml';
import { isTopThread } from 'xxscreeps/engine/service/index.js';

function applyEnvironmentOverrides(config: Schema): Schema {
	const backend = {
		...(config.backend ?? {}),
	};
	let updated = config.backend !== undefined;

	if (process.env.XXSCREEPS_BACKEND_SECRET !== undefined) {
		backend.secret = process.env.XXSCREEPS_BACKEND_SECRET;
		updated = true;
	}
	if (process.env.XXSCREEPS_STEAM_API_KEY !== undefined) {
		backend.steamApiKey = process.env.XXSCREEPS_STEAM_API_KEY;
		updated = true;
	}
	if (!updated) {
		return config;
	}
	return {
		...config,
		backend,
	};
}

// Load configuration
export const configPath = new URL('.screepsrc.yaml', `${pathToFileURL(process.cwd())}/`);
const content = await async function() {
	try {
		return await fs.readFile(configPath, 'utf8');
	} catch {}
}();
const config = function(): Schema {
	if (content === undefined) {
		if (isTopThread) {
			console.warn('`.screepsrc.yaml` not found; using default configuration');
		}
		return applyEnvironmentOverrides({});
	} else {
		return applyEnvironmentOverrides(jsYaml.load(content) as Schema);
	}
}();
export default config;
