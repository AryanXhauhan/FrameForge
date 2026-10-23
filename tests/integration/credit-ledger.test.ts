import { prisma } from '../../src/config/database';
import { creditLedger } from '../../src/services/credit-ledger.service';
import { InsufficientCreditsError } from '../../src/utils/errors';
import { v4 as uuidv4 } from 'uuid';

describe('CreditLedger Transactional Integration Tests', () => {
  let testUserId: string;

  let testProjectId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `test-${uuidv4()}@frameforge.io`,
        name: 'Credit Test User',
        creditAccount: {
          create: {
            balance: 20,
            reservedCredits: 0,
          },
        },
      },
    });
    testUserId = user.id;

    const project = await prisma.project.create({
      data: {
        userId: testUserId,
        name: 'Test Project',
      },
    });
    testProjectId = project.id;
  });

  afterAll(async () => {
    if (testUserId) {
      await prisma.user.delete({ where: { id: testUserId } });
    }
    await prisma.$disconnect();
  });

  async function createTestJob(): Promise<string> {
    const job = await prisma.processingJob.create({
      data: {
        userId: testUserId,
        projectId: testProjectId,
        type: 'PROXY_GENERATION',
        status: 'QUEUED',
      },
    });
    return job.id;
  }

  test('successfully reserves credits when balance is sufficient', async () => {
    const jobId = await createTestJob();
    const result = await creditLedger.reserveCredits(testUserId, jobId, 10, `idem-${jobId}`);

    expect(result.success).toBe(true);
    expect(result.reservedCredits).toBe(10);
    expect(result.balance).toBe(20);

    const account = await creditLedger.getAccount(testUserId);
    expect(account.availableCredits).toBe(10);
  });

  test('idempotency: multiple reservation calls with the same key do NOT reserve twice', async () => {
    const jobId = await createTestJob();
    const idempotencyKey = `idem-${uuidv4()}`;

    // First call: reserves 5 credits
    const firstRes = await creditLedger.reserveCredits(testUserId, jobId, 5, idempotencyKey);
    expect(firstRes.reservedCredits).toBe(15); // 10 from previous test + 5

    // Second call with same idempotency key: should be a no-op / replay
    const secondRes = await creditLedger.reserveCredits(testUserId, jobId, 5, idempotencyKey);
    expect(secondRes.reservedCredits).toBe(15); // Unchanged!
  });

  test('prevents over-allocation and rejects reservation when insufficient credits', async () => {
    const jobId = await createTestJob();
    // Current balance: 20, Reserved: 15. Available: 5. Requesting 10 should throw!
    await expect(creditLedger.reserveCredits(testUserId, jobId, 10)).rejects.toThrow(InsufficientCreditsError);

    const account = await creditLedger.getAccount(testUserId);
    expect(account.availableCredits).toBe(5);
    expect(account.balance).toBe(20);
  });

  test('settlement: consumeReservedCredits deducts balance and reserved amount', async () => {
    const jobId = await createTestJob();
    await creditLedger.reserveCredits(testUserId, jobId, 5);

    // Consume the 5 credits
    await creditLedger.consumeReservedCredits(testUserId, jobId, 5);

    const account = await creditLedger.getAccount(testUserId);
    expect(account.balance).toBe(15);
    expect(account.reservedCredits).toBe(15);
  });

  test('release: releaseReservedCredits returns reservation to available balance on failure', async () => {
    // Grant 10 credits to replenish balance for release test
    await creditLedger.grantCredits(testUserId, 10);
    const jobId = await createTestJob();
    await creditLedger.reserveCredits(testUserId, jobId, 5);

    // Release the reservation
    await creditLedger.releaseReservedCredits(testUserId, jobId, 5);

    const account = await creditLedger.getAccount(testUserId);
    expect(account.reservedCredits).toBe(15);
  });
});
