/**
 * `@trace/domain/testing` — verification helpers, importable by plugin authors.
 *
 * Kept in a separate entry point so the conformance suite ships with the package (a contract
 * nobody can run is just a comment) without pulling test-only code into production imports.
 */

export { assertValidEvidenceKind, MAX_SUMMARY_CHARS } from './conformance.ts';
