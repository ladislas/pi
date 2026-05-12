#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import { dirname, join, posix, resolve } from "path";
import { fileURLToPath } from "url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentPackagePath = "packages/coding-agent";
const codingAgentDir = join(repoRoot, codingAgentPackagePath);
const lockfilePath = join(repoRoot, "package-lock.json");
const shrinkwrapPath = join(codingAgentDir, "npm-shrinkwrap.json");

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

for (const arg of args) {
	if (arg !== "--check") {
		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function productionDependencies(pkg) {
	return {
		...(pkg.dependencies || {}),
		...(pkg.optionalDependencies || {}),
	};
}

function sortedObject(obj) {
	return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function copyLockEntry(entry) {
	const copied = { ...entry };
	delete copied.dev;
	delete copied.devOptional;
	delete copied.extraneous;
	delete copied.link;
	return sortedObject(copied);
}

function copyPackageJsonEntry(pkg, { includeName }) {
	const entry = includeName ? { name: pkg.name, version: pkg.version } : { version: pkg.version };

	for (const field of [
		"license",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
	]) {
		if (pkg[field] !== undefined) {
			entry[field] = pkg[field];
		}
	}

	return sortedObject(entry);
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) {
		throw new Error(`Cannot derive package name from lock path: ${lockPath}`);
	}

	const rest = lockPath.slice(index + marker.length).split("/");
	if (rest[0]?.startsWith("@")) {
		return `${rest[0]}/${rest[1]}`;
	}
	return rest[0];
}

function workspaceOutputPath(packageName) {
	return `node_modules/${packageName}`;
}

function findWorkspacePackages(lockPackages) {
	const workspaces = new Map();

	for (const [lockPath, entry] of Object.entries(lockPackages)) {
		if (!lockPath.startsWith("packages/") || lockPath.includes("/node_modules/") || !entry.name || !entry.version) {
			continue;
		}

		workspaces.set(entry.name, {
			lockPath,
			pkg: readJson(join(repoRoot, lockPath, "package.json")),
		});
	}

	return workspaces;
}

function createResolver(lockPackages) {
	return function resolveExternalDependency(packageName, fromLockPath) {
		const candidateDirs = [];

		let current = fromLockPath;
		while (current) {
			candidateDirs.push(current);
			const parent = posix.dirname(current);
			if (parent === "." || parent === current) {
				break;
			}
			current = parent;
		}
		candidateDirs.push("");

		const tried = new Set();
		for (const dir of candidateDirs) {
			const candidate = dir ? `${dir}/node_modules/${packageName}` : `node_modules/${packageName}`;
			if (tried.has(candidate)) {
				continue;
			}
			tried.add(candidate);

			const entry = lockPackages[candidate];
			if (entry && !entry.link) {
				return candidate;
			}
		}

		const suffix = `node_modules/${packageName}`;
		const matches = Object.entries(lockPackages)
			.filter(([lockPath, entry]) => !entry.link && (lockPath === suffix || lockPath.endsWith(`/${suffix}`)))
			.map(([lockPath]) => lockPath);

		if (matches.length === 1) {
			return matches[0];
		}

		throw new Error(
			`Cannot resolve ${packageName} from ${fromLockPath || "root"}. ` +
				(matches.length > 1 ? `Matches: ${matches.join(", ")}` : "No matching lockfile entry found."),
		);
	};
}

function validateShrinkwrapPackages(shrinkwrapPackages) {
	const errors = [];
	const includedPaths = new Set(Object.keys(shrinkwrapPackages));

	for (const [lockPath, entry] of Object.entries(shrinkwrapPackages)) {
		if (entry.link) {
			errors.push(`${lockPath} is a link entry`);
		}
		if (typeof entry.resolved === "string" && /^(file:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
	}

	for (const [lockPath, entry] of Object.entries(shrinkwrapPackages)) {
		for (const dependencyName of Object.keys(entry.optionalDependencies || {})) {
			const dependencyIncluded = [...includedPaths].some(
				(candidate) => candidate === `node_modules/${dependencyName}` || candidate.endsWith(`/node_modules/${dependencyName}`),
			);
			if (!dependencyIncluded) {
				errors.push(`${lockPath} optional dependency ${dependencyName} is missing`);
			}
		}
	}

	const platformEntries = Object.entries(shrinkwrapPackages).filter(([, entry]) => entry.os || entry.cpu || entry.libc);
	if (platformEntries.length === 0) {
		errors.push("no platform-specific optional dependency entries found");
	}

	if (errors.length > 0) {
		throw new Error(`Generated shrinkwrap failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

function generateShrinkwrap() {
	const rootLock = readJson(lockfilePath);
	if (rootLock.lockfileVersion !== 3 || !rootLock.packages) {
		throw new Error("package-lock.json must be lockfileVersion 3 and contain a packages map");
	}

	const lockPackages = rootLock.packages;
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	const workspaces = findWorkspacePackages(lockPackages);
	const resolveExternalDependency = createResolver(lockPackages);
	const shrinkwrapPackages = {
		"": copyPackageJsonEntry(codingAgentPackage, { includeName: true }),
	};
	const addedPaths = new Set([""]);
	const queue = Object.keys(productionDependencies(codingAgentPackage)).map((name) => ({ name, from: "" }));

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) {
			break;
		}

		const workspace = workspaces.get(item.name);
		if (workspace) {
			const outputPath = workspaceOutputPath(item.name);
			if (addedPaths.has(outputPath)) {
				continue;
			}

			shrinkwrapPackages[outputPath] = copyPackageJsonEntry(workspace.pkg, { includeName: false });
			addedPaths.add(outputPath);

			for (const dependencyName of Object.keys(productionDependencies(workspace.pkg))) {
				queue.push({ name: dependencyName, from: outputPath });
			}
			continue;
		}

		const lockPath = resolveExternalDependency(item.name, item.from);
		if (addedPaths.has(lockPath)) {
			continue;
		}

		const entry = lockPackages[lockPath];
		shrinkwrapPackages[lockPath] = copyLockEntry(entry);
		addedPaths.add(lockPath);

		for (const dependencyName of Object.keys(productionDependencies(entry))) {
			queue.push({ name: dependencyName, from: lockPath });
		}
	}

	validateShrinkwrapPackages(shrinkwrapPackages);

	return {
		name: codingAgentPackage.name,
		version: codingAgentPackage.version,
		lockfileVersion: 3,
		requires: true,
		packages: sortedObject(shrinkwrapPackages),
	};
}

try {
	const shrinkwrap = generateShrinkwrap();
	const content = `${JSON.stringify(shrinkwrap, null, "\t")}\n`;

	if (checkOnly) {
		const current = readFileSync(shrinkwrapPath, "utf8");
		if (current !== content) {
			console.error("packages/coding-agent/npm-shrinkwrap.json is out of date.");
			console.error("Run: npm run shrinkwrap:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/npm-shrinkwrap.json is up to date.");
	} else {
		writeFileSync(shrinkwrapPath, content);
		const packageCount = Object.keys(shrinkwrap.packages).length - 1;
		const platformPackageCount = Object.values(shrinkwrap.packages).filter((entry) => entry.os || entry.cpu || entry.libc).length;
		console.log(`Wrote packages/coding-agent/npm-shrinkwrap.json (${packageCount} packages, ${platformPackageCount} platform-specific).`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
