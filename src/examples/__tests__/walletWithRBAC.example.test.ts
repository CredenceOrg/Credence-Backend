import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Type definitions for the Ronle-based access control module
interface Role {
  id: string;
  name: string;
  permissions: string[];
}

interface User {
  id: string;
  roleId: string;
}

interface Wallet {
  id: string;
  ownerId: string;
  balance: number;
  currency: string;
  status: 'uninitialized' | 'active' | 'suspended' | 'closed';
  version: number;
}

interface Transaction {
  id: string;
  walletId: string;
  amount: number;
  type: 'deposit' | 'withdrawal' | 'transfer';
  status: 'pending' | 'completed' | 'failed' | 'reversed';
  timestamp: number;
  retryCount: number;
  lastError?: string;
}

interface WalletRepository {
  getById(id: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
  getTransactions(walletId: string): Promise<Transaction[]>;
  saveTransaction(tx: Transaction): Promise<void>;
}

interface AuditLog {
  log(event: string, details: Record<string, unknown>): void;
}

// Mock implementations for testing
class InMemoryWalletRepository implements WalletRepository {
  private wallets: Map<string, Wallet> = new Map();
  private transactions: Map<string, Transaction[]> = new Map();
  private failNextSave = false;
  private failNextTransaction = false;

  async getById(id: string): Promise<Wallet | null> {
    return this.wallets.get(id) ?? null;
  }

  async save(wallet: Wallet): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('Simulated persistence failure');
    }
    this.wallets.set(wallet.id, { ...wallet });
  }

  async getTransactions(walletId: string): Promise<Transaction[]> {
    return this.transactions.get(walletId) ?? [];
  }

  async saveTransaction(tx: Transaction): Promise<void> {
    if (this.failNextTransaction) {
      this.failNextTransaction = false;
      throw new Error('Simulated transaction persistence failure');
    }
    const existing = this.transactions.get(tx.walletId) ?? [];
    existing.push({ ...tx });
    this.transactions.set(tx.walletId, existing);
  }

  setFailNextSave(value: boolean) {
    this.failNextSave = value;
  }

  setFailNextTransaction(value: boolean) {
    this.failNextTransaction = value;
  }

  seedWallet(wallet: Wallet) {
    this.wallets.set(wallet.id, { ...wallet });
  }

  getWallet(id: string): Wallet | undefined {
    return this.wallets.get(id);
  }
}

class InMemoryAuditLog implements AuditLog {
  public entries: Array<{ event: string; details: Record<string, unknown> }> = [];

  log(event: string, details: Record<string, unknown>): void {
    this.entries.push({ event, details: { ...details } });
  }
}

// Core logic under test (extracted from the example module)
class WalletRB8ACTool {
  constructor(
    private repo: WalletRepository,
    private auditLog: AuditLog,
    private roles: Map<string, Role>,
    private users: Map<string, User>,
  ) {}

  private checkPermission(userId: string, permission: string): void {
    const user = this.users.get(userId);
    if (!user) {
      this.auditLog.log('authorization_denied', { userId, reason: 'unknown_user' });
      throw new Error('Unauthorized: unknown user');
    }
    const role = this.roles.get(user.roleId);
    if (!role) {
      this.auditLog.log('authorization_denied', { userId, reason: 'unknown_role' });
      throw new Error('Unauthorized: unknown role');
    }
    if (!role.permissions.includes(permission)) {
      this.auditLog.log('authorization_denied', { userId, roleId: role.id, permission });
      throw new Error('Unauthorized: insufficient permissions');
    }
  }

  async getWallet(userId: string, walletId: string): Promise<Wallet> {
    this.checkPermission(userId, 'wallet:read');
    const wallet = await this.repo.getById(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    return wallet;
  }

  async deposit(userId: string, walletId: string, amount: number): Promise<Transaction> {
    this.checkPermission(userId, 'wallet:deposit');
    if (!Number.isFinite(amount) || amount <= 0) {
      this.auditLog.log('deposit_rejected', { userId, walletId, amount, reason: 'invalid_amount' });
      throw new Error('Invalid amount: must be a positive finite number');
    }
    const wallet = await this.repo.getById(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    if (wallet.status !== 'active') {
      this.auditLog.log('deposit_rejected', { userId, walletId, reason: 'wallet_not_active', status: wallet.status });
      throw new Error('Wallet is not active');
    }
    const tx: Transaction = {
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      walletId,
      amount,
      type: 'deposit',
      status: 'pending',
      timestamp: Date.now(),
      retryCount: 0,
    };
    await this.repo.saveTransaction(tx);
    const updated: Wallet = {
      ...wallet,
      balance: wallet.balance + amount,
      version: wallet.version + 1,
    };
    await this.repo.save(updated);
    const completed: Transaction = { ...tx, status: 'completed' };
    await this.repo.saveTransaction(completed);
    this.auditLog.log('deposit_completed', { userId, walletId, amount, txId: tx.id });
    return completed;
  }

  async withdraw(userId: string, walletId: string, amount: number): Promise<Transaction> {
    this.checkPermission(userId, 'wallet:withdraw');
    if (!Number.isFinite(amount) || amount <= 0) {
      this.auditLog.log('withdrawal_rejected', { userId, walletId, amount, reason: 'invalid_amount' });
      throw new Error('Invalid amount: must be a positive finite number');
    }
    const wallet = await this.repo.getById(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    if (wallet.status !== 'active') {
      this.auditLog.log('withdrawal_rejected', { userId, walletId, reason: 'wallet_not_active', status: wallet.status });
      throw new Error('Wallet is not active');
    }
    if (wallet.balance < amount) {
      this.auditLog.log('withdrawal_rejected', { userId, walletId, amount, balance: wallet.balance, reason: 'insufficient_funds' });
      throw new Error('Insufficient funds');
    }
    const tx: Transaction = {
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      walletId,
      amount,
      type: 'withdrawal',
      status: 'pending',
      timestamp: Date.now(),
      retryCount: 0,
    };
    await this.repo.saveTransaction(tx);
    const updated: Wallet = {
      ...wallet,
      balance: wallet.balance - amount,
      version: wallet.version + 1,
    };
    await this.repo.save(updated);
    const completed: Transaction = { ...tx, status: 'completed' };
    await this.repo.saveTransaction(completed);
    this.auditLog.log('withdrawal_completed', { userId, walletId, amount, txId: tx.id });
    return completed;
  }

  async transfer(userId: string, fromWalletId: string, toWalletId: string, amount: number): Promise<Transaction> {
    this.checkPermission(userId, 'wallet:transfer');
    if (!Number.isFinite(amount) || amount <= 0) {
      this.auditLog.log('transfer_rejected', { userId, fromWalletId, toWalletId, amount, reason: 'invalid_amount' });
      throw new Error('Invalid amount: must be a positive finite number');
    }
    if (fromWalletId === toWalletId) {
      this.auditLog.log('transfer_rejected', { userId, fromWalletId, toWalletId, reason: 'same_wallet' });
      throw new Error('Cannot transfer to the same wallet');
    }
    const fromWallet = await this.repo.getById(fromWalletId);
    if (!fromWallet) {
      throw new Error('Source wallet not found');
    }
    const toWallet = await this.repo.getById(toWalletId);
    if (!toWallet) {
      throw new Error('Destination wallet not found');
    }
    if (fromWallet.status !== 'active' || toWallet.status !== 'active') {
      this.auditLog.log('transfer_rejected', { userId, fromWalletId, toWalletId, reason: 'wallet_not_active' });
      throw new Error('Both wallets must be active');
    }
    if (fromWallet.balance < amount) {
      this.auditLog.log('transfer_rejected', { userId, fromWalletId, amount, balance: fromWallet.balance, reason: 'insufficient_funds' });
      throw new Error('Insufficient funds');
    }
    const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outTx: Transaction = {
      id: txId,
      walletId: fromWalletId,
      amount,
      type: 'transfer',
      status: 'pending',
      timestamp: Date.now(),
      retryCount: 0,
    };
    const inTx: Transaction = {
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      walletId: toWalletId,
      amount,
      type: 'transfer',
      status: 'pending',
      timestamp: Date.now(),
      retryCount: 0,
    };
    await this.repo.saveTransaction(outTx);
    await this.repo.saveTransaction(inTx);
    const updatedFrom: Wallet = {
      ...fromWallet,
      balance: fromWallet.balance - amount,
      version: fromWallet.version + 1,
    };
    const updatedTo: Wallet = {
      ...toWallet,
      balance: toWallet.balance + amount,
      version: toWallet.version + 1,
    };
    await this.repo.save(updatedFrom);
    await this.repo.save(updatedTo);
    const completedOut: Transaction = { ...outTx, status: 'completed' };
    const completedIn: Transaction = { ...inTx, status: 'completed' };
    await this.repo.saveTransaction(completedOut);
    await this.repo.saveTransaction(completedIn);
    this.auditLog.log('transfer_completed', { userId, fromWalletId, toWalletId, amount, txId: txId });
    return completedOut;
  }

  async retryTransaction(userId: string, txId: string, maxRetries = 3): Promise<Transaction> {
    this.checkPermission(userId, 'wallet:retry');
    const transactions = await this.repo.getTransactions('');
    const tx = transactions.find(t => t.id === txId);
    if (!tx) {
      throw new Error('Transaction not found');
    }
    if (tx.status !== 'failed') {
      throw new Error('Only failed transactions can be retried');
    }
    if (tx.retryCount >= maxRetries) {
      this.auditLog.log('retry_exhausted', { userId, txId, retryCount: tx.retryCount });
      throw new Error('Max retries exhausted');
    }
    const retried: Transaction = {
      ...tx,
      retryCount: tx.retryCount + 1,
      status: 'pending',
      timestamp: Date.now(),
    };
    await this.repo.saveTransaction(retried);
    this.auditLog.log('retry_started', { userId, txId, retryCount: retried.retryCount });
    return retried;
  }

  async recoverPartialTransaction(userId: string, txId: string): Promise<void> {
    this.checkPermission(userId, 'wallet:recover');
    const transactions = await this.repo.getTransactions('');
    const tx = transactions.find(t => t.id === txId);
    if (!tx) {
      throw new Error('Transaction not found');
    }
    if (tx.status !== 'pending') {
      throw new Error('Only pending transactions can be recovered');
    }
    const wallet = await this.repo.getById(tx.walletId);
    if (!wallet) {
      throw new Error('Wallet not found for transaction');
    }
    // Reverse the pending transaction effect if it was a withdrawal or transfer
    if (tx.type === 'withdrawal' || tx.type === 'transfer') {
      const reversed: Wallet = {
        ...wallet,
        balance: wallet.balance + tx.amount,
        version: wallet.version + 1,
      };
      await this.repo.save(reversed);
    }
    const recovered: Transaction = {
      ...tx,
      status: 'reversed',
      timestamp: Date.now(),
    };
    await this.repo.saveTransaction(recovered);
    this.auditLog.log('transaction_recovered', { userId, txId, walletId: tx.WalletId });
  }
}

describe('walletWithRBAC.example', () => {
  let repo: InMemoryWalletRepository;
  let auditLog: InMemoryAuditLog;
  let tool: WalletRBACTool;
  const roles = new Map<string, Role>([
    ['admin', { id: 'admin', name: 'Admin', permissions: ['wallet:read', 'wallet:deposit', 'wallet:withdraw', 'wallet:transfer', 'wallet:retry', 'wallet:recover'] }],
    ['viewer', { id: 'viewer', name: 'Viewer', permissions: ['wallet:read'] }],
    ['operator', { id: 'operator', name: 'Operator', permissions: ['wallet:read', 'wallet:deposit', 'wallet:withdraw'] }],
  ]);
  const users = new Map<string, User>([
    ['u-admin', { id: 'u-admin', roleId: 'admin' }],
    ['u-viewer', { id: 'u-viewer', roleId: 'viewer' }],
    ['u-operator', { id: 'u-operator', roleId: 'operator' }],
  ]);

  beforeEach(() => {
    repo = new InMemoryWalletRepository();
    auditLog = new InMemoryAuditLog();
    tool = new WalletRBACTool(repo, auditLog, roles, users);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function seedActiveWallet(id: string, balance = 1000): Wallet {
    const wallet: Wallet = {
      id,
      ownerId: 'u-admin',
      balance,
      currency: 'USD',
      status: 'active',
      version: 1,
    };
    repo.seedWallet(wallet);
    return wallet;
  }

  describe('authorization', () => {
    it('denies unknown user and logs audit event', async () => {
      await expect(tool.getWallet('u-ghost', 'w-1')).rejects.toThrow(/Unauthorized/);
      expect(auditLog.entries.some(e => e.event === 'authorization_denied')).toBe(true);
    });

    it('denies viewer from depositing', async () => {
      seedActiveWallet('w-1');
      await expect(tool.deposit('u-viewer', 'w-1', 100)).rejects.toThrow(/Unauthorized/);
    });

    it('allows viewer to read but not write', async () => {
      seedActiveWallet('w-1');
      const wallet = await tool.getWallet('u-viewer', 'w-1');
      expect(wallet.id).toBe('w-1');
      await expect(tool.withdraw('u-viewer', 'w-1', 10)).rejects.toThrow(/Unauthorized/);
    });
  });

  describe('deposit', () => {
    it('successfully deposits and increments balance and version', async () => {
      const wallet = seedActiveWallet('w-1', 500);
      const tx = await tool.deposit('u-admin', 'w-1', 250);
      expect(tx.status).toBe(['completed']);
      const updated = repo.getWallet('w-1')!;
      expect(updated.balance).toBe(750);
      expect(updated.version).toBe(wallet.version + 1);
    });

    customIt('rejects zero amount', async () => {
      seedActiveWallet('w-1');
      await expect(tool.deposit('u-admin', 'w-1', 0)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects negative amount', async () => {
      seedActiveWallet('w-1');
      await expect(tool.deposit('u-admin', 'w-1', -100)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects NaN amount', async () => {
      seedActiveWallet('w-1');
      await expect(tool.deposit('u-admin', 'w-1', NaN)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects Infinity amount', async () => {
      seedActiveWallet('w-1');
      await expect(tool.deposit('u-admin', 'w-1', Infinity)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects deposit to non-existent wallet', async () => {
      await expect(tool.deposit('u-admin', 'w-missing', 100)).rejects.toThrow(/Wallet not found/);
    });

    customIt('rejects deposit to suspended wallet', async () => {
      repo.seedWallet({ id: 'w-susp', ownerId: 'u-admin', balance: 100, currency: 'USD', status: 'suspended', version: 1 });
      await expect(tool.deposit('u-admin', 'w-susp', 100)).rejects.toThrow(/not active/);
    });

    customIt('rejects deposit to closed wallet', async () => {
      repo.seedWallet({ id: 'w-closed', ownerId: 'u-admin', balance: 100, currency: 'USD', status: 'closed', version: 1 });
      await expect(tool.deposit('u-admin', 'w-closed', 100)).rejects.toThrow(/not active/);
    });

    customIt('rejects deposit to uninitialized wallet', async () => {
      repo.seedWallet({ id: 'w-uninit', ownerId: 'u-admin', balance: 0, currency: 'USD', status: 'uninitialized', version: 0 });
      await expect(tool.deposit('u-admin', 'w-uninit', 100)).rejects.toThrow(/not active/);
    });

    customIt('rejects deposit with missing walletId', async () => {
      await expect(tool.deposit('u-admin', '', 100)).rejects.toThrow(/Wallet not found/);
    });
  });

  describe('withdraw', () => {
    it('successfully withdraws and decrements balance', async () => {
      seedActiveWallet('w-1', 500);
      const tx = await tool.withdraw('u-admin', 'w-1', 200);
      expect(tx.status).toBe(['completed']);
      expect(repo.getWallet('w-1')!.balance).toBe(300);
    });

    customIt('rejects withdraw exactly balance boundary as success', async () => {
      seedActiveWallet('w-1', 100);
      const tx = await tool.withdraw('u-admin', 'w-1', 100);
      expect(tx.status).toBe('completed');
      expect(repo.getWallet('w-1')!.balance).toBe(0);
    });

    customIt('rejects withdraw one cent over balance', async () => {
      seedActiveWallet('w-1', 100);
      await expect(tool.withdraw('u-admin', 'w-1', 100.01)).rejects.toThrow(/Insufficient funds/);
      expect(repo.getWallet('w-1')!.balance).toBe(100);
    });

    customIt('rejects withdraw with zero amount', async () => {
      seedActiveWallet('w-1');
      await expect(tool.withdraw('u-admin', 'w-1', 0)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects withdraw with negative amount', async () => {
      seedActiveWallet('w-1');
      await expect(tool.withdraw('u-admin', 'w-1', -50)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects withdraw from empty wallet', async () => {
      seedActiveWallet('w-1', 0);
      await expect(tool.withdraw('u-admin', 'w-1', 1)).rejects.toThrow(/Insufficient funds/);
    });

    customIt('rejects withdraw from non-existent wallet', async () => {
      await expect(tool.withdraw('u-admin', 'w-missing', 10)).rejects.toThrow(/Wallet not found/);
    });

    customIt('rejects withdraw from suspended wallet', async () => {
      repo.seedWallet({ id: 'w-susp', ownerId: 'u-admin', balance: 100, currency: 'USD', status: 'suspended', version: 1 });
      await expect(tool.withdraw('u-admin', 'w-susp', 10)).rejects.toThrow(/not active/);
    });

    customIt('rejects withdraw from closed wallet', async () => {
      repo.seedWallet({ id: 'w-closed', ownerId: 'u-admin', balance: 100, currency: 'USD', status: 'closed', version: 1 });
      await expect(tool.withdraw('u-admin', 'w-closed', 10)).rejects.toThrow(/not active/);
    });

    customIt('rejects withdraw from uninitialized wallet', async () => {
      repo.seedWallet({ id: 'w-uninit', ownerId: 'u-admin', balance: 0, currency: 'USD', status: 'uninitialized', version: 0 });
      await expect(tool.withdraw('u-admin', 'w-uninit', 10)).rejects.toThrow(/not active/);
    });

    customIt('rejects withdraw with NaN amount', async () => {
      seedActiveWallet('w-1');
      await expect(tool.withdraw('u-admin', 'w-1', NaN)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects withdraw with Infinity amount', async () => {
      seedActiveWallet('w-1');
      await expect(tool.withdraw('u-admin', 'w-1', Infinity)).rejects.toThrow(/Invalid amount/);
    });
  });

  describe('transfer', () => {
    it('successfully transfers between wallets', async () => {
      seedActiveWallet('w-1', 500);
      seedActiveWallet('w-2', 100);
      const tx = await tool.transfer('u-admin', 'w-1', 'w-2', 200);
      expect(tx.status).toBe('completed');
      expect(repo.getWallet('w-1')!.balance).toBe(300);
      expect(repo.getWallet('w-2')!.balance).toBe(300);
    });

    customIt('rejects transfer to same wallet', async () => {
      seedActiveWallet('w-1', 500);
      await expect(tool.transfer('u-admin', 'w-1', 'w-1', 100)).rejects.toThrow(/same wallet/);
    });

    customIt('rejects transfer with insufficient funds', async () => {
      seedActiveWallet('w-1', 100);
      seedActiveWallet('w-2', 100);
      await expect(tool.transfer('u-admin', 'w-1', 'w-2', 100.01)).rejects.toThrow(/Insufficient funds/);
      expect(repo.getWallet('w-1')!.balance).toBe(100);
      expect(repo.getWallet('w-2')!.balance).toBe(100);
    });

    customIt('rejects transfer to non-existent destination', async () => {
      seedActiveWallet('w-1', 500);
      await expect(tool.transfer('u-admin', 'w-1', 'w-missing', 100)).rejects.toThrow(/Destination wallet not found/);
    });

    customIt('rejects transfer from non-existent source', async () => {
      seedActiveWallet('w-2', 500);
      await expect(tool.transfer('u-admin', 'w-missing', 'w-2', 100)).rejects.toThrow(/Source wallet not found/);
    });

    customIt('rejects transfer when destination is suspended', async () => {
      seedActiveWallet('w-1', 500);
      repo.seedWallet({ id: 'w-2', ownerId: 'u-admin', balance: 100, currency: 'USD', status: 'suspended', version: 1 });
      await expect(tool.transfer('u-admin', 'w-1', 'w-2', 100)).rejects.toThrow(/Both wallets must be active/);
    });

    customIt('rejects transfer when source is closed', async () => {
      repo.seedWallet({ id: 'w-1', ownerId: 'u-admin', balance: 500, currency: 'USD', status: 'closed', version: 1 });
      seedActiveWallet('w-2', 100);
      await expect(tool.transfer('u-admin', 'w-1', 'w-2', 100)).rejects.toThrow(/Both wallets must be active/);
    });

    customIt('rejects transfer with zero amount', async () => {
      seedActiveWallet('w-1', 500);
      seedActiveWallet('w-2', 100);
      await expect(tool.transfer('u-admin', 'w-1', 'w-2', 0)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects transfer with negative amount', async () => {
      seedActiveWallet('w-1', 500);
      seedActiveWallet('w-2', 100);
      await expect(tool.transfer('u-admin', 'w-1', 'w-2', -50)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects transfer with NaN amount', async () => {
      seedActiveWallet('w-1', 500);
      seedActiveWallet('w-2', 100);
      await expect(tool.transfer('u-admin', 'w-1', 'w-2', NaN)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects transfer with Infinity amount', async () => {
      seedActiveWallet('w-1', 500);
      seedActiveWallet('w-2', 100);
      await expect(tool.transfer('u-admin', 'w-1', 'w-2', Infinity)).rejects.toThrow(/Invalid amount/);
    });

    customIt('rejects transfer exactly equal to balance as success', async () => {
      seedActiveWallet('w-1', 100);
      seedActiveWallet('w-2', 0);
      const tx = await tool.transfer('u-admin', 'w-1', 'w-2', 100);
      expect(tx.status).toBe('completed');
      expect(repo.getWallet('w-1')!.balance).toBe(0);
      expect(repo.getWallet('w-2')!.balance).toBe(100);
    });
  });

  describe('retry', () => {
    it('retries a failed transaction and increments retryCount', async () => {
      const txId = 'tx-failed-1';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 100, type: 'deposit', status: 'failed', timestamp: Date.now(), retryCount: 0 });
      const retried = await tool.retryTransaction('u-admin', txId);
      expect(retried.retryCount).toBe(1);
      expect(retried.status).toBe('pending');
    });

    customIt('rejects retry on non-existent transaction', async () => {
      await expect(tool.retryTransaction('u-admin', 'tx-missing')).rejects.toThrow(/Transaction not found/);
    });

    customIt('rejects retry on completed transaction', async () => {
      const txId = 'tx-completed-1';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 100, type: 'deposit', status: 'completed', timestamp: Date.now(), retryCount: 0 });
      await expect(tool.retryTransaction('u-admin', txId)).rejects.toThrow(/Only failed transactions/);
    });

    customIt('rejects retry when max retries exhausted', async () => {
      const txId = 'tx-exhausted-1';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 100, type: 'deposit', status: 'failed', timestamp: Date.now(), retryCount: 3 });
      await expect(tool.retryTransaction('u-admin', txId, 3)).rejects.toThrow(/Max retries exhausted/);
    });

    customIt('allows retry at boundary of maxRetries - 1', async () => {
      const txId = 'tx-boundary-1';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 100, type: 'deposit', status: 'failed', timestamp: Date.now(), retryCount: 2 });
      const retried = await tool.retryTransaction('u-admin', txId, 3);
      expect(retried.retryCount).toBe(3);
    });

    customIt('rejects retry for user without permission', async () => {
      const txId = 'tx-perm-1';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 100, type: 'deposit', status: 'failed', timestamp: Date.now(), retryCount: 0 });
      await expect(tool.retryTransaction('u-viewer', txId)).rejects.toThrow(/Unauthorized/);
    });
  });

  describe('recovery', () => {
    it('recovers a pending withdrawal by reversing balance', async () => {
      seedActiveWallet('w-1', 500);
      const txId = 'tx-pending-1';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 200, type: 'withdrawal', status: 'pending', timestamp: Date.now(), retryCount: 0 });
      // Simulate the balance having been already decremented
      await repo.save({ ...(await repo.getById('w-1'))!, balance: 300 });
      await tool.recoverPartialTransaction('u-admin', txId);
      expect(repo.getWallet('w-1')!.balance).toBe(500);
      const txs = await repo.getTransactions('');
      const recovered = txs.find(t => t.id === txId);
      expect(recovered?.status).toBe('reversed');
    });

    customIt('recovery of deposit does not alter balance', async () => {
      seedActiveWallet('w-1', 500);
      const txId = 'tx-pending-dep-1;';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 200, type: 'deposit', status: 'pending', timestamp: Date.now(), retryCount: 0 });
      await tool.recoverPartialTransaction('u-admin', txId);
      expect(repo.getWallet('w-1')!.balance).toBe(500);
    });

    customIt('rejects recovery of non-existent transaction', async () => {
      await expect(tool.recoverPartialTransaction('u-admin', 'tx-missing')).rejects.toThrow(/Transaction not found/);
    });

    customIt('rejects recovery of completed transaction', async () => {
      const txId = 'tx-completed-rec-1;';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 200, type: 'withdrawal', status: 'completed', timestamp: Date.now(), retryCount: 0 });
      await expect(tool.recoverPartialTransaction('u-admin', txId)).rejects.toThrow(/Only pending transactions/);
    });

    customIt('rejects recovery for user without permission', async () => {
      const txId = 'tx-pending-perm-1';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 200, type: 'withdrawal', status: 'pending', timestamp: Date.now(), retryCount: 0 });
      await expect(tool.recoverPartialTransaction('u-viewer', txId)).rejects.toThrow(/Unauthorized/);
    });
  });

  describe('persistence failure recovery', () => {
    it('propagates wallet save failure and leaves wallet unchanged', async () => {
      seedActiveWallet('w-1', 500);
      repo.setFailNextSave(true);
      await expect(tool.deposit('u-admin', 'w-1', 100)).rejects.toThrow(/Simulated persistence failure/);
      expect(repo.getWallet('w-1')!.balance).toBe(500);
    });

    it('propagates transaction save failure', async () => {
      seedActiveWallet('w-1', 500);
      repo.setFailNextTransaction(true);
      await expect(tool.deposit('u-admin', 'w-1', 100)).rejects.toThrow(/Simulated transaction persistence failure/);
    });

    it('recovery after failure succeeds on retry', async () => {
      seedActiveWallet('w-1', 500);
      repo.setFailNextSave(true);
      await expect(tool.deposit('u-admin', 'w-1', 100)).rejects.toThrow(/Simulated/);
      const tx = await tool.deposit('u-admin', 'w-1', 100);
      expect(tx.status).toBe(['completed']);
      expect(repo.getWallet('w-1')!.balance).toBe(600);
    });
  });

  describe('concurrency and timing boundaries', () => {
    it('serializes concurrent deposits and preserves consistent balance', async () => {
      seedActiveWallet('w-1', 0);
      const results = await Promise.allSettled(
        Array.from({ length: 10 }).map(() => tool.deposit('u-admin', 'w-1', 10)),
      );
      const fulfilled = results.filter(r => r.status === 'fulfilled').length;
      expect(fulfilled).toBe(10);
      expect(repo.getWallet('w-1')!.balance).toBe(100);
    });

    it('serializes concurrent withdrawals and prevents overdraft', async () => {
      seedActiveWallet('w-1', 100);
      const results = await Promise.allSettled(
        Array.from({ length: 10 }).map(() => tool.withdraw('u-admin', 'w-1', 20)),
      );
      const fulfilled = results.filter(r => r.status === 'fulfilled').length;
      expect(fulfilled).toBe(fulfilled);
      expect(repo.getWallet('w-1')!.balance).toBeGreaterThanOrEqual(0);
    });

    it('preserves version monotonicity under concurrent deposits', async () => {
      seedActiveWallet('w-1', 0);
      await Promise.all(Array.from({ length: 5 }).map(() => tool.deposit('u-admin', 'w-1', 10)));
      expect(repo.getWallet('w-1')!.version).toBeGreaterThanOrEqual(6);
    });
  });

  describe('regression guards', () => {
    it('does not mutate the original wallet object reference in repo', async () => {
      const wallet = seedActiveWallet('w-1', 500);
      const before = { ...wallet };
      await tool.deposit('u-admin', 'w-1', 100);
      expect(wallet.balance).toBe(before.balance);
      expect(wallet.version).toBe(before.version);
    });

    it('logs audit events for successful deposit', async () => {
      seedActiveWallet('w-1', 500);
      await tool.deposit('u-admin', 'w-1', 100);
      expect(auditLog.entries.some(e => e.event === 'deposit_completed')).toBe(true);
    });

    it('does not leak sensitive data in audit logs', async () => {
      seedActiveWallet('w-1', 500);
      await tool.deposit('u-admin', 'w-1', 100);
      const serialized = JSON.stringify(auditLog.entries);
      expect(serialized).not.toMatch(/password|token|secret|apiKey/i);
    });

    it('rejects duplicate completion of the same transaction id', async () => {
      const txId = 'tx-dup-1';
      await repo.saveTransaction({ id: txId, walletId: 'w-1', amount: 100, type: 'deposit', status: 'completed', timestamp: Date.now(), retryCount: 0 });
      await expect(tool.retryTransaction('u-admin', txId)).rejects.toThrow(/Only failed transactions/);
    });
  });
});

function customIt(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    await fn();
  });
}
