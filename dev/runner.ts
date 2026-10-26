/**
 * Runs the connector in the working directory the way Gety does, and writes a
 * snapshot of everything it produced.
 *
 * - Process: the vendored host runner (vendor/gety-deno/host/runner.ts) in a
 *   separate Deno process, launched with the arguments Gety derives from the
 *   manifest `permissions` (dev/sandbox.ts). A manifest without
 *   `permissions` runs unrestricted, as in Gety.
 * - Input: the StartFrame (config, last state, data and home directories) on
 *   stdin, which stays open until the process exits. SIGINT to the dev runner
 *   closes it, the runner's cooperative cancel signal (a terminal Ctrl+C also
 *   interrupts the connector process directly); either way the poll counts as
 *   cancelled.
 * - State: committed only when the poll ends with `poll_done` and exit code 0,
 *   and written to the state file right away, before the next poll. It is the
 *   state of the last batch that carried one; the state of an earlier batch is
 *   never saved. A failed poll leaves the committed state untouched
 *   (documents it already delivered stay delivered, as in Gety's index).
 *
 * Config values come from environment variables (`.env`): field `a.b_c` is
 * read from `GETY_CONFIG_A_B_C` or `A_B_C`, then the field's default.
 */
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
	RunnerMessage,
	WireDoc,
	WireDocUpdate,
} from '../vendor/gety-deno/sdk/src/types.ts';
import {
	deriveLaunch,
	type LaunchPlan,
	type ParsedPermissions,
	parsePermissions,
	type PermissionOs,
} from './sandbox.ts';

interface Manifest {
	id: string;
	name?: string;
	version?: string;
	entry: string;
	permissions?: unknown;
	config?: {
		fields?: ManifestConfigField[];
	};
}

interface ManifestConfigField {
	id: string;
	type: string;
	required?: boolean;
	default_value?: unknown;
}

interface RunnerOptions {
	polls: number;
	intervalSeconds: number;
	resetState: boolean;
	statePath: string;
	outDir: string;
	fullAccess: boolean;
	permissions?: unknown;
	deno: string;
}

interface ConfigValueResult {
	id: string;
	type: string;
	envNames: string[];
	source: 'env' | 'default' | 'implicit_default';
	value?: unknown;
}

type PollOutcome =
	| { kind: 'success' }
	| { kind: 'error'; message: string }
	| { kind: 'cancelled' };

interface PollSummary {
	poll: number;
	outcome: PollOutcome['kind'];
	error?: string;
	exit_code: number;
	batches: number;
	updates: number;
	upserts: number;
	deletes: number;
	state_committed: boolean;
}

/** Grace period between closing stdin and killing the process (Gety: 5 s). */
const CANCEL_GRACE_MS = 5_000;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const runtimeRoot = join(repoRoot, 'vendor/gety-deno');
const runnerDir = resolve('dev/.runner');
const defaultStatePath = join(runnerDir, 'state.json');
const defaultRunsDir = resolve('dev/runs');

if (import.meta.main) {
	Deno.exit(await main());
}

async function main(): Promise<number> {
	const options = parseArgs(Deno.args);
	const manifest = await readJson<Manifest>(resolve('manifest.json'));
	const fields = manifest.config?.fields ?? [];
	const configResults = resolveConfig(fields);
	const config = buildConfig(configResults);
	const permissions: ParsedPermissions = options.fullAccess
		? 'unrestricted'
		: parsePermissions(
			'permissions' in options ? options.permissions : manifest.permissions,
			fields,
		);
	const { protocol_version: protocolVersion } = await readJson<
		{ protocol_version: string }
	>(join(runtimeRoot, 'SOURCE.json'));

	const dirs = {
		data: join(runnerDir, 'data'),
		tmp: join(runnerDir, 'tmp'),
		denoDir: join(runnerDir, 'deno_dir'),
	};
	for (const dir of Object.values(dirs)) {
		await Deno.mkdir(dir, { recursive: true });
	}
	// Gety writes the same mapping next to its runtime copy.
	const importMap = join(runnerDir, 'import_map.json');
	await writeJson(importMap, {
		imports: {
			'@gety-ai/connector-sdk': pathToFileURL(
				join(runtimeRoot, 'sdk/src/mod.ts'),
			).href,
		},
	});

	const stateBefore = options.resetState
		? null
		: await readJsonIfExists(options.statePath);
	const runDir = await createRunDir(options.outDir);
	const docsDir = join(runDir, 'docs');
	await Deno.mkdir(docsDir, { recursive: true });

	const updates: WireDocUpdate[] = [];
	const pollSummaries: PollSummary[] = [];
	let committedState = stateBefore;
	let docIndex = 0;
	let launchArgs: string[] = [];

	for (let poll = 1; poll <= options.polls; poll += 1) {
		const sessionTmp = await Deno.makeTempDir({
			dir: dirs.tmp,
			prefix: 'session-',
		});
		try {
			const plan = deriveLaunch(
				permissions,
				config,
				{
					runtime: runtimeRoot,
					runnerTs: join(runtimeRoot, 'host/runner.ts'),
					importMap,
					code: Deno.cwd(),
					entryRel: manifest.entry,
					data: dirs.data,
					tmp: sessionTmp,
					denoDir: dirs.denoDir,
					home: homedir(),
				},
				{
					path: Deno.env.get('PATH'),
					names: Object.keys(Deno.env.toObject()),
				},
				permissionOs(),
			);
			launchArgs = plan.args;
			console.error(
				`[dev-runner] poll ${poll}: ${options.deno} ${
					plan.args.map(shellQuote).join(' ')
				}`,
			);

			const startFrame = {
				protocol_version: protocolVersion,
				config,
				last_state: committedState ?? null,
				data_dir: dirs.data,
				home_dir: homedir(),
			};
			const tally = {
				batches: 0,
				upserts: 0,
				deletes: 0,
				// Latest state the poll reported; starts as the committed one.
				state: committedState,
			};
			const result = await runPoll(
				options.deno,
				plan,
				startFrame,
				async (message) => {
					if (message.type === 'log') {
						console.error(`[${message.level}] ${message.message}`);
						return;
					}
					if (message.type !== 'batch') {
						return;
					}
					tally.batches += 1;
					// An omitted `state` keeps the previous one; `null` replaces it.
					if (message.state !== undefined) {
						tally.state = message.state;
					}
					for (const update of message.updates) {
						updates.push(update);
						if (update.kind === 'upsert') {
							tally.upserts += 1;
							docIndex += 1;
							await writeDocSnapshot(docsDir, runDir, update.doc, docIndex);
						} else {
							tally.deletes += 1;
						}
					}
				},
			);

			// Gety commits the state of the last batch once the poll succeeded,
			// persisting it before it becomes the state the next poll starts from;
			// a poll without batches leaves the state as it was. Only a committed
			// state replaces the persisted one, so a failed run (even with
			// --reset-state) leaves the state file untouched.
			const committed = result.outcome.kind === 'success' && tally.batches > 0;
			if (committed) {
				await writeJson(options.statePath, tally.state);
				committedState = tally.state;
			}
			pollSummaries.push({
				poll,
				outcome: result.outcome.kind,
				error: result.outcome.kind === 'error'
					? result.outcome.message
					: undefined,
				exit_code: result.exitCode,
				batches: tally.batches,
				updates: tally.upserts + tally.deletes,
				upserts: tally.upserts,
				deletes: tally.deletes,
				state_committed: committed,
			});
			console.error(
				`[dev-runner] poll ${poll}: ${result.outcome.kind}, ${tally.batches} batches, ${tally.upserts} upserts, ${tally.deletes} deletes, state ${
					committed ? 'committed' : 'not committed'
				}`,
			);
			if (result.outcome.kind !== 'success') {
				if (result.outcome.kind === 'error') {
					console.error(`[dev-runner] error: ${result.outcome.message}`);
				}
				break;
			}
		} finally {
			await Deno.remove(sessionTmp, { recursive: true });
		}

		if (poll < options.polls && options.intervalSeconds > 0) {
			await delay(options.intervalSeconds * 1000);
		}
	}

	await writeJson(join(runDir, 'summary.json'), {
		manifest: {
			id: manifest.id,
			name: manifest.name,
			version: manifest.version,
			entry: manifest.entry,
		},
		config: configResults.map((result) => ({
			id: result.id,
			type: result.type,
			env_names: result.envNames,
			source: result.source,
		})),
		permissions,
		deno_args: launchArgs,
		state_path: options.statePath,
		run_dir: runDir,
		polls: pollSummaries,
		totals: {
			updates: updates.length,
			upserts: updates.filter((update) => update.kind === 'upsert').length,
			deletes: updates.filter((update) => update.kind === 'delete').length,
			doc_types: docTypeCounts(updates),
		},
	});
	await writeJson(join(runDir, 'state.before.json'), stateBefore);
	await writeJson(join(runDir, 'state.after.json'), committedState);
	await writeJson(join(runDir, 'updates.json'), updates);
	await writeJson(
		join(runDir, 'deletes.json'),
		updates.flatMap((update) => update.kind === 'delete' ? [update.id] : []),
	);

	console.log(`Connector run snapshot written to ${runDir}`);
	const failed = pollSummaries.some((summary) => summary.outcome !== 'success');
	return failed ? 1 : 0;
}

/**
 * Spawn one poll, feed it the StartFrame and dispatch its stdout frames.
 * Mirrors gety-core's Deno connector: the poll succeeds only with `poll_done`
 * and exit code 0; an `error` frame or a nonzero exit is a failure.
 */
async function runPoll(
	deno: string,
	plan: LaunchPlan,
	startFrame: unknown,
	onMessage: (message: RunnerMessage) => Promise<void>,
): Promise<{ outcome: PollOutcome; exitCode: number }> {
	const env = Deno.env.toObject();
	for (const name of plan.envRemove) {
		delete env[name];
	}
	for (const [name, value] of plan.envSet) {
		env[name] = value;
	}
	const child = new Deno.Command(deno, {
		args: plan.args,
		cwd: plan.cwd,
		env,
		clearEnv: true,
		stdin: 'piped',
		stdout: 'piped',
		stderr: 'inherit',
	}).spawn();

	const stdin = child.stdin.getWriter();
	await stdin.write(
		new TextEncoder().encode(`${JSON.stringify(startFrame)}\n`),
	);
	// Keep stdin open: closing it is the cooperative cancel signal.
	let cancelled = false;
	const cancel = () => {
		if (cancelled) {
			return;
		}
		cancelled = true;
		console.error('[dev-runner] cancelling: closing stdin');
		void stdin.close().catch(() => {});
		setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				// Already exited.
			}
		}, CANCEL_GRACE_MS);
	};
	Deno.addSignalListener('SIGINT', cancel);

	let outcome: PollOutcome | null = null;
	let sawPollDone = false;
	try {
		for await (const line of readLines(child.stdout)) {
			if (line.trim() === '') {
				continue;
			}
			const message = JSON.parse(line) as RunnerMessage;
			if (message.type === 'poll_done') {
				sawPollDone = true;
				break;
			}
			if (message.type === 'error') {
				outcome = { kind: 'error', message: errorText(message) };
				break;
			}
			await onMessage(message);
		}
	} catch (error) {
		// Unreadable output: stop the process instead of leaving it blocked on
		// a full stdout pipe.
		outcome = { kind: 'error', message: `invalid runner output: ${error}` };
		child.kill('SIGKILL');
	}
	const status = await child.status;
	Deno.removeSignalListener('SIGINT', cancel);
	await stdin.close().catch(() => {});
	if (cancelled) {
		outcome = { kind: 'cancelled' };
	} else if (outcome == null && !status.success) {
		outcome = {
			kind: 'error',
			message: `deno exited with code ${status.code}`,
		};
	} else if (outcome == null && !sawPollDone) {
		outcome = {
			kind: 'error',
			message: 'deno poll exited 0 without emitting poll_done',
		};
	}
	return { outcome: outcome ?? { kind: 'success' }, exitCode: status.code };
}

/** The host's wording: permission denials replace the author's message. */
function errorText(
	message: Extract<RunnerMessage, { type: 'error' }>,
): string {
	const author = message.stack
		? `${message.message}\n${message.stack}`
		: message.message;
	const denial = message.permission;
	if (denial == null) {
		return author;
	}
	const declarable = ['read', 'net', 'env', 'run'].includes(denial.kind);
	return `permission denied: ${denial.kind} access to ${
		JSON.stringify(denial.target)
	} ${
		declarable
			? "is not granted by the connector's manifest"
			: 'is not available to sandboxed connectors'
	} (${author})`;
}

async function* readLines(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	let buffered = '';
	for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
		buffered += chunk;
		let newline = buffered.indexOf('\n');
		while (newline !== -1) {
			yield buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			newline = buffered.indexOf('\n');
		}
	}
	if (buffered !== '') {
		yield buffered;
	}
}

function permissionOs(): PermissionOs {
	switch (Deno.build.os) {
		case 'darwin':
			return 'macos';
		case 'windows':
			return 'windows';
		default:
			return 'linux';
	}
}

function shellQuote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg)
		? arg
		: `'${arg.replaceAll("'", `'\\''`)}'`;
}

function parseArgs(args: string[]): RunnerOptions {
	if (args.includes('--help')) {
		console.log([
			'Usage: deno task runner -- [options]',
			'',
			'Runs the connector under the sandbox Gety derives from its manifest',
			'`permissions` (unrestricted when the manifest declares none).',
			'',
			'Options:',
			'  --reset-state          Ignore the committed runner state for this run.',
			'  --polls <count>        Number of poll cycles to run. Defaults to 1.',
			'  --interval <seconds>   Delay between poll cycles. Defaults to 0.',
			'  --state <path>         State file path. Defaults to dev/.runner/state.json.',
			'  --out-dir <path>       Snapshot output directory. Defaults to dev/runs.',
			'  --permissions <json>   Use this `permissions` value instead of the',
			'                         manifest\'s, e.g. \'{"net":["api.example.com"]}\'.',
			'  --full-access          Run unrestricted, whatever the manifest declares.',
			'  --deno <path>          Deno binary. Defaults to $DENO_BIN or deno.',
		].join('\n'));
		Deno.exit(0);
	}

	const runnerArgs = args.filter((arg) => arg !== '--');
	const options: RunnerOptions = {
		polls: 1,
		intervalSeconds: 0,
		resetState: false,
		statePath: defaultStatePath,
		outDir: defaultRunsDir,
		fullAccess: false,
		deno: Deno.env.get('DENO_BIN') || 'deno',
	};

	for (let index = 0; index < runnerArgs.length; index += 1) {
		const arg = runnerArgs[index];
		if (arg === '--reset-state') {
			options.resetState = true;
			continue;
		}
		if (arg === '--full-access') {
			options.fullAccess = true;
			continue;
		}

		const value = runnerArgs[index + 1];
		if (value == null) {
			throw new Error(`Missing value for ${arg}.`);
		}

		if (arg === '--polls') {
			options.polls = positiveInteger(value, arg);
		} else if (arg === '--interval') {
			options.intervalSeconds = nonNegativeNumber(value, arg);
		} else if (arg === '--state') {
			options.statePath = resolve(value);
		} else if (arg === '--out-dir') {
			options.outDir = resolve(value);
		} else if (arg === '--permissions') {
			options.permissions = JSON.parse(value);
		} else if (arg === '--deno') {
			options.deno = value;
		} else {
			throw new Error(`Unknown runner argument ${arg}.`);
		}
		index += 1;
	}

	return options;
}

function resolveConfig(fields: ManifestConfigField[]): ConfigValueResult[] {
	return fields.map((field) => {
		const envNames = configEnvNames(field.id);
		const envValue = firstEnvValue(envNames);
		if (envValue != null) {
			return {
				id: field.id,
				type: field.type,
				envNames,
				source: 'env',
				value: parseConfigValue(field, envValue),
			};
		}

		if (field.default_value !== undefined) {
			return {
				id: field.id,
				type: field.type,
				envNames,
				source: 'default',
				value: normalizeDefaultValue(field),
			};
		}

		if (field.required === true) {
			throw new Error(
				`Missing required config field "${field.id}". Set ${
					envNames.join(' or ')
				} in .env.`,
			);
		}

		return {
			id: field.id,
			type: field.type,
			envNames,
			source: 'implicit_default',
			value: implicitDefaultValue(field),
		};
	});
}

function buildConfig(results: ConfigValueResult[]): Record<string, unknown> {
	const config: Record<string, unknown> = {};
	for (const result of results) {
		setNestedConfig(config, result.id, result.value);
	}
	return config;
}

async function writeDocSnapshot(
	docsDir: string,
	runDir: string,
	doc: WireDoc,
	index: number,
): Promise<void> {
	const base = `${String(index).padStart(4, '0')}-${
		safeFileName(
			[doc.doc_type, doc.id].filter(Boolean).join('__') || 'doc',
		)
	}`;
	const content = typeof doc.content === 'string' ? doc.content : null;
	let contentPath: string | null = null;

	if (content != null) {
		const extension = doc.content_format === 'markdown' ? 'md' : 'txt';
		contentPath = join(docsDir, `${base}.${extension}`);
		await Deno.writeTextFile(contentPath, content);
	}

	const { content: _content, ...docMetadata } = doc;
	await writeJson(join(docsDir, `${base}.json`), {
		...docMetadata,
		content_file: contentPath == null ? null : relative(runDir, contentPath),
	});
}

function configEnvNames(fieldId: string): string[] {
	const name = fieldId
		.replace(/[^0-9A-Za-z]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toUpperCase();
	return [`GETY_CONFIG_${name}`, name];
}

function firstEnvValue(names: string[]): string | null {
	for (const name of names) {
		const value = Deno.env.get(name);
		if (value != null && value !== '') {
			return value;
		}
	}
	return null;
}

function parseConfigValue(field: ManifestConfigField, value: string): unknown {
	if (
		field.type === 'text' || field.type === 'password' ||
		field.type === 'dropdown' || field.type === 'directory'
	) {
		return value;
	}
	if (field.type === 'number') {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			throw new Error(`Config field "${field.id}" must be a number.`);
		}
		return parsed;
	}
	if (field.type === 'checkbox') {
		return parseBoolean(value, field.id);
	}
	throw new Error(`Unsupported config field type "${field.type}".`);
}

function normalizeDefaultValue(field: ManifestConfigField): unknown {
	const value = field.default_value;
	if (typeof value === 'string') {
		return parseConfigValue(field, value);
	}
	if (field.type === 'checkbox' && typeof value === 'boolean') {
		return value;
	}
	if (
		field.type === 'number' && typeof value === 'number' &&
		Number.isFinite(value)
	) {
		return value;
	}
	if (
		(field.type === 'text' || field.type === 'password' ||
			field.type === 'dropdown' || field.type === 'directory') &&
		typeof value === 'string'
	) {
		return value;
	}
	throw new Error(
		`Default value for config field "${field.id}" has wrong type.`,
	);
}

function implicitDefaultValue(field: ManifestConfigField): unknown {
	if (field.type === 'checkbox') {
		return false;
	}
	if (field.type === 'number') {
		return 0;
	}
	if (
		field.type === 'text' || field.type === 'password' ||
		field.type === 'dropdown' || field.type === 'directory'
	) {
		return '';
	}
	throw new Error(`Unsupported config field type "${field.type}".`);
}

function parseBoolean(value: string, fieldId: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) {
		return true;
	}
	if (['0', 'false', 'no', 'off'].includes(normalized)) {
		return false;
	}
	throw new Error(`Config field "${fieldId}" must be a boolean.`);
}

function setNestedConfig(
	config: Record<string, unknown>,
	fieldId: string,
	value: unknown,
): void {
	const parts = fieldId.split('.');
	let target = config;
	for (const [index, part] of parts.entries()) {
		if (part === '') {
			throw new Error(`Invalid config field id "${fieldId}".`);
		}

		if (index === parts.length - 1) {
			target[part] = value;
			return;
		}

		const existing = target[part];
		if (!isRecord(existing)) {
			target[part] = {};
		}
		target = target[part] as Record<string, unknown>;
	}
}

function docTypeCounts(updates: WireDocUpdate[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const update of updates) {
		if (update.kind !== 'upsert') {
			continue;
		}
		const docType = update.doc.doc_type ?? 'unknown';
		counts[docType] = (counts[docType] ?? 0) + 1;
	}
	return counts;
}

function safeFileName(value: string): string {
	const safe = value.replace(/[^0-9A-Za-z._-]+/g, '_').replace(/^_+|_+$/g, '');
	return (safe || 'doc').slice(0, 140);
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return parsed;
}

function nonNegativeNumber(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative number.`);
	}
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function createRunDir(outDir: string): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const runDir = join(outDir, timestamp);
	await Deno.mkdir(runDir, { recursive: true });
	return runDir;
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await Deno.readTextFile(path)) as T;
}

async function readJsonIfExists(path: string): Promise<unknown> {
	try {
		return JSON.parse(await Deno.readTextFile(path)) as unknown;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return null;
		}
		throw error;
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await Deno.mkdir(dirname(path), { recursive: true });
	await Deno.writeTextFile(path, `${JSON.stringify(value, null, '\t')}\n`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
