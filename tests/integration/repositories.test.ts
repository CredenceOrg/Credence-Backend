import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import {
	AttestationsRepository,
	BondsRepository,
	IdentitiesRepository,
	ScoreHistoryRepository,
	SlashEventsRepository,
	type BondStatus,
} from "../../src/db/repositories/index.js";
import {
	createSchema,
	dropSchema,
	resetDatabase,
} from "../../src/db/schema.js";
import { createTestDatabase, type TestDatabase } from "./testDatabase.js";

const delay = async (milliseconds: number): Promise<void> => {
	await new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
};

const expectPgError = async (
	operation: Promise<unknown>,
	code: string,
): Promise<void> => {
	await assert.rejects(operation, (error: unknown) => {
		return Boolean((error as { code?: string }).code === code);
	});
};

describe("DB repositories integration", () => {
	let database: TestDatabase;

	let identitiesRepository: IdentitiesRepository;
	let bondsRepository: BondsRepository;
	let attestationsRepository: AttestationsRepository;
	let slashEventsRepository: SlashEventsRepository;
	let scoreHistoryRepository: ScoreHistoryRepository;

	before(async () => {
		database = await createTestDatabase();

		await createSchema(database.pool);

		identitiesRepository = new IdentitiesRepository(database.pool);
		bondsRepository = new BondsRepository(database.pool);
		attestationsRepository = new AttestationsRepository(database.pool);
		slashEventsRepository = new SlashEventsRepository(database.pool);
		scoreHistoryRepository = new ScoreHistoryRepository(database.pool);
	});

	beforeEach(async () => {
		await resetDatabase(database.pool);
	});

	after(async () => {
		await dropSchema(database.pool);
		await database.close();
	});

	describe("identities repository", () => {
		it("supports CRUD and list query", async () => {
			const first = await identitiesRepository.create({
				address: "GIDENTITY_1",
				displayName: "Alice",
			});
			const second = await identitiesRepository.create({
				address: "GIDENTITY_2",
			});

			const fetched = await identitiesRepository.findByAddress(first.address);
			assert.ok(fetched);
			assert.equal(fetched.displayName, "Alice");

			const all = await identitiesRepository.list();
			assert.deepEqual(
				all.map((identity) => identity.address),
				["GIDENTITY_1", "GIDENTITY_2"],
			);

			await delay(10);
			const updated = await identitiesRepository.update(first.address, {
				displayName: "Alice Updated",
			});

			assert.ok(updated);
			assert.equal(updated.displayName, "Alice Updated");
			assert.ok(updated.updatedAt.getTime() > first.updatedAt.getTime());

			assert.equal(
				await identitiesRepository.update("UNKNOWN", { displayName: null }),
				null,
			);

			assert.equal(await identitiesRepository.delete(second.address), true);
			assert.equal(await identitiesRepository.delete(second.address), false);
			assert.equal(
				await identitiesRepository.findByAddress(second.address),
				null,
			);
		});

		it("enforces unique and non-empty address constraints", async () => {
			await identitiesRepository.create({ address: "DUPLICATE" });

			await expectPgError(
				identitiesRepository.create({ address: "DUPLICATE" }),
				"23505",
			);

			await expectPgError(
				identitiesRepository.create({ address: "   " }),
				"23514",
			);
		});
	});

	describe("bonds repository", () => {
		it("supports CRUD and identity query methods", async () => {
			await identitiesRepository.create({ address: "GBOND_OWNER" });

			const created = await bondsRepository.create({
				identityAddress: "GBOND_OWNER",
				amount: "12.5",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			const found = await bondsRepository.findById(created.id);
			assert.ok(found);
			assert.equal(found.status, "active");

			const byIdentity = await bondsRepository.listByIdentity("GBOND_OWNER");
			assert.equal(byIdentity.length, 1);
			assert.equal(byIdentity[0].id, created.id);

			const updated = await bondsRepository.updateStatus(
				created.id,
				"released",
			);
			assert.ok(updated);
			assert.equal(updated.status, "released");

			assert.equal(await bondsRepository.updateStatus(9_999, "slashed"), null);

			assert.equal(await bondsRepository.delete(created.id), true);
			assert.equal(await bondsRepository.delete(created.id), false);
			assert.equal(await bondsRepository.findById(created.id), null);
			assert.deepEqual(await bondsRepository.listByIdentity("UNKNOWN"), []);
		});

		it("enforces foreign keys and check constraints", async () => {
			await identitiesRepository.create({ address: "GBOND_CONSTRAINTS" });

			await expectPgError(
				bondsRepository.create({
					identityAddress: "MISSING_IDENTITY",
					amount: "10",
					startTime: new Date("2025-01-01T00:00:00.000Z"),
					durationDays: 10,
				}),
				"23503",
			);

			await expectPgError(
				bondsRepository.create({
					identityAddress: "GBOND_CONSTRAINTS",
					amount: "-0.1",
					startTime: new Date("2025-01-01T00:00:00.000Z"),
					durationDays: 10,
				}),
				"23514",
			);

			await expectPgError(
				bondsRepository.create({
					identityAddress: "GBOND_CONSTRAINTS",
					amount: "10",
					startTime: new Date("2025-01-01T00:00:00.000Z"),
					durationDays: 0,
				}),
				"23514",
			);

			await expectPgError(
				bondsRepository.create({
					identityAddress: "GBOND_CONSTRAINTS",
					amount: "10",
					startTime: new Date("2025-01-01T00:00:00.000Z"),
					durationDays: 10,
					status: "invalid" as BondStatus,
				}),
				"23514",
			);
		});

		it("cascades bond rows when owning identity is deleted", async () => {
			await identitiesRepository.create({ address: "GBOND_CASCADE" });

			const bond = await bondsRepository.create({
				identityAddress: "GBOND_CASCADE",
				amount: "22.0",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 14,
			});

			assert.equal(await identitiesRepository.delete("GBOND_CASCADE"), true);
			assert.equal(await bondsRepository.findById(bond.id), null);
		});
	});

	describe("attestations repository", () => {
		it("supports CRUD and query methods", async () => {
			await identitiesRepository.create({ address: "GSUBJECT" });
			await identitiesRepository.create({ address: "GATTESTER" });

			const bond = await bondsRepository.create({
				identityAddress: "GSUBJECT",
				amount: "5.0",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 20,
			});

			const created = await attestationsRepository.create({
				bondId: bond.id,
				attesterAddress: "GATTESTER",
				subjectAddress: "GSUBJECT",
				score: 70,
				note: "good behavior",
			});

			const found = await attestationsRepository.findById(created.id);
			assert.ok(found);
			assert.equal(found.score, 70);

			const bySubject = await attestationsRepository.listBySubject("GSUBJECT");
			assert.equal(bySubject.length, 1);
			assert.equal(bySubject[0].id, created.id);

			const byBond = await attestationsRepository.listByBond(bond.id);
			assert.equal(byBond.length, 1);

			const updated = await attestationsRepository.updateScore(created.id, 90);
			assert.ok(updated);
			assert.equal(updated.score, 90);

			assert.equal(await attestationsRepository.updateScore(99_999, 40), null);

			assert.equal(await attestationsRepository.delete(created.id), true);
			assert.equal(await attestationsRepository.delete(created.id), false);
			assert.equal(await attestationsRepository.findById(created.id), null);
			assert.deepEqual(await attestationsRepository.listByBond(99_999), []);
		});

		it("enforces unique, foreign key, and score constraints", async () => {
			await identitiesRepository.create({ address: "GSUBJECT_CONSTRAINTS" });
			await identitiesRepository.create({ address: "GATTESTER_CONSTRAINTS" });

			const bond = await bondsRepository.create({
				identityAddress: "GSUBJECT_CONSTRAINTS",
				amount: "9",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 12,
			});

			await attestationsRepository.create({
				bondId: bond.id,
				attesterAddress: "GATTESTER_CONSTRAINTS",
				subjectAddress: "GSUBJECT_CONSTRAINTS",
				score: 80,
			});

			await expectPgError(
				attestationsRepository.create({
					bondId: bond.id,
					attesterAddress: "GATTESTER_CONSTRAINTS",
					subjectAddress: "GSUBJECT_CONSTRAINTS",
					score: 82,
				}),
				"23505",
			);

			await expectPgError(
				attestationsRepository.create({
					bondId: 999_999,
					attesterAddress: "GATTESTER_CONSTRAINTS",
					subjectAddress: "GSUBJECT_CONSTRAINTS",
					score: 50,
				}),
				"23503",
			);

			await expectPgError(
				attestationsRepository.create({
					bondId: bond.id,
					attesterAddress: "GATTESTER_CONSTRAINTS",
					subjectAddress: "GSUBJECT_CONSTRAINTS",
					score: 101,
				}),
				"23514",
			);
		});

		it("cascades attestations when the related bond is deleted", async () => {
			await identitiesRepository.create({ address: "GSUBJECT_CASCADE" });
			await identitiesRepository.create({ address: "GATTESTER_CASCADE" });

			const bond = await bondsRepository.create({
				identityAddress: "GSUBJECT_CASCADE",
				amount: "12",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 10,
			});

			const attestation = await attestationsRepository.create({
				bondId: bond.id,
				attesterAddress: "GATTESTER_CASCADE",
				subjectAddress: "GSUBJECT_CASCADE",
				score: 75,
			});

			assert.equal(await bondsRepository.delete(bond.id), true);
			assert.equal(await attestationsRepository.findById(attestation.id), null);
		});
	});

	describe("slash events repository", () => {
		it("supports CRUD, list and aggregate query methods", async () => {
			await identitiesRepository.create({ address: "GSLASH_OWNER" });

			const bond = await bondsRepository.create({
				identityAddress: "GSLASH_OWNER",
				amount: "50",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 100,
			});

			const first = await slashEventsRepository.create({
				bondId: bond.id,
				slashAmount: "2.5",
				reason: "late payout",
			});

			const second = await slashEventsRepository.create({
				bondId: bond.id,
				slashAmount: "4",
				reason: "evidence mismatch",
			});

			const found = await slashEventsRepository.findById(first.id);
			assert.ok(found);
			assert.equal(found.reason, "late payout");

			const listed = await slashEventsRepository.listByBond(bond.id);
			assert.deepEqual(
				listed.map((event) => event.id),
				[second.id, first.id],
			);

			const total = await slashEventsRepository.totalSlashedForBond(bond.id);
			assert.ok(Math.abs(Number(total) - 6.5) < 0.00001);
			assert.equal(
				await slashEventsRepository.totalSlashedForBond(999_999),
				"0",
			);

			assert.equal(await slashEventsRepository.delete(first.id), true);
			assert.equal(await slashEventsRepository.delete(first.id), false);
			assert.equal(await slashEventsRepository.findById(first.id), null);
			assert.deepEqual(await slashEventsRepository.listByBond(999_999), []);
		});

		it("enforces foreign keys and slash constraints", async () => {
			await identitiesRepository.create({ address: "GSLASH_CONSTRAINTS" });

			const bond = await bondsRepository.create({
				identityAddress: "GSLASH_CONSTRAINTS",
				amount: "20",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 7,
			});

			await expectPgError(
				slashEventsRepository.create({
					bondId: 999_999,
					slashAmount: "1",
					reason: "bad bond",
				}),
				"23503",
			);

			await expectPgError(
				slashEventsRepository.create({
					bondId: bond.id,
					slashAmount: "0",
					reason: "bad amount",
				}),
				"23514",
			);

			await expectPgError(
				slashEventsRepository.create({
					bondId: bond.id,
					slashAmount: "1",
					reason: "   ",
				}),
				"23514",
			);
		});

		it("cascades slash events when parent bond is deleted", async () => {
			await identitiesRepository.create({ address: "GSLASH_CASCADE" });

			const bond = await bondsRepository.create({
				identityAddress: "GSLASH_CASCADE",
				amount: "3",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 3,
			});

			const slashEvent = await slashEventsRepository.create({
				bondId: bond.id,
				slashAmount: "1.3",
				reason: "violation",
			});

			assert.equal(await bondsRepository.delete(bond.id), true);
			assert.equal(await slashEventsRepository.findById(slashEvent.id), null);
		});
	});

	describe("score history repository", () => {
		it("supports create, list, latest, and delete methods", async () => {
			await identitiesRepository.create({ address: "GSCORE_OWNER" });

			const older = await scoreHistoryRepository.create({
				identityAddress: "GSCORE_OWNER",
				score: 30,
				source: "bond",
				computedAt: new Date("2025-01-01T00:00:00.000Z"),
			});

			const newer = await scoreHistoryRepository.create({
				identityAddress: "GSCORE_OWNER",
				score: 80,
				source: "manual",
				computedAt: new Date("2025-01-02T00:00:00.000Z"),
			});

			const listed =
				await scoreHistoryRepository.listByIdentity("GSCORE_OWNER");
			assert.deepEqual(
				listed.map((entry) => entry.id),
				[newer.id, older.id],
			);

			const latest =
				await scoreHistoryRepository.findLatestByIdentity("GSCORE_OWNER");
			assert.ok(latest);
			assert.equal(latest.id, newer.id);
			assert.equal(latest.score, 80);

			assert.equal(
				await scoreHistoryRepository.findLatestByIdentity("UNKNOWN"),
				null,
			);

			assert.equal(await scoreHistoryRepository.delete(older.id), true);
			assert.equal(await scoreHistoryRepository.delete(older.id), false);
		});

		it("enforces foreign keys and value constraints", async () => {
			await identitiesRepository.create({ address: "GSCORE_CONSTRAINTS" });

			await expectPgError(
				scoreHistoryRepository.create({
					identityAddress: "MISSING",
					score: 10,
					source: "bond",
				}),
				"23503",
			);

			await expectPgError(
				scoreHistoryRepository.create({
					identityAddress: "GSCORE_CONSTRAINTS",
					score: -1,
					source: "bond",
				}),
				"23514",
			);

			await expectPgError(
				scoreHistoryRepository.create({
					identityAddress: "GSCORE_CONSTRAINTS",
					score: 50,
					source: "invalid" as never,
				}),
				"23514",
			);
		});

		it("cascades history rows when identity is deleted", async () => {
			await identitiesRepository.create({ address: "GSCORE_CASCADE" });

			await scoreHistoryRepository.create({
				identityAddress: "GSCORE_CASCADE",
				score: 77,
				source: "slash",
			});

			assert.equal(await identitiesRepository.delete("GSCORE_CASCADE"), true);
			assert.deepEqual(
				await scoreHistoryRepository.listByIdentity("GSCORE_CASCADE"),
				[],
			);
		});
	});

	describe("cross-table foreign key behavior", () => {
		it("cascades dependent rows from identities to all child tables", async () => {
			await identitiesRepository.create({ address: "GCASCADE_OWNER" });
			await identitiesRepository.create({ address: "GCASCADE_ATTESTER" });

			const bond = await bondsRepository.create({
				identityAddress: "GCASCADE_OWNER",
				amount: "15",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 8,
			});

			const attestation = await attestationsRepository.create({
				bondId: bond.id,
				attesterAddress: "GCASCADE_ATTESTER",
				subjectAddress: "GCASCADE_OWNER",
				score: 91,
			});

			const slashEvent = await slashEventsRepository.create({
				bondId: bond.id,
				slashAmount: "2.0",
				reason: "policy violation",
			});

			await scoreHistoryRepository.create({
				identityAddress: "GCASCADE_OWNER",
				score: 65,
				source: "attestation",
			});

			assert.equal(await identitiesRepository.delete("GCASCADE_OWNER"), true);

			assert.equal(await bondsRepository.findById(bond.id), null);
			assert.equal(await attestationsRepository.findById(attestation.id), null);
			assert.equal(await slashEventsRepository.findById(slashEvent.id), null);
			assert.deepEqual(
				await scoreHistoryRepository.listByIdentity("GCASCADE_OWNER"),
				[],
			);
			assert.notEqual(
				await identitiesRepository.findByAddress("GCASCADE_ATTESTER"),
				null,
			);
		});
	});

	describe("edge cases and additional coverage", () => {
		it("handles empty results gracefully", async () => {
			// Test empty lists
			assert.deepEqual(await identitiesRepository.list(), []);
			assert.deepEqual(await bondsRepository.listByIdentity("NONEXISTENT"), []);
			assert.deepEqual(
				await attestationsRepository.listBySubject("NONEXISTENT"),
				[],
			);
			assert.deepEqual(await attestationsRepository.listByBond(999999), []);
			assert.deepEqual(await slashEventsRepository.listByBond(999999), []);
			assert.deepEqual(
				await scoreHistoryRepository.listByIdentity("NONEXISTENT"),
				[],
			);

			// Test null returns for missing entities
			assert.equal(await identitiesRepository.findByAddress("MISSING"), null);
			assert.equal(await bondsRepository.findById(999999), null);
			assert.equal(await attestationsRepository.findById(999999), null);
			assert.equal(await slashEventsRepository.findById(999999), null);
			assert.equal(
				await scoreHistoryRepository.findLatestByIdentity("MISSING"),
				null,
			);
		});

		it("handles boundary values correctly", async () => {
			await identitiesRepository.create({ address: "GBOUNDARY_TEST" });

			// Test minimum and maximum valid scores
			await scoreHistoryRepository.create({
				identityAddress: "GBOUNDARY_TEST",
				score: 0, // minimum
				source: "manual",
			});

			await scoreHistoryRepository.create({
				identityAddress: "GBOUNDARY_TEST",
				score: 100, // maximum
				source: "bond",
			});

			const bond1 = await bondsRepository.create({
				identityAddress: "GBOUNDARY_TEST",
				amount: "0.0000001", // very small amount
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 1, // minimum duration
			});

			const bond2 = await bondsRepository.create({
				identityAddress: "GBOUNDARY_TEST",
				amount: "1.0",
				startTime: new Date("2025-01-02T00:00:00.000Z"),
				durationDays: 2,
			});

			await attestationsRepository.create({
				bondId: bond1.id,
				attesterAddress: "GBOUNDARY_TEST",
				subjectAddress: "GBOUNDARY_TEST",
				score: 0, // minimum score
			});

			await attestationsRepository.create({
				bondId: bond2.id,
				attesterAddress: "GBOUNDARY_TEST",
				subjectAddress: "GBOUNDARY_TEST",
				score: 100, // maximum score
			});
		});

		it("handles special string characters and nulls", async () => {
			// Test with special characters in address
			const specialAddress = "GSPECIAL_ÄÖÜß@#$%";
			await identitiesRepository.create({
				address: specialAddress,
				displayName: "Special ÄÖÜß Characters & Symbols @#$%",
			});

			const found = await identitiesRepository.findByAddress(specialAddress);
			assert.ok(found);
			assert.equal(found.displayName, "Special ÄÖÜß Characters & Symbols @#$%");

			// Test null display name
			await identitiesRepository.create({
				address: "GNULL_TEST",
				displayName: null,
			});

			const nullTest = await identitiesRepository.findByAddress("GNULL_TEST");
			assert.ok(nullTest);
			assert.equal(nullTest.displayName, null);

			// Test updating to and from null
			await identitiesRepository.update("GNULL_TEST", {
				displayName: "Not null anymore",
			});
			await identitiesRepository.update("GNULL_TEST", { displayName: null });

			const backToNull = await identitiesRepository.findByAddress("GNULL_TEST");
			assert.ok(backToNull);
			assert.equal(backToNull.displayName, null);
		});

		it("handles large amounts and long strings", async () => {
			await identitiesRepository.create({ address: "GLARGE_TEST" });

			// Test large monetary amounts
			const bond = await bondsRepository.create({
				identityAddress: "GLARGE_TEST",
				amount: "999999999999.9999999", // large amount with max precision
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 32767, // large duration
			});

			// Test long strings
			const longReason = "A".repeat(1000); // Very long reason string
			await slashEventsRepository.create({
				bondId: bond.id,
				slashAmount: "123456789.1234567",
				reason: longReason,
			});

			const longNote = "N".repeat(2000); // Very long note
			await attestationsRepository.create({
				bondId: bond.id,
				attesterAddress: "GLARGE_TEST",
				subjectAddress: "GLARGE_TEST",
				score: 50,
				note: longNote,
			});
		});

		it("validates complex constraint interactions", async () => {
			await identitiesRepository.create({ address: "GCOMPLEX_1" });
			await identitiesRepository.create({ address: "GCOMPLEX_2" });

			const bond = await bondsRepository.create({
				identityAddress: "GCOMPLEX_1",
				amount: "10",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 30,
			});

			// Test attestation uniqueness constraint with different combinations
			await attestationsRepository.create({
				bondId: bond.id,
				attesterAddress: "GCOMPLEX_1",
				subjectAddress: "GCOMPLEX_2",
				score: 70,
			});

			// This should work (different attester)
			await attestationsRepository.create({
				bondId: bond.id,
				attesterAddress: "GCOMPLEX_2",
				subjectAddress: "GCOMPLEX_1",
				score: 80,
			});

			// This should fail (duplicate attester-subject for same bond)
			await expectPgError(
				attestationsRepository.create({
					bondId: bond.id,
					attesterAddress: "GCOMPLEX_1",
					subjectAddress: "GCOMPLEX_2",
					score: 75,
				}),
				"23505",
			);
		});

		it("tests all score sources and bond statuses", async () => {
			await identitiesRepository.create({ address: "GENUM_TEST" });

			// Test all score sources
			const sources = ["bond", "attestation", "slash", "manual"] as const;
			for (const source of sources) {
				await scoreHistoryRepository.create({
					identityAddress: "GENUM_TEST",
					score: 50,
					source,
				});
			}

			const history = await scoreHistoryRepository.listByIdentity("GENUM_TEST");
			assert.equal(history.length, 4);
			assert.ok(
				sources.every((source) =>
					history.some((entry) => entry.source === source),
				),
			);

			// Test all bond statuses
			const bond1 = await bondsRepository.create({
				identityAddress: "GENUM_TEST",
				amount: "5",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 10,
				status: "active",
			});

			const bond2 = await bondsRepository.create({
				identityAddress: "GENUM_TEST",
				amount: "5",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 10,
				status: "released",
			});

			const bond3 = await bondsRepository.create({
				identityAddress: "GENUM_TEST",
				amount: "5",
				startTime: new Date("2025-01-01T00:00:00.000Z"),
				durationDays: 10,
				status: "slashed",
			});

			assert.equal(bond1.status, "active");
			assert.equal(bond2.status, "released");
			assert.equal(bond3.status, "slashed");

			// Test status updates
			await bondsRepository.updateStatus(bond1.id, "released");
			await bondsRepository.updateStatus(bond2.id, "slashed");
			await bondsRepository.updateStatus(bond3.id, "active");

			const updatedBond1 = await bondsRepository.findById(bond1.id);
			assert.equal(updatedBond1?.status, "released");
		});

		it("tests timestamp and date handling", async () => {
			await identitiesRepository.create({ address: "GDATE_TEST" });

			// Test different date formats and timezones
			const utcDate = new Date("2025-06-15T14:30:00.000Z");
			const localDate = new Date("2025-06-15T14:30:00");

			const bond = await bondsRepository.create({
				identityAddress: "GDATE_TEST",
				amount: "10",
				startTime: utcDate,
				durationDays: 15,
			});

			assert.ok(bond.createdAt instanceof Date);
			assert.ok(bond.startTime instanceof Date);

			// Test score history with explicit timestamp
			const scoreEntry = await scoreHistoryRepository.create({
				identityAddress: "GDATE_TEST",
				score: 85,
				source: "manual",
				computedAt: localDate,
			});

			assert.ok(scoreEntry.computedAt instanceof Date);

			// Test timestamp ordering
			await delay(10);
			const secondEntry = await scoreHistoryRepository.create({
				identityAddress: "GDATE_TEST",
				score: 90,
				source: "bond",
			});

			const orderedHistory =
				await scoreHistoryRepository.listByIdentity("GDATE_TEST");
			assert.equal(orderedHistory[0].id, secondEntry.id); // Latest first
			assert.equal(orderedHistory[1].id, scoreEntry.id);
		});
	});
});
