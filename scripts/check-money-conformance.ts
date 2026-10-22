#!/usr/bin/env ts-node
/**
 * CI conformance gate for the shared money policy.
 *
 * Runs the same versioned vector set (contracts/money/vectors/money-policy.v1.json)
 * through both implementations:
 *   - Rust:    `cargo test -p money conformance -- --nocapture`
 *   - Backend: `jest` conformance suite under backend/src/money
 *
 * On divergence or failure, prints the minimized failing vector together with the
 * package name (`contracts/money` or `backend`) and exits non-zero.
 * Exits zero only when both suites pass.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const VECTORS_PATH = join(REPO_ROOT, 'contracts', 'money', 'vectors', 'money-policy.v1.json');
const BACKEND_DIR = join(REPO_ROOT, 'backend');

const SUPPORTED_VECTOR_VERSION = 1;

type PackageName = 'contracts/money' | 'backend';

interface MoneyVector {
  id: string;
  operation: string;
  inputs: Record<string, unknown>;
  expected: unknown;
  [key: string]: unknown;
}

interface VectorFile {
  version: number;
  policy?: string;
  vectors: MoneyVector[];
  [key: string]: unknown;
}

interface SuiteResult {
  packageName: PackageName;
  passed: boolean;
  output: string;
  failingVectorIds: string[];
}

function fail(message: string): never {
  console.error(`[money-conformance] ERROR: ${message}`);
  process.exit(1);
}

function loadAndValidateVectors(): VectorFile {
  if (!existsSync(VECTORS_PATH)) {
    fail(`vector file not found at ${VECTORS_PATH}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
  } catch (err) {
    fail(`failed to parse vector file: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('vector file must contain a JSON object');
  }

  const file = parsed as VectorFile;

  if (typeof file.version !== 'number' || !Number.isInteger(file.version)) {
    fail('vector file is missing an integer "version" field');
  }

  if (file.version !== SUPPORTED_VECTOR_VERSION) {
    fail(
      `unsupported vector version ${file.version}; expected ${SUPPORTED_VECTOR_VERSION}`,
    );
  }

  if (!Array.isArray(file.vectors) || file.vectors.length === 0) {
    fail('vector file must contain a non-empty "vectors" array');
  }

  const seenIds = new Set<string>();
  file.vectors.forEach((vector, index) => {
    const where = `vectors[${index}]`;
    if (typeof vector !== 'object' || vector === null) {
      fail(`${where} must be an object`);
    }
    if (typeof vector.id !== 'string' || vector.id.length === 0) {
      fail(`${where} is missing a non-empty string "id"`);
    }
    if (seenIds.has(vector.id)) {
      fail(`duplicate vector id "${vector.id}"`);
    }
    seenIds.add(vector.id);
    if (typeof vector.operation !== 'string' || vector.operation.length === 0) {
      fail(`vector "${vector.id}" is missing a non-empty string "operation"`);
    }
    if (typeof vector.inputs !== 'object' || vector.inputs === null || Array.isArray(vector.inputs)) {
      fail(`vector "${vector.id}" is missing an object "inputs" field`);
    }
    if (!('expected' in vector)) {
      fail(`vector "${vector.id}" is missing an "expected" field`);
    }
  });

  return file;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): { status: number; output: string } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });

  if (result.error) {
    return {
      status: 1,
      output: `failed to spawn "${command}": ${result.error.message}`,
    };
  }

  const output = [result.stdout ?? '', result.stderr ?? ''].join('\n');
  return { status: result.status ?? 1, output };
}

/**
 * Extract failing vector ids from suite output. Both suites are expected to emit
 * lines of the form: `MONEY_CONFORMANCE_FAIL vector=<id>`.
 */
function extractFailingVectorIds(output: string): string[] {
  const ids = new Set<string>();
  const pattern = /MONEY_CONFORMANCE_FAIL\s+vector=(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

function runRustSuite(): SuiteResult {
  const { status, output } = runCommand(
    'cargo',
    ['test', '-p', 'money', 'conformance', '--', '--nocapture'],
    REPO_ROOT,
  );
  return {
    packageName: 'contracts/money',
    passed: status === 0,
    output,
    failingVectorIds: extractFailingVectorIds(output),
  };
}

function runBackendSuite(): SuiteResult {
  const { status, output } = runCommand(
    'npx',
    ['jest', '--runInBand', '--testPathPattern', 'money.*conformance', '--verbose'],
    BACKEND_DIR,
  );
  return {
    packageName: 'backend',
    passed: status === 0,
    output,
    failingVectorIds: extractFailingVectorIds(output),
  };
}

function findVector(vectors: MoneyVector[], id: string): MoneyVector | undefined {
  return vectors.find((v) => v.id === id);
}

function printMinimizedVector(
  packageName: PackageName,
  vector: MoneyVector | undefined,
  vectorId: string,
  output: string,
): void {
  console.error('');
  console.error(`[money-conformance] DIVERGENCE in package: ${packageName}`);
  if (vector) {
    console.error(`  id:        ${vector.id}`);
    console.error(`  operation: ${vector.operation}`);
    console.error(`  inputs:    ${JSON.stringify(vector.inputs)}`);
    console.error(`  expected:  ${JSON.stringify(vector.expected)}`);
  } else {
    console.error(`  id:        ${vectorId}`);
    console.error('  (vector definition not found in shared vector file)');
  }
  console.error('  actual:    see suite output below');
  console.error('  --- suite output ---');
  console.error(output.trim());
  console.error('  --------------------');
}

function reportFailure(result: SuiteResult, vectors: MoneyVector[]): void {
  if (result.failingVectorIds.length > 0) {
    for (const id of result.failingVectorIds) {
      printMinimizedVector(result.packageName, findVector(vectors, id), id, result.output);
    }
  } else {
    // Suite failed without a structured vector marker; surface the raw output.
    console.error('');
    console.error(`[money-conformance] FAILURE in package: ${result.packageName}`);
    console.error('  (no structured failing vector reported)');
    console.error('  --- suite output ---');
    console.error(result.output.trim());
    console.error('  --------------------');
  }
}

function main(): void {
  console.log('[money-conformance] loading shared vectors...');
  const vectorFile = loadAndValidateVectors();
  console.log(
    `[money-conformance] loaded ${vectorFile.vectors.length} vectors (version ${vectorFile.version})`,
  );

  console.log('[money-conformance] running Rust suite (contracts/money)...');
  const rustResult = runRustSuite();

  console.log('[money-conformance] running backend suite (backend)...');
  const backendResult = runBackendSuite();

  let failed = false;

  if (!rustResult.passed) {
    failed = true;
    reportFailure(rustResult, vectorFile.vectors);
  }

  if (!backendResult.passed) {
    failed = true;
    reportFailure(backendResult, vectorFile.vectors);
  }

  if (failed) {
    console.error('');
    console.error('[money-conformance] FAILED: implementations diverged from shared vectors.');
    process.exit(1);
  }

  console.log('[money-conformance] PASSED: both implementations conform to shared vectors.');
  process.exit(0);
}

main();