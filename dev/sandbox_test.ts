// Cases ported from the tests of Gety's libs/gety-deno-connectors/src/launch.rs
// and permissions/parse.rs, so dev/sandbox.ts derives the same arguments.
import assert from 'node:assert/strict';
import {
	type ConfigField,
	DerivedValueError,
	deriveLaunch,
	type HostEnv,
	type LaunchPaths,
	parsePermissions,
	type PermissionOs,
} from './sandbox.ts';

const fields: ConfigField[] = [
	{ id: 'url', type: 'text' },
	{ id: 'dir', type: 'directory' },
	{ id: 'token', type: 'password' },
];

const paths: LaunchPaths = {
	runtime: '/rt',
	runnerTs: '/rt/runner.ts',
	importMap: '/rt/import_map.json',
	code: '/code',
	entryRel: 'src/main.ts',
	data: '/c/data',
	tmp: '/c/tmp/s1',
	denoDir: '/c/deno_dir',
	home: '/home/u',
};

function launch(
	permissions: unknown,
	config: unknown,
	os: PermissionOs = 'linux',
	env: HostEnv = { names: [] },
	launchPaths: LaunchPaths = paths,
) {
	return deriveLaunch(
		parsePermissions(permissions, fields),
		config,
		launchPaths,
		env,
		os,
	);
}

Deno.test('sandbox arguments carry base and declared grants', () => {
	const plan = launch(
		{
			net: ['api.x.com:443', '*.y.com', { config_field: 'url' }],
			read: [
				'~',
				'~/.codex/sessions',
				{ path: '~/win', os: ['windows'] },
				{ config_field: 'dir' },
			],
			env: ['CODEX_HOME'],
			run: ['git'],
		},
		{ url: 'https://Self.Host:8443/api', dir: '/exports' },
	);
	assert.deepEqual(plan.args, [
		'run',
		'--no-prompt',
		'--no-config',
		'--no-remote',
		'--no-npm',
		'--import-map=/rt/import_map.json',
		'--allow-read=/rt,/code,/c/data,/c/tmp/s1,/home/u,/home/u/.codex/sessions,/exports',
		'--allow-write=/c/data,/c/tmp/s1',
		'--allow-env=TMPDIR,TMP,TEMP,CODEX_HOME',
		'--ignore-env',
		'--allow-sys=homedir,cpus,systemMemoryInfo,osRelease,osUptime,loadavg,statfs',
		'--allow-net=api.x.com:443,*.y.com,self.host:8443',
		'--allow-run=git',
		'/rt/runner.ts',
		'/code',
		'src/main.ts',
	]);
	assert.deepEqual(plan.cwd, '/c/data');
});

Deno.test('empty grants are omitted and any host drops the list', () => {
	const offline = launch({}, {}).args;
	assert.deepEqual(offline.some((arg) => arg.startsWith('--allow-net')), false);
	assert.deepEqual(offline.some((arg) => arg.startsWith('--allow-run')), false);
	assert.deepEqual(offline.includes('--allow-all'), false);

	// Declared but blank: no host resolves, so no network.
	const blank = launch(
		{ net: [{ config_field: 'url' }], read: [{ config_field: 'dir' }] },
		{ url: ' ', dir: '' },
	).args;
	assert.deepEqual(blank.some((arg) => arg.startsWith('--allow-net')), false);
	assert.deepEqual(
		blank.includes('--allow-read=/rt,/code,/c/data,/c/tmp/s1'),
		true,
	);

	const any = launch(
		{ net: ['*', 'a.com', { config_field: 'url' }] },
		{ url: 'not a host' },
	).args;
	assert.deepEqual(any.includes('--allow-net'), true);
});

Deno.test('invalid derived values are config errors', () => {
	assert.throws(
		() => launch({ net: [{ config_field: 'url' }] }, { url: '*.x.com' }),
		DerivedValueError,
	);
	assert.throws(
		() => launch({ read: [{ config_field: 'dir' }] }, { dir: 'relative' }),
		DerivedValueError,
	);
});

Deno.test('unrestricted mode allows all with the same dirs', () => {
	for (const permissions of [undefined, 'unrestricted']) {
		const plan = launch(permissions, {});
		assert.deepEqual(plan.args, [
			'run',
			'--allow-all',
			'--no-prompt',
			'--no-config',
			'--import-map=/rt/import_map.json',
			'/rt/runner.ts',
			'/code',
			'src/main.ts',
		]);
		assert.deepEqual(plan.cwd, '/c/data');
		assert.deepEqual(plan.envSet, [
			['DENO_DIR', '/c/deno_dir'],
			['TMPDIR', '/c/tmp/s1'],
			['TMP', '/c/tmp/s1'],
			['TEMP', '/c/tmp/s1'],
		]);
	}
});

Deno.test('permissions may be omitted but not null', () => {
	assert.throws(
		() => parsePermissions(null, fields),
		{
			message:
				'invalid permissions: permissions: expected "unrestricted" or an object, got null',
		},
	);
});

Deno.test('commas are escaped and windows verbatim prefixes removed', () => {
	const plan = launch(
		{ read: [{ path: '~/notes', os: ['windows'] }] },
		{},
		'windows',
		{ names: [] },
		{
			...paths,
			data: '\\\\?\\C:\\Users\\a,b\\data',
			tmp: '\\\\?\\UNC\\srv\\share\\tmp',
		},
	);
	assert.deepEqual(
		plan.args.find((arg) => arg.startsWith('--allow-write=')),
		'--allow-write=C:\\Users\\a,,b\\data,\\\\srv\\share\\tmp',
	);
	assert.deepEqual(
		plan.args.some((arg) => arg.endsWith(',/home/u\\notes')),
		true,
	);
});

Deno.test('loader variables are removed only when running programs', () => {
	const env = {
		names: ['LD_PRELOAD', 'DYLD_LIBRARY_PATH', 'LD_FOO', 'HTTP_PROXY', 'OLD_X'],
	};
	assert.deepEqual(launch({ run: ['git'] }, {}, 'linux', env).envRemove, [
		'LD_PRELOAD',
		'DYLD_LIBRARY_PATH',
		'LD_FOO',
	]);
	assert.deepEqual(launch({ net: ['a.com'] }, {}, 'linux', env).envRemove, []);
	assert.deepEqual(launch(undefined, {}, 'linux', env).envRemove, []);
});

Deno.test('macOS PATH gains missing Homebrew dirs in both modes', () => {
	for (const permissions of [{}, undefined]) {
		const pathOf = (path: string | undefined, os: PermissionOs) =>
			launch(permissions, {}, os, { path, names: [] }).envSet.find(([name]) =>
				name === 'PATH'
			)?.[1];
		assert.deepEqual(
			pathOf('/usr/bin:/bin', 'macos'),
			'/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
		);
		assert.deepEqual(
			pathOf('/usr/local/bin:/usr/bin', 'macos'),
			'/usr/local/bin:/usr/bin:/opt/homebrew/bin',
		);
		assert.deepEqual(
			pathOf(undefined, 'macos'),
			'/opt/homebrew/bin:/usr/local/bin',
		);
		assert.deepEqual(pathOf('/usr/bin', 'linux'), undefined);
	}
});

Deno.test('grants are sorted and deduplicated like the host sets', () => {
	const plan = launch(
		{
			net: [{ config_field: 'url' }, '*.b.com', 'b.com:80', 'a.com', 'b.com'],
			read: [{ config_field: 'dir' }, '~/z', '~/a', '~/a/'],
			env: ['Z', 'A', 'Z'],
			run: ['tar', 'git'],
		},
		{ url: 'c.com', dir: '/d' },
	);
	assert.deepEqual(
		plan.args.find((arg) => arg.startsWith('--allow-net=')),
		'--allow-net=a.com,b.com,b.com:80,*.b.com,c.com',
	);
	assert.deepEqual(
		plan.args.find((arg) => arg.startsWith('--allow-read=')),
		'--allow-read=/rt,/code,/c/data,/c/tmp/s1,/home/u/a,/home/u/z,/d',
	);
	assert.deepEqual(
		plan.args.find((arg) => arg.startsWith('--allow-env=')),
		'--allow-env=TMPDIR,TMP,TEMP,A,Z',
	);
	assert.deepEqual(plan.args.includes('--allow-run=git,tar'), true);
});

Deno.test('invalid declarations are rejected with the entry path', () => {
	const cases: [unknown, string][] = [
		[42, 'permissions: expected "unrestricted" or an object, got 42'],
		[{ write: [] }, 'permissions.write: unknown key'],
		[{ net: 'a.com' }, 'permissions.net: expected an array'],
		[
			{ net: ['https://a.com/x'] },
			'permissions.net[0]: "https://a.com/x" must be a host, not a URL; write "a.com"',
		],
		[
			{ net: ['A.com'] },
			'permissions.net[0]: "A.com": host names must be lowercase',
		],
		[
			{ net: ['a.com:0'] },
			'permissions.net[0]: "a.com:0": port "0" must be a number',
		],
		[
			{ net: ['::1'] },
			'permissions.net[0]: "::1": IPv6 addresses must be written in brackets',
		],
		[
			{ net: [{ config_field: 'token' }] },
			'permissions.net[0]: must not reference password field "token"',
		],
		[
			{ net: [{ config_field: 'dir' }] },
			'permissions.net[0]: config field "dir" must be a text field',
		],
		[{ read: ['/etc'] }, 'permissions.read[0]: "/etc" is an absolute path'],
		[
			{ read: ['~/a/../b'] },
			'permissions.read[0]: "~/a/../b" has an invalid path segment ".."',
		],
		[
			{ read: [{ path: '~/a', os: [] }] },
			'permissions.read[0].os: must list at least one',
		],
		[
			{ read: [{ config_field: 'missing' }] },
			'permissions.read[0]: config field "missing" is not declared',
		],
		[{ env: ['1X'] }, 'permissions.env[0]: "1X" is not a variable name'],
		[
			{ run: ['/bin/sh'] },
			'permissions.run[0]: "/bin/sh" must be a program name without path separators',
		],
	];
	for (const [permissions, message] of cases) {
		assert.throws(
			() => parsePermissions(permissions, fields),
			(error) => error instanceof Error && error.message.includes(message),
		);
	}
});

Deno.test('IPv4 and bracketed IPv6 literals are hosts', () => {
	const plan = launch({ net: ['127.0.0.1:8080', '[::1]', '[0:0::1]:443'] }, {});
	assert.deepEqual(
		plan.args.find((arg) => arg.startsWith('--allow-net=')),
		'--allow-net=127.0.0.1:8080,[::1],[::1]:443',
	);
});
