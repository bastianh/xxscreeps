import type { DecorationDefinition, DecorationProp, DecorationType } from './catalog.js';

// Everything that maps a definition's property schema onto a placement: parsing what the client
// sends, encoding it for storage, and reading it back. The definition is the authority for a
// property's type in all three directions, which is why they live together.

/** A property value as the client exchanges it. */
export type PropValue = boolean | number | string;

/** Where a decoration is placed, and the property values the player chose. */
export interface Placement {
	/** Target shard and room. Absent for the global decorations that ride along with creeps. */
	shard?: string;
	room?: string;
	props: Record<string, PropValue>;
}

/** A rejected placement, carrying the message handed back to the client. */
export interface PlacementError {
	error: string;
}

/** Longest free-form string a property may hold; lists arrive `!SEP!`-joined into one of these. */
const maxStringLength = 1024;

const isColor = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

/**
 * One property value as the client sent it. Numbers and booleans are accepted in their string
 * spelling too — the client round-trips placed values through form state and sends back whatever
 * that left behind.
 */
function parseProp(name: string, prop: DecorationProp, value: unknown): { value: PropValue } | PlacementError {
	switch (prop.type) {
		case 'boolean': {
			if (typeof value === 'boolean') {
				return { value };
			}
			return value === 'true' || value === '1' ? { value: true } :
				value === 'false' || value === '0' ? { value: false } :
				{ error: `'${name}' is not a boolean` };
		}

		case 'range': {
			// `Number` reads `null` and `[]` as zero, so anything but a number or its string
			// spelling is rejected before the conversion rather than after it.
			const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
			if (!Number.isFinite(number)) {
				return { error: `'${name}' is not a number` };
			} else if (prop.min !== undefined && number < prop.min) {
				return { error: `'${name}' is below its minimum of ${prop.min}` };
			} else if (prop.max !== undefined && number > prop.max) {
				return { error: `'${name}' is above its maximum of ${prop.max}` };
			}
			return { value: number };
		}

		case 'color':
			return typeof value === 'string' && isColor(value)
				? { value }
				: { error: `'${name}' is not a '#rrggbb' colour` };

		case 'display':
		case 'string':
			return typeof value === 'string' && value.length <= maxStringLength
				? { value }
				: { error: `'${name}' is not a string of at most ${maxStringLength} characters` };
	}
}

/**
 * The `active` payload of an activation request, checked against what the definition declares.
 * Properties the client left out fall back to the definition's seed, so a placement always carries
 * a complete set and later readers never have to consult the defaults again.
 */
export function parsePlacement(definition: DecorationDefinition, active: Record<string, unknown>): Placement | PlacementError {
	const { shard, room, ...rest } = active;
	const props: Record<string, PropValue> = {};
	for (const [ name, value ] of Object.entries(rest)) {
		const prop = definition.props[name];
		if (prop === undefined) {
			return { error: `'${definition._id}' has no property '${name}'` };
		}
		const parsed = parseProp(name, prop, value);
		if ('error' in parsed) {
			return parsed;
		}
		props[name] = parsed.value;
	}
	for (const [ name, prop ] of Object.entries(definition.props)) {
		if (props[name] === undefined && prop.default !== undefined) {
			props[name] = prop.default;
		}
	}
	// A creep decoration follows its owner rather than sitting somewhere, so it names no room.
	if (definition.type === 'creep') {
		return { props };
	} else if (typeof shard !== 'string' || typeof room !== 'string') {
		return { error: `'${definition._id}' must be placed in a room` };
	}
	return { shard, room, props };
}

/** Whether a placement is visible on the world map, which the `world` property decides. */
export const isOnWorldMap = (placement: Placement) => placement.props.world === true;

/**
 * The flat shape the client exchanges — the target sits alongside the property values rather than
 * beside them, which is the same shape {@link parsePlacement} reads. A pack property named `shard`
 * or `room` loses to the target here; storage keeps both apart, so nothing is actually dropped.
 */
export const placementToWire = (placement: Placement): Record<string, PropValue> => ({
	...placement.props,
	...placement.shard !== undefined && { shard: placement.shard },
	...placement.room !== undefined && { room: placement.room },
});

/** Hash fields hold strings; the definition tells {@link decodeProps} what each one was. */
export const encodeProps = (props: Record<string, PropValue>): Record<string, string> =>
	Object.fromEntries(Object.entries(props).map(([ name, value ]) =>
		[ `prop/${name}`, typeof value === 'boolean' ? value ? '1' : '0' : String(value) ]));

export function decodeProps(definition: DecorationDefinition, fields: Record<string, string>) {
	const props: Record<string, PropValue> = {};
	for (const [ field, value ] of Object.entries(fields)) {
		const name = field.startsWith('prop/') ? field.slice('prop/'.length) : undefined;
		const prop = name === undefined ? undefined : definition.props[name];
		if (name !== undefined && prop !== undefined) {
			props[name] = prop.type === 'boolean' ? value === '1' : prop.type === 'range' ? Number(value) : value;
		}
	}
	return props;
}

/**
 * Decoration types whose presence in a room excludes `type` from it. A landscape paints both the
 * floor and the walls, so it collides with either half; graffiti may be stacked freely.
 */
export function conflictingTypes(type: DecorationType): readonly DecorationType[] {
	switch (type) {
		case 'floorLandscape': return [ 'floorLandscape', 'landscape' ];
		case 'wallLandscape': return [ 'wallLandscape', 'landscape' ];
		case 'landscape': return [ 'landscape', 'floorLandscape', 'wallLandscape' ];
		case 'object': return [ 'object' ];
		case 'creep': return [ 'creep' ];
		case 'wallGraffiti': return [];
	}
}

/** Whether two decorations may not occupy the same room at the same time. */
export function conflicts(left: DecorationDefinition, right: DecorationDefinition) {
	if (!conflictingTypes(left.type).includes(right.type)) {
		return false;
	}
	// Two object overlays only argue when they decorate the same kind of structure.
	return left.type === 'object' ? left.objectType === right.objectType : true;
}
