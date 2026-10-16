/**
 * Builds and checks the two GitHub Release assets Gety installs a connector
 * from: `manifest.json` and `<id>-<version>.zip`.
 *
 * ```text
 * deno task package [--tag <tag>] [--include <path>]... [--out <dir>]
 * deno run -R -W scripts/package.ts check <dir> [--tag <tag>]
 * ```
 *
 * `pack` (the default command) zips `manifest.json`, the manifest's `entry`
 * and its `.map`, the manifest's `icon` and every `--include` file or
 * directory, writes the zip and a copy of `manifest.json` to `<out>`
 * (default `release/`), then checks `<out>`. `check` verifies a directory
 * holding exactly the two assets, e.g. the ones downloaded from a published
 * Release.
 *
 * The release workflow also runs this script for other connector
 * repositories with `--no-config`, so it must only import fully qualified,
 * pinned specifiers.
 */
import { parseArgs } from 'jsr:@std/cli@1.0.32/parse-args';
import { format, parse, tryParse } from 'jsr:@std/semver@1.0.8';
import {
	configure,
	Uint8ArrayReader,
	Uint8ArrayWriter,
	ZipReader,
	ZipWriter,
} from 'jsr:@zip-js/zip-js@2.23.0';

const MANIFEST = 'manifest.json';
const DEFAULT_OUT_DIR = 'release';
// Gety's limits for a Release package.
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const USAGE = `usage:
  deno task package [--tag <tag>] [--include <path>]... [--out <dir>]
  deno run -R -W scripts/package.ts check <dir> [--tag <tag>]`;

configure({ useWebWorkers: false });

class PackageError extends Error {}

function fail(message: string): never {
	throw new PackageError(message);
}

interface Manifest {
	id: string;
	version: string;
	entry: string;
	icon?: string;
}

if (import.meta.main) {
	try {
		await main(Deno.args);
	} catch (error) {
		if (!(error instanceof PackageError)) {
			throw error;
		}
		console.error(`error: ${error.message}`);
		Deno.exit(1);
	}
}

async function main(args: string[]): Promise<void> {
	const flags = parseArgs(args, {
		string: ['tag', 'out', 'include'],
		collect: ['include'],
		unknown: (arg) =>
			arg.startsWith('-') ? fail(`unknown option ${arg}\n${USAGE}`) : true,
	});
	const [command = 'pack', ...rest] = flags._.map(String);
	switch (command) {
		case 'pack': {
			if (rest.length > 0) {
				fail(USAGE);
			}
			const outDir = flags.out ?? DEFAULT_OUT_DIR;
			await pack(outDir, flags.tag, flags.include);
			await check(outDir, flags.tag);
			break;
		}
		case 'check': {
			if (rest.length !== 1 || flags.include.length > 0 || flags.out) {
				fail(USAGE);
			}
			await check(rest[0], flags.tag);
			break;
		}
		default:
			fail(`unknown command ${command}\n${USAGE}`);
	}
}

async function pack(
	outDir: string,
	tag: string | undefined,
	includes: string[],
): Promise<void> {
	const manifestBytes = await Deno.readFile(MANIFEST);
	const manifest = parseManifest(manifestBytes);
	if (tag !== undefined) {
		checkTag(tag, manifest.version);
	}

	const files = new Map<string, Uint8Array>([[MANIFEST, manifestBytes]]);
	await addPath(files, manifest.entry, 'file');
	const sourceMap = `${manifest.entry}.map`;
	if (await exists(sourceMap)) {
		await addPath(files, sourceMap, 'file');
	}
	if (manifest.icon !== undefined) {
		await addPath(files, manifest.icon, 'file');
	}
	for (const include of includes) {
		await addPath(files, packagePath(include, '--include'), 'any');
	}

	const zip = await writeZip(files);
	await prepareOutDir(outDir);
	const zipName = assetName(manifest);
	await Deno.writeFile(`${outDir}/${MANIFEST}`, manifestBytes);
	await Deno.writeFile(`${outDir}/${zipName}`, zip);
	console.log(
		`packed ${outDir}/${zipName}: ${[...files.keys()].join(', ')}`,
	);
}

/** Checks `dir` against Gety's Release contract. */
async function check(dir: string, tag: string | undefined): Promise<void> {
	const manifestBytes = await readFileIn(dir, MANIFEST);
	const manifest = parseManifest(manifestBytes);
	if (tag !== undefined) {
		checkTag(tag, manifest.version);
	}
	const zipName = assetName(manifest);
	const names: string[] = [];
	for await (const item of Deno.readDir(dir)) {
		names.push(item.name);
	}
	if (
		names.length !== 2 || !names.includes(MANIFEST) ||
		!names.includes(zipName)
	) {
		fail(
			`${dir} must hold exactly ${MANIFEST} and ${zipName}, found: ${
				names.sort().join(', ')
			}`,
		);
	}

	const zip = await readFileIn(dir, zipName);
	if (zip.length > MAX_ZIP_BYTES) {
		fail(`${zipName} is ${zip.length} bytes, over ${MAX_ZIP_BYTES}`);
	}
	const reader = new ZipReader(new Uint8ArrayReader(zip));
	const entries = await reader.getEntries();
	if (entries.length > MAX_ENTRIES) {
		fail(`${zipName} has ${entries.length} entries, over ${MAX_ENTRIES}`);
	}
	const files = new Map<string, Uint8Array>();
	let unpackedBytes = 0;
	for (const entry of entries) {
		const name = entry.filename.endsWith('/')
			? entry.filename.slice(0, -1)
			: entry.filename;
		if (packagePath(name, `${zipName} entry`) !== name) {
			fail(`${zipName} entry ${entry.filename} is not a normalized path`);
		}
		if (entry.symlink) {
			fail(`${zipName} entry ${entry.filename} is a symbolic link`);
		}
		if (entry.encrypted) {
			fail(`${zipName} entry ${entry.filename} is encrypted`);
		}
		if (entry.directory) {
			continue;
		}
		if (files.has(name)) {
			fail(`${zipName} has ${name} twice`);
		}
		const data = await entry.getData(new Uint8ArrayWriter());
		unpackedBytes += data.length;
		if (unpackedBytes > MAX_UNPACKED_BYTES) {
			fail(`${zipName} unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
		}
		files.set(name, data);
	}
	await reader.close();

	const packedManifest = files.get(MANIFEST);
	if (packedManifest === undefined) {
		fail(`${zipName} has no ${MANIFEST} at its root`);
	}
	if (
		packedManifest.length !== manifestBytes.length ||
		packedManifest.some((byte, i) => byte !== manifestBytes[i])
	) {
		fail(`${zipName}'s ${MANIFEST} differs from the ${MANIFEST} asset`);
	}
	for (const path of [manifest.entry, manifest.icon]) {
		if (path !== undefined && !files.has(path)) {
			fail(`${zipName} is missing ${path}, which ${MANIFEST} references`);
		}
	}
	console.log(
		`checked ${dir}: ${zipName} has ${files.size} files (${unpackedBytes} bytes), ${MANIFEST} matches, entry ${manifest.entry} present, no symlinks`,
	);
}

function parseManifest(bytes: Uint8Array): Manifest {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch (error) {
		fail(`${MANIFEST} is not valid UTF-8 JSON: ${error}`);
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		fail(`${MANIFEST} must be a JSON object`);
	}
	const { id, version, entry, icon } = raw as Record<string, unknown>;
	if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
		fail(`${MANIFEST} id must match ${ID_PATTERN}`);
	}
	if (typeof version !== 'string' || tryParse(version) === undefined) {
		fail(`${MANIFEST} version must be a SemVer version`);
	}
	if (typeof entry !== 'string') {
		fail(`${MANIFEST} entry must be a string`);
	}
	if (icon !== undefined && typeof icon !== 'string') {
		fail(`${MANIFEST} icon must be a string`);
	}
	return {
		id,
		version,
		entry: packagePath(entry, `${MANIFEST} entry`),
		icon: icon === undefined
			? undefined
			: packagePath(icon, `${MANIFEST} icon`),
	};
}

/** A Release tag is the manifest version, optionally prefixed with `v`. */
function checkTag(tag: string, version: string): void {
	const tagVersion = tryParse(tag.startsWith('v') ? tag.slice(1) : tag);
	if (tagVersion === undefined) {
		fail(`tag ${tag} is not a SemVer version (with an optional v prefix)`);
	}
	if (format(tagVersion) !== format(parse(version))) {
		fail(`tag ${tag} does not match ${MANIFEST} version ${version}`);
	}
}

function assetName(manifest: Manifest): string {
	return `${manifest.id}-${manifest.version}.zip`;
}

/**
 * Normalizes a relative `/`-separated path that stays inside the connector
 * directory, the rule Gety applies to `entry` and `icon`.
 */
function packagePath(value: string, what: string): string {
	if (
		value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)
	) {
		fail(`${what} must be a relative path using /: ${value}`);
	}
	const parts = value.split('/').filter((part) => part !== '' && part !== '.');
	if (parts.length === 0 || parts.includes('..')) {
		fail(`${what} must name a path inside the connector directory: ${value}`);
	}
	return parts.join('/');
}

/** Adds a file, or every file under a directory, refusing symbolic links. */
async function addPath(
	files: Map<string, Uint8Array>,
	path: string,
	kind: 'file' | 'any',
): Promise<void> {
	const parts = path.split('/');
	for (let i = 1; i < parts.length; i++) {
		await statNoSymlink(parts.slice(0, i).join('/'));
	}
	const info = await statNoSymlink(path);
	if (info.isFile) {
		files.set(path, await Deno.readFile(path));
	} else if (info.isDirectory && kind === 'any') {
		const children: string[] = [];
		for await (const child of Deno.readDir(path)) {
			children.push(child.name);
		}
		for (const child of children.sort()) {
			await addPath(files, `${path}/${child}`, 'any');
		}
	} else {
		fail(`${path} is not a regular file`);
	}
}

async function statNoSymlink(path: string): Promise<Deno.FileInfo> {
	let info: Deno.FileInfo;
	try {
		info = await Deno.lstat(path);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			fail(`${path} does not exist; build the connector first`);
		}
		throw error;
	}
	if (info.isSymlink) {
		fail(`${path} is a symbolic link; packages cannot contain links`);
	}
	return info;
}

async function writeZip(files: Map<string, Uint8Array>): Promise<Uint8Array> {
	const directories = new Set<string>();
	for (const path of files.keys()) {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) {
			directories.add(parts.slice(0, i).join('/'));
		}
	}
	const writer = new ZipWriter(new Uint8ArrayWriter());
	for (const directory of [...directories].sort()) {
		await writer.add(`${directory}/`, undefined, { directory: true });
	}
	for (const path of [...files.keys()].sort()) {
		await writer.add(path, new Uint8ArrayReader(files.get(path)!));
	}
	return await writer.close();
}

/**
 * Creates `dir`, or empties it when it only holds earlier package output, so
 * a mistyped `--out` never deletes anything else.
 */
async function prepareOutDir(dir: string): Promise<void> {
	await Deno.mkdir(dir, { recursive: true });
	const previous: string[] = [];
	for await (const item of Deno.readDir(dir)) {
		if (
			!item.isFile || (item.name !== MANIFEST && !item.name.endsWith('.zip'))
		) {
			fail(`${dir} holds ${item.name}; choose an empty --out directory`);
		}
		previous.push(item.name);
	}
	for (const name of previous) {
		await Deno.remove(`${dir}/${name}`);
	}
}

async function readFileIn(dir: string, name: string): Promise<Uint8Array> {
	try {
		return await Deno.readFile(`${dir}/${name}`);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			fail(`${dir} has no ${name}`);
		}
		throw error;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await Deno.lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return false;
		}
		throw error;
	}
}
