import { ArgumentParser } from 'argparse';
import { config } from './index.js';

/**
 * Resolves the shard a service instance attaches to, defaulting to the first configured shard.
 *
 * Unlike `checkArguments` this tolerates arguments belonging to someone else: in single-threaded
 * mode the service entry points are imported into the launcher's process, where `process.argv`
 * holds the launcher's own flags.
 */
export function checkShardArgument() {
	const parser = new ArgumentParser({ add_help: false });
	parser.add_argument('--shard', { dest: 'shard', nargs: '?', type: 'str' });
	const [ argv ] = parser.parse_known_args() as [ { shard: string | null } ];
	return argv.shard ?? config.shards[0]!.name;
}

export function checkArguments<Type extends {
	argv?: true;
	boolean?: readonly string[];
	string?: readonly string[];
}>(options: Type):
	Record<NonNullable<Type['boolean']>[number], boolean> &
	Partial<Record<NonNullable<Type['string']>[number], string>> & {
		argv: Type['argv'] extends true ? (string | undefined)[] : never;
	} {
	const parser = new ArgumentParser();
	for (const key of options.boolean ?? []) {
		parser.add_argument(`--${key}`, {
			action: 'store_true',
			default: false,
			dest: key,
		});
	}
	for (const key of options.string ?? []) {
		parser.add_argument(`--${key}`, {
			dest: key,
			nargs: '?',
			type: 'str',
		});
	}
	if (options.argv) {
		parser.add_argument('argv', {
			nargs: '*',
		});
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-return
	return parser.parse_args();
}
