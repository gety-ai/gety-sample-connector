/**
 * Maintains `vendor/gety-deno/`, a byte-exact copy of the Gety Deno connector
 * runtime (`connectors/deno` in the Gety repository): the SDK sources, the
 * host runner and the JSON schemas.
 *
 *   deno task sync-sdk <gety checkout> [--ref <rev>]
 *     Copy the files from <rev> (default HEAD) of the checkout and rewrite
 *     SOURCE.json.
 *   deno task sync-sdk:check
 *     Fail when a vendored file was edited, added or removed by hand.
 *
 * Files are read from git objects, not the working tree, so the copy always
 * matches the recorded commit.
 */
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const vendorDir = join(repoRoot, 'vendor/gety-deno');
const sourcePath = join(vendorDir, 'SOURCE.json');

/** Directory of the Deno connector runtime inside the Gety repository. */
const GETY_RUNTIME_DIR = 'connectors/deno';

/** Runtime files to vendor, relative to {@link GETY_RUNTIME_DIR}. */
function isVendoredFile(path: string): boolean {
	if (path.startsWith('sdk/src/')) {
		return path.endsWith('.ts') && !path.endsWith('_test.ts');
	}
	return [
		'host/runner.ts',
		'host/start_frame.ts',
		'manifest.schema.json',
		'wire.schema.json',
	].includes(path);
}

interface Source {
	gety_commit: string;
	gety_version: string;
	protocol_version: string;
	/** sha256 of every vendored file, keyed by its path in vendor/gety-deno. */
	files: Record<string, string>;
}

if (import.meta.main) {
	const args = Deno.args.filter((arg) => arg !== '--');
	if (args.includes('--check')) {
		const problems = await check();
		if (problems.length > 0) {
			console.error('vendor/gety-deno does not match SOURCE.json:');
			for (const problem of problems) {
				console.error(`  ${problem}`);
			}
			console.error(
				'Do not edit vendored files; refresh them with `deno task sync-sdk <gety checkout>`.',
			);
			Deno.exit(1);
		}
		console.log('vendor/gety-deno matches SOURCE.json.');
	} else {
		await sync(parseSyncArgs(args));
	}
}

function parseSyncArgs(args: string[]): { checkout: string; ref: string } {
	let checkout: string | undefined;
	let ref = 'HEAD';
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--ref') {
			const value = args[index + 1];
			if (value == null) {
				throw new Error('Missing value for --ref.');
			}
			ref = value;
			index += 1;
		} else if (arg.startsWith('-') || checkout != null) {
			throw new Error(
				`Unexpected argument ${arg}. Usage: sync-sdk.ts <gety checkout> [--ref <rev>] | --check`,
			);
		} else {
			checkout = arg;
		}
	}
	if (checkout == null) {
		throw new Error(
			'Usage: sync-sdk.ts <gety checkout> [--ref <rev>] | --check',
		);
	}
	return { checkout, ref };
}

async function sync({ checkout, ref }: { checkout: string; ref: string }) {
	const decoder = new TextDecoder();
	const commit = decoder.decode(
		await git(checkout, ['rev-parse', '--verify', `${ref}^{commit}`]),
	).trim();
	const listing = decoder.decode(
		await git(checkout, [
			'ls-tree',
			'-r',
			'--name-only',
			commit,
			'--',
			`${GETY_RUNTIME_DIR}/`,
		]),
	);
	const paths = listing.split('\n')
		.filter((line) => line !== '')
		.map((line) => line.slice(GETY_RUNTIME_DIR.length + 1))
		.filter(isVendoredFile)
		.sort();
	if (!paths.includes('host/runner.ts') || !paths.includes('sdk/src/mod.ts')) {
		throw new Error(
			`${checkout} at ${commit} has no Deno connector runtime in ${GETY_RUNTIME_DIR}/.`,
		);
	}

	// Read everything first so a failure leaves the current copy untouched.
	const blobs = new Map<string, Uint8Array>();
	const files: Record<string, string> = {};
	for (const path of paths) {
		const bytes = await gitBlob(
			checkout,
			commit,
			`${GETY_RUNTIME_DIR}/${path}`,
		);
		blobs.set(path, bytes);
		files[path] = await sha256(bytes);
	}
	const protocolVersion = decoder.decode(blobs.get('host/runner.ts')).match(
		/const BUNDLED_PROTOCOL_VERSION = "([^"]+)";/,
	)?.[1];
	if (protocolVersion == null) {
		throw new Error('BUNDLED_PROTOCOL_VERSION not found in host/runner.ts.');
	}
	const getyVersion = JSON.parse(
		decoder.decode(await gitBlob(checkout, commit, 'gety-client/package.json')),
	)?.version;
	if (typeof getyVersion !== 'string') {
		throw new Error('gety-client/package.json has no version.');
	}

	await Deno.remove(vendorDir, { recursive: true }).catch((error) => {
		if (!(error instanceof Deno.errors.NotFound)) {
			throw error;
		}
	});
	for (const [path, bytes] of blobs) {
		const target = join(vendorDir, path);
		await Deno.mkdir(dirname(target), { recursive: true });
		await Deno.writeFile(target, bytes);
	}
	const source: Source = {
		gety_commit: commit,
		gety_version: getyVersion,
		protocol_version: protocolVersion,
		files,
	};
	await Deno.writeTextFile(
		sourcePath,
		`${JSON.stringify(source, null, '\t')}\n`,
	);

	console.log(
		`Vendored ${paths.length} files from Gety ${getyVersion} (${commit}).`,
	);
}

async function check(): Promise<string[]> {
	const source = await readSource();
	if (source == null) {
		return ['SOURCE.json is missing'];
	}
	const problems: string[] = [];
	const present = new Set<string>();
	for await (const path of walkFiles(vendorDir)) {
		const rel = relative(vendorDir, path).replaceAll('\\', '/');
		if (rel === 'SOURCE.json') {
			continue;
		}
		present.add(rel);
		const expected = source.files[rel];
		if (expected == null) {
			problems.push(`${rel}: not listed in SOURCE.json`);
		} else if (expected !== await sha256(await Deno.readFile(path))) {
			problems.push(`${rel}: content differs from the recorded hash`);
		}
	}
	for (const rel of Object.keys(source.files)) {
		if (!present.has(rel)) {
			problems.push(`${rel}: missing`);
		}
	}
	return problems.sort();
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
	for await (const entry of Deno.readDir(dir)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory) {
			yield* walkFiles(path);
		} else {
			yield path;
		}
	}
}

async function readSource(): Promise<Source | null> {
	try {
		return JSON.parse(await Deno.readTextFile(sourcePath)) as Source;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return null;
		}
		throw error;
	}
}

async function gitBlob(
	checkout: string,
	commit: string,
	path: string,
): Promise<Uint8Array> {
	return await git(checkout, ['cat-file', 'blob', `${commit}:${path}`]);
}

async function git(checkout: string, args: string[]): Promise<Uint8Array> {
	const output = await new Deno.Command('git', {
		args: ['-C', checkout, ...args],
		stdout: 'piped',
		stderr: 'piped',
	}).output();
	if (!output.success) {
		throw new Error(
			`git ${args.join(' ')} failed: ${
				new TextDecoder().decode(output.stderr).trim()
			}`,
		);
	}
	return output.stdout;
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	return Array.from(
		new Uint8Array(digest),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
}
