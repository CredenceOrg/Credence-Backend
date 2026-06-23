/**
 * Example: Wallet Operations with RBAC Policy Engine
 *
 * This example demonstrates how to combine the WalletsRepository
 * with the PolicyEngine to create a secure wallet service with
 * fine-grained access control and complete audit trails.
 */

import { Pool } from "pg";
import { WalletsRepository } from "../db/repositories/walletsRepository.js";
import {
  policyEngine,
  PolicyRules,
  PolicyDecision,
} from "../services/rbac/policyEngine.js";
import { AuthenticatedUser } from "../types/rbac.js";

// ============================================================================
// Setup
// ============================================================================

async function setupExample() {
  const pool = new Pool({
    connectionString: process.env.DB_URL,
    max: 10,
  });

  // Create wallets table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      address TEXT NOT NULL UNIQUE,
      balance NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (balance >= 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const walletRepo = new WalletsRepository(pool, pool);

  return { pool, walletRepo };
}

// ============================================================================
// Configure RBAC Policies
// ============================================================================

function configurePolicies() {
  // Public can view health status
  policyEngine.addRule(PolicyRules.publicRead("health"));

  // Users can read their own wallets
  policyEngine.addRule(
    PolicyRules.ownerOnly("read:wallet", "wallet:*", (resource) => {
      // Extract wallet address from resource identifier
      const parts = resource.split(":");
      return parts[1] || "";
    }),
  );

  // Users can debit their own wallets
  policyEngine.addRule(
    PolicyRules.ownerOnly("debit:wallet", "wallet:*", (resource) => {
      const parts = resource.split(":");
      return parts[1] || "";
    }),
  );

  // Verifiers can read any wallet
  policyEngine.addRule(
    PolicyRules.requireMinRole("read:wallet", "wallet:*", "verifier"),
  );

  // Admins can credit any wallet
  policyEngine.addRule(PolicyRules.adminOnly("credit:wallet", "wallet:*"));

  // Admins can delete wallets
  policyEngine.addRule(PolicyRules.adminOnly("delete:wallet", "wallet:*"));

  // Setup audit callback to log all decisions
  policyEngine.onAudit((log) => {
    console.log("[RBAC Audit]", {
      timestamp: log.timestamp.toISOString(),
      user: log.user?.address || "anonymous",
      action: log.action,
      resource: log.resource,
      decision: log.decision,
      reason: log.reason.message,
    });
  });
}

// ============================================================================
// Secure Wallet Service
// ============================================================================

class SecureWalletService {
  constructor(private readonly walletRepo: WalletsRepository) {}

  /**
   * Create a new wallet (authenticated users only).
   */
  async createWallet(
    user: AuthenticatedUser,
    address: string,
    initialBalance?: string,
  ) {
    // Check permission
    const authCheck = await policyEngine.check(
      user,
      "create:wallet",
      `wallet:${address}`,
    );

    if (authCheck.decision === PolicyDecision.DENY) {
      throw new Error(`Access denied: ${authCheck.reason.message}`);
    }

    return this.walletRepo.create({ address, initialBalance });
  }

  /**
   * Get wallet balance (owner or verifier+).
   */
  async getBalance(user: AuthenticatedUser | null, walletAddress: string) {
    // Check permission
    const authCheck = await policyEngine.check(
      user,
      "read:wallet",
      `wallet:${walletAddress}`,
    );

    if (authCheck.decision === PolicyDecision.DENY) {
      throw new Error(`Access denied: ${authCheck.reason.message}`);
    }

    const wallet = await this.walletRepo.findByAddress(walletAddress);
    if (!wallet) {
      throw new Error(`Wallet ${walletAddress} not found`);
    }

    return wallet.balance;
  }

  /**
   * Debit from wallet (owner only).
   */
  async debit(user: AuthenticatedUser, walletAddress: string, amount: string) {
    // Check permission
    const authCheck = await policyEngine.check(
      user,
      "debit:wallet",
      `wallet:${walletAddress}`,
      { amount, operation: "debit" },
    );

    if (authCheck.decision === PolicyDecision.DENY) {
      throw new Error(`Access denied: ${authCheck.reason.message}`);
    }

    const wallet = await this.walletRepo.findByAddress(walletAddress);
    if (!wallet) {
      throw new Error(`Wallet ${walletAddress} not found`);
    }

    return this.walletRepo.debit(wallet.id, amount);
  }

  /**
   * Credit to wallet (admin only).
   */
  async credit(user: AuthenticatedUser, walletAddress: string, amount: string) {
    // Check permission
    const authCheck = await policyEngine.check(
      user,
      "credit:wallet",
      `wallet:${walletAddress}`,
      { amount, operation: "credit" },
    );

    if (authCheck.decision === PolicyDecision.DENY) {
      throw new Error(`Access denied: ${authCheck.reason.message}`);
    }

    const wallet = await this.walletRepo.findByAddress(walletAddress);
    if (!wallet) {
      throw new Error(`Wallet ${walletAddress} not found`);
    }

    return this.walletRepo.credit(wallet.id, amount);
  }

  /**
   * Delete wallet (admin only).
   */
  async deleteWallet(user: AuthenticatedUser, walletAddress: string) {
    // Check permission
    const authCheck = await policyEngine.check(
      user,
      "delete:wallet",
      `wallet:${walletAddress}`,
    );

    if (authCheck.decision === PolicyDecision.DENY) {
      throw new Error(`Access denied: ${authCheck.reason.message}`);
    }

    const wallet = await this.walletRepo.findByAddress(walletAddress);
    if (!wallet) {
      throw new Error(`Wallet ${walletAddress} not found`);
    }

    return this.walletRepo.delete(wallet.id);
  }
}

// ============================================================================
// Example Usage
// ============================================================================

async function runExample() {
  console.log("=".repeat(60));
  console.log("Wallet with RBAC Example");
  console.log("=".repeat(60));

  const { pool, walletRepo } = await setupExample();
  configurePolicies();

  const service = new SecureWalletService(walletRepo);

  // Create test users
  const alice: AuthenticatedUser = {
    id: "alice-id",
    address: "0xALICE",
    role: "user",
  };

  const bob: AuthenticatedUser = {
    id: "bob-id",
    address: "0xBOB",
    role: "user",
  };

  const verifier: AuthenticatedUser = {
    id: "verifier-id",
    address: "0xVERIFIER",
    role: "verifier",
  };

  const admin: AuthenticatedUser = {
    id: "admin-id",
    address: "0xADMIN",
    role: "admin",
  };

  try {
    // 1. Create wallets
    console.log("\n1. Creating wallets...");
    await walletRepo.create({ address: "0xALICE", initialBalance: "1000" });
    await walletRepo.create({ address: "0xBOB", initialBalance: "500" });
    console.log("✓ Wallets created");

    // 2. Alice reads her own balance (ALLOW)
    console.log("\n2. Alice reads her own balance...");
    const aliceBalance = await service.getBalance(alice, "0xALICE");
    console.log(`✓ Alice's balance: ${aliceBalance}`);

    // 3. Bob tries to read Alice's balance (DENY)
    console.log("\n3. Bob tries to read Alice's balance...");
    try {
      await service.getBalance(bob, "0xALICE");
      console.log("✗ Should have been denied!");
    } catch (error: any) {
      console.log(`✓ Access denied: ${error.message}`);
    }

    // 4. Verifier reads Alice's balance (ALLOW - hierarchy)
    console.log("\n4. Verifier reads Alice's balance...");
    const verifierRead = await service.getBalance(verifier, "0xALICE");
    console.log(`✓ Verifier sees balance: ${verifierRead}`);

    // 5. Alice debits from her wallet (ALLOW)
    console.log("\n5. Alice debits 200 from her wallet...");
    const debitResult = await service.debit(alice, "0xALICE", "200");
    console.log(
      `✓ Debit successful: ${debitResult.previousBalance} → ${debitResult.newBalance}`,
    );

    // 6. Bob tries to debit from Alice's wallet (DENY)
    console.log("\n6. Bob tries to debit from Alice's wallet...");
    try {
      await service.debit(bob, "0xALICE", "100");
      console.log("✗ Should have been denied!");
    } catch (error: any) {
      console.log(`✓ Access denied: ${error.message}`);
    }

    // 7. Admin credits Bob's wallet (ALLOW)
    console.log("\n7. Admin credits 1000 to Bob's wallet...");
    const creditResult = await service.credit(admin, "0xBOB", "1000");
    console.log(`✓ Credit successful: new balance ${creditResult.balance}`);

    // 8. User tries to credit (DENY)
    console.log("\n8. Alice tries to credit her own wallet...");
    try {
      await service.credit(alice, "0xALICE", "1000");
      console.log("✗ Should have been denied!");
    } catch (error: any) {
      console.log(`✓ Access denied: ${error.message}`);
    }

    // 9. Concurrent debits from Alice's wallet
    console.log("\n9. Testing concurrent debits (Alice: 800 balance)...");
    const aliceWallet = await walletRepo.findByAddress("0xALICE");
    if (aliceWallet) {
      const concurrentDebits = await Promise.allSettled([
        walletRepo.debit(aliceWallet.id, "200"),
        walletRepo.debit(aliceWallet.id, "200"),
        walletRepo.debit(aliceWallet.id, "200"),
        walletRepo.debit(aliceWallet.id, "200"),
        walletRepo.debit(aliceWallet.id, "200"), // This should fail
      ]);

      const succeeded = concurrentDebits.filter(
        (r) => r.status === "fulfilled",
      );
      const failed = concurrentDebits.filter((r) => r.status === "rejected");

      console.log(`✓ Succeeded: ${succeeded.length}, Failed: ${failed.length}`);

      const finalAlice = await walletRepo.findById(aliceWallet.id);
      console.log(`✓ Final balance: ${finalAlice?.balance} (never negative!)`);
    }

    // 10. View audit logs
    console.log("\n10. Audit Log Summary:");
    const auditLogs = policyEngine.getAuditLogs();
    console.log(`Total decisions: ${auditLogs.length}`);
    console.log(
      `Allowed: ${auditLogs.filter((l) => l.decision === PolicyDecision.ALLOW).length}`,
    );
    console.log(
      `Denied: ${auditLogs.filter((l) => l.decision === PolicyDecision.DENY).length}`,
    );

    // Show denied access attempts
    console.log("\nDenied Access Attempts:");
    const deniedLogs = policyEngine.getAuditLogs({
      decision: PolicyDecision.DENY,
    });
    deniedLogs.forEach((log) => {
      console.log(
        `  - ${log.user?.address || "anonymous"} → ${log.action} on ${log.resource}`,
      );
      console.log(`    Reason: ${log.reason.message}`);
    });
  } finally {
    await pool.query("DROP TABLE IF EXISTS wallets");
    await pool.end();
  }

  console.log("\n" + "=".repeat(60));
  console.log("Example completed!");
  console.log("=".repeat(60));
}

// Run the example if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runExample().catch(console.error);
}

export { SecureWalletService, configurePolicies };
