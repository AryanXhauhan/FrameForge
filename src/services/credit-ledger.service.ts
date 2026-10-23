import { Prisma, CreditTransactionType, CreditTransactionStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { InsufficientCreditsError } from '../utils/errors';
import { appLogger } from '../utils/logger';

export class CreditLedgerService {
  private logger = appLogger.child('CreditLedger');

  /**
   * Atomically reserve credits for a job using row-level locking (SELECT ... FOR UPDATE).
   * Idempotent by idempotencyKey.
   */
  async reserveCredits(
    userId: string,
    jobId: string,
    amount: number,
    idempotencyKey?: string,
    txClient?: Prisma.TransactionClient
  ): Promise<{ success: boolean; balance: number; reservedCredits: number }> {
    const runInTx = async (tx: Prisma.TransactionClient) => {
      // 1. Check if transaction already exists for idempotency
      if (idempotencyKey) {
        const existingTx = await tx.creditTransaction.findUnique({
          where: { idempotencyKey },
        });
        if (existingTx) {
          const account = await tx.creditAccount.findUniqueOrThrow({ where: { userId } });
          return { success: true, balance: account.balance, reservedCredits: account.reservedCredits };
        }
      }

      // 2. Lock account row with FOR UPDATE
      const accounts = await tx.$queryRaw<Array<{ id: string; balance: number; reservedCredits: number; version: number }>>`
        SELECT id, balance, "reservedCredits", version 
        FROM credit_accounts 
        WHERE "userId" = ${userId} 
        FOR UPDATE
      `;

      if (!accounts || accounts.length === 0) {
        // Create initial account if none exists
        await tx.creditAccount.create({
          data: {
            userId,
            balance: 100,
            reservedCredits: 0,
          },
        });
        return this.reserveCredits(userId, jobId, amount, idempotencyKey, tx);
      }

      const account = accounts[0];
      const available = account.balance - account.reservedCredits;

      if (available < amount) {
        throw new InsufficientCreditsError(
          `Insufficient credits: available ${available}, requested ${amount} (balance: ${account.balance}, reserved: ${account.reservedCredits})`
        );
      }

      // 3. Increment reserved credits
      const updatedAccount = await tx.creditAccount.update({
        where: { id: account.id },
        data: {
          reservedCredits: { increment: amount },
          version: { increment: 1 },
        },
      });

      // 4. Record RESERVE transaction
      await tx.creditTransaction.create({
        data: {
          userId,
          jobId,
          type: CreditTransactionType.RESERVE,
          amount,
          status: CreditTransactionStatus.PENDING,
          idempotencyKey: idempotencyKey || undefined,
        },
      });

      this.logger.info(`Reserved ${amount} credits for user ${userId}, job ${jobId}`, {
        userId,
        jobId,
        available: updatedAccount.balance - updatedAccount.reservedCredits,
      });

      return {
        success: true,
        balance: updatedAccount.balance,
        reservedCredits: updatedAccount.reservedCredits,
      };
    };

    const executeWithRetry = async (retries = 3, delayMs = 50): Promise<{ success: boolean; balance: number; reservedCredits: number }> => {
      try {
        if (txClient) {
          return await runInTx(txClient);
        } else {
          return await prisma.$transaction(runInTx, {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 10000,
            timeout: 25000,
          });
        }
      } catch (err: any) {
        // Postgres 40001 (serialization failure) or concurrent update retry
        if (
          retries > 0 &&
          (err?.code === '40001' || err?.message?.includes('could not serialize access') || err?.message?.includes('deadlock'))
        ) {
          this.logger.warn(`Concurrent update detected in reserveCredits, retrying (${retries} left)...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return executeWithRetry(retries - 1, delayMs * 2);
        }
        throw err;
      }
    };

    return executeWithRetry();
  }

  /**
   * Consume reserved credits upon successful job completion.
   * Decrements both balance and reservedCredits.
   */
  async consumeReservedCredits(
    userId: string,
    jobId: string,
    amount: number,
    txClient?: Prisma.TransactionClient
  ): Promise<void> {
    const runInTx = async (tx: Prisma.TransactionClient) => {
      // Find pending reservation for this job
      const reservation = await tx.creditTransaction.findFirst({
        where: {
          userId,
          jobId,
          type: CreditTransactionType.RESERVE,
          status: CreditTransactionStatus.PENDING,
        },
      });

      if (!reservation) {
        this.logger.warn(`No pending credit reservation found to consume for job ${jobId}`);
        return;
      }

      // Update account: balance -= amount, reservedCredits -= amount
      await tx.creditAccount.update({
        where: { userId },
        data: {
          balance: { decrement: amount },
          reservedCredits: { decrement: amount },
          version: { increment: 1 },
        },
      });

      // Mark reservation settled
      await tx.creditTransaction.update({
        where: { id: reservation.id },
        data: { status: CreditTransactionStatus.SETTLED },
      });

      // Record CONSUME record
      await tx.creditTransaction.create({
        data: {
          userId,
          jobId,
          type: CreditTransactionType.CONSUME,
          amount,
          status: CreditTransactionStatus.SETTLED,
        },
      });

      this.logger.info(`Consumed ${amount} credits for user ${userId}, job ${jobId}`, { userId, jobId });
    };

    if (txClient) {
      await runInTx(txClient);
    } else {
      await prisma.$transaction(runInTx, {
        maxWait: 10000,
        timeout: 20000,
      });
    }
  }

  /**
   * Release reserved credits back to user if job fails or is cancelled.
   */
  async releaseReservedCredits(
    userId: string,
    jobId: string,
    amount: number,
    txClient?: Prisma.TransactionClient
  ): Promise<void> {
    const runInTx = async (tx: Prisma.TransactionClient) => {
      const reservation = await tx.creditTransaction.findFirst({
        where: {
          userId,
          jobId,
          type: CreditTransactionType.RESERVE,
          status: CreditTransactionStatus.PENDING,
        },
      });

      if (!reservation) {
        return; // Already released or no reservation
      }

      // Decrement reservedCredits only
      await tx.creditAccount.update({
        where: { userId },
        data: {
          reservedCredits: { decrement: amount },
          version: { increment: 1 },
        },
      });

      await tx.creditTransaction.update({
        where: { id: reservation.id },
        data: { status: CreditTransactionStatus.RELEASED },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          jobId,
          type: CreditTransactionType.RELEASE,
          amount,
          status: CreditTransactionStatus.SETTLED,
        },
      });

      this.logger.info(`Released ${amount} reserved credits for user ${userId}, job ${jobId}`, { userId, jobId });
    };

    if (txClient) {
      await runInTx(txClient);
    } else {
      await prisma.$transaction(runInTx, {
        maxWait: 10000,
        timeout: 20000,
      });
    }
  }

  /**
   * Reset user credits to a specific target balance (e.g. 50 or 100)
   */
  async resetCredits(userId: string, targetBalance: number = 50): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const account = await tx.creditAccount.upsert({
        where: { userId },
        create: {
          userId,
          balance: targetBalance,
          reservedCredits: 0,
        },
        update: {
          balance: targetBalance,
          reservedCredits: 0,
          version: { increment: 1 },
        },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          type: CreditTransactionType.GRANT,
          amount: targetBalance,
          status: CreditTransactionStatus.SETTLED,
        },
      });

      this.logger.info(`Reset credits for user ${userId} to ${targetBalance}`);
      return account.balance;
    });
  }

  async getAccount(userId: string) {
    let account = await prisma.creditAccount.findUnique({ where: { userId } });
    if (!account) {
      account = await prisma.creditAccount.create({
        data: {
          userId,
          balance: 100,
          reservedCredits: 0,
        },
      });
    }
    return {
      balance: account.balance,
      reservedCredits: account.reservedCredits,
      availableCredits: account.balance - account.reservedCredits,
    };
  }
}

export const creditLedger = new CreditLedgerService();
