import type { TickPayload } from 'xxscreeps/engine/runner/index.js';
import type { CPU } from 'xxscreeps/game/game.js';

/**
 * The parts of `Game.cpu` which are just the tick's numbers, shared by every sandbox. What differs
 * between them is how time is measured and how the isolate is torn down, which is what the
 * subclasses supply.
 */
export abstract class BaseCPU implements Pick<CPU, 'bucket' | 'limit' | 'shardLimits' | 'tickLimit'> {
	readonly bucket;
	readonly limit;
	readonly shardLimits;
	readonly tickLimit;

	constructor(data: TickPayload) {
		this.bucket = data.cpu.bucket;
		this.limit = data.cpu.limit;
		this.shardLimits = data.cpu.shardLimits;
		this.tickLimit = data.cpu.tickLimit;
	}

	abstract getUsed(): number;
}
