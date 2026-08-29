import type { TickPayload } from 'xxscreeps/engine/runner/index.js';
import type { CPU } from 'xxscreeps/game/game.js';
import * as C from 'xxscreeps/game/constants/index.js';
import { hooks } from 'xxscreeps/game/index.js';

// A division requested by player code this tick, handed to the driver by the connector below. Only
// the last call survives: the runtime answers immediately, so an earlier request never took effect.
let request: Record<string, number> | undefined;

/** @internal */
export function flushShardLimitsRequest() {
	const value = request;
	request = undefined;
	return value;
}

hooks.register('runtimeConnector', {
	send(result) {
		result.shardLimitsRequest = flushShardLimitsRequest();
	},
});

/**
 * The parts of `Game.cpu` which are just the tick's numbers, shared by every sandbox. What differs
 * between them is how time is measured and how the isolate is torn down, which is what the
 * subclasses supply.
 */
export abstract class BaseCPU implements Pick<CPU, 'bucket' | 'limit' | 'setShardLimits' | 'shardLimits' | 'tickLimit'> {
	readonly bucket;
	readonly limit;
	readonly shardLimits;
	readonly tickLimit;
	readonly #shardLimitsCooldown;

	constructor(data: TickPayload) {
		this.bucket = data.cpu.bucket;
		this.limit = data.cpu.limit;
		this.shardLimits = data.cpu.shardLimits;
		this.tickLimit = data.cpu.tickLimit;
		this.#shardLimitsCooldown = data.cpu.shardLimitsCooldown;
	}

	setShardLimits = (limits: Record<string, number>) => {
		if (this.#shardLimitsCooldown > 0) {
			return C.ERR_BUSY;
		}
		// The division always adds up to the account's CPU, so the current one states the total
		const names = Object.keys(this.shardLimits);
		const total = names.reduce((sum, name) => sum + this.shardLimits[name]!, 0);
		const values = names.map(name => limits[name]);
		if (
			Object.keys(limits).length !== names.length ||
			values.some(value => typeof value !== 'number' || !Number.isInteger(value) || value < 0) ||
			values.reduce((sum, value) => sum! + value!, 0) !== total
		) {
			return C.ERR_INVALID_ARGS;
		}
		// The driver applies it after this tick; the values a later tick reads come back from there
		request = Object.fromEntries(names.map(name => [ name, limits[name]! ]));
		return C.OK;
	};

	abstract getUsed(): number;
}
